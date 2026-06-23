# INTEGRACIÓN — bot-tt-kalaza (para Facundo)

> Conjunto de cambios sobre el bot WhatsApp→Drive (kalaza), listos para **integrar y deployar VOS**.
> Todo está en la rama **`fase0-confiabilidad`** (14 commits sobre `master` `702feb5`).
> **Nada fue deployado ni mergeado a master.** Validado con `node --check` (todos los `.js`) y `npm test` (14/14 offline). NO se corrió `npm start` ni se conectó a WhatsApp/Drive.

---

## 0. Cómo obtener el código

La rama `fase0-confiabilidad` está en la copia de Fede. Para traerla a tu proyecto local:
- **Opción A (recomendada):** que se pushee la rama al remoto y la traés: `git fetch && git checkout fase0-confiabilidad`, la revisás y mergeás a tu rama de trabajo.
- **Opción B:** aplicar los cambios archivo por archivo según la lista de §4 (todos los archivos nuevos/modificados están enumerados).

Commits (de más nuevo a más viejo):
```
25f9d1f auditoria  /auditoria (recibidos vs subidos vs pendientes + huecos)
4d07dce cleanup    eliminar codigo muerto V0.6
1c487f5 alertas    dedup con TTL + canal out-of-band (Telegram)
d58d68d routing    grupos por ID estable + canonicalizacion del 9 AR
4ec37f5 retry      Drive transitorio vs permanente + Retry-After
297916b acuse      reaccion 👍/🕒 + lock por messageKey
54a5b59 test       suite offline (npm test) + rename package a bot-tt-kalaza
39d3db3 mod-05     informe semanal de errores via Claude (fetch, sin SDK)
3a96b46 mod-03     /broadcast con confirmacion
38ac84d mod-02     blacklist + exentos dinamicos desde Sheets
4e91490 mod-04     comandos de control + statsStore + /forzar
3e958bb mod-01     grupos/TAGs dinamicos desde Sheets
b2289e7 fase0-B    auto-recuperacion (health+watchdog) + catch-up + guard /data
e2cb58e fase0-A    no perder comprobantes + backpressure
```

---

## 1. Qué cambió, en dos grupos

### A) Fase 0 — Confiabilidad → **SE ACTIVA SOLA AL DEPLOYAR** (no requiere config)
Cambia el comportamiento en runtime. Es lo que hay que probar sí o sí antes de producción.
- **No perder comprobantes:** si la subida a Drive en vivo agota reintentos, el comprobante se **reencola a pendientes** en vez de perderse (antes: pérdida silenciosa / "P5"). Igual si falla la conversión de un PDF (se encola el PDF crudo).
- **Backpressure:** `p-limit` en el handler de mensajes (`HANDLER_CONCURRENCY`) + semáforo en la conversión PDF (`PDF_CONCURRENCY`) → no se dispara OOM bajo ráfaga.
- **Auto-recuperación:** ante `disconnected` (que no sea LOGOUT) el proceso hace `exit(1)` para que la plataforma reinicie; **`/health`** reporta el estado REAL de WhatsApp; watchdog que reinicia si queda "vivo pero sordo". `railway.toml` con healthcheck + restart ON_FAILURE.
- **Catch-up:** al `ready`, relee los últimos N min de cada grupo y reencamina los comprobantes con media que entraron durante una caída (idempotencia evita duplicados).
- **Acuse visual:** el bot reacciona al comprobante → **👍** subido / **🕒** encolado fuera de horario (`REACT_ON_PROCESSED`).
- **Retry de Drive inteligente:** distingue transitorio (429/5xx/red → reintenta, respeta `Retry-After`) de permanente (4xx → propaga y reencola).
- **Idempotencia:** lock en memoria por `messageKey` (cierra la race entre handlers concurrentes).
- **Alertas:** dedup con TTL (re-alerta condiciones recurrentes) + canal out-of-band por Telegram para ERROR/CRITICAL (opcional).
- **Grupos por ID estable** (evita el bug de homónimos) y **canonicalización del "9"** en teléfonos AR de la blacklist.

