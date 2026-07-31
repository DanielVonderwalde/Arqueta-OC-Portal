# Contrato de API - Arqueta OC Portal (v1)

Este documento es la referencia unica entre el frontend (Portal-OC-Interno.html,
Portal-Clientes.html) y la capa de API. Si algo no esta aqui, no existe.

Es tambien el documento que se necesita para el punto 6 del plan: cuando la API
se mude a un hosting comercial, el contrato no cambia, solo cambia la URL base.

---

## 1. Ambientes y URL base

| Ambiente | URL base |
| --- | --- |
| Emulador local | http://127.0.0.1:5001/arqueta-portal/us-central1/api |
| Produccion | https://us-central1-arqueta-portal.cloudfunctions.net/api |

Todas las rutas cuelgan del prefijo de version:

    <URL base>/v1/<recurso>

Hay una ruta sin version, solo para monitoreo:

    GET <URL base>/health  ->  { "status": "ok", "apiVersion": "v1", "env": "prod" }

### Politica de versionado

- Agregar un endpoint o un campo nuevo NO cambia la version.
- Quitar o renombrar un campo, o cambiar el significado de uno existente, SI
  obliga a publicar /v2. Las dos versiones conviven hasta que el frontend
  termine de migrar; recien entonces se retira /v1.

---

## 2. Autenticacion

Token JWT (HS256) en el encabezado:

    Authorization: Bearer <accessToken>

| Token | Duracion | Para que sirve |
| --- | --- | --- |
| accessToken | 30 min | acompanar cada llamada |
| refreshToken | 8 h | pedir un accessToken nuevo sin volver a escribir la contrasena |

El refreshToken se rota: cada vez que se usa, el anterior queda revocado. Las
sesiones viven en la base (private/sessions), asi que se pueden cerrar del lado
del servidor: logout, cambio de contrasena, cambio de rol o desactivacion del
usuario cierran las sesiones abiertas de inmediato.

### Roles

| Rol | Alcance |
| --- | --- |
| admin | todo, incluidos costos internos y gestion de usuarios |
| asociado | operacion diaria, sin costos internos, opcionalmente limitado a ciertos clientes |
| cliente | solo la informacion de su propia empresa |

El rol se valida SIEMPRE en el servidor. Ocultar un boton en el HTML no es un
control de acceso.

---

## 3. Convenciones

### Respuesta correcta

    { "data": { ... } }
    { "data": [ ... ], "page": { "limit": 25, "nextCursor": "q-123", "hasMore": true } }

### Respuesta con error

    {
      "error": {
        "code": "forbidden",
        "message": "No tienes permiso para esta operacion.",
        "details": null,
        "requestId": "7c1f..."
      }
    }

El requestId tambien viaja en el encabezado X-Request-Id y sirve para buscar la
peticion en los logs.

| code | HTTP | Cuando ocurre |
| --- | --- | --- |
| bad_request | 400 | falta un parametro o es incoherente |
| unauthorized | 401 | sin token, token vencido o credenciales malas |
| forbidden | 403 | el rol no alcanza, o el dato es de otra empresa |
| not_found | 404 | el recurso no existe |
| conflict | 409 | duplicado o regla de negocio (ej. ultimo admin) |
| payload_too_large | 413 | archivo mayor al limite |
| unsupported_media_type | 415 | tipo de archivo no permitido |
| validation_error | 422 | los campos no pasan el esquema |
| rate_limited | 429 | demasiados intentos, ver Retry-After |
| internal_error | 500 | error no previsto, el detalle queda solo en el log |

### Paginacion

Todos los listados aceptan limit (1-100, por omision 25) y cursor. El servidor
devuelve nextCursor; se repite la llamada con ese valor hasta que hasMore sea
false. No existe ningun endpoint que devuelva la base completa.

### Limites de tasa

| Grupo | Limite | Ventana | Bloqueo |
| --- | --- | --- | --- |
| login | 5 intentos | 5 min | 15 min |
| lectura | 300 | 1 min | 1 min |
| escritura | 60 | 1 min | 2 min |
| subida de archivos | 20 | 5 min | 5 min |

