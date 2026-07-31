'use strict';

/**
 * Configuracion por ambiente (dev / staging / prod).
 *
 * Regla del proyecto: NADA hardcodeado en el codigo de negocio. Todo lo que
 * cambia entre ambientes vive aqui, y todo lo secreto vive en Secret Manager
 * (process.env inyectado por firebase functions:secrets:set).
 *
 * APP_ENV se define al desplegar:
 *   firebase functions:config unset (v1) / o variable de entorno APP_ENV en .env.<proyecto>
 */

const APP_ENV = String(process.env.APP_ENV || 'dev').toLowerCase();
const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true';

const BASE = {
  service: 'arqueta-api',
  apiVersion: 'v1',
  logLevel: 'info',
  corsOrigins: [],

  tokens: {
    issuer: 'arqueta-api',
    accessMinutes: 30,
    refreshHours: 8,
    clockToleranceSec: 10
  },

  passwords: {
    /* bcrypt: coste 12 (~250 ms). Suficiente contra fuerza bruta offline y
       tolerable para un login esporadico en Cloud Functions. */
    bcryptRounds: 12,
    minLength: 10
  },

  pagination: {
    defaultLimit: 25,
    maxLimit: 100,
    /* tope duro de registros que la funcion lee de RTDB en una consulta
       filtrada, para que un cliente no pueda forzar una lectura completa */
    hardScanCap: 2000
  },

  rateLimits: {
    login:  { max: 5,   windowSec: 300, blockSec: 900 },
    read:   { max: 300, windowSec: 60,  blockSec: 60 },
    write:  { max: 60,  windowSec: 60,  blockSec: 120 },
    upload: { max: 20,  windowSec: 300, blockSec: 300 }
  },

  uploads: {
    maxBytes: 25 * 1024 * 1024,
    signedUrlMinutes: 15,
    storagePrefix: 'documents',
    allowedMime: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel'
    ]
  }
};

const PER_ENV = {
  dev: {
    logLevel: 'debug',
    corsOrigins: [
      'http://localhost:5000',
      'http://127.0.0.1:5000',
      'http://localhost:8080'
    ],
    rateLimits: { login: { max: 50, windowSec: 300, blockSec: 30 } }
  },
  staging: {
    logLevel: 'debug',
    corsOrigins: ['https://arqueta-portal-staging.web.app']
  },
  prod: {
    logLevel: 'info',
    corsOrigins: [
      'https://danielvonderwalde.github.io',
      'https://arqueta-portal.web.app',
      'https://arqueta-portal.firebaseapp.com'
    ]
  }
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

function deepFreeze(o) {
  Object.getOwnPropertyNames(o).forEach(function (k) {
    if (o[k] && typeof o[k] === 'object') deepFreeze(o[k]);
  });
  return Object.freeze(o);
}

const config = deepFreeze(
  merge(BASE, Object.assign({ env: APP_ENV, isEmulator: IS_EMULATOR }, PER_ENV[APP_ENV] || PER_ENV.dev))
);

/**
 * Lee un secreto obligatorio. Falla temprano y con mensaje claro si falta,
 * en vez de firmar tokens con undefined.
 */
function requireSecret(name) {
  const value = process.env[name];
  if (!value || value.length < 24) {
    if (config.env === 'dev' && IS_EMULATOR && name === 'JWT_SECRET') {
      return 'emulator-only-insecure-secret-do-not-use-in-prod';
    }
    throw new Error('Falta el secreto ' + name + '. Ejecuta: firebase functions:secrets:set ' + name);
  }
  return value;
}

function optionalSecret(name) {
  return process.env[name] || null;
}

module.exports = { config: config, requireSecret: requireSecret, optionalSecret: optionalSecret };