### B) MODs — Operabilidad → **DORMIDOS hasta setear su env var** (sin config, el bot anda igual que hoy)
- **MOD-01:** grupos/TAGs dinámicos desde Google Sheets (Service Account) → **reemplaza la variable de entorno de grupos** (`config.json` / `WHATSAPP_ALLOWED_GROUPS_JSON`). Lee la planilla **`1UybD45jEcUfALjnm8uRJrDoy4U0GSeLeTFi9-hYB9r8`** (pestaña "Hoja 1"): **columna K = nombre del grupo de WhatsApp, columna E = TAG, desde la fila 2**. El bot vincula los grupos de esas filas **donde está presente** y los procesa con su TAG. **Auto-recarga cada `SHEETS_RELOAD_MINUTES` (default 15):** para sumar un grupo nuevo **NO hace falta deploy** — basta agregar el bot al grupo (cuyo nombre exacto esté en la col K) y, en la próxima recarga (o con `/recargar`), queda reconocido. Activa con `GOOGLE_SHEETS_ID` + Service Account.
- **MOD-02:** blacklist + grupos exentos desde una planilla nueva del bot. Activa con `GOOGLE_SHEETS_BOT_CONFIG_ID`.
- **MOD-03:** `/broadcast` (difusión masiva con confirmación). Requiere grupo de control.
- **MOD-04:** comandos en el grupo de control + métricas. Requiere `WHATSAPP_CONTROL_GROUP_NAME`.
- **MOD-05:** informe semanal de errores vía Claude (fetch nativo, **sin SDK nuevo**). Análisis IA si hay `ANTHROPIC_API_KEY`.

---

## 2. Variables de entorno nuevas

> Compatibilidad: si NO setea las de los MODs, el bot usa `config.json` / `blocked-senders.json` como hoy. Las de Fase 0 ya tienen defaults sanos.

**Fase 0 / mejoras (opcionales, con default):**
| Var | Default | Qué hace |
|---|---|---|
| `HANDLER_CONCURRENCY` | 3 | Handlers de mensaje en paralelo (backpressure) |
| `PDF_CONCURRENCY` | 2 | Conversiones PDF simultáneas (anti-OOM) |
| `AUTO_RECOVERY_ENABLED` | true | exit(1) en disconnect + watchdog (REQUIERE sesión en /data) |
| `WATCHDOG_INTERVAL_SECONDS` | 60 | Frecuencia del watchdog de estado |
| `WATCHDOG_MAX_FAILURES` | 2 | Fallos seguidos antes de reiniciar |
| `HEALTH_PORT` | 3000 | Puerto de `/health` (Railway inyecta `PORT`) |
| `CATCHUP_ENABLED` | true | Recuperar backlog de outage al arrancar |
| `CATCHUP_DELAY_SECONDS` / `CATCHUP_WINDOW_MINUTES` / `CATCHUP_FETCH_LIMIT` | 30 / 30 / 50 | Parámetros del catch-up |
| `REACT_ON_PROCESSED` | true | Reacción 👍/🕒 al comprobante |
| `ALERT_DEDUPE_TTL_MINUTES` | 30 | Re-alertar condición recurrente tras N min |
| `ALERT_TELEGRAM_BOT_TOKEN` / `ALERT_TELEGRAM_CHAT_ID` | — | Canal out-of-band de alertas (opcional) |

**MOD-01 (Sheets grupos):** `GOOGLE_SHEETS_ID` = `1UybD45jEcUfALjnm8uRJrDoy4U0GSeLeTFi9-hYB9r8` (activa), `GOOGLE_SHEETS_SHEET_NAME` (Hoja 1), `GOOGLE_SHEETS_GROUP_COLUMN` (K), `GOOGLE_SHEETS_TAG_COLUMN` (E), `GOOGLE_SHEETS_CREDENTIALS_PATH` (JSON del Service Account, **requerido**), `SHEETS_MATCH_CASE_SENSITIVE` (false), `SHEETS_TAG_NORMALIZE` (upper_underscore), `SHEETS_GROUPS_CACHE_PATH`, `SHEETS_RELOAD_MINUTES` (15; auto-reconoce grupos nuevos sin deploy; 0 = off).

**MOD-02 (Sheets blacklist):** `GOOGLE_SHEETS_BOT_CONFIG_ID` (activa), `GOOGLE_SHEETS_BLACKLIST_SHEET_NAME` (BOT_BLACKLIST), `GOOGLE_SHEETS_EXEMPT_SHEET_NAME` (BOT_EXEMPT), `SHEETS_BLACKLIST_CACHE_PATH`.

