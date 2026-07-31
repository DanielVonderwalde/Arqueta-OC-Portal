'use strict';

/**
 * Contrasenas y sesiones.
 *
 * Contrasenas
 * -----------
 * Almacenamiento definitivo: bcrypt (coste 12). SHA-256 sin sal, que es lo
 * que hoy tiene el HTML, es demasiado rapido de romper offline.
 *
 * Migracion sin romper a nadie: si el registro todavia trae un hash legado
 * SHA-256, se valida contra el y, si es correcto, se reescribe en bcrypt en
 * el mismo login. El usuario no se entera y nadie pierde el acceso.
 *
 * Formatos legados que hay que seguir aceptando (vienen del HTML actual):
 *   internos: sha256(usuario_en_minusculas + ":" + contrasena)
 *   clientes: sha256(contrasena)
 *
 * Sesiones
 * --------
 * JWT HS256 firmado con JWT_SECRET (Secret Manager). El access token dura
 * poco; el refresh token queda registrado en la base con su jti para poder
 * revocarlo (logout, desactivacion de usuario, robo de token).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { config, requireSecret } = require('../config');
const { errors } = require('./errors');
const db = require('./db');

/* ---------- hashes ---------- */

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function legacyInternalHash(user, password) {
  return sha256Hex(String(user || '').trim().toLowerCase() + ':' + String(password || ''));
}

function legacyClientHash(password) {
  return sha256Hex(String(password || ''));
}

/** Comparacion en tiempo constante para evitar timing attacks. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function hashPassword(plain) {
  if (String(plain || '').length < config.passwords.minLength) {
    throw errors.validation({ password: 'Debe tener al menos ' + config.passwords.minLength + ' caracteres.' });
  }
  return bcrypt.hash(String(plain), config.passwords.bcryptRounds);
}

/**
 * Verifica una contrasena contra un registro de credenciales.
 * record: { passwordHash, algo, legacyHash }
 * legacyHashOfInput: hash SHA-256 calculado con el formato legado que aplique.
 * Devuelve { ok, needsUpgrade }.
 */
async function verifyPassword(record, plain, legacyHashOfInput) {
  if (!record || !plain) return { ok: false, needsUpgrade: false };

  if (record.algo === 'bcrypt' && record.passwordHash) {
    const ok = await bcrypt.compare(String(plain), record.passwordHash);
    return { ok: ok, needsUpgrade: false };
  }

  const legacy = record.legacyHash || record.passwordHash;
  if (legacy && legacyHashOfInput && safeEqual(legacy, legacyHashOfInput)) {
    return { ok: true, needsUpgrade: true };
  }

  /* Coste artificial para que un usuario inexistente tarde lo mismo que uno
     existente y no se pueda enumerar cuentas por tiempo de respuesta. */
  await bcrypt.compare(String(plain), '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvaliduC');
  return { ok: false, needsUpgrade: false };
}

/* ---------- tokens ---------- */

function secret() {
  return requireSecret('JWT_SECRET');
}

function issueTokens(subject) {
  const jti = crypto.randomUUID();
  const base = {
    sub: subject.sub,
    role: subject.role,
    label: subject.label || null,
    client_id: subject.client_id || null,
    clients: subject.clients || null
  };

  const accessToken = jwt.sign(Object.assign({ typ: 'access', jti: jti }, base), secret(), {
    algorithm: 'HS256',
    issuer: config.tokens.issuer,
    expiresIn: config.tokens.accessMinutes * 60
  });

  const refreshToken = jwt.sign({ typ: 'refresh', jti: jti, sub: subject.sub, role: subject.role }, secret(), {
    algorithm: 'HS256',
    issuer: config.tokens.issuer,
    expiresIn: config.tokens.refreshHours * 3600
  });

  return {
    jti: jti,
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresIn: config.tokens.accessMinutes * 60,
    tokenType: 'Bearer'
  };
}

function verifyToken(token, expectedTyp) {
  let payload;
  try {
    payload = jwt.verify(String(token || ''), secret(), {
      algorithms: ['HS256'],
      issuer: config.tokens.issuer,
      clockTolerance: config.tokens.clockToleranceSec
    });
  } catch (e) {
    throw errors.unauthorized(e.name === 'TokenExpiredError' ? 'La sesion expiro. Vuelve a iniciar sesion.' : 'Token invalido.');
  }
  if (expectedTyp && payload.typ !== expectedTyp) throw errors.unauthorized('Token invalido.');
  return payload;
}

/* ---------- sesiones (revocables) ---------- */

async function openSession(jti, subject, meta) {
  const expiresAt = Date.now() + config.tokens.refreshHours * 3600 * 1000;
  await db.child(db.PATHS.sessions, jti).set({
    sub: subject.sub,
    role: subject.role,
    client_id: subject.client_id || null,
    createdAt: db.now(),
    expiresAt: expiresAt,
    ip: (meta && meta.ip) || null,
    userAgent: (meta && meta.userAgent) || null,
    revokedAt: null
  });
}

async function assertSessionActive(jti) {
  const snap = await db.child(db.PATHS.sessions, jti).once('value');
  const s = snap.val();
  if (!s) throw errors.unauthorized('La sesion ya no existe.');
  if (s.revokedAt) throw errors.unauthorized('La sesion fue cerrada.');
  if (s.expiresAt && Date.now() > s.expiresAt) throw errors.unauthorized('La sesion expiro.');
  return s;
}

async function revokeSession(jti) {
  await db.child(db.PATHS.sessions, jti).update({ revokedAt: db.now() });
}

async function revokeAllSessionsOf(sub) {
  const snap = await db.ref(db.PATHS.sessions).orderByChild('sub').equalTo(sub).once('value');
  const updates = {};
  snap.forEach(function (row) {
    if (!row.val().revokedAt) updates[row.key + '/revokedAt'] = db.now();
  });
  if (Object.keys(updates).length) await db.ref(db.PATHS.sessions).update(updates);
  return Object.keys(updates).length;
}

module.exports = {
  sha256Hex: sha256Hex,
  legacyInternalHash: legacyInternalHash,
  legacyClientHash: legacyClientHash,
  safeEqual: safeEqual,
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  issueTokens: issueTokens,
  verifyToken: verifyToken,
  openSession: openSession,
  assertSessionActive: assertSessionActive,
  revokeSession: revokeSession,
  revokeAllSessionsOf: revokeAllSessionsOf
};
