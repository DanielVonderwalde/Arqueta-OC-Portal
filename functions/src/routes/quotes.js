'use strict';

/**
 * /v1/quotes
 *
 * Dos reglas que vienen directo de la auditoria:
 *
 * 1. El desglose de costos (costBreakdown) NO viaja dentro de la cotizacion.
 *    Vive en su propio nodo y solo lo sirve un endpoint aparte, exclusivo de
 *    admin. Asi un asociado o un cliente no pueden verlo ni por error ni
 *    inspeccionando la respuesta.
 *
 * 2. Los archivos (pdfData / excelData en base64) tampoco viajan aqui. La
 *    cotizacion solo trae la metadata de sus documentos; el contenido se pide
 *    a /v1/documents y se sirve con URL firmada de corta vida.
 */

const express = require('express');
const { z } = require('zod');

const { errors } = require('../lib/errors');
const db = require('../lib/db');
const { validate, rateLimit } = require('../middleware/security');
const { authenticate, requireAdmin, requireInternal, resolveClientScope, rowVisibleFor, canSeeCosts } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const HEAVY_FIELDS = ['pdfData', 'excelData', 'excelInsertoData'];
const COST_FIELDS = ['costBreakdown', 'costo', 'costos', 'margen'];

function toPublic(row, withCosts) {
  const out = {};
  Object.keys(row).forEach(function (k) {
    if (HEAVY_FIELDS.indexOf(k) >= 0) return;
    if (!withCosts && COST_FIELDS.indexOf(k) >= 0) return;
    out[k] = row[k];
  });
  out.has_pdf = Boolean(row.pdfName);
  out.has_excel = Boolean(row.excelName);
  return out;
}

const listQuery = z.object({
  client_id: z.string().max(80).optional(),
  status: z.string().max(40).optional(),
  search: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(120).optional()
}).strict();

const quoteSchema = z.object({
  client_id: z.string().min(1).max(80),
  quote_number: z.string().trim().min(1).max(60),
  product_name: z.string().trim().max(160).optional(),
  reference: z.string().trim().max(160).optional(),
  date: z.string().max(20).optional(),
  status: z.string().max(40).optional(),
  version: z.coerce.number().int().min(1).optional(),
  descuento: z.coerce.number().min(0).max(100).optional(),
  has_inserto: z.boolean().optional(),
  sustrato: z.string().max(120).optional(),
  calibre: z.string().max(60).optional(),
  gramaje: z.string().max(60).optional(),
  tintas: z.string().max(120).optional(),
  barniz: z.string().max(120).optional(),
  acabado_spec: z.string().max(240).optional(),
  realces: z.string().max(240).optional(),
  entrega: z.string().max(120).optional(),
  lugar_entrega: z.string().max(160).optional()
}).strict();

/* El desglose de costos NO es una lista de conceptos sueltos: es un renglon
   por volumen (quantity_tier) con el desglose de insumos y el precio de venta.
   Asi lo captura el panel interno y asi vive ya en arqueta_db/costBreakdown.
   El esquema anterior ({ concepto, unidad, cantidad, costo_unitario }) no
   correspondia a ningun campo real de la aplicacion. */
const numeroOpc = z.coerce.number().nullable().optional();

const tierSchema = z.object({
  quantity_tier: z.coerce.number().min(1),
  sustrato: numeroOpc,
  acabado: numeroOpc,
  materiales: numeroOpc,
  mod: numeroOpc,
  ee: numeroOpc,
  extras: numeroOpc,
  transporte: numeroOpc,
  valor_venta_total: numeroOpc,
  margen: numeroOpc,
  blended: z.boolean().optional(),
  real: numeroOpc
}).strict();

const costSchema = z.object({
  tiers: z.array(tierSchema).max(50)
}).strict();

