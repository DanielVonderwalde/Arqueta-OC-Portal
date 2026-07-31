'use strict';

/**
 * /v1/auth
 *
 * Es el unico lugar del sistema donde se comparan contrasenas. El navegador
 * nunca vuelve a ver un hash ni la lista de usuarios.
 */

const express = require('express');
const { z } = require('zod');

const { config, optionalSecret } = require('../config');
const { errors } = require('../lib/errors');
const { logger } = require('../lib/logger');
const db = require('../lib/db');
const cred = require('../lib/credentials');
const { validate, rateLimit, resetRateLimit } = require('../middleware/security');
const { authenticate, ROLES } = require('../middleware/auth');

const router = express.Router();

const loginSchema = z.object({
  user: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256)
}).strict();

const clientLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(1).max(256)
}).strict();

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(4096) }).strict();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(config.passwords.minLength).max(256)
}).strict();

function publicIdentity(subject) {
  return {
    id: subject.sub,
    role: subject.role,
    label: subject.label || null,
    client_id: subject.client_id || null
  };
}

async function findByChild(path, field, value) {
  const snap = await db.ref(path).orderByChild(field).equalTo(value).limitToFirst(1).once('value');
  const val = snap.val();
  if (!val) return null;
  const key = Object.keys(val)[0];
  return Object.assign({ id: key }, val[key]);
}

async function upgradeHash(path, id, plain) {
  const passwordHash = await cred.hashPassword(plain);
  await db.child(path, id).update({ passwordHash: passwordHash, algo: 'bcrypt', legacyHash: null, upgradedAt: db.now() });
}

/* ---------------------------------------------------------------
 * POST /v1/auth/login  (admin / asociado)
 * --------------------------------------------------------------- */
