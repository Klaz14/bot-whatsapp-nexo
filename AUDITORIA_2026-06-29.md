# Auditoría de estado — Bot WhatsApp Nexo (2026-06-29)

> Auditoría exhaustiva del estado real del código (no solo de los `.md`): qué dejó Facundo
> implementado, conectado y configurado, vs. qué quedó solo en spec o dormido.
> Generada cruzando SPEC_CAMBIOS / SPEC_ROBUSTEZ / PLAN_FASE0 contra el código real,
> con verificación adversarial de cada hallazgo crítico (43 agentes, 10 dimensiones).

## Resumen ejecutivo

- **El bot corre 100% en modo LEGACY.** Lee grupos/TAGs de `config.json` (54 grupos) y la blacklist de `blocked-senders.json` en disco. Ninguna de las planillas de Google Sheets está conectada en runtime.
- **4 de las 5 MODs están DORMIDAS puramente por configuración, no por bugs.** El código existe y está bien cableado; faltan tres env vars en Railway: `GOOGLE_SHEETS_ID` (MOD-01), `GOOGLE_SHEETS_BOT_CONFIG_ID` (MOD-02) y `WHATSAPP_CONTROL_GROUP_NAME` (MOD-03 + MOD-04 completo). Un mismo gate apaga `/broadcast` y los 10 comandos del grupo de control.
- **MOD-05 (informe semanal) es el único MOD con el scheduler PRENDIDO** (default `WEEKLY_REPORT_ENABLED=true`), pero corre castrado: sin `ANTHROPIC_API_KEY` envía el resumen crudo sin análisis IA, y sin grupo admin configurado el informe puede generarse y perderse en silencio.
- **La capa Fase 0 de Facundo (confiabilidad) SÍ está activa.** A diferencia de las MODs, no depende de Sheets ni de env vars: defaults sanos, se prende sola al deployar. Reencolado durable, backpressure p-limit, watchdog/health, catch-up y retry inteligente están implementados y conectados. **Falta su smoke-test en runtime real.**
- **Las deudas P4/P5/P6 de CLAUDE.md §11 ya están RESUELTAS** por la Fase 0, pero el doc no se actualizó. También está obsoleto el "código muerto" de §11 (buildUploadFilename, getOrCreateFolder, folderCache: ya no existen) y la frase "sin tests automatizados" (hay `npm test`).
- **Las 6 mejoras de SPEC_ROBUSTEZ (R1-R6) siguen sin implementar.** El repo está igual que el día del incidente del 23/06: patch HTTPS duplicado por copy-paste, sin cleanup de Singleton locks (la causa real del outage), sin documentar el acople a googleapis.
- **MATIZ corregido por verificación:** `BOT_DRY_RUN` SÍ funciona (se chequea en ~13 puntos de `driveService.js`). El finder original lo había marcado mal como config muerta.

---

## Las 5 MODs (SPEC_CAMBIOS)

