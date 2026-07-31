'use strict';

/**
 * /v1/users  -  gestion de usuarios de la plataforma (solo admin)
 *
 * Es el backend del punto 4 del plan: createUser, updateUserRole,
 * deactivateUser, listUsers. El rol se valida AQUI, no solo en la pantalla:
 * aunque alguien manipule el frontend, sin un token de admin no pasa.
 *
 * No existe borrado de usuarios. Se desactivan, para no perder el rastro de
 * quien hizo que en la bitacora.
 */

const express = require('express');
const { z } = require('zod');

const { config } = require('../config');
const { errors } = require('../lib/errors');
const db = require('../lib/db');
const cred = require('../lib/credentials');
const { validate, rateLimit } = require('../middleware/security');
const { authenticate, requireAdmin, ROLES } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

/* Nunca sale un hash de aqui. */
function toPublic(row) {
  return {
    id: row.id,
    user: row.user,
    label: row.label || row.user,
    role: row.role,
    clients: row.clients || null,
    activo: row.activo !== false && row.active !== false,
    needsPasswordUpgrade: row.algo !== 'bcrypt',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    deactivatedAt: row.deactivatedAt || null
  };
}

const createSchema = z.object({
  user: z.string().trim().toLowerCase().min(3).max(40).regex(/^[a-z0-9._-]+$/, 'Solo letras, numeros, punto, guion y guion bajo.'),
  label: z.string().trim().min(2).max(80),
  role: z.enum([ROLES.ADMIN, ROLES.ASOCIADO]),
  password: z.string().min(config.passwords.minLength).max(256),
  clients: z.array(z.string().max(80)).max(200).optional()
}).strict();

const updateSchema = z.object({
  label: z.string().trim().min(2).max(80).optional(),
  role: z.enum([ROLES.ADMIN, ROLES.ASOCIADO]).optional(),
  clients: z.array(z.string().max(80)).max(200).nullable().optional()
}).strict();

const resetSchema = z.object({ password: z.string().min(config.passwords.minLength).max(256) }).strict();

async function countActiveAdmins() {
  const snap = await db.ref(db.PATHS.credUsers).orderByChild('role').equalTo(ROLES.ADMIN).once('value');
  return db.asList(snap.val()).filter(function (u) { return (u.activo !== false && u.active !== false); }).length;
}