/* GET /v1/quotes */
router.get('/', rateLimit('read'), validate({ query: listQuery }), async function (req, res, next) {
  try {
    const q = req.valid.query || {};
    const scope = resolveClientScope(req, q.client_id || null);
    const visible = rowVisibleFor(req);
    const withCosts = canSeeCosts(req);
    const search = (q.search || '').toLowerCase();

    const result = await db.listPage({
      path: db.PATHS.quotes,
      /* Si hay cliente definido se usa el indice .indexOn de client_id: la
         base solo devuelve ese subconjunto, no la tabla completa. */
      filterField: scope ? 'client_id' : null,
      filterValue: scope || null,
      limit: q.limit,
      cursor: q.cursor,
      sortBy: 'date',
      sortDesc: true,
      where: function (row) {
        if (!visible(row)) return false;
        if (q.status && String(row.status) !== q.status) return false;
        if (search) {
          const hay = (String(row.quote_number || '') + ' ' + String(row.product_name || '') + ' ' + String(row.reference || '')).toLowerCase();
          if (hay.indexOf(search) < 0) return false;
        }
        return true;
      },
      map: function (row) { return toPublic(row, withCosts); }
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* GET /v1/quotes/:id */
router.get('/:id', rateLimit('read'), async function (req, res, next) {
  try {
    const row = await db.getById(db.PATHS.quotes, req.params.id);
    if (!row) throw errors.notFound('La cotizacion');
    resolveClientScope(req, row.client_id);
    if (!rowVisibleFor(req)(row)) throw errors.forbidden('Esa cotizacion no pertenece a tu cuenta.');

    const docsSnap = await db.ref(db.PATHS.documents).orderByChild('quote_id').equalTo(String(row.id)).once('value');
    const documents = db.asList(docsSnap.val())
      .filter(function (d) { return !d.deletedAt; })
      .map(function (d) {
        return { id: d.id, file_name: d.file_name, mime_type: d.mime_type, size_bytes: d.size_bytes, created_at: d.created_at, kind: d.kind || null };
      });

    res.json({ data: Object.assign(toPublic(row, canSeeCosts(req)), { documents: documents }) });
  } catch (err) {
    next(err);
  }
});

/* POST /v1/quotes */
router.post('/', requireInternal, rateLimit('write'), validate({ body: quoteSchema }), async function (req, res, next) {
  try {
    const body = req.valid.body;
    resolveClientScope(req, body.client_id);
    const client = await db.getById(db.PATHS.clients, body.client_id);
    if (!client) throw errors.badRequest('El cliente indicado no existe.');

    const id = db.newId('q');
    const row = Object.assign({ id: id, status: 'vigente', version: 1 }, body, {
      createdAt: db.now(),
      createdBy: req.auth.sub
    });
    await db.put(db.PATHS.quotes, id, row);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'quote.create', target: 'quote', targetId: id, ip: req.clientIp, requestId: req.requestId });
    res.status(201).json({ data: toPublic(row, canSeeCosts(req)) });
  } catch (err) {
    next(err);
  }
});

/* PATCH /v1/quotes/:id */
router.patch('/:id', requireInternal, rateLimit('write'), validate({ body: quoteSchema.partial() }), async function (req, res, next) {
  try {
    const existing = await db.getById(db.PATHS.quotes, req.params.id);
    if (!existing) throw errors.notFound('La cotizacion');
    resolveClientScope(req, existing.client_id);

    const row = await db.patch(db.PATHS.quotes, req.params.id, Object.assign({}, req.valid.body, { updatedAt: db.now(), updatedBy: req.auth.sub }));
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'quote.update', target: 'quote', targetId: req.params.id, ip: req.clientIp, requestId: req.requestId, meta: { fields: Object.keys(req.valid.body) } });
    res.json({ data: toPublic(row, canSeeCosts(req)) });
  } catch (err) {
    next(err);
  }
});

/* GET /v1/quotes/:id/cost-breakdown  (solo admin)
   Devuelve los renglones por volumen de esa cotizacion. Va por el indice
   .indexOn de quote_id, asi que la base no entrega la tabla completa. */
router.get('/:id/cost-breakdown', requireAdmin, rateLimit('read'), async function (req, res, next) {
  try {
    const quoteId = String(req.params.id);
    const quote = await db.getById(db.PATHS.quotes, quoteId);
    if (!quote) throw errors.notFound('La cotizacion');

    const snap = await db.ref(db.PATHS.costBreakdown).orderByChild('quote_id').equalTo(quoteId).once('value');
    const tiers = db.asList(snap.val())
      .map(function (r) {
        const c = Object.assign({}, r);
        delete c.id;
        delete c.updatedBy;
        return c;
      })
      .sort(function (a, b) { return (a.quantity_tier || 0) - (b.quantity_tier || 0); });

    res.json({ data: { quote_id: quoteId, tiers: tiers } });
  } catch (err) {
    next(err);
  }
});

/* PUT /v1/quotes/:id/cost-breakdown  (solo admin)
   Reemplaza los renglones de ESTA cotizacion y no toca los de las demas.
   Va como una sola escritura multiruta: o entran todos o no entra ninguno,
   para que no quede un desglose a medias si se corta la conexion. */
router.put('/:id/cost-breakdown', requireAdmin, rateLimit('write'), validate({ body: costSchema }), async function (req, res, next) {
  try {
    const quoteId = String(req.params.id);
    const quote = await db.getById(db.PATHS.quotes, quoteId);
    if (!quote) throw errors.notFound('La cotizacion');

    const snap = await db.ref(db.PATHS.costBreakdown).orderByChild('quote_id').equalTo(quoteId).once('value');
    const previos = snap.val() || {};

    const cambios = {};
    Object.keys(previos).forEach(function (k) { cambios[k] = null; });

    req.valid.body.tiers.forEach(function (t) {
      const key = db.newId('cb');
      cambios[key] = Object.assign({}, t, {
        id: key,
        quote_id: quoteId,
        updatedAt: db.now(),
        updatedBy: req.auth.sub
      });
    });

    await db.ref(db.PATHS.costBreakdown).update(cambios);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'quote.cost_update', target: 'quote', targetId: quoteId, ip: req.clientIp, requestId: req.requestId, meta: { tiers: req.valid.body.tiers.length, reemplazados: Object.keys(previos).length } });

    res.json({ data: { quote_id: quoteId, tiers: req.valid.body.tiers.length } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