| MOD | Código | Conectado | Configurado en prod | Estado neto | Qué falta para activar |
|---|---|---|---|---|---|
| **MOD-01** Grupos/TAGs desde Sheets | ✅ (solo match exacto; el ambiguo/scoring está diferido) | ✅ (init en index.js, lookup en messageHandler, auto-recarga) | ❌ | 🟡 **Dormido por config** | Setear `GOOGLE_SHEETS_ID` + `GOOGLE_SHEETS_CREDENTIALS_PATH` (Service Account), con el JSON del SA en `/data` y la planilla compartida como Viewer |
| **MOD-02** Blacklist/exentos desde Sheets | ✅ (completo; usa `canonicalizePhone`, más robusto que el spec) | ✅ (blacklistCache wired al handler) | ❌ | 🟡 **Dormido por config** | Setear `GOOGLE_SHEETS_BOT_CONFIG_ID` + el mismo SA; compartir la planilla nueva |
| **MOD-03** Difusión `/broadcast` | ✅ (preview, CONFIRMAR/CANCELAR, timeout, delay, reporte) | ✅ (creación condicional + ruteo desde grupo de control) | ❌ | 🟡 **Dormido por config** | Setear `WHATSAPP_CONTROL_GROUP_NAME` y tener el grupo de control creado con el bot adentro |
| **MOD-04** Comandos del grupo de control + statsStore | ✅ (10 comandos + `/auditoria` extra; statsStore con rotación lazy) | ✅ (dispatch wired; statsStore PRENDIDO sin gate) | ❌ (comandos) / ✅ (statsStore) | 🟡 **Comandos dormidos por config** | Mismo gate: `WHATSAPP_CONTROL_GROUP_NAME`. El `statsStore` ya escribe métricas, solo sus lectores están dormidos |
| **MOD-05** Informe semanal vía Claude API | ✅ (fetch nativo, modelo Haiku 4.5, dedupe en disco) | ✅ (scheduler arranca en `ready`, default ON) | 🟡 parcial | 🟡 **Scheduler ON, análisis IA y entrega en duda** | Setear `ANTHROPIC_API_KEY` (para análisis IA) + grupo admin (`WHATSAPP_CONTROL_GROUP_NAME` o `WHATSAPP_ALERT_*`) para que el informe se entregue |

**Notas sobre MOD-01:** el match ambiguo/parcial con scoring, la consulta interactiva al grupo de control y el `pendingMatches`/`manualMatch` **no están implementados** (diferidos explícitamente en el header de `groupMatcher.js`). Solo existe match exacto. También faltan: el fallback runtime de TAG inválido (sube con nombre sanitizado), el log de arranque O4 (sigue mostrando `config.json` legacy), el formato CSV de `/grupos`, y dos env vars del spec (`SHEETS_MATCH_MIN_SCORE`, `SHEETS_MATCH_PENDING_TIMEOUT_HOURS`) que dependen del scoring no implementado.

**MOD-02 — riesgo latente al activar:** el "tercer nivel de fallback" de la nota 4 del spec **no se implementó**. Con MOD-02 activo + Sheets caída + cache de disco ausente, la blacklist queda VACÍA (nadie bloqueado) en silencio, sin caer a `blocked-senders.json`. Hoy es inocuo (MOD-02 dormido), pero hay que tenerlo presente al prenderlo.

---

## Capa Fase 0 (confiabilidad — lo extra de Facundo)