El login se cuenta por IP + usuario, para que nadie pueda bloquear a un usuario
legitimo gastandole los intentos desde otra IP.

---

## 4. Endpoints

### 4.1 Autenticacion  (/v1/auth)

| Metodo y ruta | Quien | Que hace |
| --- | --- | --- |
| POST /login | publico | login interno (admin/asociado). Body: user, password |
| POST /client-login | publico | login del portal de clientes. Body: email, password |
| POST /refresh | publico | Body: refreshToken. Devuelve tokens nuevos y revoca el anterior |
| POST /logout | autenticado | cierra la sesion actual |
| GET /me | autenticado | identidad del token (id, rol, client_id) |
| POST /change-password | autenticado | Body: currentPassword, newPassword |
| POST /bootstrap | token de bootstrap | migracion inicial de credenciales, se autobloquea |

Respuesta de login:

    {
      "data": {
        "identity": { "id": "admin", "role": "admin", "label": "Administrador", "client_id": null },
        "tokens": { "accessToken": "...", "refreshToken": "...", "expiresIn": 1800, "tokenType": "Bearer" }
      }
    }

Usuario inexistente y contrasena incorrecta devuelven exactamente el mismo
mensaje y tardan lo mismo: no se puede averiguar que cuentas existen.

### 4.2 Clientes  (/v1/clients)

| Metodo y ruta | Quien | Que hace |
| --- | --- | --- |
| GET / | interno, cliente (solo el suyo) | listado paginado |
| GET /:id | interno, cliente (solo el suyo) | ficha del cliente |
| POST / | admin | alta de cliente |
| PATCH /:id | interno | edita nombre, notas, portal_active |
| PUT /:id/portal-access | admin | asigna correo y contrasena de portal |
| POST /:id/deactivate | admin | desactiva y cierra sus sesiones |

Nunca se devuelve portal_password ni portal_password_hash.

### 4.3 Cotizaciones  (/v1/quotes)

| Metodo y ruta | Quien | Que hace |
| --- | --- | --- |
| GET / | todos (con alcance) | filtros: client_id, status, search, limit, cursor |
| GET /:id | todos (con alcance) | cotizacion + metadata de sus documentos |
| POST / | interno | alta |
| PATCH /:id | interno | edicion |
| GET /:id/cost-breakdown | SOLO admin | desglose de costos |
| PUT /:id/cost-breakdown | SOLO admin | guarda el desglose |

El desglose de costos no viaja nunca dentro de la cotizacion, y los campos
pdfData / excelData (base64) ya no se devuelven: en su lugar va la lista de
documentos con su id.

### 4.4 Ordenes  (/v1/orders)

| Metodo y ruta | Quien | Que hace |
| --- | --- | --- |
| GET /client | todos (con alcance) | ordenes de compra de clientes |
| GET /client/:id | todos (con alcance) | detalle |
| POST /client | cliente o interno | alta de OC; valida que cada cotizacion sea de esa empresa |
| PATCH /client/:id/status | interno | pendiente, recibida, facturada, rechazada |
| GET /purchase | interno | ordenes internas |
| POST /purchase | interno | alta contra una cotizacion |
| PATCH /purchase/:id | interno | edicion |

Marcar como facturada exige factura_numero. El cliente nunca puede cambiar el
estatus ni los campos de factura.

### 4.5 Documentos  (/v1/documents)

| Metodo y ruta | Quien | Que hace |
| --- | --- | --- |
| POST / | autenticado | crea la metadata y devuelve URL firmada de subida |
| POST /:id/confirm | autenticado | verifica el archivo y lo marca listo |
| GET / | autenticado | documentos de una cotizacion u orden |
| GET /:id/download-url | autenticado | URL firmada de descarga (15 min) |
| DELETE /:id | interno | marca como borrado, el archivo se conserva |

Flujo de subida:

    1. POST /v1/documents  { file_name, mime_type, size_bytes, quote_id }
       -> { document: {...}, upload: { url, method: "PUT", headers } }
    2. PUT <upload.url>  con el archivo y el Content-Type indicado
    3. POST /v1/documents/<id>/confirm

