# TABLERO DE TRABAJO — Bot WhatsApp Nexo

> Backlog vivo. Rama de trabajo: `dev`. Base: `AUDITORIA_2026-06-29.md`.
> Estado actual: bot ANDANDO en producción (Railway de Facundo), 100% modo LEGACY
> (grupos desde `config.json`, blacklist desde `blocked-senders.json`). 54 grupos + Recaudadora Santi.
> Regla: producción SOLO LECTURA. No commit/push/deploy sin OK explícito.

---

## 🎯 SCOPE ACORDADO — "código listo para migrar" (2026-07-01)

Estrategia: **Opción B** — nada se deploya al Railway de Facundo. Juntamos todas las mejoras en `dev`
y hacemos **un solo corte** en el Railway nuevo cuando llegue el chip.

**✅ CÓDIGO LISTO PARA MIGRAR — Bloques 1 + 2 CERRADOS (2026-07-05). Tests 23/23 · `node --check` OK en todo `src/` y `scripts/`.**

- **Bloque 1 — Blindaje del incidente:** R1 ✅ · R5 ✅ · R4 ✅ · R2 ✅
- **Bloque 2 — Deudas / robustez extra:** B1/I1 ✅ · B2 ✅ · B3 ✅ · B4 ✅ (verificado) · I2 alertas + aviso post-caída ✅
- **R3 (fetch nativo): POST-MIGRACIÓN.** Grande y riesgoso, y el patch HTTPS ya lo mitiga. No entra al corte.
- **Bloque 3 (limpieza D1-D3):** opcional, si sobra tiempo.

**Nada deployado — todo en `dev`, sin commit.** Lo que RESTA no es código: (1) activar features vía env vars —con sus prerrequisitos— y (2) monitor externo (infra). Ver secciones de abajo.

---

## 🚚 MIGRACIÓN A RAILWAY NUEVO (prioridad: preparar TODO antes de que llegue el chip)

Objetivo: dejar el Railway destino listo para que, cuando llegue el chip, el corte sea mínimo y fuera de horario.

- [ ] **M1** — Crear/preparar el proyecto en el Railway nuevo (con plan que soporte Volume `/data` persistente)
- [ ] **M2** — Conectar el repo de GitHub al Railway nuevo
- [ ] **M3** — Copiar las 47 env vars del Railway de Facundo → al nuevo (tenemos acceso de lectura al de Facundo)
- [ ] **M4** — Preparar la migración del Volume `/data`: `config.json`, `.wwebjs_auth/` (sesión WhatsApp), `processed-messages.json`, `business-calendar.json`, `token.json`
- [ ] **M5** — Coordinar la ventana de corte con la llegada del chip → **fuera de horario / finde**
- [ ] **M6** — Al migrar: re-escaneo de QR (si la sesión no viaja limpia) desde el teléfono que tenga el número

> ⚠️ El corte real del bot ocurre al **reactivar el número en un teléfono nuevo**, no al sacar el chip. Ver conversación.

---

## ⚙️ COSAS QUE FALTA SETEAR (env vars — activan features ya programadas)

Todo el código existe y está cableado. Estas variables lo prenden. Detalle en `AUDITORIA_2026-06-29.md`.

- [ ] **C1** — `WHATSAPP_CONTROL_GROUP_NAME` → prende **MOD-03 (`/broadcast`) + MOD-04 (los 10 comandos)** de un saque. ⭐ Mayor impacto/esfuerzo.
  - ✅ **DECIDIDO (2026-07-05):** el grupo de control será **"BOT TEST"** (nombre exacto) — el mismo grupo de alertas/errores actual (donde el bot ya manda los errores). Se nuclea todo ahí: comandos + alertas + errores + aviso post-caída.
  - ✅ **Prerrequisito YA cumplido:** el bot **ya es miembro** de ese grupo → setear la var es SEGURO (no dispara el bug del operationalNotifier que bloquea el `ready` con grupos nuevos). Igual conviene un smoke test tras setearla.
- [ ] **C2** — `GOOGLE_SHEETS_ID` + `GOOGLE_SHEETS_CREDENTIALS_PATH` → prende **MOD-01** (grupos/TAGs desde Sheets, sin redeploy). Requiere Service Account + planilla compartida como Viewer.
  - ✅ **DECIDIDO (2026-07-05):** el Service Account se crea bajo la cuenta de **Google Cloud de Fede** (el dueño; proyecto `ScoringInfoExpert` o uno nuevo dedicado). Correcto por gobernanza — los recursos van bajo el dueño, no bajo el empleado. (@nexotuc.com es Hostinger, no sirve para Google Cloud.)