| Pieza | Estado | Evidencia/nota |
|---|---|---|
| **Reencolado durable** (upload en vivo agota reintentos → pending, cierra P5) | ✅ Implementado y conectado | `messageHandler.js:167` `enqueueToPending()`, invocado en el catch del upload (`:483`, reason `upload_live`). No marca processed; lo cierra el pendingProcessor al subir OK |
| **Reencolado de PDF crudo** si falla la conversión (F0.2) | ✅ Implementado y conectado | `messageHandler.js:351` encola el PDF original; pendingProcessor re-rasteriza (`:84-92`). Dockerfile instala poppler. **Salvedad:** el fallo PARCIAL de multipágina NO se reencola (decisión consciente, deuda P2) |
| **Backpressure p-limit en el handler** (HANDLER_CONCURRENCY, cierra P6) | ✅ Implementado y conectado | `index.js:255` `pLimit(config.concurrency.handler)`; `:301` envuelve `messageHandler`. Default 3. Lock `inFlight` Set cierra la race intra-proceso |
| **Semáforo PDF** (PDF_CONCURRENCY, cierra P4) | ✅ Implementado y conectado | `pdfConverter.js:18-23` `pLimit(...||2)`. **Detalle:** `PDF_CONCURRENCY` se lee directo de `process.env`, no vía `env.js` (rompe la convención de config centralizada; cosmético) |
| **Auto-recuperación: /health** con estado real de WhatsApp | ✅ Implementado y conectado | `index.js:346` `startHealthServer()` arranca SIEMPRE; `railway.toml:12-13` `healthcheckPath=/health`. Pendiente confirmar 200 en runtime |
| **Auto-recuperación: exit-on-disconnect + watchdog** | ✅ Implementado y conectado | `index.js:224-227` exit(1) diferido si `reason!=LOGOUT`; watchdog cada 60s, exit tras 2 fallos. `railway.toml` `restartPolicyType=ON_FAILURE`. **Depende de F0.6:** la sesión debe vivir en `/data` o el restart pediría QR |
| **Catch-up de outage al arranque** (F0.5) | ✅ Implementado y conectado | `index.js:410-439`, diferido tras `ready`. Default ON. **Limitaciones:** solo cubre `windowMinutes` (30 min) y `fetchLimit` (50 msgs/grupo); outages largos requieren `recoverWindow.js` manual. Filtra por `config.whatsapp.groups`, NO por groupsCache → inconsistencia latente si se activa Sheets |
| **Retry inteligente de Drive** (status code + Retry-After + jitter) | ✅ Implementado y conectado | `driveRetry.js`: `isRetryableDriveError` (408/429/5xx + red), `retryWaitMs` respeta Retry-After, backoff con jitter cap 60s. Usado en single y multipágina. Propaga permanentes sin gastar reintentos |
| **Acuse visual 👍 / 🕒** | ✅ Implementado y conectado | `messageHandler.js` `reactSafe()`, default `REACT_ON_PROCESSED=true`, best-effort |
| **Validación runtime (smoke-test)** | ❓ Desconocido | `node --check` OK en los 8 archivos clave; `npm test` (offline) pasa 14/14. Pero **nunca se corrió `npm start` ni se conectó a WhatsApp/Drive.** El comportamiento dinámico (exit real, /health 200, catch-up reencaminando, OOM bajo ráfaga) NO está confirmado |

---

## Robustez pendiente (SPEC_ROBUSTEZ R1-R6)

| R | Tarea | Estado | Nota |
|---|---|---|---|
| **R1** | Auto-cleanup de Singleton locks de Chromium antes de `initialize()` | ❌ No | **La única R que cierra la causa real del outage del 23/06.** No existe `src/utils/sessionLocks.js`. Agravante: el watchdog hace exit(1), un lock huérfano puede dar crash-loop "profile in use" |
| **R2** | Documentar el acople del patch HTTPS a googleapis en CLAUDE.md §11 | ❌ No | §11 no menciona el patch HTTPS ni el riesgo de regresión silenciosa al bumpear googleapis/gaxios |
| **R3** | Migrar las llamadas a Google a fetch nativo (cura de fondo del gzip) | ❌ No | Sigue en `googleapis ^144.0.0` con el monkey-patch global de `https.request` como único mecanismo. Deuda media, no bloqueante |
| **R4** | Extraer el patch HTTPS a módulo compartido `httpsIdentityPatch.js` | ❌ No | El patch sigue **duplicado byte-a-byte** en `index.js:10-25` y `recoverWindow.js:6-21`. Riesgo de drift |
| **R5** | Clasificar `premature`/`ERR_STREAM_PREMATURE_CLOSE` como reintentable en driveRetry | ❌ No | Cambio de una línea. Hoy un "Premature close" que se escape del patch se clasifica como permanente y el pendiente queda trabado |
| **R6** | Monitoreo externo de /health + alerta de caída | ❓ Desconocido (en repo: no hecho) | El endpoint `/health` ya existe (de F0.4). La doc en DEPLOYMENT.md no se escribió. El alta del monitor (UptimeRobot) es infra fuera del repo |

---

## Features dormidas por configuración (lista accionable, orden de impacto)

