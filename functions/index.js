'use strict';

/**
 * Arqueta-OC-Portal — Capa de API (Cloud Functions).
 *
 * Toda la aplicacion HTTP vive en src/app.js. Este archivo solo declara
 * las funciones desplegables, la region, los limites de recursos y los
 * secretos que necesita el runtime.
 *
 * Se expone UNA sola funcion HTTP (api) que enruta internamente con Express.
 * Ventajas frente a una funcion por endpoint:
 *  - un solo cold start compartido,
 *  - middlewares comunes (auth, rate limit, logging) en un solo lugar,
 *  - versionado por prefijo de ruta (/v1/...) sin redesplegar todo.
 */

const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

/* Secretos: se guardan en Secret Manager, NUNCA en el codigo ni en git.
   Se cargan con:
     firebase functions:secrets:set JWT_SECRET
     firebase functions:secrets:set BOOTSTRAP_TOKEN
*/
const JWT_SECRET = defineSecret('JWT_SECRET');
const BOOTSTRAP_TOKEN = defineSecret('BOOTSTRAP_TOKEN');

setGlobalOptions({
  region: 'us-central1',
  memory: '256MiB',
  timeoutSeconds: 60,
  maxInstances: 10,
  concurrency: 20
});

const createApp = require('./src/app');

exports.api = onRequest(
  { secrets: [JWT_SECRET, BOOTSTRAP_TOKEN], cors: false },
  createApp()
);
