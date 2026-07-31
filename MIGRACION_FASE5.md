# MIGRACION FASE 5 - Cerrar la base de datos (RTDB)

Documento operativo de la fase 5 del plan de migracion (ver API_CONTRACT.md seccion 6).

**Objetivo:** pasar de reglas abiertas (`database.rules.transitional.json`) a reglas cerradas
(`database.rules.json`), de forma que la RTDB solo sea accesible desde el Admin SDK de las
Cloud Functions y ningun navegador pueda leer ni escribir directo.

**Estado: PREPARADO, NO EJECUTADO.** `firebase.json` sigue apuntando al archivo transitorio
a proposito, para que un `firebase deploy` accidental no tumbe los portales en vivo.

Commits de preparacion: `2e260c2` (reglas cerradas) y `5654604` (reglas transitorias).

---

## 1. Situacion actual verificada (2026-07-31)

| Hecho | Detalle |
|---|---|
| `firebase.json` | `database.rules` apunta a `database.rules.transitional.json` |
| Reglas desplegadas en produccion | **Sin ningun indice.** La REST API responde `Index not defined` para todas las consultas con `orderBy` |
| Despliegue desde el navegador | Imposible: `/.settings/rules.json` responde **403**. Hace falta la CLI, es decir GitHub Codespaces |
| Consecuencia | El SDK web descarga nodos completos y filtra en el cliente; la busqueda de credenciales previa al login sigue trayendo los 30 clientes al navegador |
| Portales | `API_BASE = ''` en ambos: hablan directo con la RTDB |
| Proyecto | `arqueta-portal` (`.firebaserc`: alias `default` y `prod`) |
| Funcion exportada | `api` (`functions/index.js`), codebase `api`, runtime nodejs20 |

---

## 2. Preflight: bloqueantes que impiden cerrar hoy

**B1 - La fase 1 no esta hecha.** La API no esta desplegada y los dos portales tienen
`API_BASE = ''`. Si se cierran las reglas antes de desplegar la API y de poner la URL real
en `API_BASE`, ambos portales dejan de funcionar por completo.

**B2 - Nodos sin equivalente en la API.** Los portales usan directo:

- `arqueta_files` -> Portal-OC-Interno.html y Portal-Clientes.html (`mergeFiles`)
- `arqueta_backups` -> Portal-OC-Interno.html (`autoRespaldo` / `crearRespaldo`)

La version cerrada los deja en `.read/.write: false` y **no existe endpoint equivalente**.
Antes de cerrar hay que (a) mover los archivos a Storage via `/v1/documents` (fase 4) y
(b) crear endpoints de respaldo o mover el respaldo a Cloud Scheduler (punto 3 del plan
maestro).

**B3 - `saveData()` hace un `set()` de la base completa.** No hay endpoint que replique esa
escritura. Hay que sustituirla por escrituras por entidad (que ya existen en la API) antes
de cerrar.

> Regla: mientras B1, B2 o B3 sigan abiertos, **no desplegar `database.rules.json`**.

---

## 3. Paso intermedio seguro (recomendado: se puede hacer ya)

`database.rules.transitional.json` ya trae todos los indices y **mantiene exactamente los
mismos accesos que hoy**. Desplegarlo no cierra la base y no cambia nada visible, pero
elimina los `Index not defined` y permite que Firebase filtre y pagine en servidor
(punto 5 del plan maestro). Es reversible y no toca datos.

Este paso (5a) es independiente de B1/B2/B3 y se puede ejecutar en cuanto haya Codespaces.

---

## 4. Preparacion del entorno (una sola vez)

Repo -> boton **Code** -> pestana **Codespaces** -> *Create codespace on main*.

```bash
npm install -g firebase-tools
firebase --version
firebase login --no-localhost      # pegar el codigo que devuelve el navegador
firebase projects:list             # debe aparecer arqueta-portal
firebase use prod
```

**Respaldo previo.** El despliegue de reglas no modifica datos, pero se toma snapshot igual,
con el mecanismo propio de la app usado en el tramo anterior:
`arqueta_backups/premigracion/<fecha>-<motivo>` con el formato `{fecha, bytes, data}`, y se
verifica el tamano byte a byte. **Nunca** commitear datos de produccion al repo (es publico)
ni dejarlos en el workspace de Codespaces.

---

## 5. Comandos exactos

### 5a. Desplegar solo los indices (no cierra la base)

`firebase.json` **se queda como esta** (apuntando al transitorio).