El archivo nunca pasa por la funcion, asi que el tamano no consume memoria ni
tiempo de ejecucion. Limite actual: 25 MB, solo PDF y hojas de calculo.

### 4.6 Usuarios  (/v1/users)  - solo admin

| Metodo y ruta | Que hace |
| --- | --- |
| GET / | listado con rol y estado |
| POST / | alta (user, label, role, password, clients) |
| PATCH /:id | cambia etiqueta, rol o clientes asignados |
| POST /:id/deactivate | desactiva (no borra) y cierra sesiones |
| POST /:id/reactivate | reactiva |
| POST /:id/reset-password | asigna contrasena nueva y cierra sesiones |
| GET /audit-log | bitacora de acciones |

No se puede quitar el rol ni desactivar al ultimo administrador activo, ni
desactivarse a uno mismo.

---

## 5. Modelo de datos

| Nodo | Contenido | Quien lo lee |
| --- | --- | --- |
| arqueta_db/clients | datos del cliente, sin credenciales | API |
| arqueta_db/quotes | cotizaciones, sin costos ni base64 | API |
| arqueta_db/costBreakdown | desglose de costos por cotizacion | API, solo admin |
| arqueta_db/purchaseOrders | ordenes internas | API |
| arqueta_db/clientOCs | ordenes de compra de clientes | API |
| documents | metadata de archivos (ruta, tipo, tamano) | API |
| private/credentials | hashes bcrypt de usuarios y clientes | API |
| private/sessions | sesiones activas por jti | API |
| private/rateLimit | contadores de intentos | API |
| private/auditLog | bitacora append-only | API, lectura admin |

Los archivos viven en Cloud Storage, en documents/<client_id>/<doc_id>-<nombre>.
La base de datos nunca guarda el contenido de un archivo.

---

## 6. Migracion por fases

1. Desplegar la API y correr POST /v1/auth/bootstrap. El portal actual sigue
   funcionando igual, sin cambios.
2. Migrar el login del portal de clientes a POST /v1/auth/client-login, y el
   interno a POST /v1/auth/login.
3. Migrar lecturas y escrituras a la API, endpoint por endpoint.
4. Migrar los PDFs a Storage con /v1/documents.
5. Cambiar firebase.json a database.rules.json (base cerrada) y desplegar.
   A partir de aqui el navegador ya no habla con Firebase.
6. Rollback: volver a database.rules.transitional.json y revertir el commit
   del frontend. La API puede quedar desplegada sin afectar nada.

## 7. Estado de la fase 3

Fecha de corte: 31 de julio de 2026.

### 7.1 Lo que ya quedo

**Portal-OC-Interno.html** ya no descarga la base antes del login. `initFirebase()`
se llamaba en `DOMContentLoaded`, de modo que cualquier visitante recibia
`arqueta_db` completa (clientes, cotizaciones, costos y margenes) sin escribir
una sola contrasena. Ahora se llama desde `abrirSesionUI()`, es idempotente, y
al cerrar sesion se corta el listener en vivo y se limpia la memoria. Verificado
en el sitio publicado: cero peticiones a la base al abrir la pagina.

**Portal-Clientes.html** tiene un objeto `datos` que decide de donde salen los
datos: de la API si `API_BASE` esta configurado, o de Firebase como hasta hoy.
Pasan por ahi la carga de cotizaciones, la escalera de precios, las ordenes de
compra, el alta de una OC y la actualizacion en vivo (listener con Firebase,
sondeo cada 60 s con la API).

### 7.2 Tres defectos corregidos en la capa de API

Se encontraron revisando el modelo real contra lo que se habia escrito en la
fase 1. Ninguno era visible hasta intentar usar la API de verdad.