- [ ] **C3** — `GOOGLE_SHEETS_BOT_CONFIG_ID` (+ mismo SA) → prende **MOD-02** (blacklist/exentos desde Sheets).
- [ ] **C4** — `ANTHROPIC_API_KEY` → prende el análisis IA del **informe semanal (MOD-05)**. El scheduler ya corre.
- [ ] **C5** — Verificar en Railway: `PROCESSED_STORE_PATH=/data/...` (o se pierde la idempotencia tras redeploy)
- [ ] **C6** — Verificar en Railway: `BOT_PROCESSING_ENABLED=true` (o el bot ignora todo)
- [ ] **C7** — Verificar en Railway: sesión WhatsApp persistida en `/data` (o el restart pide QR)

> Nota: `SHEETS_GROUPS_CACHE_PATH` / `SHEETS_BLACKLIST_CACHE_PATH` YA están en Railway pero **no activan nada** — el gate real es el `*_ID`.

---

## 🔴 PROBLEMAS A TRATAR (código — de la auditoría)

Robustez pendiente (SPEC_ROBUSTEZ R1-R6, ninguna implementada) + deudas abiertas.

- [x] **R1** ✅ **HECHO en `dev` (sin deploy)** — Auto-cleanup de Singleton locks de Chromium al arrancar. Nuevo `src/utils/sessionLocks.js` (`clearSingletonLocks`, best-effort recursivo) + llamada en `src/index.js` antes de `client.initialize()`. Test en `scripts/test-offline.js` (15/15 OK). Replica en código el fix manual `find /data/.wwebjs_auth/ -name "Singleton*" -delete`. **Falta:** smoke-test runtime al deployar (que el bot arranque tras borrar locks reales).
- [x] **R5** ✅ **HECHO en `dev`** — `premature`/`ERR_STREAM_PREMATURE_CLOSE` agregado a `RETRYABLE_NET_RE` en `src/utils/driveRetry.js` + test. Ahora un premature close se reintenta con backoff en vez de fallar permanente.
- [x] **R4** ✅ **HECHO en `dev`** — patch HTTPS extraído a `src/utils/httpsIdentityPatch.js` (idempotente) + aplicado en `src/index.js` y `scripts/recoverWindow.js` (se eliminó la duplicación) + 2 tests.
- [x] **R2** ✅ **HECHO en `dev`** — entrada en CLAUDE.md §11 sobre el acople del patch HTTPS a `googleapis` (regla anti-bump + smoke test) + comentario en el propio módulo.
- [~] **R6** 🟢 — Alertas de caída (DECIDIDO 2026-07-01). Reboot se deja como está (Railway lo maneja).
  - [x] ✅ **Bot vivo con error** → alertas enriquecidas (I2, hecho). **Bot que revivió** → aviso post-caída (hecho, ver I2 en Ideas).
  - [ ] **Bot caído AHORA** (código imposible por WhatsApp) → **monitor externo** (UptimeRobot, gratis) que pinguea `/health` cada 1-5 min 24/7 y avisa por mail; opcional Telegram (`ALERT_TELEGRAM_*`). **Es INFRA, no código** — se configura en la migración.
