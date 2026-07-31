'use strict';

/**
 * Errores de la API.
 *
 * Contrato unico de error (documentado en API_CONTRACT.md):
 *   { error: { code, message, details, requestId } }
 *
 * - code: string estable, pensado para que el frontend haga logica con el.
 * - message: texto en espanol, apto para mostrar al usuario.
 * - details: opcional, normalmente errores de validacion campo por campo.
 * - requestId: para cruzar con los logs de Cloud Logging.
 *
 * Nunca se filtra el stack ni el mensaje de un error interno al cliente.
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details || null;
    this.expose = true;
    Error.captureStackTrace(this, ApiError);
  }

  body(requestId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        requestId: requestId || null
      }
    };
  }
}

function isApiError(err) {
  return err instanceof ApiError || (err && err.name === 'ApiError');
}

const errors = {
  badRequest: function (message, details) {
    return new ApiError(400, 'bad_request', message || 'Solicitud invalida.', details);
  },
  validation: function (details) {
    return new ApiError(422, 'validation_error', 'Los datos enviados no son validos.', details);
  },
  unauthorized: function (message) {
    return new ApiError(401, 'unauthorized', message || 'Credenciales invalidas o sesion expirada.');
  },
  forbidden: function (message) {
    return new ApiError(403, 'forbidden', message || 'No tienes permiso para esta operacion.');
  },
  notFound: function (what) {
    return new ApiError(404, 'not_found', (what || 'El recurso') + ' no existe.');
  },
  conflict: function (message) {
    return new ApiError(409, 'conflict', message || 'El recurso ya existe o cambio desde tu ultima lectura.');
  },
  payloadTooLarge: function (message) {
    return new ApiError(413, 'payload_too_large', message || 'El archivo excede el tamano permitido.');
  },
  unsupportedMedia: function (message) {
    return new ApiError(415, 'unsupported_media_type', message || 'Tipo de archivo no permitido.');
  },
  tooManyRequests: function (retryAfterSec) {
    const e = new ApiError(429, 'rate_limited', 'Demasiados intentos. Intenta de nuevo mas tarde.');
    e.retryAfterSec = retryAfterSec || 60;
    return e;
  },
  internal: function () {
    /* mensaje generico a proposito: los detalles quedan solo en el log */
    return new ApiError(500, 'internal_error', 'Ocurrio un error interno. Ya quedo registrado.');
  }
};

module.exports = { ApiError: ApiError, isApiError: isApiError, errors: errors };
