'use strict';

/**
 * Middlewares transversales: identificador de peticion, limite de tasa,
 * validacion de entrada y manejo central de errores.
 */

const crypto = require('crypto');
const { config } = require('../config');
const { errors, isApiError } = require('../lib/errors');
const { logger } = require('../lib/logger');
const db = require('../lib/db');

/* ---------- identificacion de la peticion ---------- */

function requestContext(req, res, next) {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  req.clientIp = fwd || req.ip || 'desconocida';
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', function () {
    logger.forRequest(req).info('http_request', {
      status: res.statusCode,
      durationMs: Date.now() - req.startedAt
    });
  });
  next();
}

/* ---------- limite de tasa ---------- */

function safeKey(value) {
  return String(value || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

/**
 * Contador por ventana en RTDB con transaccion, para que funcione aunque
 * haya varias instancias de la funcion corriendo en paralelo (una variable
 * en memoria no sirve: cada instancia tendria su propio contador).
 *
 * bucket: nombre de la regla en config.rateLimits
 * keyFn : de que se cuenta (por defecto la IP). En login se usa IP + usuario
 *         para que un atacante no bloquee a un usuario legitimo solo con
 *         gastarle los intentos desde otra IP.
 */
function rateLimit(bucket, keyFn) {
  const rule = config.rateLimits[bucket];
  return async function (req, res, next) {
    try {
      const key = safeKey(bucket + '__' + (keyFn ? keyFn(req) : req.clientIp));
      const nowMs = Date.now();
      const nodeRef = db.child(db.PATHS.rateLimit, key);

      const result = await nodeRef.transaction(function (current) {
        if (!current || nowMs - current.windowStart > rule.windowSec * 1000) {
          return { windowStart: nowMs, count: 1, blockedUntil: 0 };
        }
        if (current.blockedUntil && nowMs < current.blockedUntil) return current;
        const count = (current.count || 0) + 1;
        return {
          windowStart: current.windowStart,
          count: count,
          blockedUntil: count > rule.max ? nowMs + rule.blockSec * 1000 : 0
        };
      });

      const state = (result.snapshot && result.snapshot.val()) || { count: 1, blockedUntil: 0 };
      const blocked = state.blockedUntil && nowMs < state.blockedUntil;

      res.setHeader('X-RateLimit-Limit', String(rule.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(rule.max - (state.count || 0), 0)));

      if (blocked) {
        const retry = Math.ceil((state.blockedUntil - nowMs) / 1000);
        res.setHeader('Retry-After', String(retry));
        logger.forRequest(req).warn('rate_limited', { bucket: bucket, retryAfterSec: retry });
        throw errors.tooManyRequests(retry);
      }
      req.rateLimitKey = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Se llama tras un login correcto para no castigar al usuario legitimo. */
async function resetRateLimit(key) {
  if (!key) return;
  await db.child(db.PATHS.rateLimit, key).remove();
}

/* ---------- validacion ---------- */

/**
 * validate({ body: schema, query: schema, params: schema })
 * Rechaza cualquier campo no declarado (los esquemas usan .strict()), asi
 * nadie puede colar propiedades como role o client_id en un update.
 * El resultado limpio queda en req.valid.
 */
function validate(schemas) {
  return function (req, res, next) {
    const out = {};
    const details = {};
    for (const part of ['body', 'query', 'params']) {
      if (!schemas[part]) continue;
      const parsed = schemas[part].safeParse(req[part]);
      if (parsed.success) {
        out[part] = parsed.data;
      } else {
        for (const issue of parsed.error.issues) {
          details[part + '.' + issue.path.join('.')] = issue.message;
        }
      }
    }
    if (Object.keys(details).length) return next(errors.validation(details));
    req.valid = out;
    next();
  };
}

/* ---------- errores ---------- */

function notFound(req, res, next) {
  next(errors.notFound('La ruta ' + req.method + ' ' + req.path));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const log = logger.forRequest(req);

  if (isApiError(err)) {
    if (err.status >= 500) log.error('api_error', { code: err.code, stack: err.stack });
    else log.warn('api_error', { code: err.code, status: err.status });
    if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
    return res.status(err.status).json(err.body(req.requestId));
  }

  if (err && err.type === 'entity.too.large') {
    const e = errors.payloadTooLarge();
    return res.status(e.status).json(e.body(req.requestId));
  }

  log.error('unhandled_error', { message: err && err.message, stack: err && err.stack });
  const internal = errors.internal();
  return res.status(500).json(internal.body(req.requestId));
}

module.exports = {
  requestContext: requestContext,
  rateLimit: rateLimit,
  resetRateLimit: resetRateLimit,
  validate: validate,
  notFound: notFound,
  errorHandler: errorHandler
};
