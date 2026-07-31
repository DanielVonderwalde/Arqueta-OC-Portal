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

/* ---------------------------------------------------------------------------
 * La llave de almacenamiento NO es el id del registro
 *
 * La base de produccion todavia guarda clients, quotes, costBreakdown y
 * clientOCs como ARREGLOS. Firebase convierte los arreglos de JavaScript en
 * objetos con llaves numericas ("0", "1", "2"...), asi que la llave real de
 * cada fila no es su id. Escribir en <path>/<id> no actualizaria la fila:
 * crearia un registro nuevo al lado y duplicaria el dato en silencio.
 *
 * keyOf() devuelve la llave real. Primero intenta el acceso directo (modelo
 * destino, indexado por id) y si no existe busca por el campo id usando el
 * indice .indexOn declarado en database.rules.json.
 *
 * Cuando se corra scripts/migrar-llaves.js la base entera queda indexada por
 * id y el segundo camino deja de usarse solo. Este archivo no cambia.
 * ------------------------------------------------------------------------- */
async function keyOf(path, id) {
  if (!id || /[.#$\[\]/]/.test(String(id))) throw errors.badRequest('Identificador invalido.');
  const directo = await rtdb.ref(path + '/' + id).once('value');
  if (directo.exists()) return String(id);
  const snap = await rtdb.ref(path).orderByChild('id').equalTo(String(id)).once('value');
  const val = snap.val();
  const llaves = val ? Object.keys(val) : [];
  return llaves.length ? llaves[0] : null;
}

/** Referencia a la fila real. Lanza 404 si el registro no existe. */
async function refOf(path, id) {
  const key = await keyOf(path, id);
  if (!key) throw errors.notFound('El registro');
  return rtdb.ref(path + '/' + key);
}

async function getById(path, id) {
  const key = await keyOf(path, id);
  if (!key) return null;
  const val = (await rtdb.ref(path + '/' + key).once('value')).val();
  if (!val || typeof val !== 'object') return null;
  return Object.assign({}, val, { id: val.id || id });
}

/**
 * Alta o reemplazo completo. Un registro nuevo se escribe siempre indexado
 * por id (modelo destino); uno que ya existe se reescribe en su llave actual
 * para no duplicarlo.
 */
async function put(path, id, data) {
  const key = (await keyOf(path, id)) || String(id);
  await rtdb.ref(path + '/' + key).set(data);
  return Object.assign({}, data, { id: id });
}

async function patch(path, id, data) {
  const fila = await refOf(path, id);
  await fila.update(data);
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
  keyOf: keyOf,
  refOf: refOf,
  getById: getById,
  put: put,
  patch: patch,
  listPage: listPage,
  writeAudit: writeAudit
};