**a) La llave de almacenamiento no es el id.** La base guarda `clients`,
`quotes`, `costBreakdown` y `clientOCs` como arreglos, y Firebase convierte los
arreglos en objetos con llaves numericas. `db.patch(path, id, ...)` escribia en
`<path>/<id>`, asi que en vez de actualizar la fila habria creado un registro
nuevo al lado, duplicando el dato en silencio. Se agrego `db.keyOf()` /
`db.refOf()`, que resuelven la llave real y funcionan con el modelo actual y con
el modelo destino indexado por id.

**b) El esquema de OC no correspondia a la aplicacion.** Se validaban lineas
`{ quote_id, descripcion, cantidad }`; los dos portales mandan
`{ codigo, product, quantity, unit_price, ... }`. Cualquier OC enviada habria
sido rechazada con 400. Ademas el semaforo `alerta_max` ahora lo calcula el
servidor, no el navegador.

**c) El desglose de costos no correspondia a la aplicacion.** Se validaban
conceptos sueltos `{ concepto, unidad, cantidad, costo_unitario }`; el modelo
real es un renglon por volumen (`quantity_tier`, `sustrato`, `acabado`,
`materiales`, `mod`, `ee`, `extras`, `transporte`, `valor_venta_total`,
`margen`). Se corrigio el esquema y los dos endpoints.

Se agrego tambien `GET /v1/quotes/:id/price-tiers`: el cliente necesita la
escalera de precios para armar su OC, pero no puede llamar a `/cost-breakdown`,
que es de admin. Devuelve unicamente volumen y precio de venta.

### 7.3 Pendientes con decision del usuario

**Borrado.** El panel interno hoy borra de verdad clientes, cotizaciones,
ordenes del cliente y ordenes de compra (`deleteCurrentClient`,
`deleteCurrentQuote`, `deleteClientOC`, `deletePO`). La API se diseno sin
borrado: solo desactiva, para conservar el historial. Hay que elegir antes de
migrar las escrituras del panel interno:

1. Agregar endpoints de borrado que repliquen lo de hoy.
2. Cambiar borrar por desactivar. Conserva el historial, pero cambia lo que ve
   el administrador.
3. Dejar el borrado solo contra Firebase.

**Migracion de llaves.** Mientras la base siga guardando arreglos, cada lectura
por id necesita el indice `id` que ya se agrego a `database.rules.json`. Pasar
la base a mapas indexados por id es una migracion sobre datos de produccion:
requiere respaldo previo y autorizacion explicita. No se ha corrido.

**Correos de aviso.** `notifEmails` se lee hoy desde el navegador. Con la API
activa la base queda cerrada, asi que el aviso de OC nueva sale a la direccion
por omision hasta que el envio se mueva al servidor en la fase 4.

**Archivos adjuntos.** Siguen subiendose directo a `arqueta_files`, tambien con
la API activa. Se cambian por URL firmada en la fase 4 (`/v1/documents`).


## 8. Respaldo y migracion a mapas indexados (2026-07-31)

### 8.1 Decision tomada sobre el borrado

Queda resuelto el pendiente de 7.3: **no habra borrado fisico**. Los registros solo se
desactivan y el historial se conserva. La API mantiene su diseno original (sin endpoints
DELETE) y el portal interno debera alinearse a esa semantica.

### 8.2 Respaldo previo

Antes de tocar un solo dato se guardaron dos copias del nodo `arqueta_db` completo:

| Ruta | Proposito |
|---|---|
| `arqueta_backups/snapshots/2026-07-31` | Snapshot diario, mismo formato que ya usaba el portal |
| `arqueta_backups/premigracion/2026-07-31-mapas-indexados` | Copia fija, fuera de la rotacion diaria |

Formato: `{ fecha, bytes, data }` donde `data` es el JSON serializado. Ambas copias se
releyeron y se compararon caracter por caracter contra el nodo vivo: identicas (24 871
caracteres; 12 cotizaciones, 30 clientes, 4 OCs, 54 filas de costo, 2 correos, 2 de
historial). Las copias anteriores del 21 al 30 de julio siguen intactas.

### 8.3 El problema

Todas las colecciones se guardaban como arreglos con indice numerico, asi que la clave de
almacenamiento era la posicion (`0`, `1`, `2`...) y no el id del registro. Consecuencias:

