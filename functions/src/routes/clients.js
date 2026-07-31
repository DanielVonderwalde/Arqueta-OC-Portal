'use strict';

/**
 * /v1/clients
 *
 * Reglas de exposicion:
 *  - Nunca sale portal_password ni portal_password_hash. Las credenciales
 *    viven en private/credentials/clients y no se devuelven jamas.
 *  - Un cliente solo puede leerse a si mismo.
 *  - No hay borrado: se desactiva (portal_active = false) para conservar el
 *    historial de cotizaciones y ordenes.
 */

const express = require('express');
const { z } = require('zod');

const { errors } = require('../lib/errors');
const db = require('../lib/db');
const cred = require('../lib/credentials');
const { validate, rateLimit } = require('../middleware/security');
const { authenticate, requireAdmin, requireInternal, resolveClientScope, rowVisibleFor } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const PUBLIC_FIELDS = ['id', 'name', 'portal_email', 'portal_active', 'notes'];

function toPublic(row) {
  const out = {};
  PUBLIC_FIELDS.forEach(function (f) { if (row[f] !== undefined) out[f] = row[f]; });
  return out;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(120).optional(),
  active: z.enum(['true', 'false']).optional()
}).strict();

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  notes: z.string().max(2000).optional(),
  portal_email: z.string().trim().toLowerCase().email().max(160).optional(),
  portal_active: z.boolean().optional()
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  notes: z.string().max(2000).optional(),
  portal_active: z.boolean().optional()
}).strict();

const portalAccessSchema = z.object({
  portal_email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(10).max(256).optional(),
  active: z.boolean().optional()
}).strict();