router.post(
  '/login',
  rateLimit('login', function (req) { return req.clientIp + ':' + String((req.body || {}).user || ''); }),
  validate({ body: loginSchema }),
  async function (req, res, next) {
    const log = logger.forRequest(req);
    try {
      const userName = req.valid.body.user.toLowerCase();
      const password = req.valid.body.password;

      const record = await findByChild(db.PATHS.credUsers, 'user', userName);
      const check = await cred.verifyPassword(record, password, cred.legacyInternalHash(userName, password));

      if (!record || !check.ok || record.active === false) {
        log.warn('auth.login_failed', { user: userName });
        await db.writeAudit({ actor: userName, action: 'auth.login_failed', ip: req.clientIp, requestId: req.requestId });
        /* Mensaje identico para usuario inexistente y contrasena mala: no se
           regala informacion sobre que cuentas existen. */
        throw errors.unauthorized('Usuario o contrasena incorrectos.');
      }

      if (check.needsUpgrade) await upgradeHash(db.PATHS.credUsers, record.id, password);

      const subject = {
        sub: record.id,
        role: record.role,
        label: record.label || record.user,
        clients: Array.isArray(record.clients) ? record.clients.map(String) : null
      };
      const tokens = cred.issueTokens(subject);
      await cred.openSession(tokens.jti, subject, { ip: req.clientIp, userAgent: req.headers['user-agent'] });
      await resetRateLimit(req.rateLimitKey);
      await db.writeAudit({ actor: record.id, actorRole: record.role, action: 'auth.login', ip: req.clientIp, requestId: req.requestId });

      log.info('auth.login_ok', { actor: record.id, role: record.role, upgraded: check.needsUpgrade });
      res.json({ data: { identity: publicIdentity(subject), tokens: tokens } });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------------------------------------------------------------
 * POST /v1/auth/client-login  (portal de clientes)
 * --------------------------------------------------------------- */
router.post(
  '/client-login',
  rateLimit('login', function (req) { return req.clientIp + ':' + String((req.body || {}).email || ''); }),
  validate({ body: clientLoginSchema }),
  async function (req, res, next) {
    const log = logger.forRequest(req);
    try {
      const email = req.valid.body.email;
      const password = req.valid.body.password;

      const record = await findByChild(db.PATHS.credClients, 'email_lower', email);
      const check = await cred.verifyPassword(record, password, cred.legacyClientHash(password));

      if (!record || !check.ok || record.active === false) {
        log.warn('auth.client_login_failed', {});
        throw errors.unauthorized('Correo o contrasena incorrectos.');
      }

      const client = await db.getById(db.PATHS.clients, record.id);
      if (!client || client.portal_active === false) {
        throw errors.forbidden('El acceso al portal esta desactivado para esta empresa.');
      }

      if (check.needsUpgrade) await upgradeHash(db.PATHS.credClients, record.id, password);

      const subject = { sub: 'cliente:' + record.id, role: ROLES.CLIENTE, label: client.name || null, client_id: record.id };
      const tokens = cred.issueTokens(subject);
      await cred.openSession(tokens.jti, subject, { ip: req.clientIp, userAgent: req.headers['user-agent'] });
      await resetRateLimit(req.rateLimitKey);
      await db.writeAudit({ actor: subject.sub, actorRole: subject.role, action: 'auth.client_login', ip: req.clientIp, requestId: req.requestId });

      log.info('auth.client_login_ok', { client_id: record.id, upgraded: check.needsUpgrade });
      res.json({ data: { identity: publicIdentity(subject), tokens: tokens } });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------------------------------------------------------------
 * POST /v1/auth/refresh
 * --------------------------------------------------------------- */
router.post('/refresh', validate({ body: refreshSchema }), async function (req, res, next) {
  try {
    const payload = cred.verifyToken(req.valid.body.refreshToken, 'refresh');
    const session = await cred.assertSessionActive(payload.jti);

    /* Rotacion: el refresh usado se revoca y se emite uno nuevo. Si alguien
       reutiliza un refresh viejo, falla y queda en la bitacora. */
    await cred.revokeSession(payload.jti);

    const subject = { sub: session.sub, role: session.role, client_id: session.client_id || null };
    const tokens = cred.issueTokens(subject);
    await cred.openSession(tokens.jti, subject, { ip: req.clientIp, userAgent: req.headers['user-agent'] });

    res.json({ data: { identity: publicIdentity(subject), tokens: tokens } });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------
 * POST /v1/auth/logout
 * --------------------------------------------------------------- */
router.post('/logout', authenticate, async function (req, res, next) {
  try {
    await cred.revokeSession(req.auth.jti);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'auth.logout', ip: req.clientIp, requestId: req.requestId });
    res.json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------
 * GET /v1/auth/me
 * --------------------------------------------------------------- */
router.get('/me', authenticate, function (req, res) {
  res.json({ data: { identity: publicIdentity(req.auth) } });
});

/* ---------------------------------------------------------------
 * POST /v1/auth/change-password
 * --------------------------------------------------------------- */
router.post('/change-password', authenticate, rateLimit('write'), validate({ body: changePasswordSchema }), async function (req, res, next) {
  try {
    const isClient = req.auth.role === ROLES.CLIENTE;
    const path = isClient ? db.PATHS.credClients : db.PATHS.credUsers;
    const id = isClient ? req.auth.client_id : req.auth.sub;

    const record = await db.getById(path, id);
    const legacy = isClient
      ? cred.legacyClientHash(req.valid.body.currentPassword)
      : cred.legacyInternalHash(record && record.user, req.valid.body.currentPassword);

    const check = await cred.verifyPassword(record, req.valid.body.currentPassword, legacy);
    if (!check.ok) throw errors.unauthorized('La contrasena actual no es correcta.');

    const passwordHash = await cred.hashPassword(req.valid.body.newPassword);
    await db.child(path, id).update({ passwordHash: passwordHash, algo: 'bcrypt', legacyHash: null, updatedAt: db.now() });

    /* Cambiar la contrasena cierra las demas sesiones. */
    await cred.revokeAllSessionsOf(req.auth.sub);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'auth.change_password', targetId: id, ip: req.clientIp, requestId: req.requestId });

    res.json({ data: { ok: true, message: 'Contrasena actualizada. Vuelve a iniciar sesion.' } });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------
 * POST /v1/auth/bootstrap
 *
 * Migracion inicial: copia las credenciales que hoy viven en el HTML hacia
 * private/credentials. Se protege con un token de un solo uso y se bloquea
 * sola despues de correr una vez.
 * --------------------------------------------------------------- */
router.post('/bootstrap', rateLimit('login', function (req) { return req.clientIp + ':bootstrap'; }), async function (req, res, next) {
  try {
    const expected = optionalSecret('BOOTSTRAP_TOKEN');
    const provided = req.headers['x-bootstrap-token'];
    if (!expected || !provided || !cred.safeEqual(expected, provided)) throw errors.forbidden('Token de bootstrap invalido.');

    const flag = await db.child(db.PATHS.meta, 'bootstrappedAt').once('value');
    if (flag.val()) throw errors.conflict('El bootstrap ya se ejecuto el ' + flag.val() + '.');

    const body = req.body || {};
    const users = Array.isArray(body.users) ? body.users : [];
    const clients = Array.isArray(body.clients) ? body.clients : [];
    const updates = {};

    users.forEach(function (u) {
      const id = String(u.user || '').trim().toLowerCase();
      if (!id) return;
      updates[db.PATHS.credUsers + '/' + id] = {
        user: id,
        role: u.role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.ASOCIADO,
        label: u.label || id,
        legacyHash: u.passHash || null,
        passwordHash: null,
        algo: 'sha256-legacy',
        clients: Array.isArray(u.clients) ? u.clients.map(String) : null,
        active: true,
        createdAt: db.now()
      };
    });

    clients.forEach(function (c) {
      const id = String(c.id || '').trim();
      if (!id) return;
      updates[db.PATHS.credClients + '/' + id] = {
        email_lower: String(c.portal_email || '').trim().toLowerCase(),
        legacyHash: c.portal_password_hash || null,
        passwordHash: null,
        algo: 'sha256-legacy',
        active: c.portal_active !== false,
        createdAt: db.now()
      };
    });

    updates[db.PATHS.meta + '/bootstrappedAt'] = db.now();
    await db.ref('/').update(updates);
    await db.writeAudit({ actor: 'bootstrap', action: 'auth.bootstrap', ip: req.clientIp, requestId: req.requestId, meta: { users: users.length, clients: clients.length } });

    res.json({ data: { ok: true, users: users.length, clients: clients.length } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
