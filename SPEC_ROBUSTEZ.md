# SPEC_ROBUSTEZ.md — Endurecimiento post-incidente (Bot WhatsApp Nexo)

> ## ¿Qué es este documento?
>
> Especificación técnica escrita por ChuecoTriquis y Claudia Seria para que **Facundo implemente**.
>
> **Este documento NO es código. Nadie lo ejecuta. Nadie toca el repositorio a partir de esto.**
> Acá se describe **qué hay que hacer y por qué**; Facundo decide el **cómo** y lo implementa.
>
> Surge de auditar los parches aplicados a las apuradas durante el incidente del **23/06/2026**
> (ver `INCIDENT_2026-06-23.md`). El bot volvió a producción, pero la auditoría detectó que
> **la causa real del outage no tiene mitigación en código** y que el fix de Drive quedó frágil.
> Este spec ordena lo que falta para que sea robusto de verdad.
>
> **Antes de implementar:** leer AGENTS.md y CLAUDE.md. En conflicto, prevalece AGENTS.md.
> **Producción es SOLO LECTURA.** Validar con `node --check` y `npm test`; nada de `npm start`/deploy sin aprobación.

---

## Contexto — qué pasó y qué quedó

El 23/06 el bot estuvo caído ~1h27m + ~26min de pausa manual. Dos causas raíz:

1. **Singleton locks de Chromium** huérfanos en `/data/.wwebjs_auth/` tras abrir la Railway Console durante un redeploy → el contenedor nuevo no puede usar el perfil (`profile appears to be in use`, Code 21). **Se resolvió a mano** (`find /data/.wwebjs_auth/ -name "Singleton*" -delete`).
2. **"Premature close" de Google Drive/OAuth**: `node-fetch` pide `Accept-Encoding: gzip`; en Node 22 el gunzip emite `ERR_STREAM_PREMATURE_CLOSE` cuando Google cierra la conexión. Rompía auth y uploads. **Se parchó** forzando `Accept-Encoding: identity` global ([src/index.js:10-25](src/index.js#L10-L25), replicado en [scripts/recoverWindow.js](scripts/recoverWindow.js#L4-L20)).

**Diagnóstico de la auditoría:**
- El fix de Drive **funciona pero es frágil**: depende de que `googleapis@144 → gaxios → node-fetch → https.request`. Un bump de `googleapis` puede mover el transporte a `fetch` nativo (undici), que NO pasa por `https.request`, y el bug volvería **en silencio**.
- La causa #1 (Singleton) **no tiene una sola línea de código** que la prevenga, y ahora es **más peligrosa**: la auto-recuperación nueva (F0.4) hace `process.exit(1)` ante `disconnected` para que Railway reinicie. Si ese reinicio encuentra un lock huérfano → **crash-loop** ("profile in use") justo cuando nadie mira.

---

## Resumen de tareas

| # | Tarea | Prioridad | Esfuerzo |
|---|---|---|---|
| R1 | Auto-cleanup de Singleton locks al arrancar | 🔴 alta | chico |
| R2 | Documentar el acople del patch HTTPS a la versión de `googleapis` | 🔴 alta | doc |
| R3 | Migrar las llamadas a Google a `fetch` nativo (cura de fondo del gzip) | 🟡 media | medio |
| R4 | Extraer el patch HTTPS a un módulo compartido (anti-drift) | 🟡 media | chico |
| R5 | Clasificar `premature` como error reintentable en `driveRetry` | 🟢 baja | 1 línea |
| R6 | Monitoreo externo de `/health` + alerta de caída | 🟢 baja | bajo |

> Orden sugerido de ejecución: **R1 → R5 → R4 → R2 → R6 → R3**. R1 es lo único que cierra la causa real del outage; R3 es la cura de fondo pero es la de mayor esfuerzo y riesgo de regresión, conviene dejarla con tiempo y smoke test.

---

### R1 — Auto-cleanup de Singleton locks al arrancar

**Tipo:** `nueva funcionalidad` · **Prioridad:** 🔴 alta

**Problema:**
> La caída del 23/06 fue por archivos `SingletonLock` / `SingletonCookie` / `SingletonSocket` huérfanos en el `userDataDir` de Chromium (`/data/.wwebjs_auth/...`). Hoy el cleanup es **100% manual** desde la Railway Console — no existe en código (grep `Singleton` en `src/` = 0 resultados). [scripts/recoverWindow.js:1099-1102](scripts/recoverWindow.js#L1099-L1102) solo imprime un warning diciéndole al humano que corra el `find`.
>
> **Agravante:** la auto-recuperación F0.4 ([src/index.js:224-227](src/index.js#L224-L227)) hace `process.exit(1)` ante `disconnected`, esperando que Railway reinicie. Si el reinicio se topa con un lock huérfano, el bot no arranca y **entra en crash-loop** — el mecanismo que debía recuperar termina amplificando el problema.

**Comportamiento esperado:**
> Al arrancar el proceso, **antes de** `client.initialize()`, eliminar automáticamente cualquier archivo `Singleton*` que haya quedado en el directorio de sesión de WhatsApp (`config.paths.whatsappAuthData`, recursivo). El borrado debe:
> - Ser best-effort: si falla (permisos, no existe), loguear warning y continuar — nunca abortar el arranque.
> - Loguear qué borró (cantidad) para tener trazabilidad en los logs de Railway.
> - Ejecutarse **siempre** en el arranque, incluido el arranque que dispara el auto-restart de F0.4 (ese es justo el caso crítico).

**Archivos involucrados:**
> **Modificados:**
> - `src/index.js` — invocar el cleanup en `startBot()`, antes de `client.initialize()` (cerca de [src/index.js:453-461](src/index.js#L453-L461)).
> **Nuevos (sugerido):**
> - `src/utils/sessionLocks.js` — helper `clearSingletonLocks(authDataPath)` reutilizable (también lo puede usar `recoverWindow.js`).

**Notas / sugerencia de implementación:**
> Bosquejo (Facundo ajusta):
> ```js
> // src/utils/sessionLocks.js
> const fs = require('fs');
> const path = require('path');
> function clearSingletonLocks(rootDir) {
>   let removed = 0;
>   function walk(dir) {
>     let entries = [];
>     try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
>     for (const e of entries) {
>       const full = path.join(dir, e.name);
>       if (e.isDirectory()) walk(full);
>       else if (e.name.startsWith('Singleton')) {
>         try { fs.unlinkSync(full); removed += 1; } catch (_) { /* best-effort */ }
>       }
>     }
>   }
>   walk(rootDir);
>   return removed;
> }
> module.exports = { clearSingletonLocks };
> ```
> En `index.js`, antes de `client.initialize()`:
> ```js
> const { clearSingletonLocks } = require('./utils/sessionLocks');
> const removed = clearSingletonLocks(config.paths.whatsappAuthData);
> if (removed) console.log(`[SESSION] ${removed} Singleton lock(s) huérfano(s) eliminado(s) antes de iniciar.`);
> ```
> **Precaución (validar):** el cleanup debe correr cuando el contenedor anterior YA liberó el proceso Chromium (en Railway, el restart implica contenedor nuevo → no hay proceso vivo usando el perfil). En entornos donde pudiera haber dos instancias vivas, borrar el lock de una instancia activa sería incorrecto — pero el proyecto es **single-instance** (CLAUDE.md §12), así que en operación normal es seguro. Documentarlo igual.
> **Tener en cuenta `recoverWindow.js`:** ese script abre su propia sesión. Si se le agrega cleanup, coordinar para que NO corra mientras el bot está vivo (sigue valiendo la regla operativa: recovery solo con el bot pausado).

---

### R2 — Documentar el acople del patch HTTPS a la versión de `googleapis`

**Tipo:** `documentación / guardarraíl` · **Prioridad:** 🔴 alta

**Problema:**
> El patch `Accept-Encoding: identity` ([src/index.js:10-25](src/index.js#L10-L25)) funciona porque hoy `googleapis@144` usa internamente `gaxios → node-fetch → https.request`. Versiones más nuevas de `gaxios` usan el **`fetch` nativo (undici)**, que **no pasa por `https.request`**. Si alguien actualiza `googleapis` (o sus transitivas), el patch deja de interceptar y el "Premature close" **vuelve sin aviso** — no hay error en el patch, solo una regresión silenciosa en auth/uploads. Es el mismo tipo de deuda que CLAUDE.md §11 ya documenta para el patch de `whatsapp-web.js`.

**Comportamiento esperado:**
> Dejar registrado el riesgo donde se vea antes de tocar dependencias:
> - Agregar el patch HTTPS a la lista de **deuda técnica conocida** de CLAUDE.md §11, con la regla: *"antes de actualizar `googleapis`/`gaxios`, validar que el patch HTTPS sigue interceptando los requests a Google (o que ya no hace falta porque se migró a fetch nativo — ver R3)"*.
> - Comentario en el propio patch apuntando a esta nota.
> - Smoke test mínimo documentado: tras cualquier bump de `googleapis`, verificar en logs que un refresh de token + un upload responden 200 sin `premature`.

**Archivos involucrados:**
> `CLAUDE.md` (§11), comentario en `src/index.js` (patch) y `scripts/recoverWindow.js`.

---

### R3 — Migrar las llamadas a Google a `fetch` nativo (cura de fondo)

**Tipo:** `modificación` · **Prioridad:** 🟡 media

**Problema:**
> El patch HTTPS es un workaround. La causa de fondo es la combinación `node-fetch` 2.x + gunzip de Node 22. La cura real es no depender de ese transporte.

**Comportamiento esperado:**
> Evaluar una de estas vías (Facundo elige según lo que rompa menos):
> - **(a)** Configurar el cliente de Google para usar el `fetch` nativo de Node 22 (undici) como transporte de gaxios, que no tiene el bug de gunzip. Si se logra, el patch HTTPS (R4) se puede **remover**.
> - **(b)** Actualizar `node-fetch` / `gaxios` / `googleapis` a una versión que maneje bien el cierre de stream gzip en Node 22. **Requiere R2** (revalidar el patch) y smoke test completo.
> - **(c)** Mantener el patch indefinidamente como solución aceptada, asumiendo R2+R4. Es válido si (a) y (b) resultan riesgosas.
>
> Cualquiera que se elija, el criterio de éxito es el mismo: refresh de token + uploads a Drive responden OK bajo Node 22 sin `premature`, **sin** depender de un monkey-patch frágil.

**Archivos involucrados:**
> `package.json` / `package-lock.json` (si se bumpea), `src/auth/googleOAuth.js`, `src/services/driveService.js`, y eventualmente remover el patch de `src/index.js` + `scripts/recoverWindow.js`.

**Notas:**
> Alto esfuerzo y riesgo de regresión en auth/uploads → hacerlo con tiempo, en ventana tranquila y con smoke test autorizado. No es bloqueante para operar; R1+R2 cubren la urgencia.

---

### R4 — Extraer el patch HTTPS a un módulo compartido

**Tipo:** `refactor` · **Prioridad:** 🟡 media

**Problema:**
> El patch está **duplicado por copy-paste** en [src/index.js:10-25](src/index.js#L10-L25) y [scripts/recoverWindow.js:4-20](scripts/recoverWindow.js#L4-L20). Dos copias divergen con el tiempo, y cualquier entry point nuevo que hable con Google y no lo replique queda expuesto al bug.

**Comportamiento esperado:**
> Un único módulo (ej. `src/utils/httpsIdentityPatch.js`) que exporte y aplique el patch, `require()`-eado como **primera línea** de cada entry point (`src/index.js`, `scripts/recoverWindow.js`, y cualquier script futuro que use Google). El patch debe seguir aplicándose **antes** de que cualquier módulo capture una referencia a `https.request`.

**Archivos involucrados:**
> **Nuevos:** `src/utils/httpsIdentityPatch.js`. **Modificados:** `src/index.js`, `scripts/recoverWindow.js`.

**Notas:**
> Si se hace R3(a) y se remueve el patch, R4 queda sin objeto. Si el patch se mantiene (R3c), R4 es el mínimo higiénico.

---

### R5 — Clasificar `premature` como error reintentable en `driveRetry`

**Tipo:** `modificación` · **Prioridad:** 🟢 baja

**Problema:**
> `RETRYABLE_NET_RE` ([src/utils/driveRetry.js:5](src/utils/driveRetry.js#L5)) no incluye `premature` ni `ERR_STREAM_PREMATURE_CLOSE`. Si un "Premature close" se escapa del patch, en el `pendingProcessor` se clasifica **permanente** → quema reintentos → marca el pendiente como `failed` y alerta, en vez de tratarlo como transitorio. En vivo el handler reencola a pending (no se pierde), pero el pendiente puede quedar trabado.

**Comportamiento esperado:**
> Agregar `premature` (case-insensitive) al regex de errores de red reintentables, para que estos casos se reintenten con backoff en lugar de fallar permanente.

**Archivos involucrados:**
> `src/utils/driveRetry.js` — extender `RETRYABLE_NET_RE`. Agregar caso en `scripts/test-offline.js` (la suite ya testea `driveRetry`).

**Notas:**
> Cambio de una línea, belt-and-suspenders. Conviene aunque se haga R3, por si algún path no queda cubierto.

---

### R6 — Monitoreo externo de `/health` + alerta de caída

**Tipo:** `nueva funcionalidad / operativa` · **Prioridad:** 🟢 baja

**Problema:**
> Durante el incidente nadie se enteró automáticamente: lo notaron porque los comprobantes no llegaban a Drive. Ya existe el endpoint `/health` ([src/index.js:346-375](src/index.js#L346-L375)) que reporta el estado real de WhatsApp, pero nada lo vigila desde afuera.

**Comportamiento esperado:**
> - Configurar un monitor externo (UptimeRobot, BetterStack o similar) que pinguee `GET /health` cada 1–5 min y avise (mail/WhatsApp/Telegram) si responde ≠ 200 por X minutos.
> - Es configuración de infra, no necesariamente código. Si se quiere alerta interna además, evaluar reusar el canal out-of-band de Telegram que ya existe en `operationalNotifier` (`ALERT_TELEGRAM_*`).

**Archivos involucrados:**
> Infra (dashboard del monitor). Opcionalmente documentar en `DEPLOYMENT.md` la URL de `/health` y el monitor configurado.

---

## Checklist de entrega

- [ ] R1 validado con `node --check` + caso en `npm test` (cleanup borra `Singleton*`, no rompe si no existe).
- [ ] R5 con su test en `scripts/test-offline.js`.
- [ ] CLAUDE.md §11 actualizado (R2) con el acople del patch HTTPS.
- [ ] `.env.example` / `DEPLOYMENT.md` actualizados si R6 agrega config.
- [ ] Smoke test autorizado antes de confiar R1 en producción (que el bot arranque tras borrar locks).
- [ ] Sin secretos ni datos reales en el código.
- [ ] Sin `npm start` / deploy ejecutados sin aprobación.

---

*Documento generado: 2026-06-23 — Claudia Seria / ChuecoTriquis. Basado en auditoría del código post-incidente y en `INCIDENT_2026-06-23.md`.*