**MOD-03/04 (control):** `WHATSAPP_CONTROL_GROUP_NAME` (activa), `STATS_STORE_PATH`, `BROADCAST_CONFIRM_TIMEOUT_MS` (300000), `BROADCAST_SEND_DELAY_MS` (1500).

**MOD-05 (informe):** `WEEKLY_REPORT_ENABLED` (true), `ANTHROPIC_API_KEY` (para el análisis), `ANTHROPIC_MODEL` (claude-haiku-4-5-20251001), `WEEKLY_REPORT_HOUR` (18), `WEEKLY_REPORT_LOOKBACK_DAYS` (7), `WEEKLY_REPORT_STATE_PATH`.

> Todas están documentadas en `.env.example`. Las rutas de cache/estado conviene apuntarlas a `/data` en Railway (ver §6).

---

## 3. Comandos del grupo de control (MOD-04/03)
`/comandos` `/status` `/resumen` `/pendientes` `/recargar` `/grupos` `/bloqueados` `/forzar` `/errores` `/auditoria` `/broadcast <msg>`

---

## 4. Archivos

**Nuevos:** `src/services/sheetsService.js`, `groupsCache.js`, `groupMatcher.js`, `blacklistCache.js`, `statsStore.js`, `weeklyReportService.js`; `src/handlers/commandHandler.js`, `broadcastHandler.js`; `src/utils/driveRetry.js`, `logParser.js`, `sequence.js`; `scripts/test-offline.js`; `railway.toml`; `PLAN_FASE0.md`.

**Modificados:** `src/index.js` (wiring + auto-recuperación + catch-up + ruteo de comandos), `src/handlers/messageHandler.js` (reencolado a pending, 👍, lock, TAG por ID, blacklist cache), `src/config/env.js` (todos los bloques de config nuevos), `src/services/driveService.js` (retry inteligente, listUploadedIdsForDate, limpieza), `pendingProcessor.js` (`force` para /forzar + statsStore), `operationalNotifier.js` (TTL + out-of-band), `blockedSenders.js` (canonical 9), `pdfConverter.js` (semáforo), `fileNames.js` + `mask.js` (limpieza), `.env.example`, `.gitignore`, `package.json`.

---

## 5. Dependencias
- **Sin dependencias npm nuevas.** `p-limit` ya estaba; Anthropic (MOD-05) y Telegram (alertas OOB) se llaman por **`fetch` nativo** (Node 22). `package-lock.json` queda intacto → `npm ci` no se rompe.
- `npm ci` instala todo (incluye Chromium de puppeteer vía whatsapp-web.js).

---

## 6. Checklist de deploy (lo hacés vos)

1. **Integrar** la rama / archivos a tu proyecto local.
2. **🔴 Confirmar persistencia en Railway:** que `PROCESSED_STORE_PATH`, `WHATSAPP_AUTH_DATA_PATH`, `WHATSAPP_WEB_CACHE_PATH`, `GOOGLE_TOKEN_PATH`, `GOOGLE_CREDENTIALS_PATH` (y los `*_CACHE_PATH` / `STATS_STORE_PATH` / `WEEKLY_REPORT_STATE_PATH`) apunten a `/data/...`. **Bloqueante:** sin esto, el auto-restart de Fase 0 podría pedir QR. (El arranque ya alerta CRÍTICO si detecta rutas efímeras en Railway.)
3. **Validar:** `npm ci` → `npm test` (14/14) → `node --check index.js`.
4. **Smoke test** (no en el número de producción para no pisar la sesión): boot seguro `ALLOW_REAL_WHATSAPP_CONNECTION=false node index.js` (ver `/health`), y/o conectado en `BOT_DRY_RUN=true` con un número de prueba.
5. **Deploy de Fase 0** primero (sin setear ninguna env de MODs) → es transparente para la operatoria; conviene en una ventana tranquila (el catch-up recupera lo que entre durante el reinicio).
6. **Activar MODs de a uno**, validando cada uno (ver §7).

---

## 7. Activación incremental de los MODs

