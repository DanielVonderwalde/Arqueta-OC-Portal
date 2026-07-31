'use strict';

/**
 * /v1/documents
 *
 * Sustituye el esquema actual de guardar el PDF en base64 dentro de la base
 * de datos. Aqui la base solo guarda METADATA; el archivo vive en Storage.
 *
 * Flujo de subida (el archivo nunca pasa por la funcion, asi que no importa
 * si pesa 40 MB):
 *   1. POST /v1/documents        -> devuelve document_id + uploadUrl firmada
 *   2. el navegador hace PUT del archivo a uploadUrl
 *   3. POST /v1/documents/:id/confirm -> la API verifica el objeto y lo marca listo
 *
 * Descarga: GET /v1/documents/:id/download-url devuelve una URL firmada de
 * 15 minutos. No hay lectura publica del bucket.
 *
 * Borrado: nunca se elimina el objeto. Se marca deletedAt y deja de listarse.
 */

const express = require('express');
const { z } = require('zod');

const { config } = require('../config');
const { errors } = require('../lib/errors');
const db = require('../lib/db');
const { validate, rateLimit } = require('../middleware/security');
const { authenticate, requireInternal, resolveClientScope, rowVisibleFor } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function bucket() {
  return db.admin.storage().bucket();
}

function safeName(name) {
  return String(name || 'archivo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

const createSchema = z.object({
  file_name: z.string().trim().min(1).max(180),
  mime_type: z.string().trim().min(3).max(120),
  size_bytes: z.coerce.number().int().min(1),
  quote_id: z.string().max(80).optional(),
  client_oc_id: z.string().max(80).optional(),
  kind: z.enum(['cotizacion_pdf', 'cotizacion_excel', 'inserto_excel', 'orden_compra', 'factura', 'otro']).optional()
}).strict();

/** Resuelve a que cliente pertenece el documento y valida el permiso. */
async function resolveOwner(req, body) {
  if (body.quote_id) {
    const quote = await db.getById(db.PATHS.quotes, body.quote_id);
    if (!quote) throw errors.badRequest('La cotizacion indicada no existe.');
    resolveClientScope(req, quote.client_id);
    return { client_id: String(quote.client_id), quote_id: String(quote.id), client_oc_id: null };
  }
  if (body.client_oc_id) {
    const oc = await db.getById(db.PATHS.clientOCs, body.client_oc_id);
    if (!oc) throw errors.badRequest('La orden de compra indicada no existe.');
    resolveClientScope(req, oc.client_id);
    return { client_id: String(oc.client_id), quote_id: null, client_oc_id: String(oc.id) };
  }
  throw errors.badRequest('Indica quote_id o client_oc_id.');
}

/* POST /v1/documents  -> URL firmada de subida */
router.post('/', rateLimit('upload'), validate({ body: createSchema }), async function (req, res, next) {
  try {
    const body = req.valid.body;

    if (config.uploads.allowedMime.indexOf(body.mime_type) < 0) {
      throw errors.unsupportedMedia('Solo se aceptan PDF y hojas de calculo.');
    }
    if (body.size_bytes > config.uploads.maxBytes) {
      throw errors.payloadTooLarge('El limite es ' + Math.round(config.uploads.maxBytes / 1048576) + ' MB.');
    }

    const owner = await resolveOwner(req, body);
    const id = db.newId('doc');
    const storagePath = config.uploads.storagePrefix + '/' + owner.client_id + '/' + id + '-' + safeName(body.file_name);

    const file = bucket().file(storagePath);
    const signed = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + config.uploads.signedUrlMinutes * 60 * 1000,
      contentType: body.mime_type
    });

    const record = {
      id: id,
      client_id: owner.client_id,
      quote_id: owner.quote_id,
      client_oc_id: owner.client_oc_id,
      file_name: body.file_name,
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
      storage_path: storagePath,
      kind: body.kind || 'otro',
      status: 'pendiente',
      uploaded_by: req.auth.sub,
      created_at: db.now(),
      deletedAt: null
    };
    await db.put(db.PATHS.documents, id, record);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'document.create', target: 'document', targetId: id, ip: req.clientIp, requestId: req.requestId });

    res.status(201).json({
      data: {
        document: record,
        upload: { url: signed[0], method: 'PUT', headers: { 'Content-Type': body.mime_type }, expiresInSec: config.uploads.signedUrlMinutes * 60 }
      }
    });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/documents/:id/confirm */
router.post('/:id/confirm', rateLimit('upload'), async function (req, res, next) {
  try {
    const record = await db.getById(db.PATHS.documents, req.params.id);
    if (!record) throw errors.notFound('El documento');
    resolveClientScope(req, record.client_id);
    if (!rowVisibleFor(req)(record)) throw errors.forbidden('Ese documento no pertenece a tu cuenta.');

    const file = bucket().file(record.storage_path);
    const exists = await file.exists();
    if (!exists[0]) throw errors.badRequest('Todavia no se recibio el archivo en el almacenamiento.');

    const meta = await file.getMetadata();
    const realSize = Number(meta[0].size || 0);
    if (realSize > config.uploads.maxBytes) {
      await file.delete({ ignoreNotFound: true });
      throw errors.payloadTooLarge('El archivo recibido excede el limite permitido.');
    }

    const updated = await db.patch(db.PATHS.documents, record.id, {
      status: 'listo',
      size_bytes: realSize,
      confirmed_at: db.now()
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

/* GET /v1/documents/:id/download-url */
router.get('/:id/download-url', rateLimit('read'), async function (req, res, next) {
  try {
    const record = await db.getById(db.PATHS.documents, req.params.id);
    if (!record || record.deletedAt) throw errors.notFound('El documento');
    resolveClientScope(req, record.client_id);
    if (!rowVisibleFor(req)(record)) throw errors.forbidden('Ese documento no pertenece a tu cuenta.');

    const signed = await bucket().file(record.storage_path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + config.uploads.signedUrlMinutes * 60 * 1000,
      responseDisposition: 'attachment; filename="' + safeName(record.file_name) + '"'
    });

    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'document.download', target: 'document', targetId: record.id, ip: req.clientIp, requestId: req.requestId });
    res.json({ data: { url: signed[0], expiresInSec: config.uploads.signedUrlMinutes * 60, file_name: record.file_name, mime_type: record.mime_type } });
  } catch (err) {
    next(err);
  }
});

/* GET /v1/documents?quote_id=... */
router.get('/', rateLimit('read'), async function (req, res, next) {
  try {
    const quoteId = req.query.quote_id ? String(req.query.quote_id) : null;
    const ocId = req.query.client_oc_id ? String(req.query.client_oc_id) : null;
    if (!quoteId && !ocId) throw errors.badRequest('Indica quote_id o client_oc_id.');

    const result = await db.listPage({
      path: db.PATHS.documents,
      filterField: quoteId ? 'quote_id' : 'client_oc_id',
      filterValue: quoteId || ocId,
      limit: req.query.limit,
      cursor: req.query.cursor,
      sortBy: 'created_at',
      where: function (row) { return !row.deletedAt && rowVisibleFor(req)(row); }
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* DELETE /v1/documents/:id  (marca, no borra) */
router.delete('/:id', requireInternal, rateLimit('write'), async function (req, res, next) {
  try {
    const record = await db.getById(db.PATHS.documents, req.params.id);
    if (!record) throw errors.notFound('El documento');
    resolveClientScope(req, record.client_id);

    await db.patch(db.PATHS.documents, record.id, { deletedAt: db.now(), deletedBy: req.auth.sub });
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'document.soft_delete', target: 'document', targetId: record.id, ip: req.clientIp, requestId: req.requestId });
    res.json({ data: { ok: true, note: 'El archivo se conserva en el almacenamiento; solo deja de listarse.' } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