- `db.patch(ruta, id, ...)` escribia en `<ruta>/<id>`, una clave que no existia: en vez de
  actualizar el registro habria creado uno nuevo en paralelo.
- No se podia leer ni actualizar un registro por id sin descargar la coleccion entera.
- Borrar un elemento intermedio de un arreglo deja huecos y Firebase convierte el nodo a
  objeto de forma impredecible.

### 8.4 Estrategia: tolerante en lectura, indexada en escritura

El orden importaba, porque `renderQuotesList` y `renderClientsList` no ordenan: muestran los
registros en el orden en que vienen. Un mapa se lee en orden lexicografico de claves, asi
que migrar sin mas habria reordenado las listas a la vista del usuario. Por eso cada
registro lleva ahora un campo `_orden` que preserva la posicion original.

En `Portal-OC-Interno.html`:

| Funcion | Que hace |
|---|---|
| `aArreglo(v)` | Acepta arreglo (legado) o mapa indexado y siempre devuelve un arreglo, ordenado por `_orden` cuando todos los registros lo traen |
| `normalizarDB(d)` | Aplica `aArreglo` a cada coleccion; garantiza que exista como arreglo vacio si Firebase la omitio por estar vacia |
| `aMapaIndexado(arr, claveFn)` | Convierte a mapa, asigna `_orden` y sanea caracteres no validos en claves |
| `paraGuardar(d)` | Deja el objeto listo para escribir: mapas por id |

Se normaliza en `saveData`, `mergeFiles` y `renderAll`, de forma idempotente. En
`Portal-Clientes.html` ya existia `aArreglo`; solo se le agrego el orden por `_orden`.

Claves resultantes:

| Coleccion | Clave |
|---|---|
| `quotes`, `clients`, `clientOCs`, `purchaseOrders`, `controllerHistory` | el `id` del registro |
| `costBreakdown` | `cb-<quote_id>-<quantity_tier>` con el volumen rellenado a 9 digitos, para que el orden lexicografico coincida con el numerico |
| `notifEmails` | sigue siendo un arreglo de textos, no tiene id |

**Compatibilidad en ambos sentidos.** Una pestana con la version anterior abierta que guarde
arreglos no rompe nada: la version nueva los vuelve a indexar en el siguiente guardado.

### 8.5 Verificacion

1. Ida y vuelta sobre los datos reales de produccion: arreglos -> mapas -> arreglos devuelve
   exactamente el mismo contenido y el mismo orden en las 6 colecciones, incluyendo el
   reordenamiento lexicografico que aplica Firebase al releer un mapa.
2. Las dos versiones se compilaron y se verifico que los 3 scripts embebidos del portal
   interno y los 2 del portal de clientes parsean sin errores.
3. Tras migrar: las claves de `quotes`, `clients` y `clientOCs` son exactamente los ids, y
   `GET /arqueta_db/clients/<id>` devuelve el registro sin escanear la coleccion.
4. Se cargo el nodo migrado tal cual llega de Firebase en el portal interno publicado y se
   ejecuto `renderAll()`: sin errores, 30 clientes, 12 cotizaciones, 4 OCs, 54 filas de costo.
5. Un guardado simulado sobre esos datos reproduce los mismos mapas por id: es estable.

### 8.6 Lo que falta y necesita Codespaces

Las reglas del repo ya declaran los indices, **pero nunca se han desplegado**. Comprobado
contra la base viva: cualquier consulta `orderByChild` responde
`Index not defined` por REST. El SDK del navegador no falla, pero eso es peor: descarga el
nodo completo y filtra en el cliente. Es decir, la busqueda de credenciales previa al login
sigue trayendo los 30 clientes al navegador, justo lo que el punto 3 del Prompt A queria
evitar. El filtrado del lado del servidor **no esta activo todavia**.

Se intento leer `/.settings/rules.json` por REST y responde `403 Permission denied`, asi que
las reglas no se pueden desplegar desde el navegador. Hace falta, desde Codespaces:

```bash
firebase deploy --only database
```

Mientras tanto los indices son solo una intencion escrita en el repo.
