'use strict';

/**
 * /v1/orders
 *
 *   /purchase  ordenes internas contra una cotizacion (purchaseOrders)
 *   /client    ordenes de compra que suben los clientes (clientOCs)
 *
 * El cliente puede crear y consultar SUS ordenes, pero nunca cambiar el
 * estatus ni tocar los campos de facturacion: eso es exclusivo del equipo
 * interno. El campo fileData (base64) ya no se acepta; los archivos se suben
 * por /v1/documents y aqui solo se referencia document_id.
 */

const express = require('express');
const { z } = require('zod');

const { errors } = require('../lib/errors');
const db = require('../lib/db');
const { validate, rateLimit } = require('../middleware/security');
const { authenticate, requireAdmin, requireInternal, resolveClientScope, rowVisibleFor, ROLES } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const OC_STATUSES = ['pendiente', 'recibida', 'facturada', 'rechazada'];

const listQuery = z.object({
  client_id: z.string().max(80).optional(),
  status: z.enum(OC_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(120).optional()
}).strict();

/* Forma real de un renglon de orden de compra, tal como lo capturan los dos
   portales. Antes esta validacion pedia { quote_id, descripcion, cantidad },
   que no corresponde a ningun campo que exista en la aplicacion: cualquier OC
   enviada desde el portal habria sido rechazada con 400.

   quote_id es opcional a proposito: el cliente puede pedir un producto que
   todavia no tiene cotizacion cargada, y el panel interno captura OCs a mano.
   Cuando si viene, el servidor verifica que esa cotizacion sea de su empresa. */
const lineSchema = z.object({
  codigo: z.string().trim().max(80).optional(),
  product: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().min(0),
  unit_price: z.coerce.number().min(0),
  precio_manual: z.boolean().optional(),
  quote_id: z.string().max(80).optional(),
  quote_number: z.string().max(60).optional(),
  alerta: z.enum(['ok', 'warn', 'bad']).optional(),
  avisos: z.array(z.string().max(300)).max(20).optional()
}).strict();

const clientOcSchema = z.object({
  client_id: z.string().max(80).optional(),
  oc_number: z.string().trim().min(1).max(60),
  notes: z.string().max(2000).optional(),
  fecha_deseada: z.string().max(20).optional(),
  urgente: z.boolean().optional(),
  document_id: z.string().max(120).optional(),
  lines: z.array(lineSchema).min(1).max(200)
}).strict();

const statusSchema = z.object({
  status: z.enum(OC_STATUSES),
  factura_numero: z.string().max(60).optional(),
  factura_fecha: z.string().max(20).optional(),
  motivo: z.string().max(500).optional()
}).strict();

const purchaseSchema = z.object({
  quote_id: z.string().min(1).max(80),
  quantity_ordered: z.coerce.number().min(0),
  notes: z.string().max(2000).optional(),
  status: z.string().max(40).optional()
}).strict();

/* =============== ordenes de compra del cliente =============== */

router.get('/client', rateLimit('read'), validate({ query: listQuery }), async function (req, res, next) {
  try {
    const q = req.valid.query || {};
    const scope = resolveClientScope(req, q.client_id || null);
    const visible = rowVisibleFor(req);

    const result = await db.listPage({
      path: db.PATHS.clientOCs,
      filterField: scope ? 'client_id' : null,
      filterValue: scope || null,
      limit: q.limit,
      cursor: q.cursor,
      sortBy: 'date_submitted',
      sortDesc: true,
      where: function (row) {
        if (!visible(row)) return false;
        if (q.status && row.status !== q.status) return false;
        return true;
      },
      map: function (row) {
        const copy = Object.assign({}, row);
        delete copy.fileData;
        return copy;
      }
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/client/:id', rateLimit('read'), async function (req, res, next) {
  try {
    const row = await db.getById(db.PATHS.clientOCs, req.params.id);
    if (!row) throw errors.notFound('La orden de compra');
    resolveClientScope(req, row.client_id);
    if (!rowVisibleFor(req)(row)) throw errors.forbidden('Esa orden no pertenece a tu cuenta.');
    const copy = Object.assign({}, row);
    delete copy.fileData;
    res.json({ data: copy });
  } catch (err) {
    next(err);
  }
});

router.post('/client', rateLimit('write'), validate({ body: clientOcSchema }), async function (req, res, next) {
  try {
    const body = req.valid.body;
    const clientId = req.auth.role === ROLES.CLIENTE ? req.auth.client_id : body.client_id;
    if (!clientId) throw errors.badRequest('Falta client_id.');
    resolveClientScope(req, clientId);

    /* Si la linea trae cotizacion, tiene que ser de esta misma empresa: asi
       nadie puede ordenar contra la cotizacion de otro cliente. */
    for (const line of body.lines) {
      if (!line.quote_id) continue;
      const quote = await db.getById(db.PATHS.quotes, line.quote_id);
      if (!quote) throw errors.badRequest('La cotizacion ' + line.quote_id + ' no existe.');
      if (String(quote.client_id) !== String(clientId)) throw errors.forbidden('Una de las cotizaciones no pertenece a tu empresa.');
    }

    /* El semaforo de la OC lo calcula el servidor a partir de las lineas.
       Si llegara ya resuelto desde el navegador se podria maquillar. */
    const niveles = body.lines.map(function (l) { return l.alerta || 'ok'; });
    const alertaMax = niveles.indexOf('bad') >= 0 ? 'bad' : (niveles.indexOf('warn') >= 0 ? 'warn' : 'ok');

    const id = db.newId('oc');
    const ahora = db.now();
    const row = {
      id: id,
      client_id: String(clientId),
      oc_number: body.oc_number,
      notes: body.notes || '',
      fecha_deseada: body.fecha_deseada || '',
      urgente: body.urgente === true,
      document_id: body.document_id || null,
      lines: body.lines,
      alerta_max: alertaMax,
      status: 'pendiente',
      /* Solo la fecha, igual que las OCs que ya existen en la base. */
      date_submitted: ahora.slice(0, 10),
      createdAt: ahora,
      createdBy: req.auth.sub
    };
    await db.put(db.PATHS.clientOCs, id, row);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client_oc.create', target: 'client_oc', targetId: id, ip: req.clientIp, requestId: req.requestId });
    res.status(201).json({ data: row });
  } catch (err) {
    next(err);
  }
});

/* Autorizacion del administrador (2026-08-03)

   TODO cambio de estatus de una orden de compra de cliente lo autoriza un
   administrador: aceptar, rechazar, facturar y regresar a pendiente. El
   asociado ya no mueve el estatus; deja una solicitud en
   autorizacion_pendiente y la orden se queda como estaba, de modo que el
   cliente sigue viendo 'pendiente' hasta que el admin la acepte.

   Nada se sobrescribe sin dejar rastro: cada solicitud y cada decision se
   agregan a la lista autorizaciones de la propia orden, ademas del
   auditLog. Ningun campo se elimina. */
const ACCIONES_AUTORIZABLES = OC_STATUSES;

const decisionSchema = z.object({
  decision: z.enum(['autorizar', 'no_autorizar']),
  motivo: z.string().max(500).optional(),
  factura_numero: z.string().max(60).optional(),
  factura_fecha: z.string().max(20).optional()
}).strict();

function historialDe(row) {
  return Array.isArray(row.autorizaciones) ? row.autorizaciones.slice() : [];
}

/* autorizacion_pendiente: null borra la solicitud en RTDB; el historial
   queda en autorizaciones. */
function patchDeEstatus(existing, accion, extra) {
  const e = extra || {};
  return {
    status: accion,
    factura_numero: e.factura_numero || existing.factura_numero || '',
    factura_fecha: e.factura_fecha || existing.factura_fecha || '',
    statusMotivo: e.motivo || null,
    statusUpdatedAt: db.now(),
    statusUpdatedBy: e.actor || null,
    autorizacion_pendiente: null
  };
}

router.patch('/client/:id/status', requireInternal, rateLimit('write'), validate({ body: statusSchema }), async function (req, res, next) {
  try {
    const existing = await db.getById(db.PATHS.clientOCs, req.params.id);
    if (!existing) throw errors.notFound('La orden de compra');
    resolveClientScope(req, existing.client_id);

    const body = req.valid.body;
    const ahora = db.now();
    if (body.status === 'facturada' && !body.factura_numero) {
      throw errors.badRequest('Para marcar como facturada hay que indicar factura_numero.');
    }

    /* Asociado: solicitud, no cambio. El estatus sigue igual. */
    if (req.auth.role !== ROLES.ADMIN) {
      const solicitud = {
        accion: body.status,
        desde: existing.status || 'pendiente',
        motivo: body.motivo || '',
        factura_numero: body.factura_numero || '',
        factura_fecha: body.factura_fecha || '',
        solicitadoPor: req.auth.sub,
        solicitadoEn: ahora
      };
      const previo = historialDe(existing);
      previo.push({ accion: body.status, resultado: 'solicitada', por: req.auth.sub, fecha: ahora, motivo: body.motivo || '' });
      const pendiente = await db.patch(db.PATHS.clientOCs, req.params.id, { autorizacion_pendiente: solicitud, autorizaciones: previo });
      await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client_oc.status_request', target: 'client_oc', targetId: req.params.id, ip: req.clientIp, requestId: req.requestId, meta: { from: existing.status, to: body.status } });
      return res.status(202).json({ data: pendiente });
    }

    const lista = historialDe(existing);
    lista.push({ accion: body.status, resultado: 'autorizada', por: req.auth.sub, fecha: ahora, motivo: body.motivo || '' });
    const patch = patchDeEstatus(existing, body.status, { factura_numero: body.factura_numero, factura_fecha: body.factura_fecha, motivo: body.motivo, actor: req.auth.sub });
    patch.autorizaciones = lista;
    const row = await db.patch(db.PATHS.clientOCs, req.params.id, patch);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client_oc.status', target: 'client_oc', targetId: req.params.id, ip: req.clientIp, requestId: req.requestId, meta: { from: existing.status, to: body.status } });
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

/* Solo el administrador resuelve la solicitud del asociado. */
router.post('/client/:id/authorization', requireAdmin, rateLimit('write'), validate({ body: decisionSchema }), async function (req, res, next) {
  try {
    const existing = await db.getById(db.PATHS.clientOCs, req.params.id);
    if (!existing) throw errors.notFound('La orden de compra');
    resolveClientScope(req, existing.client_id);

    const solicitud = existing.autorizacion_pendiente;
    if (!solicitud || ACCIONES_AUTORIZABLES.indexOf(solicitud.accion) < 0) {
      throw errors.conflict('Esa orden no tiene ninguna solicitud pendiente de autorizacion.');
    }

    const body = req.valid.body;
    const ahora = db.now();
    const autoriza = body.decision === 'autorizar';
    const facturaNumero = body.factura_numero || solicitud.factura_numero || existing.factura_numero || '';
    if (autoriza && solicitud.accion === 'facturada' && !facturaNumero) {
      throw errors.badRequest('Para autorizar la facturacion hay que indicar factura_numero.');
    }

    const lista = historialDe(existing);
    lista.push({
      accion: solicitud.accion,
      resultado: autoriza ? 'autorizada' : 'no_autorizada',
      solicitadoPor: solicitud.solicitadoPor || '',
      por: req.auth.sub,
      fecha: ahora,
      motivo: body.motivo || ''
    });

    const patch = autoriza
      ? patchDeEstatus(existing, solicitud.accion, { factura_numero: facturaNumero, factura_fecha: body.factura_fecha || solicitud.factura_fecha, motivo: body.motivo || solicitud.motivo, actor: req.auth.sub })
      : { autorizacion_pendiente: null };
    patch.autorizaciones = lista;

    const row = await db.patch(db.PATHS.clientOCs, req.params.id, patch);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'client_oc.authorization', target: 'client_oc', targetId: req.params.id, ip: req.clientIp, requestId: req.requestId, meta: { accion: solicitud.accion, decision: body.decision, solicitadoPor: solicitud.solicitadoPor || '' } });
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

/* =============== ordenes internas =============== */

router.get('/purchase', requireInternal, rateLimit('read'), validate({ query: listQuery }), async function (req, res, next) {
  try {
    const q = req.valid.query || {};
    const result = await db.listPage({
      path: db.PATHS.purchaseOrders,
      limit: q.limit,
      cursor: q.cursor,
      sortBy: 'createdAt',
      sortDesc: true,
      where: rowVisibleFor(req)
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/purchase', requireInternal, rateLimit('write'), validate({ body: purchaseSchema }), async function (req, res, next) {
  try {
    const quote = await db.getById(db.PATHS.quotes, req.valid.body.quote_id);
    if (!quote) throw errors.badRequest('La cotizacion indicada no existe.');
    resolveClientScope(req, quote.client_id);

    const id = db.newId('po');
    const row = Object.assign({ id: id, client_id: quote.client_id, status: 'abierta' }, req.valid.body, {
      createdAt: db.now(),
      createdBy: req.auth.sub
    });
    await db.put(db.PATHS.purchaseOrders, id, row);
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'purchase_order.create', target: 'purchase_order', targetId: id, ip: req.clientIp, requestId: req.requestId });
    res.status(201).json({ data: row });
  } catch (err) {
    next(err);
  }
});

router.patch('/purchase/:id', requireInternal, rateLimit('write'), validate({ body: purchaseSchema.partial() }), async function (req, res, next) {
  try {
    const existing = await db.getById(db.PATHS.purchaseOrders, req.params.id);
    if (!existing) throw errors.notFound('La orden interna');
    resolveClientScope(req, existing.client_id);
    const row = await db.patch(db.PATHS.purchaseOrders, req.params.id, Object.assign({}, req.valid.body, { updatedAt: db.now(), updatedBy: req.auth.sub }));
    await db.writeAudit({ actor: req.auth.sub, actorRole: req.auth.role, action: 'purchase_order.update', target: 'purchase_order', targetId: req.params.id, ip: req.clientIp, requestId: req.requestId });
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
