# SPEC_CAMBIOS.md — Bot WhatsApp Nexo

> ## 🟢 ESTADO (actualizado 2026-06-23): las 5 MODs YA fueron implementadas
>
> Facundo implementó MOD-01 a MOD-05 y las mergeó a `master` (commit `c3e3038`, merge `8710293` "fase0-confiabilidad"), sumando además una capa de confiabilidad (reencolado durable, backpressure, auto-recuperación, catch-up, retry inteligente). **Este documento queda como referencia histórica del diseño, no como trabajo pendiente.**
> El endurecimiento que sigue pendiente está en **`SPEC_ROBUSTEZ.md`**.

> ## ¿Qué es este documento?
>
> Especificación técnica escrita por ChuecoTriquis y Claudia Seria para que **Facundo implemente**.
>
> **Este documento NO es código. Nadie lo ejecuta. Nadie toca el repositorio a partir de esto.**
> ChuecoTriquis y Claudia Seria se limitan a escribir y refinar la spec acá.
> Facundo lee este archivo, lo entiende, y es quien escribe el código, corre los tests y hace el deploy.
>
> **Reglas del documento:**
> - Se puede editar libremente: agregar detalles, corregir comportamientos, completar secciones pendientes.
> - No reemplaza AGENTS.md ni CLAUDE.md — Facundo debe leer ambos antes de implementar.
> - En caso de conflicto entre este spec y AGENTS.md, prevalece AGENTS.md.
> - Cada MOD tiene un estado: `especificado` (listo para implementar) o `pendiente` (spec incompleta).
>
> **Cómo leer los bloques ⚠️ "Observaciones verificadas contra el código":**
> Varios MODs incluyen un bloque marcado con ⚠️. Son observaciones que surgieron de **auditar el código actual contra esta spec** (con referencias a archivo y línea). La **funcionalidad descrita en cada MOD es lo que se necesita hacer** — eso no se discute. Lo que estos bloques aportan es: "ojo, el código actual no se comporta como la spec asume acá, y esta es una propuesta de cómo resolverlo". Son **sugerencias de implementación**, no órdenes: Facundo evalúa cada una y decide el cómo final según su criterio técnico.
>
> **Antes de implementar cualquier MOD, Facundo debe:**
> 1. Leer AGENTS.md completo.
> 2. Leer CLAUDE.md completo.
> 3. Leer el MOD entero (descripción + comportamiento actual + comportamiento esperado + notas).
> 4. Preguntar antes de arrancar si algo no está claro.

---

## Contexto base

- **Repo:** `bot-whatsapp-nexo`
- **Versión actual:** V0.6 — estructura plana en Drive, soporte PDF multi-página, 54 grupos productivos
- **Deploy:** Railway + Docker + Volume `/data`
- **Stack:** Node.js 22 CommonJS, whatsapp-web.js, googleapis, node-poppler

---

## Modificaciones

---

### MOD-01 — Grupos y TAGs dinámicos desde Google Sheets (reemplaza config hardcodeada)

**Estado:** `especificado — listo para implementar`
**Tipo:** `modificación`

**Descripción:**
> Reemplazar la configuración estática de grupos/TAGs (`config.json` / `WHATSAPP_ALLOWED_GROUPS_JSON`) por lectura dinámica desde una planilla Google Sheets existente. El bot mantiene un cache en memoria y en disco; consulta Sheets al arrancar y cuando se le ordena vía comando `/recargar` desde el grupo de administración. Si Sheets no está disponible, opera con el último cache conocido. La planilla **no se modifica** — ya está en uso por otros sistemas.

---

**Comportamiento actual:**

> Los grupos permitidos y sus TAGs se configuran de forma estática en `config.json` (campo `groups`) o en la variable de entorno `WHATSAPP_ALLOWED_GROUPS_JSON`. El objeto tiene la forma `{ "Nombre exacto del grupo": "TAG" }`. Cambiar un grupo requiere editar el archivo o la env var y reiniciar el bot.
>
> Código de lookup en `messageHandler.js`:
> ```js
> const tag = config.whatsapp.groups[chat.name];
> if (!tag) return; // ignora el mensaje si no hay TAG
> ```

---

**Comportamiento esperado:**

> **Fuente de datos:**
> - Planilla Google Sheets existente (ya integrada con otros sistemas — no modificar).
> - Pestaña/hoja: `"Hoja 1"` (configurable via env var).
> - **Columna K** (`WHATSAPP`): nombre exacto del grupo de WhatsApp tal como aparece en la app.
> - **Columna E** (`TAG`): TAG identificador para el naming de archivos en Drive.
> - Todas las demás columnas se ignoran.
>
> **Filtrado de filas válidas al leer la Sheets:**
> - Ignorar la fila de headers (primera fila).
> - Ignorar filas donde columna K está vacía.
> - Ignorar filas donde columna K parece número de teléfono (contiene solo dígitos, `+`, `,` y espacios). Regex sugerido: `/^[\d\+\,\s]+$/`.
> - Ignorar filas donde columna E (TAG) está vacía o es solo `"-"` (guion solo).
> - Ignorar filas con múltiples valores separados por coma en columna K.
> - El resultado es una lista de pares `{ grupoWhatsapp, tag }` válidos.
>
> **Ciclo de vida del cache:**
>
> 1. **Al arrancar** (después del evento `ready`): el bot intenta cargar desde Sheets.
>    - Si Sheets responde → extrae pares válidos, ejecuta matching (ver abajo), guarda cache en memoria y en disco (`/data/sheets-groups-cache.json`).
>    - Si Sheets falla → carga desde cache en disco si existe. Si no existe cache en disco, arranca sin grupos configurados y envía alerta al grupo de administración.
>
> 2. **En operación normal**: el bot hace el lookup de TAG desde el objeto en memoria (O(1), sin latencia adicional respecto al comportamiento actual).
>
> 3. **Al recibir comando `/recargar`** desde el grupo de administración:
>    - Recarga desde Sheets en segundo plano (sin interrumpir procesamiento de mensajes).
>    - Si la recarga es exitosa → actualiza cache en memoria y en disco → responde en el grupo de admin: `"✓ Sheets cargada. X grupos vinculados. Cache actualizado [HH:mm]."`.
>    - Si la recarga falla → mantiene cache actual sin cambios → responde en el grupo de admin: `"✗ Error al recargar desde Sheets. Se mantiene el cache anterior (cargado [fecha])."`.
>    - El cache en disco **nunca se borra automáticamente** (ni por recargas fallidas, ni por reinicios).
>
> **Sistema de matching (al arrancar o al `/recargar`):**
>
> El bot obtiene la lista de grupos donde está presente (`client.getChats()` → filtrar `chat.isGroup === true`) y cruza contra los pares válidos de la Sheets:
>
> - **Match exacto (100%)** → vincula automáticamente `{ "nombre_grupo": "TAG" }`. Sin notificación.
> - **Match parcial (score alto, sin ser exacto)** → envía mensaje al grupo de administración:
>   ```
>   ❓ El grupo "NOMBRE_GRUPO" podría corresponder a:
>   [1] Candidato A (92% similar)
>   [2] Candidato B (85% similar)
>   [3] Ninguno de los anteriores
>   Respondé con el número.
>   ```
>   El bot espera respuesta hasta `SHEETS_MATCH_PENDING_TIMEOUT_HOURS` horas (default: 24hs). Si no hay respuesta, el grupo queda sin vincular hasta el próximo `/recargar`.
>   La vinculación confirmada se guarda en cache con flag `manualMatch: true`.
> - **Sin match** → el grupo se ignora silenciosamente. No se procesa.
>
> **Comportamiento ante grupo sin TAG en runtime:**
>
> Si durante la operación llega un mensaje de un grupo que no tiene vinculación en el cache (no está en Sheets o no fue confirmado por matching):
> - El mensaje se ignora (comportamiento idéntico al actual).
> - No se alerta (el bot puede estar en grupos de administración, broadcast, u otros que no son grupos productivos).
>
> Si el bot está en un grupo que sí tiene vinculación en cache pero el TAG resultó inválido en runtime (edge case):
> - Subir el archivo a Drive usando el nombre sanitizado del grupo como TAG de fallback (truncado a 20 caracteres, usando `sanitizeDriveFolderName()`).
> - Enviar alerta al grupo de administración con el texto del error + el comprobante adjunto (primera página si es PDF multi-página, ya convertida a JPG en ese punto del flujo).

---

**Archivos involucrados:**

