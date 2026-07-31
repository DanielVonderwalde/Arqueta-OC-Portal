'use strict';

/**
 * Autenticacion y control de acceso.
 *
 * Principio: el frontend oculta opciones, pero QUIEN decide es el backend.
 * Cualquier endpoint que devuelva o modifique datos pasa por authenticate()
 * y por una regla de rol explicita. No hay endpoints "abiertos" salvo
 * /health y /auth/*.
 *
 * Roles:
 *   admin    - todo, incluye costos internos y gestion de usuarios
 *   asociado - operacion diaria; sin costos internos; puede quedar limitado
 *              a una lista de clientes asignados
 *   cliente  - solo SUS datos (client_id del token), sin costos internos
 */

const { errors } = require('../lib/errors');
const cred = require('../lib/credentials');

const ROLES = { ADMIN: 'admin', ASOCIADO: 'asociado', CLIENTE: 'cliente' };
const INTERNAL_ROLES = [ROLES.ADMIN, ROLES.ASOCIADO];

function readBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/** Exige un access token valido y una sesion no revocada. */
async function authenticate(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) throw errors.unauthorized('Falta el encabezado Authorization.');

    const payload = cred.verifyToken(token, 'access');
    await cred.assertSessionActive(payload.jti);

    req.auth = {
      sub: payload.sub,
      role: payload.role,
      label: payload.label || null,
      client_id: payload.client_id || null,
      clients: Array.isArray(payload.clients) ? payload.clients : null,
      jti: payload.jti
    };
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole() {
  const allowed = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.auth) return next(errors.unauthorized());
    if (allowed.indexOf(req.auth.role) < 0) {
      return next(errors.forbidden('Tu rol (' + req.auth.role + ') no puede realizar esta operacion.'));
    }
    next();
  };
}

const requireAdmin = requireRole(ROLES.ADMIN);
const requireInternal = requireRole(ROLES.ADMIN, ROLES.ASOCIADO);

/**
 * Devuelve el client_id sobre el que la peticion PUEDE operar.
 * - cliente: siempre el suyo, se ignora lo que mande en la query.
 * - asociado con lista de clientes asignados: solo esos.
 * - admin: el que pida (o todos si no pide ninguno).
 */
function resolveClientScope(req, requestedClientId) {
  const auth = req.auth;
  if (!auth) throw errors.unauthorized();

  if (auth.role === ROLES.CLIENTE) {
    if (!auth.client_id) throw errors.forbidden('Tu usuario no esta vinculado a ningun cliente.');
    if (requestedClientId && String(requestedClientId) !== String(auth.client_id)) {
      throw errors.forbidden('Solo puedes consultar la informacion de tu propia empresa.');
    }
    return auth.client_id;
  }

  if (auth.role === ROLES.ASOCIADO && auth.clients && auth.clients.length) {
    if (!requestedClientId) return null;
    if (auth.clients.indexOf(String(requestedClientId)) < 0) {
      throw errors.forbidden('Ese cliente no esta asignado a tu usuario.');
    }
    return String(requestedClientId);
  }

  return requestedClientId ? String(requestedClientId) : null;
}

/** Filtro de fila para listados, coherente con resolveClientScope. */
function rowVisibleFor(req) {
  const auth = req.auth;
  return function (row) {
    if (!row) return false;
    if (auth.role === ROLES.ADMIN) return true;
    if (auth.role === ROLES.CLIENTE) return String(row.client_id) === String(auth.client_id);
    if (auth.clients && auth.clients.length) return auth.clients.indexOf(String(row.client_id)) >= 0;
    return true;
  };
}

/** true solo para quien puede ver costos internos. */
function canSeeCosts(req) {
  return Boolean(req.auth) && req.auth.role === ROLES.ADMIN;
}

module.exports = {
  ROLES: ROLES,
  INTERNAL_ROLES: INTERNAL_ROLES,
  authenticate: authenticate,
  requireRole: requireRole,
  requireAdmin: requireAdmin,
  requireInternal: requireInternal,
  resolveClientScope: resolveClientScope,
  rowVisibleFor: rowVisibleFor,
  canSeeCosts: canSeeCosts
};