```bash
firebase deploy --only database --project arqueta-portal
```

### 5b. Cerrar la base (solo cuando B1, B2 y B3 esten resueltos)

```bash
# 1. editar firebase.json:  "rules": "database.rules.json"
# 2. commitear ese cambio a main
firebase deploy --only database --project arqueta-portal
```

El despliegue de las Cloud Functions (fase 1) es aparte:

```bash
cd functions && npm ci && cd ..
firebase deploy --only functions:api --project arqueta-portal
```

---

## 6. Verificacion

### Despues de 5a (indices)

Ejecutar desde la pestana de **github.io** (firebaseio.com da CORS desde github.com):

```
GET https://arqueta-portal-default-rtdb.firebaseio.com/arqueta_db/quotes.json?orderBy="client_id"&equalTo=<id>
```

- Antes: `{"error":"Index not defined, add \".indexOn\": \"client_id\" ..."}`
- Despues: `200` con los datos filtrados.

Repetir con `costBreakdown?orderBy="quote_id"` y `clients?orderBy="portal_email"`.

### Despues de 5b (cierre)

- La misma peticion anonima debe responder `Permission denied`.
- `arqueta_files` y `arqueta_backups` tambien deben responder `Permission denied`.
- La API (Admin SDK) sigue leyendo y escribiendo con normalidad.

### Prueba funcional en ambos portales (obligatoria en los dos casos)

1. Login en Portal-OC-Interno y en Portal-Clientes.
2. Listados de clientes, cotizaciones, OCs y desglose de costos.
3. Alta y edicion de un registro; verificar que persiste tras recargar.
4. Desactivar y reactivar un cliente (cascada a cotizaciones, OCs y filas de costo).
5. Pantalla **Desactivados** (rol admin).
6. Adjuntar un archivo y ver que aparece en la otra sesion.
7. Respaldo automatico: confirmar que se escribe el snapshot del dia.

---

## 7. Rollback

El rollback de reglas es inmediato y **no toca datos**.

```bash
# 1. Reglas: volver al archivo transitorio
#    firebase.json ->  "rules": "database.rules.transitional.json"
firebase deploy --only database --project arqueta-portal

# 2. Front: revertir el commit que activo API_BASE
git revert <sha-del-commit-del-front>
git push origin main
```

GitHub Pages vuelve a publicar en 1-2 minutos. Si el problema fuera de datos y no de
reglas, restaurar desde `arqueta_backups/premigracion/<fecha>-<motivo>`.

---

## 8. Anexo: indices desplegados y por que

| Nodo | `.indexOn` | Quien lo consulta |
|---|---|---|
| `arqueta_db/clients` | id, portal_email, portal_active, activo | `db.getById` / `db.listPage` ordenan por `id`; login de clientes |
| `arqueta_db/quotes` | id, client_id, status, date, activo | `clients.js` cascada por `client_id`; listados |
| `arqueta_db/costBreakdown` | id, quote_id, activo | `quotes.js` y `clients.js` por `quote_id` |
| `arqueta_db/clientOCs` | id, client_id, status, date_submitted, activo | `clients.js` cascada por `client_id` |
| `arqueta_db/purchaseOrders` | id, quote_id, client_id, status, activo | `orders.js` y listados |
| `arqueta_db/notifEmails` | id | `db.listPage` ordena por `id` |
| `documents` | id, quote_id, client_oc_id, client_id | `quotes.js` por `quote_id`; `documents.js` |
| `private/credentials/users` | user, role, activo | `users.js` (`orderByChild('role')`) y desactivacion |
| `private/credentials/clients` | email_lower, activo | `clients.js`, login por `email_lower` |
| `private/sessions` | sub | `lib/credentials.js` |
| `private/auditLog` | at, actor, targetId | herramienta de gestion de usuarios (punto 4 del plan) |
| `private/rateLimit` | (sin indice) | acceso por clave directa |

**Sobre `activo`:** hoy ningun endpoint hace `orderByChild('activo')`. El indice se adelanta
al filtrado en servidor de los registros desactivados (punto 5 del plan maestro) y evita un
segundo despliegue de reglas cuando se implemente.

**Sobre `arqueta_files` y `arqueta_backups`:** en la version cerrada quedan con
`.read/.write: false` **explicitos**. Heredarian `false` de la raiz de todos modos; se
escriben explicitos para dejar documentado que el cierre es intencional y no un olvido.
