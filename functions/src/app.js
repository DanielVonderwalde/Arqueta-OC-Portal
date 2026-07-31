'use strict';

/**
 * Aplicacion Express de la API.
 *
 * Versionado: todo cuelga de /v1. Cuando haya que romper el contrato se crea
 * /v2 en paralelo, se migra el frontend y recien despues se retira /v1. El
 * numero de version NO se toca por agregar campos o endpoints nuevos.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { config } = require('./config');
const { errors } = require('./lib/errors');
const { requestContext, notFound, errorHandler } = require('./middleware/security');

function buildCors() {
  return cors({
    origin: function (origin, callback) {
      /* Sin Origin = llamada servidor a servidor o curl: se permite, porque
         CORS no es un control de autorizacion (eso lo hace el token). */
      if (!origin) return callback(null, true);
      if (config.corsOrigins.indexOf(origin) >= 0) return callback(null, true);
      return callback(errors.forbidden('Origen no permitido: ' + origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Bootstrap-Token'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'X-RateLimit-Remaining'],
    credentials: false,
    maxAge: 600
  });
}

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', true);

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use(buildCors());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);

  /* Salud del servicio. Sin datos internos: solo sirve para monitoreo. */
  app.get('/health', function (req, res) {
    res.json({ status: 'ok', apiVersion: config.apiVersion, env: config.env, time: new Date().toISOString() });
  });

  const v1 = express.Router();
  v1.use('/auth', require('./routes/auth'));
  v1.use('/clients', require('./routes/clients'));
  v1.use('/quotes', require('./routes/quotes'));
  v1.use('/orders', require('./routes/orders'));
  v1.use('/documents', require('./routes/documents'));
  v1.use('/users', require('./routes/users'));
  app.use('/v1', v1);

  /* Llamar sin version es un error explicito, no un 404 confuso. */
  app.use(function (req, res, next) {
    if (req.path === '/' || /^\/(auth|clients|quotes|orders|documents|users)/.test(req.path)) {
      return next(errors.badRequest('Falta el prefijo de version. Usa /v1' + req.path));
    }
    next();
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