> **Nuevos:**
> - `src/services/sheetsService.js` — autenticación con Google Sheets API + descarga de filas + filtrado de pares válidos (K, E).
> - `src/services/groupMatcher.js` — lógica de matching entre grupos presentes en el bot y grupos de Sheets (exact match + scoring para match ambiguo).
> - `src/services/groupsCache.js` — gestión del mapa `{ "nombre_grupo": "TAG" }` en memoria y en disco. Expone `getTag(groupName)`, `reload()`, `persist()`, `loadFromDisk()`.
>
> **Modificados:**
> - `src/config/env.js` — nuevas variables de entorno (ver sección siguiente).
> - `src/handlers/messageHandler.js` — reemplazar `config.whatsapp.groups[chat.name]` por `groupsCache.getTag(chat.name)`.
> - `index.js` — inicializar `groupsCache` después del evento `ready`; suscribir el handler de respuestas de matching al grupo de administración.
> - `.env.example` — documentar todas las variables nuevas.

---

**Variables de entorno nuevas / modificadas:**

> | Variable | Descripción | Default |
> |---|---|---|
> | `GOOGLE_SHEETS_ID` | ID del documento Sheets (extraído de la URL: `.../spreadsheets/d/<ID>/edit`) | — (requerida para activar MOD-01) |
> | `GOOGLE_SHEETS_SHEET_NAME` | Nombre de la pestaña/hoja | `"Hoja 1"` |
> | `GOOGLE_SHEETS_TAG_COLUMN` | Letra de columna del TAG | `"E"` |
> | `GOOGLE_SHEETS_GROUP_COLUMN` | Letra de columna del nombre de grupo WA | `"K"` |
> | `GOOGLE_SHEETS_CREDENTIALS_PATH` | Path al JSON de Service Account (si se usa SA; omitir si se usa OAuth del bot) | — |
> | `SHEETS_MATCH_CASE_SENSITIVE` | Si el matching de nombre de grupo es case-sensitive | `"false"` |
> | `SHEETS_MATCH_MIN_SCORE` | Umbral mínimo (0–100) para considerar match parcial digno de consultar | `"80"` |
> | `SHEETS_MATCH_PENDING_TIMEOUT_HOURS` | Horas de espera para respuesta de matching ambiguo en grupo de admin | `"24"` |
>
> **Compatibilidad hacia atrás:** si `GOOGLE_SHEETS_ID` **no está definida**, el bot usa el comportamiento actual (`config.whatsapp.groups` desde `config.json` o `WHATSAPP_ALLOWED_GROUPS_JSON`). Si `GOOGLE_SHEETS_ID` **está definida**, Sheets es la única fuente de verdad y las variables legacy se ignoran. Decisión final sobre deprecación: Facundo.

---

**Notas para Facundo:**

> **1. Autenticación con Google Sheets — elegir una opción:**
>
> | | OAuth del bot (mismo token) | Service Account (recomendado) |
> |---|---|---|
> | Setup | Agregar scope `spreadsheets.readonly` al `token.json` existente + re-autenticar con `npm run auth` | Crear SA en GCP, compartir planilla con email del SA como Viewer, agregar JSON de credenciales |
> | Estabilidad | Token expira → también cae acceso a Drive | No expira, autónomo 24/7 |
> | Riesgo | Token compartido: falla SA = falla Drive | Sin riesgo cruzado |
> | Recomendación | Aceptable si el token se renueva periódicamente | **Preferido para producción 24/7** |
>
> **2. Detección de "número de teléfono" en columna K:**
> Usar regex `/^[\d\+\,\s]+$/` para identificar filas que son contactos individuales y no grupos de WhatsApp. Filtrarlas antes del matching.
>
> **3. Normalización de TAGs — elegir una opción:**
> Los TAGs en la planilla son inconsistentes (mayúsculas/minúsculas, con espacios: `"CRUZ NEG 2"`, `"bl neg 5"`, `"BET - BIP"`). Opciones:
> - **(a)** Usar tal cual — compatible con planilla existente, archivos con espacios en Drive.
> - **(b)** Uppercase automático al leer.
> - **(c)** Reemplazar espacios por `_`.
> - **(d) Recomendada:** uppercase + reemplazar espacios por `_` → `"cruz neg 2"` → `"CRUZ_NEG_2"`. Consistente con el estilo de naming actual.
>
> **4. Algoritmo de scoring para matching ambiguo:**
> Opciones: Levenshtein distance, Jaro-Winkler, Jaccard sobre palabras. Para nombres de grupos de WhatsApp (cadenas cortas de 5–40 chars), Jaro-Winkler suele funcionar mejor. Existen paquetes npm livianos: `fastest-levenshtein`, `natural`. El umbral `SHEETS_MATCH_MIN_SCORE` controla cuándo se activa la consulta al admin (debajo del umbral → ignorar directamente).
>
> **5. Respuestas interactivas de matching ambiguo:**
> El handler de respuestas (`"1"`, `"2"`, `"3"`) en el grupo de admin requiere estado (preguntas pendientes asociadas a grupos). Implementar como `Map` en memoria: `pendingMatches.set(questionId, { grupos, candidates, expiresAt })`. Este mecanismo se coordina con MOD-04 (comandos en grupo de control) — puede implementarse el matching exacto en una primera fase y diferir el matching ambiguo para cuando MOD-04 esté listo.
>
> **6. Timing de inicialización:**
> `client.getChats()` solo está disponible después del evento `ready`. La carga de Sheets debe ejecutarse después de `ready`. Durante el lapso entre `ready` y la primera carga, usar el cache en disco si existe (sesión anterior). Esto garantiza que el bot procesa comprobantes desde el primer segundo de `ready`.
>
> **7. Atomicidad del update en memoria:**
> Node.js es single-threaded. Reemplazar el objeto de grupos en memoria es atómico desde la perspectiva del event loop. Los handlers en vuelo al momento del reemplazo usan el snapshot anterior (sin problema). Los nuevos mensajes post-reemplazo usan el nuevo mapa. No se requieren locks ni pausas durante el `/recargar`.
>
> **8. Estructura del cache en disco** (`/data/sheets-groups-cache.json`):
> ```json
> {
>   "loadedAt": "2026-06-11T14:30:00.000Z",
>   "source": "sheets",
>   "groups": {
>     "Vapeboss QR": "VPBOSS",
>     "Transferencias Auad/Nexo": "AA"
>   },
>   "manualMatches": {
>     "Nombre grupo con typo": { "tag": "TAG", "confirmedAt": "...", "matchedTo": "Nombre en Sheets" }
>   }
> }
> ```
>
> **9. Comando `/grupos` (CSV de estado actual):**
> Debe exportar como archivo `.csv` adjunto en WhatsApp el contenido del cache actual: columnas `GRUPO_WHATSAPP,TAG,ORIGEN` (origen: `sheets` o `manual`). Útil como backup y auditoría. Este comando se registra en MOD-04 pero su implementación depende de `groupsCache.js`.

---

**⚠️ Observaciones verificadas contra el código (sugerencias):**