- **MOD-04 (comandos):** crear el grupo de control en WhatsApp → **agregar el bot al grupo** → verificar membresía → recién ahí setear `WHATSAPP_CONTROL_GROUP_NAME`. (Invertir el orden puede bloquear el `ready` — bug histórico del operationalNotifier.)
- **MOD-01 (grupos por Sheets — el pedido de "no depender de deploys"):**
  1. Crear un **Service Account** en GCP y compartir la planilla `1UybD45jEcUfALjnm8uRJrDoy4U0GSeLeTFi9-hYB9r8` como **Viewer** con el email del SA. Poner el JSON y setear `GOOGLE_SHEETS_CREDENTIALS_PATH`. (El scope OAuth actual `drive.file` NO alcanza para leer Sheets → por eso el SA.)
  2. Setear `GOOGLE_SHEETS_ID=1UybD45jEcUfALjnm8uRJrDoy4U0GSeLeTFi9-hYB9r8`. A partir de ahí Sheets es la fuente de verdad de grupos/TAGs y **se ignora `config.json` / `WHATSAPP_ALLOWED_GROUPS_JSON`**.
  3. En la planilla, **col K = nombre EXACTO del grupo de WhatsApp, col E = TAG, desde la fila 2**. (Filas con K vacía, con coma, o que parezcan teléfono se ignoran; TAG vacío o "-" también.)
  4. **Sumar un grupo nuevo (sin deploy):** agregar el bot al grupo de WhatsApp (cuyo nombre exacto figure en la col K). En la próxima auto-recarga (`SHEETS_RELOAD_MINUTES`, default 15 min) o con `/recargar`, queda vinculado y se procesa con su TAG. El nombre debe coincidir EXACTO (case-insensitive); el match por similitud quedó deferido (§8).
- **MOD-02 (blacklist por Sheets):** mismo Service Account; setear `GOOGLE_SHEETS_BOT_CONFIG_ID` (planilla NUEVA del bot, con pestañas `BOT_BLACKLIST` y `BOT_EXEMPT`).
- **MOD-03 (broadcast):** requiere el grupo de control (MOD-04).
- **MOD-05 (informe):** setear `ANTHROPIC_API_KEY` (sin key igual manda el resumen crudo).

---

## 8. Pendientes / deferidos (con notas para vos)

- **ID secuencial atómico (colisión bot ↔ `recoverWindow` / dos instancias):** NO se tocó el formato del filename `<ID>_<DDMM>_<HHmm>_<TAG>` porque la conciliación depende de él (AGENTS.md lo protege). Mitigación operativa: **correr `recoverWindow.js` solo con el bot pausado** (single-instance). Si se quisiera resolver por código, habría que reservar el ID de forma atómica (contador persistido en /data con lock) — fase aparte.
- **Tracking por página en PDF multipágina (caso parcial en la cola de pendientes):** si un PDF multipágina falla parcialmente en el `pendingProcessor`, el reintento recalcula `baseId` y puede re-subir páginas ya subidas. Es raro. Fix sugerido: persistir en `appProperties` del pendiente las páginas ya subidas + `baseId` estable y saltearlas en el reintento. (El caso en vivo ya se maneja: el fallo total reencola el PDF crudo; el parcial alerta y no reencola para no duplicar.)
- **Match ambiguo/fuzzy de MOD-01:** hoy es match EXACTO (case-insensitive). El match por similitud + confirmación interactiva en el grupo de control quedó diferido (necesita MOD-04 ya en uso). Notas: scoring Jaro-Winkler, consulta al admin con timeout, flag `manualMatch` en el cache.

---

## 9. Tests / verificación local (sin tocar producción)
- **`npm test`** → `scripts/test-offline.js`: 14 tests de la lógica pura (matcher, normalización de TAGs, métricas, blacklist + canonical 9, parser de logs, retry, dedup de alertas, huecos de secuencia). No conecta a nada, no necesita node_modules.
- **`node scripts/smoke-boot.js`** (requiere `npm ci`): bootea el bot en modo seguro (credenciales DUMMY en /tmp, `BOT_DRY_RUN`, SIN conectar a WhatsApp) y verifica que arranca + `/health` responde 200.
- **`node scripts/smoke-handler.js`** (requiere `npm ci`): prueba el flujo del handler con dependencias mockeadas — invariante "un comprobante de grupo configurado nunca se pierde (sube+👍 o encola+🕒); uno de grupo no configurado se ignora".
- **`node --check`** sobre todos los `.js` (sintaxis).

> Verificado en local el 17/06: `node --check` OK en todo, `npm test` 14/14, require-graph completo OK, boot + `/health` OK, handler flow 4/4. Se detectó y corrigió un falso positivo del guard de persistencia (disparaba por `RAILWAY_API_TOKEN` del CLI en máquinas de dev). **Nada de esto tocó producción.**