1. **`WHATSAPP_CONTROL_GROUP_NAME`** → prende de un saque **MOD-03 (`/broadcast`) + MOD-04 completo (los 10 comandos)**. Es el gate de mayor impacto: un solo valor desbloquea toda la operación interactiva. Prerrequisito: el grupo de control debe existir físicamente con el bot adentro (por el bug histórico del operationalNotifier, agregarlo ANTES de configurarlo).
2. **`GOOGLE_SHEETS_ID` + `GOOGLE_SHEETS_CREDENTIALS_PATH`** → prende **MOD-01** (grupos/TAGs dinámicos desde Sheets, sin redeploy). Requiere el JSON del Service Account en `/data` y la planilla compartida como Viewer con el email del SA. Activa también la auto-recarga periódica (`SHEETS_RELOAD_MINUTES`).
3. **`GOOGLE_SHEETS_BOT_CONFIG_ID`** (+ mismo SA) → prende **MOD-02** (blacklist/exentos desde la planilla nueva). Ojo con el fallback de tercer nivel ausente (ver nota MOD-02).
4. **`ANTHROPIC_API_KEY`** → prende el **análisis IA del informe semanal (MOD-05)**. Sin esto el scheduler igual corre pero manda resumen crudo. Para que el informe se entregue, además hace falta un grupo admin resuelto.

**Importante sobre las cache paths:** `SHEETS_GROUPS_CACHE_PATH` / `SHEETS_BLACKLIST_CACHE_PATH` que SÍ están en Railway son solo rutas de cache; **existir no activa nada**. El gate real es el `*_ID` correspondiente, que NO está presente.

**A verificar en Railway (no se pudo confirmar desde el repo):**
- `PROCESSED_STORE_PATH` debe apuntar a `/data/...` o la idempotencia se pierde tras redeploy (`checkPersistencePaths` solo ALERTA, no previene). Mismo punto para la sesión WhatsApp (F0.6).
- `BOT_PROCESSING_ENABLED` debe estar en `true` (default), o el bot ignora todos los comprobantes.

---

## Código muerto y deuda técnica vigente

**Seguro de borrar / actualizar en CLAUDE.md §11 (ya no aplica):**
- `buildUploadFilename` y `maskSenderForFilename` — **ya no existen** en el repo. Entrada obsoleta.
- `getOrCreateFolder` y `folderCache` — **ya no existen**. La entrada "folderCache sin TTL" también es obsoleta (lo único cacheado es `folderLocks`, un Map de promesas para serializar subidas).
- Las entradas P4, P5, P6, "retry genérico" y el bug pre-ready del operationalNotifier están **RESUELTAS** por la Fase 0 → actualizar §11.
- "Sin tests automatizados" es **FALSO** hoy → corregir a "tests offline parciales (`npm test`), sin framework formal ni CI/coverage".
- "Pendientes de días anteriores no procesados" está **mayormente resuelto** (`listAllPendingFiles` no asume estructura de carpetas); mantener solo la nota de huérfanos fuera del root.

**Deudas que SIGUEN ABIERTAS:**
- **R1-R6 completas** (ver tabla arriba) — la prioridad real es R1 (Singleton locks).
- **Aliases redundantes en `businessCalendar.js`** (`shouldProcessNow`, `getPendingTargetDateForMessage`): código muerto confirmado, bajo impacto.
- **`alerts.log` sin implementar:** `config.paths.alertsLog` existe pero nadie escribe ahí; las alertas van solo a consola/WhatsApp/Telegram.
- **`logicalPath "//"`:** cosmético en logs, sin impacto funcional.
- **Fallo PARCIAL de PDF multipágina (P2):** las páginas que subieron quedan en Entrantes pero el comprobante NO se reencola para completar las faltantes (se evita duplicar). Riesgo: pérdida silenciosa de páginas, solo alerta. Requiere tracking por página.
- **`ALLOW_REAL_DRIVE_UPLOADS`:** se calcula en `env.js:237` pero **no se confirmó** que algún módulo lo respete antes de subir a Drive. Posible safety flag inerte — vale verificar.
- **Canal Telegram out-of-band:** config existe (`ALERT_TELEGRAM_*`), wiring no confirmado; presumiblemente dormido.
- **Patch de whatsapp-web.js:** deuda de mantenimiento por diseño; no se comparó `patches/Client.js` contra la versión instalada en esta auditoría.