- [ ] **R3** 🟡 — Migrar llamadas a Google a `fetch` nativo (cura de fondo del gzip). **POST-MIGRACIÓN (fuera del paquete)** — grande/riesgoso, ya mitigado por el patch HTTPS. Con tiempo y smoke test.
- [x] **B1/I1** ✅ **HECHO en `dev`** — catch-up con 2 modos. **Estándar** (caída corta): ventana `CATCHUP_WINDOW_MINUTES` (30 min). **Manual** (caída larga): `CATCHUP_SINCE="YYYY-MM-DD HH:mm"` (hora local Argentina) recupera desde esa hora con límite alto (`CATCHUP_MANUAL_FETCH_LIMIT`, 500). Parser con timezone en `utils/time.js` + test. Uso eventual: setear var → reiniciar → recupera → borrar var. A futuro: comando `/recuperar` cuando esté el grupo de control (C1).
- [x] **B2** ✅ **HECHO en `dev`** — reintento en vivo del fallo parcial de PDF multipágina. Si suben algunas páginas y otras fallan, reintenta SOLO las faltantes reusando el mismo ID (`uploadPdfPagesWithRetry` parametrizada con `onlyPages`+`baseId`); si completan → 👍 + procesado; si aún faltan → alerta con el detalle (grupo, ID, páginas). Ya no se pierden páginas en silencio. Validado con `node --check` + revisión; prueba funcional en smoke runtime (requiere poppler/Drive).
- [x] **B3** ✅ **HECHO en `dev`** — `loadFromDisk()` de blacklistCache cae a `blocked-senders.json` + `BLACKLIST_EXEMPT_GROUPS_JSON` si no hay cache de Sheets (o está corrupto). Ya no arranca con blacklist vacía silenciosa. 2 tests. Blinda antes de activar MOD-02.
- [x] **B4** ✅ **VERIFICADO — no era bug.** `allowRealDriveUploads` SÍ se respeta en 13 puntos de `driveService.js` (`if config.dryRun || !allowRealDriveUploads` antes de cada subida). El flag funciona; la auditoría lo tenía como "no confirmado". Sin cambios de código.

---

## 🟡 MODIFICACIONES EN STAND-BY (features a activar / mejoras)

- [ ] **F1** — Activar MOD-03 + MOD-04 (comandos operativos: `/status`, `/resumen`, `/forzar`, `/errores`, `/broadcast`...). Depende de **C1**.
- [ ] **F2** — Activar MOD-01/MOD-02 (config desde Sheets, sin redeploy para agregar grupos). Depende de **C2/C3** + Service Account.
- [ ] **F3** — Activar análisis IA del informe semanal. Depende de **C4**.

---

## 💡 IDEAS NUEVAS (de ChuecoTriquis, 2026-06-30)

- [x] **I1 — Recuperación robusta tras caída** ✅ **HECHO (= B1).** 2 modos: automático (30 min) para caídas cortas + manual `CATCHUP_SINCE` desde una hora específica para caídas largas.
  - **Decisión técnica aplicada:** NO se usa el 👍 como memoria del bot (frágil). La fuente de verdad es `processedStore` en disco. El 👍 queda como feedback visual para humanos.
- [~] **I2 — Mejorar el feedback de errores** ("saber qué pasó, dónde, qué grupo").
  - [x] ✅ **HECHO en `dev`** — enriquecimiento de alertas: etiquetas ES (Grupo/Cartera/Comprobante/Acción), orden priorizado, y campo **Acción** en cada error de comprobante (reencolado / subido-ok / EN RIESGO). En `formatAlertMessage` + los call sites del handler. Test en test-offline.
  - [x] ✅ **HECHO en `dev`** — **Aviso post-caída**: latido persistido (`heartbeatStore` en `/data`) + al revivir, si el downtime supera el umbral (5 min), avisa a los grupos de estado "Bot reiniciado, estuvo sin actividad ~X min (desde HH:MM)". `notifyRecovery` en el notifier + 2 tests.
  - [ ] Activar el comando `/errores` — **el código YA existe (MOD-04)**; solo requiere el grupo de control (C1 = config, no código).
  - Nota: `alerts.log` declarado en config pero NO se escribe (deuda menor) → decidir si se implementa o se quita.

---

## 🧹 LIMPIEZA DE DEUDA DOCUMENTAL (bajo riesgo, cuando haya tiempo)

- [ ] **D1** — Actualizar CLAUDE.md §11: P4/P5/P6 y bug operationalNotifier YA están resueltos; `buildUploadFilename`/`getOrCreateFolder`/`folderCache` ya NO existen; "sin tests" es falso (hay `npm test`).
- [ ] **D2** — Remover aliases redundantes de `businessCalendar.js` (`shouldProcessNow`, `getPendingTargetDateForMessage`).
- [ ] **D3** — Cablear los smoke-tests (`smoke-boot`, `smoke-handler`) a `npm test`.

---

## ✅ LO QUE YA FUNCIONA (no tocar, referencia)

- Capa Fase 0 de confiabilidad ACTIVA (sin config): reencolado durable, backpressure (p-limit), watchdog + `/health` + exit-on-disconnect, retry inteligente de Drive, acuse 👍/🕒.
- Idempotencia con SHA-256 persistida en `/data`.
- Deudas P4/P5/P6 cerradas por la Fase 0.
- Flujo core (descarga → PDF→JPG → upload a Drive → dedup) íntegro.
