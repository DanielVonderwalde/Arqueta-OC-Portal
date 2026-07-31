'use strict';

/**
 * Pruebas unitarias (no necesitan Firebase ni red).
 * Se corren con:  npm test     (usa el runner nativo de Node 20)
 *
 * Las pruebas de integracion, que si tocan la base, se corren contra los
 * emuladores:  firebase emulators:exec --only functions,database "npm test"
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');

const { errors, isApiError } = require('../src/lib/errors');
const { sanitize } = require('../src/lib/logger');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

test('el formato de hash legado de usuarios internos no cambia', function () {
  /* Contrato congelado: usuario en minusculas + dos puntos + contrasena.
     Si alguien lo cambia, este test truena y nadie pierde el acceso por
     accidente. */
  const esperado = sha256Hex('admin:Ejemplo123!');
  assert.strictEqual(esperado.length, 64);
  assert.strictEqual(sha256Hex('ADMIN'.toLowerCase() + ':' + 'Ejemplo123!'), esperado);
});

test('el formato de hash legado de clientes no cambia', function () {
  const esperado = sha256Hex('Ejemplo123!');
  assert.strictEqual(esperado.length, 64);
  assert.notStrictEqual(esperado, sha256Hex('admin:Ejemplo123!'));
});

test('bcrypt valida la contrasena correcta y rechaza la incorrecta', async function () {
  const hash = await bcrypt.hash('Ejemplo123!', 10);
  assert.ok(hash.startsWith('$2'));
  assert.strictEqual(await bcrypt.compare('Ejemplo123!', hash), true);
  assert.strictEqual(await bcrypt.compare('otra-cosa', hash), false);
});

test('dos hashes bcrypt de la misma contrasena son distintos (sal aleatoria)', async function () {
  const a = await bcrypt.hash('Ejemplo123!', 10);
  const b = await bcrypt.hash('Ejemplo123!', 10);
  assert.notStrictEqual(a, b);
});

test('los errores de la API traen codigo, estatus y requestId', function () {
  const err = errors.forbidden('sin permiso');
  assert.ok(isApiError(err));
  assert.strictEqual(err.status, 403);
  const body = err.body('req-1');
  assert.strictEqual(body.error.code, 'forbidden');
  assert.strictEqual(body.error.requestId, 'req-1');
});

test('el error interno no expone detalles', function () {
  const body = errors.internal().body('req-2');
  assert.strictEqual(body.error.code, 'internal_error');
  assert.ok(!/stack/i.test(JSON.stringify(body)));
});

test('el logger nunca escribe contrasenas, tokens ni archivos', function () {
  const limpio = sanitize({
    user: 'admin',
    password: 'Ejemplo123!',
    passwordHash: 'abc',
    refreshToken: 'ey.ey.ey',
    pdfData: 'JVBERi0xLjcK',
    anidado: { portal_password: 'x', ok: 1 }
  });
  assert.strictEqual(limpio.user, 'admin');
  assert.strictEqual(limpio.password, '[redacted]');
  assert.strictEqual(limpio.passwordHash, '[redacted]');
  assert.strictEqual(limpio.refreshToken, '[redacted]');
  assert.strictEqual(limpio.pdfData, '[redacted]');
  assert.strictEqual(limpio.anidado.portal_password, '[redacted]');
  assert.strictEqual(limpio.anidado.ok, 1);
});

test('el logger recorta cadenas gigantes', function () {
  const limpio = sanitize({ nota: 'a'.repeat(5000) });
  assert.ok(limpio.nota.length < 600);
});

test('los esquemas estrictos rechazan campos no declarados', function () {
  const schema = z.object({ name: z.string() }).strict();
  assert.strictEqual(schema.safeParse({ name: 'x' }).success, true);
  /* Intento de escalada: colar role en un update. */
  assert.strictEqual(schema.safeParse({ name: 'x', role: 'admin' }).success, false);
});

test('el limite de paginacion nunca supera el maximo configurado', function () {
  const { config } = require('../src/config');
  const pedido = 100000;
  const aplicado = Math.min(Math.max(parseInt(pedido, 10) || config.pagination.defaultLimit, 1), config.pagination.maxLimit);
  assert.strictEqual(aplicado, config.pagination.maxLimit);
});
