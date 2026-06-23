# PLAN_FASE0.md — Cimientos de confiabilidad

> Plan de la **Fase 0** del bot (kalaza): cerrar las fugas de comprobantes y la falta de
> auto-recuperación, antes de los MODs de operabilidad del `SPEC_CAMBIOS.md`.
> No reemplaza AGENTS.md ni CLAUDE.md. Validación: `node --check`; **nada de `npm start`/deploy sin aprobación**.

## Estado

| Ítem | Qué | Tanda | Estado |
|---|---|---|---|
| F0.1 | Reencolar a pending cuando el upload en vivo agota reintentos (cierra P5) | A | ✅ implementado (pend. smoke test) |
| F0.2 | PDF crudo a pending si falla la conversión (no descartarlo) | A | ✅ implementado (pend. smoke test) |
| F0.3 | `p-limit` en el handler + semáforo en conversión PDF (P4/P6) | A | ✅ implementado (pend. smoke test) |
| F0.4 | Auto-recuperación: `disconnected`→exit + `/health` + watchdog + `railway.toml` | B | ✅ implementado (pend. smoke test) |
| F0.5 | Catch-up de outage al arranque | B | ✅ implementado (pend. smoke test) |
| F0.6 | Guard de arranque + confirmar rutas a `/data` | B | 🟡 guard hecho; falta confirmar vars en Railway |

"Pend. smoke test" = pasa `node --check`; falta verificación en runtime con un `npm start` autorizado.

## Tanda A — implementado (16/06/2026)

**F0.1 — cierra P5** ([src/handlers/messageHandler.js](src/handlers/messageHandler.js))
Helper `enqueueToPending()` que reusa la metadata del flujo fuera-de-horario y NO marca `processed`.
Cableado en: catch del upload normal, catch del PDF multipágina (fallo total → PDF crudo). El fallo
PARCIAL del multipágina se deja como alerta (no se reencola para no duplicar; tracking por página = P2).

**F0.2** ([src/handlers/messageHandler.js](src/handlers/messageHandler.js))
En el catch de `pdf_conversion_failed`, en vez de `return`, se encola el PDF ORIGINAL crudo a pending;
el `pendingProcessor` lo re-rasteriza. Evita perder todos los PDFs si falta poppler.

**F0.3** ([src/index.js](src/index.js), [src/utils/pdfConverter.js](src/utils/pdfConverter.js), [src/config/env.js](src/config/env.js))
`p-limit` (ya dependencia, ^3.1.0) envuelve el listener `message` (`HANDLER_CONCURRENCY`, default 3) y
las conversiones PDF (`PDF_CONCURRENCY`, default 2). Backpressure real → sin picos de OOM bajo ráfaga.

Vars nuevas (en `.env.example`): `HANDLER_CONCURRENCY=3`, `PDF_CONCURRENCY=2`.

## Tanda B — implementada en código (16/06/2026), pendiente smoke test + Railway

Todo pasa `node --check`. **NO se corrió `npm start` ni se deployó.** Antes de confiar/deployar:
verificar F0.6 en Railway y hacer un smoke test autorizado.

**F0.4** ([src/index.js](src/index.js), [railway.toml](railway.toml), [src/config/env.js](src/config/env.js))
- `disconnected` con `reason !== 'LOGOUT'` → `process.exit(1)` diferido → Railway reinicia.
- Servidor `/health` que reporta el estado REAL (`client.getState()` con timeout + gracia de arranque).
- Watchdog: `getState` cada `WATCHDOG_INTERVAL_SECONDS`; tras `WATCHDOG_MAX_FAILURES` → exit(1).
- `railway.toml`: `healthcheckPath=/health`, `restartPolicyType=ON_FAILURE`.
- Vars: `AUTO_RECOVERY_ENABLED`, `WATCHDOG_INTERVAL_SECONDS`, `WATCHDOG_MAX_FAILURES`, `HEALTH_PORT`.

**F0.5** ([src/index.js](src/index.js))
- Guard `modulosIniciados` (no re-inicializar timers/watchers ante `ready` repetido).
- `runCatchUp()` diferido tras `ready`: relee los últimos N min de cada grupo (`fetchMessages`),
  reencamina los mensajes con media por el mismo handler; la idempotencia evita duplicados.
- Vars: `CATCHUP_ENABLED`, `CATCHUP_DELAY_SECONDS`, `CATCHUP_WINDOW_MINUTES`, `CATCHUP_FETCH_LIMIT`.

**F0.6** ([src/index.js](src/index.js))
- `checkPersistencePaths()`: en Railway, si `processedStore`/`whatsappAuthData`/`whatsappWebCache`/`token`
  caen bajo `PROJECT_ROOT` (efímero), alerta CRÍTICO al arrancar.
- **Acción pendiente de Fede:** confirmar en el dashboard de Railway que esas vars apuntan a `/data`.
  🔴 Bloqueante: sin esto, el exit-on-disconnect de F0.4 podría disparar re-escaneo de QR.

## Próximo paso antes de deployar

1. Fede confirma/ajusta las rutas `/data` en Railway (F0.6).
2. Smoke test autorizado (`npm ci` + `npm start`): ver QR/ready, `/health`, y que un comprobante suba.
3. Recién entonces, merge de `fase0-confiabilidad` y deploy.

## Notas

- `node_modules` no está en la copia local → para correr/probar hace falta `npm ci`.
- El bot carga `.env` (o `ENV_FILE`); el archivo `env` cargado no se autocarga salvo `ENV_FILE=env`.