/* GET /v1/users */
router.get('/', rateLimit('read'), async function (req, res, next) {
  try {
    const snap = await db.ref(db.PATHS.credUsers).once('value');
    const rows = db.asList(snap.val()).map(toPublic).sort(function (a, b) { return a.user.localeCompare(b.user); });
    res.json({ data: rows, page: { limit: rows.length, nextCursor: null, hasMore: false } });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/users */
router.post('/', rateLimit('write'), validate({ body: createSchema }), async function (req, res, next) {
  try {
    const body = req.valid.body;
    const existing = await db.getById(db.PATHS.credUsers, body.user);
    if (existing) throw errors.conflict('Ya existe un usuario con ese nombre.');

    const record = {
      user: body.user,
      label: body.label,
      role: body.role,
      clients: body.clients && body.clients.length ? body.clients.map(String) : null,
      passwordHash: await cred.hashPassword(body.password),
      algo: 'bcrypt',
      legacyHash: null,
      activo: true,
      createdAt: db.now(),
      createdBy: req.auth.sub
    };
    await db.put(db.PATHS.credUsers, body.user, record);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'user.create', target: 'user', targetId: body.user, ip: req.clientIp, requestId: req.requestId, meta: { role: body.role } });

    res.status(201).json({ data: toPublic(Object.assign({ id: body.user }, record)) });
  } catch (err) {
    next(err);
  }
});

/* PATCH /v1/users/:id  (rol, etiqueta, clientes asignados) */
router.patch('/:id', rateLimit('write'), validate({ body: updateSchema }), async function (req, res, next) {
  try {
    const id = String(req.params.id).toLowerCase();
    const existing = await db.getById(db.PATHS.credUsers, id);
    if (!existing) throw errors.notFound('El usuario');

    const body = req.valid.body;

    /* No permitir quedarse sin ningun admin activo. */
    if (body.role && body.role !== ROLES.ADMIN && existing.role === ROLES.ADMIN && (existing.activo !== false && existing.active !== false)) {
      const admins = await countActiveAdmins();
      if (admins <= 1) throw errors.conflict('No puedes quitar el ultimo administrador activo.');
    }

    const patch = Object.assign({}, body, { updatedAt: db.now(), updatedBy: req.auth.sub });
    const row = await db.patch(db.PATHS.credUsers, id, patch);

    /* Cambiar el rol invalida las sesiones abiertas: el token viejo todavia
       lleva el rol anterior. */
    if (body.role && body.role !== existing.role) await cred.revokeAllSessionsOf(id);

    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'user.update', target: 'user', targetId: id, ip: req.clientIp, requestId: req.requestId, meta: { fields: Object.keys(body), from: existing.role, to: body.role || existing.role } });
    res.json({ data: toPublic(row) });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/users/:id/deactivate */
router.post('/:id/deactivate', rateLimit('write'), async function (req, res, next) {
  try {
    const id = String(req.params.id).toLowerCase();
    const existing = await db.getById(db.PATHS.credUsers, id);
    if (!existing) throw errors.notFound('El usuario');
    if (id === String(req.auth.sub).toLowerCase()) throw errors.conflict('No puedes desactivar tu propio usuario.');

    if (existing.role === ROLES.ADMIN && (existing.activo !== false && existing.active !== false)) {
      const admins = await countActiveAdmins();
      if (admins <= 1) throw errors.conflict('No puedes desactivar al ultimo administrador activo.');
    }

    await db.child(db.PATHS.credUsers, id).update({ activo: false, deactivatedAt: db.now(), deactivatedBy: req.auth.sub });
    const closed = await cred.revokeAllSessionsOf(id);

    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'user.deactivate', target: 'user', targetId: id, ip: req.clientIp, requestId: req.requestId, meta: { sessionsClosed: closed } });
    res.json({ data: { ok: true, sessionsClosed: closed } });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/users/:id/reactivate */
router.post('/:id/reactivate', rateLimit('write'), async function (req, res, next) {
  try {
    const id = String(req.params.id).toLowerCase();
    const existing = await db.getById(db.PATHS.credUsers, id);
    if (!existing) throw errors.notFound('El usuario');
    await db.child(db.PATHS.credUsers, id).update({ activo: true, reactivatedAt: db.now(), reactivatedBy: req.auth.sub });
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'user.reactivate', target: 'user', targetId: id, ip: req.clientIp, requestId: req.requestId });
    res.json({ data: { ok: true } });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/users/:id/reset-password */
router.post('/:id/reset-password', rateLimit('write'), validate({ body: resetSchema }), async function (req, res, next) {
  try {
    const id = String(req.params.id).toLowerCase();
    const existing = await db.getById(db.PATHS.credUsers, id);
    if (!existing) throw errors.notFound('El usuario');

    await db.child(db.PATHS.credUsers, id).update({
      passwordHash: await cred.hashPassword(req.valid.body.password),
      algo: 'bcrypt',
      legacyHash: null,
      updatedAt: db.now(),
      updatedBy: req.auth.sub
    });
    const closed = await cred.revokeAllSessionsOf(id);

    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'user.reset_password', target: 'user', targetId: id, ip: req.clientIp, requestId: req.requestId, meta: { sessionsClosed: closed } });
    res.json({ data: { ok: true, sessionsClosed: closed } });
  } catch (err) {
    next(err);
  }
});

/* GET /v1/users/audit-log?limit=100 */
router.get('/audit-log', rateLimit('read'), async function (req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const snap = await db.ref(db.PATHS.audit).limitToLast(limit).once('value');
    const rows = db.asList(snap.val()).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    res.json({ data: rows, page: { limit: limit, nextCursor: null, hasMore: rows.length === limit } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
