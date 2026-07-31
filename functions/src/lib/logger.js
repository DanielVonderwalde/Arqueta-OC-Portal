'use strict';

/**
 * Logging estructurado.
 *
 * Cloud Logging indexa automaticamente el JSON que se escribe en stdout,
 * siempre que traiga el campo "severity". Con eso se pueden crear alertas
 * (ej. mas de N eventos auth.login_failed por minuto) sin instalar nada.
 *
 * Reglas:
 *  - Nunca se loguea una contrasena, un hash, un token ni el contenido de un
 *    archivo. La lista REDACT_KEYS los reemplaza por [redacted].
 *  - Todo log de una peticion lleva requestId para poder reconstruir la traza.
 */

const { config } = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

const REDACT_KEYS = [
  'password', 'pass', 'newPassword', 'currentPassword',
  'portal_password', 'portal_password_hash', 'passHash', 'passwordHash',
  'authorization', 'token', 'accessToken', 'refreshToken', 'jwt', 'secret',
  'fileData', 'pdfData', 'excelData', 'excelInsertoData'
];

const MAX_STRING = 512;

function sanitize(value, depth) {
  const d = depth || 0;
  if (d > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '...[' + value.length + ' chars]' : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(function (v) { return sanitize(v, d + 1); });
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = REDACT_KEYS.indexOf(key) >= 0 ? '[redacted]' : sanitize(value[key], d + 1);
  }
  return out;
}

function emit(level, message, meta) {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const entry = Object.assign(
    {
      severity: SEVERITY[level],
      service: config.service,
      env: config.env,
      apiVersion: config.apiVersion,
      message: message,
      time: new Date().toISOString()
    },
    sanitize(meta || {})
  );
  /* eslint-disable no-console */
  console.log(JSON.stringify(entry));
  /* eslint-enable no-console */
}

const logger = {
  debug: function (m, meta) { emit('debug', m, meta); },
  info: function (m, meta) { emit('info', m, meta); },
  warn: function (m, meta) { emit('warn', m, meta); },
  error: function (m, meta) { emit('error', m, meta); },

  /* Devuelve un logger que ya trae requestId, ruta y actor pegados. */
  forRequest: function (req) {
    const ctx = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path,
      ip: req.clientIp,
      actor: req.auth ? req.auth.sub : null,
      role: req.auth ? req.auth.role : null
    };
    const bind = function (level) {
      return function (m, meta) { emit(level, m, Object.assign({}, ctx, meta || {})); };
    };
    return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
  }
};

module.exports = { logger: logger, sanitize: sanitize, REDACT_KEYS: REDACT_KEYS };