/* GET /v1/clients */
router.get('/', rateLimit('read'), validate({ query: listQuery }), async function (req, res, next) {
  try {
    const q = req.valid.query || {};
    const scope = resolveClientScope(req, null);
    const visible = rowVisibleFor(req);

    const result = await db.listPage({
      path: db.PATHS.clients,
      limit: q.limit,
      cursor: q.cursor,
      sortBy: 'name',
      where: function (row) {
        if (scope && String(row.id) !== String(scope)) return false;
        if (q.active === 'true' && row.portal_active !== true) return false;
        if (q.active === 'false' && row.portal_active === true) return false;
        return visible(row);
      },
      map: toPublic
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* GET /v1/clients/:id */
router.get('/:id', rateLimit('read'), async function (req, res, next) {
  try {
    const id = resolveClientScope(req, req.params.id);
    const row = await db.getById(db.PATHS.clients, id || req.params.id);
    if (!row) throw errors.notFound('El cliente');
    res.json({ data: toPublic(row) });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/clients */
router.post('/', requireAdmin, rateLimit('write'), validate({ body: createSchema }), async function (req, res, next) {
  try {
    const body = req.valid.body;
    const id = db.newId('c');
    const row = {
      id: id,
      name: body.name,
      notes: body.notes || '',
      portal_email: body.portal_email || '',
      portal_active: body.portal_active === true,
      createdAt: db.now(),
      createdBy: req.auth.sub
    };
    await db.put(db.PATHS.clients, id, row);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client.create', target: 'client', targetId: id, ip: req.clientIp, requestId: req.requestId });
    res.status(201).json({ data: toPublic(row) });
  } catch (err) {
    next(err);
  }
});

/* PATCH /v1/clients/:id */
router.patch('/:id', requireInternal, rateLimit('write'), validate({ body: updateSchema }), async function (req, res, next) {
  try {
    const id = req.params.id;
    resolveClientScope(req, id);
    const existing = await db.getById(db.PATHS.clients, id);
    if (!existing) throw errors.notFound('El cliente');

    const patch = Object.assign({}, req.valid.body, { updatedAt: db.now(), updatedBy: req.auth.sub });
    const row = await db.patch(db.PATHS.clients, id, patch);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client.update', target: 'client', targetId: id, ip: req.clientIp, requestId: req.requestId, meta: { fields: Object.keys(req.valid.body) } });
    res.json({ data: toPublic(row) });
  } catch (err) {
    next(err);
  }
});

/* PUT /v1/clients/:id/portal-access
 * Alta o cambio de acceso al portal. La contrasena llega en claro por HTTPS,
 * se convierte a bcrypt aqui y no se guarda en ningun otro lado. */
router.put('/:id/portal-access', requireAdmin, rateLimit('write'), validate({ body: portalAccessSchema }), async function (req, res, next) {
  try {
    const id = req.params.id;
    const client = await db.getById(db.PATHS.clients, id);
    if (!client) throw errors.notFound('El cliente');

    const body = req.valid.body;
    const duplicate = await db.ref(db.PATHS.credClients).orderByChild('email_lower').equalTo(body.portal_email).once('value');
    const dupVal = duplicate.val() || {};
    const dupKey = Object.keys(dupVal)[0];
    if (dupKey && dupKey !== id) throw errors.conflict('Ese correo ya esta asignado a otra empresa.');

    const update = { email_lower: body.portal_email, active: body.active !== false, updatedAt: db.now(), updatedBy: req.auth.sub };
    if (body.password) {
      update.passwordHash = await cred.hashPassword(body.password);
      update.algo = 'bcrypt';
      update.legacyHash = null;
    }
    await db.child(db.PATHS.credClients, id).update(update);
    await (await db.refOf(db.PATHS.clients, id)).update({ portal_email: body.portal_email, portal_active: body.active !== false });

    if (body.password) await cred.revokeAllSessionsOf('cliente:' + id);

    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client.portal_access', target: 'client', targetId: id, ip: req.clientIp, requestId: req.requestId, meta: { passwordChanged: Boolean(body.password) } });
    res.json({ data: { ok: true, portal_email: body.portal_email, portal_active: body.active !== false } });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/clients/:id/deactivate  (no se borra nunca) */
router.post('/:id/deactivate', requireAdmin, rateLimit('write'), async function (req, res, next) {
  try {
    const id = req.params.id;
    const client = await db.getById(db.PATHS.clients, id);
    if (!client) throw errors.notFound('El cliente');

    /* activo:false es la marca que leen los dos portales; portal_active corta ademas el acceso. */
    const marca = { activo: false, portal_active: false, deactivatedAt: db.now(), deactivatedBy: req.auth.sub };
    await (await db.refOf(db.PATHS.clients, id)).update(marca);

    /* Se arrastra a lo que cuelga del cliente, para no dejar referencias colgando. */
    const snapQuotes = await db.ref(db.PATHS.quotes).orderByChild('client_id').equalTo(id).once('value');
    const quotes = snapQuotes.val() || {};
    const cambiosQuotes = {};
    const cambiosCostos = {};
    for (const clave of Object.keys(quotes)) {
      cambiosQuotes[clave + '/activo'] = false;
      cambiosQuotes[clave + '/deactivatedAt'] = marca.deactivatedAt;
      cambiosQuotes[clave + '/deactivatedBy'] = marca.deactivatedBy;
      const snapCostos = await db.ref(db.PATHS.costBreakdown).orderByChild('quote_id').equalTo(quotes[clave].id).once('value');
      for (const clvCosto of Object.keys(snapCostos.val() || {})) {
        cambiosCostos[clvCosto + '/activo'] = false;
      }
    }
    const snapOcs = await db.ref(db.PATHS.clientOCs).orderByChild('client_id').equalTo(id).once('value');
    const cambiosOcs = {};
    for (const clave of Object.keys(snapOcs.val() || {})) {
      cambiosOcs[clave + '/activo'] = false;
      cambiosOcs[clave + '/deactivatedAt'] = marca.deactivatedAt;
      cambiosOcs[clave + '/deactivatedBy'] = marca.deactivatedBy;
    }
    if (Object.keys(cambiosQuotes).length) await db.ref(db.PATHS.quotes).update(cambiosQuotes);
    if (Object.keys(cambiosCostos).length) await db.ref(db.PATHS.costBreakdown).update(cambiosCostos);
    if (Object.keys(cambiosOcs).length) await db.ref(db.PATHS.clientOCs).update(cambiosOcs);
    await db.child(db.PATHS.credClients, id).update({ active: false });
    const closed = await cred.revokeAllSessionsOf('cliente:' + id);

    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client.deactivate', target: 'client', targetId: id, ip: req.clientIp, requestId: req.requestId, meta: { sessionsClosed: closed } });
    res.json({ data: { ok: true, sessionsClosed: closed } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
