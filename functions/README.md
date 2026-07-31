# Capa de API - Arqueta OC Portal

Cloud Functions + Express que sustituyen el acceso directo del navegador a
Firebase. El contrato completo esta en ../API_CONTRACT.md.

## Estructura

    functions/
      index.js                  declaracion de la funcion, region, secretos
      src/
        app.js                  Express: CORS, helmet, versionado /v1
        config.js               configuracion por ambiente (dev/staging/prod)
        lib/
          errors.js             contrato unico de errores
          logger.js             logs estructurados con redaccion
          db.js                 unico modulo que habla con Firebase
          credentials.js        bcrypt, migracion de hashes, JWT, sesiones
        middleware/
          auth.js               autenticacion y reglas por rol
          security.js           rate limit, validacion, manejo de errores
        routes/
          auth.js clients.js quotes.js orders.js documents.js users.js
      test/
        api.test.js             pruebas unitarias sin red

La idea de tener db.js aislado es que, cuando se migre a MySQL, solo se
reescribe ese archivo. Las rutas no se tocan.

## Requisitos

No hay terminal local, asi que todo esto se corre desde GitHub Codespaces:
en el repo, boton Code -> Codespaces -> Create codespace on main. Eso da una
terminal real dentro del navegador.

    npm install -g firebase-tools
    cd functions && npm install
    firebase login --no-localhost

## Secretos

No hay ni un secreto en el repo. Se cargan en Secret Manager:

    firebase functions:secrets:set JWT_SECRET
    firebase functions:secrets:set BOOTSTRAP_TOKEN

Para generar valores largos y aleatorios:

    node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

JWT_SECRET firma los tokens; si se cambia, todas las sesiones se invalidan.
BOOTSTRAP_TOKEN solo se usa una vez, en la migracion inicial.

## Correr en local

    npm run lint
    npm test
    npm run serve

Con los emuladores arriba, la URL base es
http://127.0.0.1:5001/arqueta-portal/us-central1/api

Prueba rapida:

    curl http://127.0.0.1:5001/arqueta-portal/us-central1/api/health

## Desplegar

    firebase deploy --only functions:api

El predeploy corre lint y pruebas: si algo falla, no se despliega.

Reglas de la base y del almacenamiento (ver la advertencia de abajo):

    firebase deploy --only database,storage

## Importante: no despliegues las reglas cerradas todavia

firebase.json apunta a database.rules.transitional.json. Esas reglas se pueden
desplegar hoy sin romper nada: cierran los nodos nuevos (private, documents) y
agregan los indices, pero dejan arqueta_db como esta, porque el portal actual
todavia lee y escribe directo.

database.rules.json es el objetivo: cierra la base por completo. Se despliega
SOLO cuando el frontend ya no hable con Firebase directamente (fase 5 del
contrato). Para hacer el cambio, en firebase.json:

    "database": { "rules": "database.rules.json" }

Si algo sale mal, se vuelve al archivo transitorio y se despliega de nuevo.

## Migracion inicial de credenciales

Una sola vez, para copiar los usuarios y clientes que hoy viven en el HTML
hacia private/credentials. Se envian los hashes SHA-256 que ya existen: nadie
tiene que cambiar su contrasena, y en su siguiente login el hash se convierte
solo a bcrypt.

    curl -X POST "<URL base>/v1/auth/bootstrap" \
      -H "Content-Type: application/json" \
      -H "X-Bootstrap-Token: <BOOTSTRAP_TOKEN>" \
      -d @bootstrap.json

Formato de bootstrap.json:

    {
      "users": [
        { "user": "admin", "label": "Administrador", "role": "admin", "passHash": "<sha256 actual>" }
      ],
      "clients": [
        { "id": "c-ejemplo", "portal_email": "compras@ejemplo.com", "portal_password_hash": "<sha256 actual>", "portal_active": true }
      ]
    }

El endpoint se bloquea solo despues de la primera ejecucion.

## Como llama el frontend

    async function api(ruta, opciones) {
      const r = await fetch(API_BASE + '/v1' + ruta, Object.assign({
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: 'Bearer ' + token } : {}
        )
      }, opciones || {}));
      const cuerpo = await r.json();
      if (!r.ok) throw new Error(cuerpo.error.message);
      return cuerpo.data;
    }

El frontend ya no necesita el SDK de Firebase para datos, ni guardar hashes,
ni conocer la estructura de la base.

## Monitoreo

Todos los logs son JSON con severity, requestId, ruta, rol y duracion. Eventos
utiles para crear alertas en Cloud Logging:

| Evento | Para que |
| --- | --- |
| auth.login_failed | pico de fallos = intento de fuerza bruta |
| rate_limited | alguien golpeando la API |
| unhandled_error | errores no previstos |
| document.download | descargas fuera de horario |

## Costos y limites

maxInstances esta en 10 y concurrency en 20. Es un techo deliberado: si algo se
descontrola, la factura no se dispara. Se sube cuando el uso real lo pida.