> **O1 — El scope OAuth actual NO alcanza para leer Sheets.**
> En [src/config/env.js:6](src/config/env.js#L6) el scope por defecto es `drive.file`. Ese scope solo da acceso a archivos que la propia app creó — no puede leer una planilla externa. Para la opción "OAuth del bot" hay que **agregar el scope `spreadsheets.readonly` y re-autenticar** (`npm run auth`, regenerar `token.json` — operación que requiere aprobación explícita y corta el acceso a Drive durante la renovación). Esto refuerza por qué la **Service Account** es la opción más limpia para 24/7: no toca el token de Drive. _Sugerencia: usar Service Account salvo que haya un motivo fuerte para lo contrario._
>
> **O2 — `googleapis` ya está instalado.** [package.json:13](package.json#L13) lista `googleapis@^144`. Leer Sheets se hace con el mismo paquete (`google.sheets({version:'v4'})`) — no hace falta dependencia nueva. El trabajo es de credenciales/scope, no de infra.
>
> **O3 — El wiring del evento `ready` está en `src/index.js`, no en el `index.js` raíz.** El `index.js` de la raíz son 3 líneas que solo llaman a `startBot()`. El handler real de `ready` (donde hay que inicializar `groupsCache`) está en [src/index.js:73-88](src/index.js#L73-L88). Donde el spec dice "modificar index.js", leer `src/index.js`.
>
> **O4 — Hoy el log de grupos al arrancar recorre `config.whatsapp.groups`.** [src/index.js:78](src/index.js#L78) itera ese objeto para imprimir los grupos configurados. Al pasar a `groupsCache`, ese log debe leer del cache nuevo (o se quita), para que no quede mostrando la fuente vieja.

---

### MOD-02 — Blacklist dinámica desde Google Sheets (reemplaza blocked-senders.json)

**Estado:** `especificado — listo para implementar`
**Tipo:** `modificación`

**Descripción:**
> Reemplazar la blacklist estática de remitentes (`blocked-senders.json`) y la lista estática de grupos exentos (`BLACKLIST_EXEMPT_GROUPS_JSON`) por lectura dinámica desde una **planilla Google Sheets nueva y separada**, creada específicamente para configuración del bot en el mismo Google Drive. La planilla de cotizaciones existente (usada en MOD-01) no se modifica ni se le agregan pestañas. El cache sigue el mismo patrón que MOD-01: en memoria + en disco, sin lectura de archivo por mensaje. Se recarga con el mismo comando `/recargar` del grupo de administración.

---

**Comportamiento actual:**

> - **Blacklist:** `blocked-senders.json` en disco con estructura `{ "blockedNumbers": ["5493815...", ...] }`. `loadBlockedSenders()` lee y parsea el archivo **en cada mensaje recibido** — lectura de disco por cada comprobante.
> - **Grupos exentos:** env var estática `BLACKLIST_EXEMPT_GROUPS_JSON`. Cambiar la lista requiere modificar la env var y reiniciar el bot.
> - La normalización de números (`normalizePhoneNumber()`) ya maneja cualquier formato: strips `@c.us`, `:0`, `+`, guiones, espacios — queda solo dígitos para comparar.
> - Código en `messageHandler.js`:
> ```js
> const blockedNumbers = loadBlockedSenders(config.paths.blockedSenders, { onWarning });
> const blocked = isSenderBlocked(senderId, blockedNumbers);
> const exemptGroups = config.blacklistExemptGroups || [];
> const isExempt = exemptGroups.includes(chat.name);
> if (blocked && !isExempt) return; // ignora el mensaje
> ```

---

**Comportamiento esperado:**

> **Planilla nueva del bot** — a crear en el mismo Google Drive, con permisos separados a la planilla de cotizaciones. Contiene dos pestañas:
>
> **No modificar la planilla de cotizaciones existente.** El bot la usa solo para lectura de grupos/TAGs (MOD-01).
>
> **Pestaña `BOT_BLACKLIST`** — números bloqueados:
> | Columna | Header | Descripción |
> |---|---|---|
> | A | TELEFONO | Número con código de país, cualquier formato (se normaliza al leer) |
> | B | DESCRIPCION | Texto libre — quién es, por qué está bloqueado. Solo para el equipo |
> | C | ACTIVO | `si` / `no` — desactivar sin borrar |
>
> **Pestaña `BOT_EXEMPT`** — grupos exentos de la blacklist:
> | Columna | Header | Descripción |
> |---|---|---|
> | A | GRUPO_WHATSAPP | Nombre exacto del grupo (igual que columna K de la planilla principal) |
> | B | DESCRIPCION | Texto libre — por qué está exento |
> | C | ACTIVO | `si` / `no` |
>
> **Filtrado de filas válidas al leer cada pestaña:**
> - Ignorar fila de headers (primera fila).
> - Ignorar filas donde columna A está vacía.
> - Ignorar filas donde columna C es `"no"` (inactivas).
> - Para `BOT_BLACKLIST`: normalizar cada número con `normalizePhoneNumber()` al cargar; descartar los que queden vacíos tras normalización.
>
> **Ciclo de vida del cache:**
> - Mismo patrón que MOD-01: carga al arrancar (después de `ready`), actualización con `/recargar`, fallback a cache en disco si Sheets falla.
> - Cache en disco: `/data/sheets-blacklist-cache.json`.
> - Estructura del cache:
> ```json
> {
>   "loadedAt": "2026-06-11T18:00:00.000Z",
>   "blockedNumbers": ["5493815123456", "5491112345678"],
>   "exemptGroups": ["cajaTTnexo", "Transferencias Auad/Nexo"]
> }
> ```
> - El `/recargar` actualiza grupos (MOD-01), blacklist y grupos exentos en una sola operación.
>
> **Comportamiento en runtime:**
> - En cada mensaje, el lookup es desde memoria: `blacklistCache.isBlocked(senderId)` y `blacklistCache.isExempt(chat.name)`.
> - Cero lecturas de disco por mensaje (mejora respecto al comportamiento actual).
> - Si el cache está vacío (Sheets nunca respondió y no hay cache en disco): asumir lista vacía (nadie bloqueado). Loguear warning.

---

**Archivos involucrados:**

> **Nuevos:**
> - `src/services/blacklistCache.js` — gestión del cache en memoria y en disco de blacklist + grupos exentos. Expone `isBlocked(senderId)`, `isExempt(groupName)`, `reload()`, `persist()`, `loadFromDisk()`.
>
> **Modificados:**
> - `src/services/sheetsService.js` (de MOD-01) — agregar `readBlacklist(sheetName)` y `readExemptGroups(sheetName)` para leer las pestañas nuevas.
> - `src/handlers/messageHandler.js` — reemplazar `loadBlockedSenders(config.paths.blockedSenders)` por `blacklistCache.isBlocked(senderId)` y `config.blacklistExemptGroups` por `blacklistCache.isExempt(chat.name)`.
> - `src/config/env.js` — nuevas variables de entorno.
> - `index.js` — inicializar `blacklistCache` junto con `groupsCache` después del `ready`.
> - `.env.example` — documentar variables nuevas.

---

**Variables de entorno nuevas / modificadas:**

> | Variable | Descripción | Default |
> |---|---|---|
> | `GOOGLE_SHEETS_BOT_CONFIG_ID` | ID de la planilla nueva del bot (distinta a `GOOGLE_SHEETS_ID` de cotizaciones) | — (requerida para activar MOD-02) |
> | `GOOGLE_SHEETS_BLACKLIST_SHEET_NAME` | Nombre de la pestaña de blacklist dentro de la planilla del bot | `"BOT_BLACKLIST"` |
> | `GOOGLE_SHEETS_EXEMPT_SHEET_NAME` | Nombre de la pestaña de grupos exentos dentro de la planilla del bot | `"BOT_EXEMPT"` |
>
> **Dos Sheets IDs distintos:** `GOOGLE_SHEETS_ID` apunta a la planilla de cotizaciones (MOD-01, solo lectura). `GOOGLE_SHEETS_BOT_CONFIG_ID` apunta a la planilla nueva del bot (MOD-02). Son documentos separados con permisos independientes.
>
> **Compatibilidad hacia atrás:** si `GOOGLE_SHEETS_BOT_CONFIG_ID` no está definida, el bot usa `blocked-senders.json` y `BLACKLIST_EXEMPT_GROUPS_JSON` como antes. `blocked-senders.json` puede mantenerse como backup de emergencia manual — decisión de Facundo.

---

**Notas para Facundo:**

> **1. Mejora de performance implícita:** actualmente `loadBlockedSenders()` lee y parsea el archivo JSON en cada mensaje recibido. Con MOD-02, el lookup pasa a ser `O(1)` desde un `Set` en memoria. Para 54 grupos activos con tráfico simultáneo, es una mejora real.
>
> **2. Usar `Set` para lookup:** al cargar el cache en memoria, convertir el array de números bloqueados a `new Set(blockedNumbers)` para que `isBlocked()` sea `O(1)` en vez de `O(n)`.
>
> **3. Normalización al escribir en Sheets:** los operadores pueden cargar números en cualquier formato (`+54 381 512-3456`, `5493815123456`, etc.). `normalizePhoneNumber()` ya maneja todo — aplicarla al leer de Sheets antes de guardar en cache, no al momento de comparar.
>
> **4. `blocked-senders.json` como fallback de emergencia:** si se quiere mantener el archivo como último recurso (Sheets caída + cache en disco perdido), `loadBlockedSenders()` se puede seguir llamando como tercer nivel de fallback. El orden sería: (1) cache Sheets en memoria, (2) cache en disco `/data/sheets-blacklist-cache.json`, (3) `blocked-senders.json` local. Decisión de Facundo.
>
> **5. Dos conexiones Sheets independientes:** `sheetsService.js` debe soportar autenticar y leer de dos documentos distintos en la misma ejecución — uno para cotizaciones (`GOOGLE_SHEETS_ID`) y otro para config del bot (`GOOGLE_SHEETS_BOT_CONFIG_ID`). Si se usa Service Account, compartir la planilla nueva con el mismo email del SA es suficiente.
>
> **6. El `/recargar` unifica todo:** la recarga debe actualizar en una sola operación grupos (MOD-01), blacklist y grupos exentos (MOD-02). La respuesta de confirmación en el grupo de admin debe incluir el resumen de las tres: `"✓ Sheets cargada. 54 grupos, 3 bloqueados, 2 grupos exentos. Cache actualizado [HH:mm]."`

---

**⚠️ Observaciones verificadas contra el código (sugerencias):**

> **O1 — Confirmado: hoy la blacklist se lee de disco en cada mensaje.** [src/handlers/messageHandler.js:80-91](src/handlers/messageHandler.js#L80-L91) llama a `loadBlockedSenders()` por cada comprobante (lee y parsea el JSON). La mejora a cache en memoria que plantea MOD-02 es real y vale. La función `normalizePhoneNumber()` ([src/services/blockedSenders.js:4-11](src/services/blockedSenders.js#L4-L11)) ya hace exactamente lo que el spec asume (strip de `@c.us`, `:0`, no-dígitos).
>
> **O2 — Los grupos exentos hoy se comparan por nombre exacto.** [src/handlers/messageHandler.js:93-94](src/handlers/messageHandler.js#L93-L94): `exemptGroups.includes(chat.name)`. El cache de MOD-02 debe mantener esa misma semántica (match exacto de `chat.name`) para no cambiar comportamiento.
>
> **O3 — Reusar la conexión Sheets de MOD-01.** Tal como dice la nota 5, `sheetsService.js` ya autentica para MOD-01; para MOD-02 es el mismo cliente leyendo otro `spreadsheetId`. No duplicar autenticación.

---

### MOD-03 — Sistema de difusión masiva a grupos (broadcast desde usuarios autorizados)

**Estado:** `especificado — listo para implementar`
**Tipo:** `nueva funcionalidad`

**Descripción:**
> Permite enviar un comunicado de texto a todos los grupos productivos monitoreados (los del cache de MOD-01) desde el grupo de control, usando un comando explícito con paso de confirmación obligatorio. Casos de uso: avisos de mantenimiento, cambio de cuenta bancaria, comunicados generales al universo de clientes.

---

**Comportamiento actual:**

> No existe mecanismo de broadcast. Para enviar un comunicado hay que hacerlo manualmente grupo por grupo desde el teléfono. Con 54 grupos, es inviable.

---

**Comportamiento esperado:**

> **Grupos destino:**
> - Todos los grupos presentes en el cache activo de MOD-01 (`groupsCache`). Eso equivale a todos los grupos productivos donde el bot está activo.
> - El grupo de control (`WHATSAPP_CONTROL_GROUP_NAME`) **no recibe** el broadcast — es solo el lugar desde donde se opera.
> - No existe segmentación por zona ni subconjunto: el broadcast siempre va a todos o a nadie.
>
> **Flujo completo:**
>
> 1. Un miembro del grupo de control escribe:
>    ```
>    /broadcast <mensaje>
>    ```
>    El mensaje puede ser de una o varias líneas. Todo lo que sigue a `/broadcast ` (con espacio) es el contenido a difundir.
>
> 2. El bot responde en el grupo de control con una preview de confirmación:
>    ```
>    📢 Vas a enviar este mensaje a 54 grupos:
>
>    ———————————————
>    <preview del mensaje tal como se va a enviar>
>    ———————————————
>
>    Respondé CONFIRMAR en los próximos 5 minutos para proceder, o CANCELAR para abortar.
>    ```
>
> 3. El usuario responde `CONFIRMAR` o `CANCELAR` (en mayúsculas, sin el slash).
>    - `CONFIRMAR` → inicia el envío.
>    - `CANCELAR` → bot responde `"✗ Difusión cancelada."` y descarta el pending.
>    - Si transcurren `BROADCAST_CONFIRM_TIMEOUT_MS` sin respuesta → bot responde `"✗ Difusión cancelada por timeout."` y descarta el pending.
>    - Solo puede haber **una difusión pendiente de confirmación a la vez**. Si se lanza un segundo `/broadcast` con una confirmación ya en curso, el bot responde: `"⚠ Ya hay una difusión esperando confirmación. Respondé CONFIRMAR o CANCELAR antes de lanzar otra."`.
>
> 4. **Envío:**
>    - El bot itera sobre todos los grupos del cache, enviando el mensaje a cada uno con un delay de `BROADCAST_SEND_DELAY_MS` entre cada envío (default: 1500 ms) para evitar detección de spam por WhatsApp.
>    - El envío corre en background — el grupo de control no se bloquea.
>    - Al iniciar el envío, el bot avisa: `"⏳ Iniciando difusión a 54 grupos..."`.
>
> 5. **Reporte final** (en el grupo de control, al terminar):
>    - Todo OK: `"✓ Difusión completada. 54/54 grupos notificados. [HH:mm]"`
>    - Con fallos parciales: `"✓ Difusión completada con errores. 51/54 notificados. Fallaron: Grupo A, Grupo B, Grupo C."`
>    - Fallo total: `"✗ Difusión fallida. 0/54 grupos notificados. Revisar logs."`
>
> **Formato del mensaje enviado a los grupos:**
> - Se envía el texto tal cual fue escrito después del `/broadcast`, sin prefijos ni headers automáticos.
> - El remitente visible es el bot (número de WhatsApp del bot). Los grupos lo verán como un mensaje del bot.
>
> **Solo texto por ahora.** Sin imágenes, sin archivos adjuntos. Extensible en el futuro.

---

**Archivos involucrados:**

> **Nuevos:**
> - `src/handlers/broadcastHandler.js` — toda la lógica de broadcast: parsear el comando, gestionar el estado de confirmación pendiente, ejecutar el envío con delay, reportar resultado.
>
> **Modificados:**
> - `src/handlers/messageHandler.js` — detectar mensajes del grupo de control y delegarlos a `broadcastHandler` cuando corresponda (comando `/broadcast`, respuestas `CONFIRMAR`/`CANCELAR`). Este mismo punto de entrada será reutilizado por MOD-04.
> - `src/config/env.js` — nuevas variables de entorno (ver sección siguiente).
> - `index.js` — no debería requerir cambios si el dispatch ya pasa por `messageHandler`.
> - `.env.example` — documentar variables nuevas.

---

**Variables de entorno nuevas / modificadas:**

> | Variable | Descripción | Default |
> |---|---|---|
> | `WHATSAPP_CONTROL_GROUP_NAME` | Nombre exacto del grupo de control desde donde se operan los comandos | — (requerida) |
> | `BROADCAST_CONFIRM_TIMEOUT_MS` | Milisegundos de espera para que el usuario confirme el broadcast antes de cancelarlo automáticamente | `300000` (5 min) |
> | `BROADCAST_SEND_DELAY_MS` | Delay en ms entre cada envío para evitar detección de spam por WhatsApp | `1500` |
>
> **Nota:** `WHATSAPP_CONTROL_GROUP_NAME` será compartida con MOD-04 (comandos de métricas). Es la misma variable para el mismo grupo.

---

**Notas para Facundo:**

> **1. Obtener el chat de cada grupo destino:**
> `groupsCache` almacena pares `{ "nombre_grupo": "TAG" }`. Para enviar, hay que resolver cada nombre a un objeto chat. La forma más limpia es usar `client.getChatById(chatId)` — pero el cache de MOD-01 guarda nombres, no IDs.
> Opciones:
> - **(a)** Al cargar el cache en MOD-01, guardar también el `chatId` junto al TAG. Recomendado.
> - **(b)** En el momento del broadcast, hacer `client.getChats()`, filtrar por nombre, y enviar. Más lento si son 54 grupos, pero funciona.
> Decisión: Facundo elige, pero la opción (a) es más limpia y performante.
>
> **2. Estado de confirmación pendiente:**
> Implementar como variable de módulo en `broadcastHandler.js`:
> ```js
> let pendingBroadcast = null;
> // { message, groupNames, groupCount, expiresAt, timeoutId }
> ```
> Al confirmar o cancelar (incluso por timeout), resetear a `null`. El `timeoutId` se usa para cancelar el timeout si el usuario responde antes.
>
> **3. El delay de 1500 ms entre envíos:**
> 54 grupos × 1.5 s = ~81 segundos para completar la difusión. Es aceptable para un comunicado masivo. Si se quiere más rápido, bajar `BROADCAST_SEND_DELAY_MS` a 800–1000 ms, pero hay riesgo de ban temporal de WhatsApp. 1500 ms es conservador y seguro.
>
> **4. Manejo de errores por grupo:**
> Envolver cada `chat.sendMessage()` en try/catch individual. Si un grupo falla, loguear el error y continuar con el siguiente — no abortar toda la difusión por un fallo puntual. Acumular los nombres de los que fallaron para el reporte final.
>
> **5. Integración con MOD-01 (groupsCache):**
> Este MOD depende de que MOD-01 esté implementado. Si MOD-01 no está listo, el broadcast no tiene de dónde sacar la lista de grupos. Implementar MOD-01 primero.
>
> **6. Identificar mensajes del grupo de control:**
> En `messageHandler.js`, agregar una check temprana:
> ```js
> if (chat.name === config.whatsapp.controlGroupName) {
>   return broadcastHandler.handle(message, chat, client);
> }
> ```
> Este mismo bloque será el punto de entrada para los comandos de MOD-04.
>
> **7. Solo texto por ahora:**
> No implementar soporte de imágenes/adjuntos en esta versión. Dejar una nota en el código (`// TODO MOD-03-v2: soporte de media`) para cuando se amplíe.

---

**🟢 Prerrequisito operativo — Grupo de control (compartido con MOD-04):**

> El grupo de control desde donde se operan `/broadcast` y los comandos de MOD-04 **hay que crearlo en WhatsApp y agregar el bot como miembro**. No existe todavía.
>
> **Orden obligatorio** (por el bug de `operationalNotifier` documentado en CLAUDE.md §11 — resolver un grupo donde el bot no es miembro puede bloquear el `ready`):
> 1. Crear el grupo en WhatsApp.
> 2. Agregar el bot FÍSICAMENTE al grupo.
> 3. Verificar membresía con un smoke test.
> 4. Recién entonces setear `WHATSAPP_CONTROL_GROUP_NAME` con el nombre exacto del grupo.
>
> Definir si el grupo de control es **uno nuevo dedicado** (recomendado, para separar comandos de las alertas) o si se reutiliza el grupo de alertas existente (`WHATSAPP_ALERT_GROUP_NAME`). Decisión de Facundo/equipo.

---

**⚠️ Observaciones verificadas contra el código (sugerencias):**

> **O1 — El filtro de seguridad del notifier rechazaría comunicados legítimos.** [src/services/operationalNotifier.js:71-78](src/services/operationalNotifier.js#L71-L78) (`isOperationalMessageSafe`) descarta cualquier mensaje que contenga un número de 8+ dígitos o una URL. Un comunicado de "cambio de cuenta" con un CBU, o uno con un link, sería rechazado en silencio (`unsafe-message`). **Sugerencia: el broadcast NO debe pasar por `sendPreparedMessage`/notifier.** Debe enviar directo con `chat.sendMessage()`. El texto del operador va tal cual (es contenido deliberado, no un log a sanitizar).
>
> **O2 — Ya existe el patrón "enviar a N grupos por nombre con delay". Reusarlo, no reinventarlo.** [src/services/operationalNotifier.js:164-175](src/services/operationalNotifier.js#L164-L175) resuelve `client.getChats()` → `Map` por nombre, y [:259-315](src/services/operationalNotifier.js#L259-L315) (`sendToDailyGroups`) **ya implementa el envío secuencial con delay entre grupos** — justo lo que pide el broadcast. Hoy hay 3 copias casi idénticas de ese loop (alert/status/daily). **Sugerencia: extraer un helper compartido** `sendToGroupsByName(names, message, {delayMs})` y construir el broadcast sobre él; de paso limpia la duplicación existente.
>
> **O3 — De dónde sacar los chats a notificar.** El cache de MOD-01 guarda `nombre → TAG`, no el objeto chat. La forma ya probada en el código es la de O2 (`getChats()` + Map por nombre). La opción (a) de la nota 1 (guardar `chatId` en el cache de MOD-01) sigue siendo más performante si se quiere evitar el `getChats()` completo en cada broadcast.
>
> **O4 — `src/index.js`, no `index.js`.** Igual que en MOD-01: el dispatch de mensajes se engancha en [src/index.js:114-120](src/index.js#L114-L120) (`client.on('message', ...)`). Ahí entra el handler de comandos.

---

### MOD-04 — Sistema de comandos en grupo de control (métricas y estadísticas operativas)

**Estado:** `especificado — listo para implementar`
**Tipo:** `nueva funcionalidad`

**Descripción:**
> Habilita un conjunto de comandos en el grupo de control para que el equipo operativo pueda consultar el estado del bot, ver métricas del día, gestionar la configuración y operar la cola de pendientes — todo desde WhatsApp, sin necesidad de acceder a Railway ni a los logs manualmente.

---

**Comportamiento actual:**

> No existe ningún sistema de comandos. Para saber cuántos comprobantes se procesaron hay que revisar los logs en Railway. Para forzar el procesamiento de pendientes fuera de horario no hay mecanismo — el operador no tiene forma de adelantar el ciclo automático. Para ver la blacklist o los grupos activos hay que acceder al servidor.

---

**Comportamiento esperado:**

> **Grupo de control:**
> Todos los comandos se envían y responden en el grupo definido por `WHATSAPP_CONTROL_GROUP_NAME`. El bot ignora cualquier mensaje que comience con `/` en grupos que no sean el de control.
>
> **Índice de comandos:**
>
> | Comando | Categoría | Descripción |
> |---|---|---|
> | `/resumen` | Consulta | Comprobantes del día: en horario (9-15) y fuera de horario (15-9), desglosado por cartera |
> | `/pendientes` | Consulta | Cuántos comprobantes están en cola esperando ser procesados |
> | `/status` | Consulta | Estado del bot: conectado, uptime, última actividad registrada |
> | `/recargar` | Configuración | Recarga grupos, TAGs y blacklist desde Google Sheets |
> | `/grupos` | Configuración | Lista los grupos activos con su TAG |
> | `/bloqueados` | Configuración | Lista los números actualmente en blacklist |
> | `/forzar` | Operación | Dispara el procesamiento de pendientes ahora mismo, sin esperar el horario automático |
> | `/broadcast <mensaje>` | Operación | Envía un comunicado de texto a todos los grupos productivos (ver MOD-03) |
> | `/errores` | Diagnóstico | Muestra los últimos 10 errores registrados en el log |
> | `/comandos` | Ayuda | Muestra este índice con todos los comandos disponibles |
>
> ---
>
> **Detalle de cada comando:**
>
> ---
>
> **`/resumen`**
> ```
> 📊 Resumen del día — Miércoles 11/06/2026
>
> ✅ En horario (09:00–15:00): 142 comprobantes
> ⏰ Fuera de horario: 8 comprobantes
> Total: 150
>
> Por cartera:
>   VPBOSS       34   (2 fuera de horario)
>   AA           28
>   CRUZ_NEG_2   22   (3 fuera de horario)
>   BL_NEG_5     18   (1 fuera de horario)
>   ...
> ```
> - Los límites de horario se leen de `businessCalendar.js` — no son hardcodeados en el comando.
> - Las métricas se leen del store de estadísticas del día (`/data/daily-stats.json`, ver Notas).
> - Si no hay datos del día (bot recién arrancado): `"Sin comprobantes registrados hoy."`.
> - Los grupos con 0 comprobantes en el día no aparecen en el listado por cartera.
>
> ---
>
> **`/pendientes`**
> ```
> 📥 Pendientes en cola: 12 comprobantes
> Más antiguo: hace 3 horas (desde 06:15)
> ```
> - Consulta `pendingDriveService` para contar los archivos en la carpeta de pendientes en Drive.
> - Si la cola está vacía: `"✓ Sin pendientes en cola."`.
>
> ---
>
> **`/status`**
> ```
> 🤖 Bot operativo
> Conectado: ✓
> Uptime: 4h 32m
> Última actividad: hace 3 minutos (comprobante subido)
> Horario actual: fuera de jornada
> Pendientes en cola: 12
> ```
> - "Última actividad" se lee del timestamp del último upload exitoso registrado en el store.
> - "Horario actual" usa `businessCalendar.js`.
>
> ---
>
> **`/recargar`**
> - Mismo comportamiento ya specced en MOD-01: recarga grupos + blacklist desde Sheets, responde con resumen de cuántos grupos, bloqueados y exentos quedaron cargados.
> - Este comando ya estaba definido en MOD-01; MOD-04 solo formaliza que vive en el sistema de comandos del grupo de control.
>
> ---
>
> **`/grupos`**
> ```
> 📋 Grupos activos: 54
>
> VPBOSS        → Vapeboss QR
> AA            → Transferencias Auad/Nexo
> CRUZ_NEG_2    → Cruz Negra 2
> ...
>
> Cache cargado: hoy 09:01
> ```
> - Formato: `TAG → Nombre del grupo`.
> - Al pie: fecha y hora de la última carga del cache.
> - Si hay muchos grupos (>20), enviar como archivo `.txt` adjunto para no inundar el chat.
>
> ---
>
> **`/bloqueados`**
> ```
> 🚫 Blacklist activa: 3 números
>
> +54 381 512-XXXX
> +54 11 4567-XXXX
> +54 351 789-XXXX
>
> Cache cargado: hoy 09:01
> ```
> - Los números se muestran enmascarados (últimos 4 dígitos reemplazados por XXXX) — nunca números completos en el chat.
> - Si la blacklist está vacía: `"✓ Sin números bloqueados."`.
>
> ---
>
> **`/forzar`**
> ```
> ⚡ Procesando pendientes fuera de horario...
> ✓ 12 comprobantes procesados. [09:58]
> ```
> - Llama directamente a `pendingProcessor.processPending()` sin verificar si está dentro del horario hábil.
> - Permite al operador adelantar el procesamiento si llega antes de las 9 o necesita forzarlo por algún motivo operativo.
> - Si no hay pendientes: `"✓ Sin pendientes para procesar."`.
> - Si ya hay un procesamiento en curso: `"⚠ Ya hay un procesamiento en curso. Esperá que termine."`.
>
> ---
>
> **`/broadcast <mensaje>`**
> - Definido en MOD-03. El dispatch de comandos lo delega a `broadcastHandler.js`.
>
> ---
>
> **`/errores`**
> ```
> 🔴 Últimos 10 errores:
>
> [mar 08:14] drive_upload_failed — Request failed with status 429
> [mar 07:52] pdf_conversion_failed — spawn pdftocairo ENOENT
> [lun 15:33] drive_upload_failed — Network timeout
> ...
> ```
> - Lee las últimas 10 líneas de `errors.log`.
> - Timestamps relativos (día de semana + hora), sin fechas exactas ni datos sensibles.
> - Mensajes de error técnicos sanitizados: sin teléfonos, sin nombres de grupos, sin paths absolutos.
> - Si no hay errores: `"✓ Sin errores registrados."`.
>
> ---
>
> **`/comandos`**
> ```
> 🤖 Comandos disponibles:
>
> 📊 Consultas
>   /resumen     — comprobantes del día por cartera
>   /pendientes  — cola de comprobantes sin procesar
>   /status      — estado general del bot
>
> ⚙️ Configuración
>   /recargar    — recargar config desde Sheets
>   /grupos      — lista de grupos activos con TAG
>   /bloqueados  — lista de números en blacklist
>
> 🔧 Operaciones
>   /forzar      — procesar pendientes ahora
>   /broadcast   — difusión masiva a grupos
>
> 🔍 Diagnóstico
>   /errores     — últimos 10 errores del log
> ```
>
> ---
>
> **Comando desconocido:**
> Si alguien escribe `/algo` que no existe en el grupo de control, el bot responde:
> `"Comando no reconocido. Escribí /comandos para ver los disponibles."`

---

**Archivos involucrados:**

> **Nuevos:**
> - `src/handlers/commandHandler.js` — dispatcher central: recibe cualquier mensaje del grupo de control que empiece con `/`, identifica el comando y delega a la función correspondiente. Centraliza el routing de todos los comandos.
> - `src/services/statsStore.js` — store de métricas diarias. Registra cada comprobante procesado exitosamente con `{ timestamp, tag, groupName, inBusinessHours }`. Expone `recordUpload()`, `getDailyStats()`, `reset()`. Persiste en `/data/daily-stats.json`. Se resetea al inicio de cada jornada hábil.
>
> **Modificados:**
> - `src/handlers/messageHandler.js` — agregar detección temprana: si el mensaje viene del grupo de control y empieza con `/`, delegar a `commandHandler.js`. Además, al finalizar un upload exitoso, llamar a `statsStore.recordUpload()`.
> - `src/handlers/broadcastHandler.js` (de MOD-03) — el dispatcher de MOD-04 lo invoca cuando el comando es `/broadcast`.
> - `src/services/pendingProcessor.js` — exponer `processPending()` como función llamable externamente (para `/forzar`). Agregar flag de "procesamiento en curso" para evitar ejecuciones simultáneas.
> - `src/config/env.js` — nueva variable `WHATSAPP_CONTROL_GROUP_NAME`.
> - `index.js` — inicializar `statsStore` después del `ready`; registrar reset diario al inicio de cada jornada.
> - `.env.example` — documentar variable nueva.

---

**Variables de entorno nuevas / modificadas:**

> | Variable | Descripción | Default |
> |---|---|---|
> | `WHATSAPP_CONTROL_GROUP_NAME` | Nombre exacto del grupo de control desde donde se operan los comandos (compartida con MOD-03) | — (requerida) |

---

**Notas para Facundo:**

> **1. `statsStore.js` — store de métricas del día:**
> El store acumula entradas durante la jornada y se resetea al inicio del próximo día hábil. Estructura del archivo `/data/daily-stats.json`:
> ```json
> {
>   "date": "2026-06-11",
>   "entries": [
>     { "ts": "2026-06-11T11:30:00.000Z", "tag": "VPBOSS", "groupName": "Vapeboss QR", "inBusinessHours": true },
>     { "ts": "2026-06-11T07:12:00.000Z", "tag": "AA", "groupName": "Transferencias Auad/Nexo", "inBusinessHours": false }
>   ]
> }
> ```
> `recordUpload()` se llama desde `messageHandler.js` después de cada upload exitoso. Es la única escritura al store; las lecturas son solo desde `/resumen` y `/status`.
>
> **2. Reset diario del store:**
> Al arrancar `pendingProcessor` (o en un scheduler propio), verificar si `daily-stats.json` tiene una fecha anterior a hoy. Si sí, archivarlo como `/data/daily-stats-YYYY-MM-DD.json` y crear uno nuevo vacío. Esto preserva el historial sin perder datos.
>
> **3. `commandHandler.js` — dispatcher central:**
> Patrón recomendado:
> ```js
> const COMMANDS = {
>   '/resumen':    require('./commands/resumenCommand'),
>   '/pendientes': require('./commands/pendientesCommand'),
>   '/status':     require('./commands/statusCommand'),
>   '/recargar':   require('./commands/recargarCommand'),
>   '/grupos':     require('./commands/gruposCommand'),
>   '/bloqueados': require('./commands/bloqueadosCommand'),
>   '/forzar':     require('./commands/forzarCommand'),
>   '/broadcast':  broadcastHandler.handleCommand,
>   '/errores':    require('./commands/erroresCommand'),
>   '/comandos':   require('./commands/comandosCommand'),
> };
>
> async function dispatch(message, chat, client) {
>   const text = message.body.trim();
>   const commandKey = Object.keys(COMMANDS).find(k => text === k || text.startsWith(k + ' '));
>   if (!commandKey) return chat.sendMessage('Comando no reconocido. Escribí /comandos para ver los disponibles.');
>   return COMMANDS[commandKey](message, chat, client);
> }
> ```
> Cada comando vive en su propio archivo dentro de `src/handlers/commands/`. Facilita agregar o sacar comandos sin tocar el dispatcher.
>
> **4. `/forzar` y concurrencia:**
> `pendingProcessor` ya corre en un `setInterval`. Si el operador manda `/forzar` mientras hay un ciclo automático en curso, podrían correr dos procesos en paralelo sobre la misma cola. Agregar un flag `isProcessing` en `pendingProcessor.js` y chequearlo antes de ejecutar — tanto en el ciclo automático como en el manual.
>
> **5. `/grupos` con muchos grupos:**
> Si `groupsCache` tiene más de 20 grupos, enviar como archivo `.txt` adjunto para no inundar el grupo de control con un mensaje gigante. Usar `MessageMedia.fromBuffer()` de whatsapp-web.js.
>
> **6. Orden de implementación sugerido:**
> 1. `statsStore.js` + wiring en `messageHandler.js` (base de datos para `/resumen`).
> 2. `commandHandler.js` con el dispatcher y `/comandos` (scaffolding).
> 3. Comandos de consulta: `/status`, `/resumen`, `/pendientes`.
> 4. Comandos de configuración: `/recargar`, `/grupos`, `/bloqueados`.
> 5. `/forzar` (requiere modificar `pendingProcessor`).
> 6. `/errores`.
> 7. Wiring de `/broadcast` → `broadcastHandler` (requiere MOD-03 implementado).

---

**⚠️ Observaciones verificadas contra el código (sugerencias):**

> **O1 — `/forzar` NO funcionaría fuera de horario tal como está el código — y ese es justo su caso de uso.** El procesador de pendientes, en [src/services/pendingProcessor.js:207-214](src/services/pendingProcessor.js#L207-L214), hace lo primero un early-return si está fuera del horario hábil (`shouldRunPendingProcessor` = `isWithinBusinessHours`). El operador que llega antes de las 9 está fuera de horario → si `/forzar` llama a la función actual, **no procesa nada**. **Sugerencia:** agregar un flag `force`/`ignoreBusinessHours` a `processPendingForOperationalDate()` (y a `runOnce()`) que saltee ese gate. El funcionamiento que necesitamos (procesar pendientes a demanda, incluso fuera de horario) requiere sí o sí esta modificación.
>
> **O2 — El "flag de procesamiento en curso" que pide la nota 4 YA EXISTE.** [src/services/pendingProcessor.js:272-309](src/services/pendingProcessor.js#L272-L309): `runOnce()` ya tiene el guard `running` y devuelve `{skipped:true, reason:'already-running'}` si hay un ciclo activo. **Sugerencia:** `/forzar` debe reusar `runOnce({force:true})` — no crear un `processPending()` nuevo. El interval automático y el `/forzar` manual comparten el mismo guard, que es lo que se quiere.
>
> **O3 — Las métricas "fuera de horario" de `/resumen` se registrarían en el lugar equivocado.** Los comprobantes fuera de horario **no los sube `messageHandler`**: los encola como pending ([src/handlers/messageHandler.js:273-330](src/handlers/messageHandler.js#L273-L330)) y los sube **después** el `pendingProcessor`, ya dentro de horario. Si `recordUpload()` vive solo en el path de upload de `messageHandler`, el contador "fuera de horario" queda en ≈0 y esos comprobantes se contarían como "en horario". Además hay **tres** puntos de éxito de subida, no uno:
> - upload normal: [src/handlers/messageHandler.js:353](src/handlers/messageHandler.js#L353)
> - PDF multipágina en horario: [src/handlers/messageHandler.js:174](src/handlers/messageHandler.js#L174)
> - pendingProcessor (los de fuera de horario): [src/services/pendingProcessor.js:120](src/services/pendingProcessor.js#L120)
>
> **Sugerencia:** llamar `recordUpload()` en los tres sitios, y derivar `inBusinessHours` del **timestamp original del mensaje** (vía `businessCalendar.isWithinBusinessHours`), no del momento de procesamiento. El dato del mensaje original ya viaja en `appProperties` del pendiente, así que se puede recuperar al procesarlo.
>
> **O4 — Hoy ningún grupo "recibe" comandos; el handler descarta texto sin media.** [src/handlers/messageHandler.js:64-75](src/handlers/messageHandler.js#L64-L75) hace early-return si el chat no está en `config.whatsapp.groups` y, más abajo ([:75](src/handlers/messageHandler.js#L75)), si el mensaje no tiene media. Un comando de texto en el grupo de control moriría en esos returns. **Sugerencia:** la detección de comandos debe ir **antes de ambos returns** — apenas se obtiene el `chat`, chequear si `chat.name === config.whatsapp.controlGroupName` y si el body empieza con `/`, y delegar a `commandHandler` antes de cualquier lógica de comprobantes.
>
> **O5 — El masking de `/bloqueados` no coincide con la función real.** El ejemplo muestra `+54 381 512-XXXX`, pero `maskPhone()` ([src/utils/mask.js:20-24](src/utils/mask.js#L20-L24)) devuelve el formato `phone_****3456` (oculta todo menos los últimos 4). **Sugerencia:** usar `maskPhone()` o `getPhoneSuffix()` ya existentes y alinear el ejemplo, o explicitar que se quiere un formatter nuevo.
>
> **O6 — Reset diario de stats: hay un hook natural, o hacerlo lazy.** El notifier ya detecta el inicio de jornada en `checkOperationalTransition` ([src/services/operationalNotifier.js:393-419](src/services/operationalNotifier.js#L393-L419)). Pero más simple aún: que `statsStore` guarde la business-date y **rote de forma lazy** al leer/escribir si cambió el día. Evita acoplar a un scheduler. _Sugerencia: modelo lazy._
>
> **O7 — Horario real: el default es 09:00–16:30, no 09:00–15:00.** [src/utils/businessCalendar.js:8](src/utils/businessCalendar.js#L8). No hay `business-calendar.json` en el repo local (producción puede definir otro vía `BUSINESS_CALENDAR_PATH`). El mock de `/resumen` usa "09:00–15:00" como ilustración. **`/resumen` debe imprimir la ventana realmente configurada** (leída de `businessCalendar`), nunca un literal. _Conviene confirmar con el equipo el horario real de producción._
>
> **O8 — Escritura atómica del `statsStore`.** Seguir el patrón de CLAUDE.md §12 / `processedStore` (escribir a `.tmp` → `fs.renameSync`). El spec no lo mencionaba; aplica también a los caches de MOD-01/02.
>
> **O9 — El grupo de control hay que crearlo y agregar el bot.** Ver el prerrequisito operativo detallado en **MOD-03** (mismo grupo, misma variable `WHATSAPP_CONTROL_GROUP_NAME`).

---

### MOD-05 — Informe semanal automatizado de errores via Claude API

**Estado:** `especificado — listo para implementar`
**Tipo:** `nueva funcionalidad`

**Descripción:**
> Todos los viernes a hora configurable, el bot recopila los eventos no exitosos de la semana desde `errors.log`, los sanitiza, y los envía a la API de Anthropic (Claude) para obtener un diagnóstico técnico y propuestas de mejora. El informe resultante se envía al grupo de administración en WhatsApp. La información enviada a Anthropic contiene únicamente descripciones técnicas de errores — sin teléfonos, nombres de clientes ni datos sensibles.

---

**Comportamiento actual:**

> El bot escribe errores en `errors.log` (path configurable via `LOG_ERRORS_PATH`) y en consola. No existe ningún mecanismo de análisis ni resumen periódico. Los errores acumulados solo se pueden revisar accediendo manualmente al archivo de log en el Volume de Railway.

---

**Comportamiento esperado:**

> **Trigger semanal:**
> - Todos los viernes a la hora configurada en `WEEKLY_REPORT_HOUR` (default: `18`, hora Argentina según `BOT_TIME_ZONE`).
> - El bot verifica el trigger mediante un scheduler interno (similar al patrón de `pendingProcessor` con `setInterval`). Chequea cada hora si es viernes y si el reporte de esa semana ya fue enviado (para evitar duplicados ante reinicios).
> - Estado de "reporte ya enviado esta semana" se guarda en disco: `/data/weekly-report-state.json` → `{ "lastReportDate": "YYYY-MM-DD" }`.
>
> **Recopilación y sanitización de logs:**
> 1. Leer `errors.log` de los últimos 7 días (filtrar por timestamp desde el lunes de la semana actual).
> 2. Parsear cada línea de log extrayendo: timestamp, tipo de evento (`eventType`), mensaje de error, y contexto técnico disponible.
> 3. Sanitizar completamente antes de enviar a Anthropic:
>    - Aplicar `maskPhone()` a cualquier número de teléfono.
>    - Aplicar `maskSensitiveText()` a nombres de grupos y campos de contexto.
>    - Conservar: `eventType`, mensaje técnico del error (stack sin paths absolutos), conteo de ocurrencias, timestamps relativos (día de la semana, no fecha exacta).
>    - Nunca enviar: números de clientes, nombres reales de grupos, IDs de Drive, paths del sistema.
> 4. Agrupar errores por `eventType`, contar frecuencia, identificar el más frecuente y el más reciente.
>
> **Payload enviado a Claude API:**
> ```
> Sos un asistente técnico analizando logs de errores de un bot de WhatsApp que sube comprobantes de transferencia a Google Drive.
>
> Errores de la semana (sanitizados):
> - drive_upload_failed: 3 ocurrencias. Último: "Request failed with status 429". Días: martes, miércoles, jueves.
> - pdf_conversion_failed: 1 ocurrencia. Error: "spawn pdftocairo ENOENT".
> - pending_enqueue_failed: 2 ocurrencias. Error: "Cannot read properties of undefined".
>
> Por cada tipo de error: (1) diagnóstico probable, (2) propuesta de fix o mitigación, (3) prioridad sugerida (alta/media/baja).
> Respuesta en español, formato estructurado, sin código.
> ```
>
> **Respuesta de Claude → informe final:**
> El informe se envía al grupo de administración en WhatsApp como mensaje de texto con formato legible. Si el informe es largo (> 4000 caracteres), se divide en mensajes o se adjunta como archivo `.txt`.
> Destino adicional (Drive, archivo local, etc.): decisión de Facundo.
>
> **Si no hay errores en la semana:**
> El bot envía al grupo de admin: `"✓ Informe semanal: sin errores registrados esta semana."` Sin llamada a la API de Anthropic.
>
> **Si la API de Anthropic falla:**
> El bot envía al grupo de admin el resumen de errores crudo (sin análisis de Claude) con nota: `"(análisis de Claude no disponible — API no respondió)"`.

---

**Archivos involucrados:**

> **Nuevos:**
> - `src/services/weeklyReportService.js` — orquesta el ciclo completo: trigger, lectura de logs, sanitización, llamada a Claude API, envío del informe.
> - `src/utils/logParser.js` — parsea líneas de `errors.log` en objetos estructurados `{ timestamp, eventType, message, context }`.
>
> **Modificados:**
> - `src/config/env.js` — nuevas variables de entorno.
> - `index.js` — inicializar y arrancar el scheduler de `weeklyReportService`.
> - `.env.example` — documentar variables nuevas.

---

**Variables de entorno nuevas / modificadas:**

> | Variable | Descripción | Default |
> |---|---|---|
> | `ANTHROPIC_API_KEY` | API key de Anthropic para llamar a Claude | — (requerida para activar MOD-05) |
> | `ANTHROPIC_MODEL` | Modelo de Claude a usar para el análisis | `"claude-haiku-4-5-20251001"` |
> | `WEEKLY_REPORT_ENABLED` | Activar/desactivar el reporte semanal | `"true"` |
> | `WEEKLY_REPORT_HOUR` | Hora del día (0–23) en que se envía el informe los viernes | `"18"` |
> | `WEEKLY_REPORT_LOOKBACK_DAYS` | Días hacia atrás que cubre el análisis | `"7"` |

---

**Notas para Facundo:**

> **1. Modelo recomendado:** `claude-haiku-4-5-20251001` — es el modelo más económico y rápido de la familia Claude 4.x. Para análisis de logs de texto estructurado es más que suficiente. Si se quiere análisis más profundo, usar `claude-sonnet-4-6`. Nunca Opus para esta tarea (costo desproporcionado).
>
> **2. Estimación de costo:** un log de ~50 errores agrupados en ~500 tokens de input + ~800 tokens de output ≈ U$D 0.001 por ejecución con Haiku. Prácticamente gratuito.
>
> **3. SDK de Anthropic:** instalar `@anthropic-ai/sdk`. Uso básico:
> ```js
> const Anthropic = require('@anthropic-ai/sdk');
> const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
> const message = await client.messages.create({
>   model: 'claude-haiku-4-5-20251001',
>   max_tokens: 1024,
>   messages: [{ role: 'user', content: prompt }]
> });
> ```
>
> **4. Deuda técnica relevante:** `alerts.log` no está implementado (ver CLAUDE.md §11). El reporte trabaja con `errors.log` que sí existe. Si en el futuro se implementa `alerts.log`, ampliarlo para incluir warnings también.
>
> **5. Scheduler interno vs cron externo:** Railway no expone cron nativo para el container. El patrón actual del bot (setInterval en `pendingProcessor`) es el camino natural. Chequear hora cada 60 minutos es suficiente; el estado en `/data/weekly-report-state.json` previene duplicados si el bot se reinicia el viernes.
>
> **6. Formato de `errors.log`:** verificar el formato actual de líneas antes de escribir el parser. El logService existente escribe cada evento como JSON en una línea (NDJSON) o como texto plano — revisar `src/services/logService.js` para confirmar el formato y ajustar `logParser.js` en consecuencia.
>
> **7. Destino adicional del informe:** ChuecoTriquis mencionó que puede convenir guardarlo también en un lugar más operativo (Drive, archivo, etc.). Decisión de Facundo según lo que sea más práctico para el equipo.

---

**⚠️ Observaciones verificadas contra el código (sugerencias):**

> **O1 — `errors.log` NO tiene campo `eventType`. Esto afecta el corazón de MOD-05 (y de `/errores` en MOD-04).** El informe agrupa por tipo de error (`drive_upload_failed: 3 ocurrencias`...), pero el log actual no guarda ese tipo. [src/services/logService.js:55-69](src/services/logService.js#L55-L69) escribe TSV:
> ```
> timestamp ⇥ grupo ⇥ tag ⇥ filename ⇥ drivePath ⇥ sender ⇥ "ERROR: <mensaje>"
> ```
> Los `eventType` (`drive_upload_failed`, `pdf_conversion_failed`, etc.) **solo existen en las llamadas a `operationalNotifier.notifyError(eventType, ...)`** — que van al grupo de alertas de WhatsApp, NO al archivo. Se ve en [src/handlers/messageHandler.js:208-231](src/handlers/messageHandler.js#L208-L231): `logService.errorEvent()` (sin eventType) y `notifySafely(...,'drive_upload_failed',...)` son dos llamadas distintas.
>
> **Sugerencia (recomendada):** como parte de MOD-05, modificar `logService.errorEvent()` para que **persista también el `eventType`** en el log (el handler ya lo tiene a mano; solo hay que pasárselo en el payload del evento). Es un cambio chico y habilita el agrupamiento limpio. Alternativa sin tocar logService: clusterizar por el texto del mensaje de error (más frágil).
>
> **O2 — `errors.log` tiene formato MIXTO.** Además del TSV de `errorEvent()`, [src/index.js:124](src/index.js#L124) y [src/index.js:143](src/index.js#L143) escriben con `logService.error(line)` un formato distinto (timestamp ISO + token tipo `unhandledRejection`/`whatsapp_initialize`). El parser (`logParser.js`) debe tolerar ambas formas.
>
> **O3 — Los duplicados contaminan `errors.log`.** [src/services/logService.js:71-82](src/services/logService.js#L71-L82) (`duplicateEvent`) escribe en el **mismo** `errors.log` líneas `duplicate_ignored` / `DUPLICATE:`. No son errores. **El parser debe descartarlas** para no inflar el conteo del informe.
>
> **O4 — El timestamp del log es hora local + nombre de zona, no ISO.** Vía `buildAuditTime` ([src/utils/time.js:38-45](src/utils/time.js#L38-L45)) → formato `"YYYY-MM-DD HH:mm:ss America/Argentina/Buenos_Aires"`. El filtro "últimos 7 días / desde el lunes" debe parsear ese formato local (las líneas del path mixto de O2 sí traen ISO). Tenerlo en cuenta en `logParser.js`.
>
> **O5 — `@anthropic-ai/sdk` no está instalado.** [package.json:12-17](package.json#L12-L17) no lo lista. Correcto pedir `npm install @anthropic-ai/sdk` (nota 3). El id `claude-haiku-4-5-20251001` es válido y vigente.
>
> **O6 — `src/index.js`, no `index.js`** para arrancar el scheduler (igual que los demás MODs).

---

---

## Checklist de entrega

- [ ] Todos los cambios validados con `node --check`
- [ ] `.env.example` actualizado si hay variables nuevas
- [ ] `README.md` actualizado si cambia algún flujo
- [ ] `AGENTS.md` actualizado si hay nuevas reglas operativas
- [ ] Sin secretos, credenciales ni datos reales en el código
- [ ] Sin `npm start` ni `npm run auth` ejecutados sin aprobación

---

---

## Resumen de estado

| MOD | Título | Estado |
|---|---|---|
| MOD-01 | Grupos y TAGs dinámicos desde Sheets | ✅ especificado |
| MOD-02 | Blacklist dinámica desde Sheets | ✅ especificado |
| MOD-03 | Difusión masiva a grupos | ✅ especificado |
| MOD-04 | Comandos en grupo de control | ✅ especificado |
| MOD-05 | Informe semanal via Claude API | ✅ especificado |

*Documento generado: 2026-06-11 — Claudia Seria / ChuecoTriquis*
*Última actualización: 2026-06-11*
