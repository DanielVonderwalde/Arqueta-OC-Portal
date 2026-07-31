'use strict';

/**
 * Acceso a datos. Unico modulo que habla con Firebase.
 *
 * Todo pasa por aqui para que, cuando migremos a MySQL, solo haya que
 * reimplementar este archivo (y no las 7 rutas).
 *
 * Nota sobre el modelo actual: el portal guarda arreglos dentro de
 * arqueta_db (clients, quotes, ...). El objetivo es tenerlos como mapas
 * indexados por id (arqueta_db/quotes/<id>). Mientras dura la migracion,
 * asList() tolera las dos formas.
 */

const admin = require('firebase-admin');
const { config } = require('../config');
const { errors } = require('./errors');

if (!admin.apps.length) admin.initializeApp();

const rtdb = admin.database();

const PATHS = {
  root: 'arqueta_db',
  clients: 'arqueta_db/clients',
  quotes: 'arqueta_db/quotes',
  costBreakdown: 'arqueta_db/costBreakdown',
  purchaseOrders: 'arqueta_db/purchaseOrders',
  clientOCs: 'arqueta_db/clientOCs',
  notifEmails: 'arqueta_db/notifEmails',
  documents: 'documents',
  credUsers: 'private/credentials/users',
  credClients: 'private/credentials/clients',
  sessions: 'private/sessions',
  rateLimit: 'private/rateLimit',
  audit: 'private/auditLog',
  meta: 'private/meta'
};

function ref(path) {
  return rtdb.ref(path);
}

function child(path, id) {
  if (!id || /[.#$\[\]/]/.test(String(id))) throw errors.badRequest('Identificador invalido.');
  return rtdb.ref(path + '/' + id);
}

function newId(prefix) {
  return (prefix ? prefix + '-' : '') + rtdb.ref().push().key;
}

function now() {
  return new Date().toISOString();
}

/** Convierte un snapshot (arreglo legado o mapa) en lista de objetos con id. */
function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return Object.keys(value).map(function (k) {
    const item = value[k];
    if (item && typeof item === 'object') return Object.assign({ id: item.id || k }, item);
    return { id: k, value: item };
  });
}

async function getById(path, id) {
  const snap = await child(path, id).once('value');
  const val = snap.val();
  if (val) return Object.assign({ id: id }, val);
  /* fallback modelo legado (arreglo): buscamos por campo id */
  const all = asList((await ref(path).once('value')).val());
  return all.find(function (r) { return String(r.id) === String(id); }) || null;
}

async function put(path, id, data) {
  await child(path, id).set(data);
  return Object.assign({ id: id }, data);
}

async function patch(path, id, data) {
  await child(path, id).update(data);
  return getById(path, id);
}

/**
 * Paginacion con cursor. El filtrado y el corte SIEMPRE ocurren aqui
 * (servidor), nunca en el navegador.
 *
 * Limitacion conocida de RTDB: no se puede combinar equalTo() con
 * startAfter(). Cuando hay filtro por campo se usa el indice .indexOn para
 * traer solo ese subconjunto (con tope hardScanCap) y el cursor se aplica
 * despues, ya en memoria de la funcion. Al migrar a MySQL esto pasa a ser un
 * WHERE ... AND id > cursor LIMIT n.
 */
async function listPage(options) {
  const opts = options || {};
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || config.pagination.defaultLimit, 1), config.pagination.maxLimit);
  const cursor = opts.cursor || null;
  let query = ref(opts.path);

  if (opts.filterField && opts.filterValue !== undefined && opts.filterValue !== null && opts.filterValue !== '') {
    query = query.orderByChild(opts.filterField).equalTo(opts.filterValue).limitToFirst(config.pagination.hardScanCap);
  } else if (!cursor) {
    query = query.orderByKey().limitToFirst(config.pagination.hardScanCap);
  } else {
    query = query.orderByKey().startAfter(cursor).limitToFirst(config.pagination.hardScanCap);
  }

  const snap = await query.once('value');
  let rows = asList(snap.val());

  if (typeof opts.where === 'function') rows = rows.filter(opts.where);

  rows.sort(function (a, b) {
    const key = opts.sortBy || 'id';
    const av = String(a[key] === undefined ? '' : a[key]);
    const bv = String(b[key] === undefined ? '' : b[key]);
    return opts.sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
  });

  if (cursor && opts.filterField) {
    const at = rows.findIndex(function (r) { return String(r.id) === String(cursor); });
    if (at >= 0) rows = rows.slice(at + 1);
  }

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? String(page[page.length - 1].id) : null;

  return {
    data: typeof opts.map === 'function' ? page.map(opts.map) : page,
    page: { limit: limit, nextCursor: nextCursor, hasMore: Boolean(nextCursor) }
  };
}

/**
 * Bitacora de auditoria. Append-only: nunca se borra ni se edita.
 * Se usa para saber quien creo/modifico/desactivo que y cuando.
 */
async function writeAudit(entry) {
  const item = {
    at: now(),
    actor: entry.actor || 'anonimo',
    actorRole: entry.actorRole || null,
    action: entry.action,
    target: entry.target || null,
    targetId: entry.targetId || null,
    ip: entry.ip || null,
    requestId: entry.requestId || null,
    meta: entry.meta || null
  };
  await ref(PATHS.audit).push(item);
  return item;
}

module.exports = {
  admin: admin,
  rtdb: rtdb,
  PATHS: PATHS,
  ref: ref,
  child: child,
  newId: newId,
  now: now,
  asList: asList,
  getById: getById,
  put: put,
  patch: patch,
  listPage: listPage,
  writeAudit: writeAudit
};