---

## Cobertura de tests

**Lo que HAY:**
- `npm test` → `scripts/test-offline.js`: ~10 suites / 14 casos con `assert` nativo contra módulos reales (groupMatcher, normalizeTag, statsStore, blacklistCache, logParser, driveRetry incl. Retry-After, blockedSenders con el "9" argentino, getTagById homónimos, dedup notifier, sequence). Pasa 14/14 sin `node_modules`.
- `scripts/smoke-handler.js`: 3 casos con assert sobre el `createMessageHandler` real mockeado (invariante: el comprobante no se pierde).
- `scripts/smoke-boot.js`: bootea `startBot()` con credenciales dummy, `ALLOW_REAL_WHATSAPP_CONNECTION=false`, verifica que no crashea y que `/health` da 200.

**Lo que NO hay:**
- Framework formal (jest/mocha), medición de coverage ni CI. No existe `.github/workflows`.
- Los smoke-tests **no están cableados a `npm test`** — hay que correrlos a mano (`node scripts/smoke-*.js`).
- **Cero cobertura del flujo end-to-end real**: conexión WhatsApp/Drive, PDF real, pendingProcessor completo, catch-up, watchdog, exit-on-disconnect.

---

## Prioridades recomendadas para arrancar

**Fase A — Activar lo que ya existe (barato, alto impacto):**

1. **Setear `WHATSAPP_CONTROL_GROUP_NAME`** (con el grupo creado y el bot adentro primero). Una sola variable prende `/broadcast` + los 10 comandos operativos. Mejor ratio impacto/esfuerzo: cero código, desbloquea toda la operación interactiva y de diagnóstico (`/status`, `/resumen`, `/forzar`, `/errores`, `/auditoria`).
2. **Confirmar en Railway las vars de persistencia y seguridad** (`PROCESSED_STORE_PATH=/data/...`, sesión WhatsApp en `/data`, `BOT_PROCESSING_ENABLED=true`). Validación, no implementación, pero es la red de seguridad de la idempotencia y del auto-restart.
3. **Setear `ANTHROPIC_API_KEY`** para que el informe semanal traiga análisis IA. Verificar también que haya grupo admin resuelto.
4. **Activar MOD-01/MOD-02 (Sheets)** cuando el Service Account esté listo: `GOOGLE_SHEETS_ID`, `GOOGLE_SHEETS_BOT_CONFIG_ID`, `GOOGLE_SHEETS_CREDENTIALS_PATH`. Elimina el redeploy para cambiar grupos.

**Fase B — Implementar lo que falta (código, por prioridad):**

5. **R1 — cleanup de Singleton locks** antes de `initialize()`. Es la causa raíz del outage del 23/06 y se agrava con el watchdog (exit-on-disconnect → crash-loop). **Empezar acá entre las R.**
6. **R5 — clasificar `premature` como reintentable** en `driveRetry.js`. Cambio de una línea + un test; cierra una pérdida de comprobantes de bajo costo.
7. **R4 — extraer el patch HTTPS a módulo compartido** y **R2 — documentar el acople a googleapis**. Anti-drift y guardarrail documental; baratos.
8. **Antes de activar MOD-02 en serio: implementar el tercer nivel de fallback** (Sheets caída + cache ausente → caer a `blocked-senders.json`) para no quedar con blacklist vacía silenciosa.
9. **Limpieza de deuda:** actualizar CLAUDE.md §11 (borrar lo obsoleto), remover aliases redundantes de `businessCalendar.js`, verificar `ALLOW_REAL_DRIVE_UPLOADS`.

**Verificación transversal pendiente:** correr el smoke-test runtime (`npm start` autorizado en entorno controlado) para confirmar que la Fase 0 funciona en vivo. Hoy todo eso está conectado a nivel código pero no validado dinámicamente.
