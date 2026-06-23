const http = require('http');
const qrcode = require('qrcode-terminal');
const pLimit = require('p-limit');

// Workaround: node-fetch/Gunzip falla con respuestas gzip en Node.js 22.
// Deshabilitar Accept-Encoding: gzip globalmente para gaxios (HTTP client de googleapis)
// para evitar el error "Premature close" al renovar el token OAuth de Drive.
try {
  const { instance: gaxiosInst } = require('gaxios');
  gaxiosInst.defaults = gaxiosInst.defaults || {};
  gaxiosInst.defaults.headers = { ...(gaxiosInst.defaults.headers || {}), 'Accept-Encoding': 'identity' };
  console.log('[GAXIOS] Accept-Encoding=identity (workaround node-fetch/gzip/Node22)');
} catch (_) {}
const { loadConfig } = require('./config/env');
const { createDriveService } = require('./services/driveService');
const { createLogService } = require('./services/logService');
const { createProcessedStore } = require('./services/processedStore');
const { createWhatsappClient } = require('./services/whatsappClient');
const { createPendingProcessor } = require('./services/pendingProcessor');
const { createOperationalNotifier } = require('./services/operationalNotifier');
const { createMessageHandler } = require('./handlers/messageHandler');
const { createSheetsService } = require('./services/sheetsService');
const { createGroupsCache } = require('./services/groupsCache');
const { createBlacklistCache } = require('./services/blacklistCache');
const { createStatsStore } = require('./services/statsStore');
const { createCommandHandler } = require('./handlers/commandHandler');
const { createBroadcastHandler } = require('./handlers/broadcastHandler');
const { createWeeklyReportService } = require('./services/weeklyReportService');
const { maskSensitiveText } = require('./utils/mask');

function startBot() {
  const config = loadConfig();
  const driveService = createDriveService(config);
  const logService = createLogService(config);
  const processedStore = createProcessedStore(config);
  const statsStore = createStatsStore(config); // MOD-04: metricas diarias
  const client = createWhatsappClient(config);
  const operationalNotifier = createOperationalNotifier({ config, client });
  const pendingProcessor = createPendingProcessor({ config, driveService, processedStore, operationalNotifier, statsStore });
  // MOD-01: cache de grupos/TAGs desde Sheets (solo si GOOGLE_SHEETS_ID esta seteada).
  // Si no, queda undefined y el handler usa config.json como hoy (backward-compatible).
  // MOD-01/02: caches desde Sheets (comparten el mismo Service Account). Cada uno se
  // activa por su env (GOOGLE_SHEETS_ID / GOOGLE_SHEETS_BOT_CONFIG_ID); si no, legacy.
  let groupsCache;
  let blacklistCache;
  let broadcastHandler; // MOD-03
  if (config.sheets.enabled || config.blacklist.enabled) {
    const sheetsService = createSheetsService(config);
    if (config.sheets.enabled) {
      groupsCache = createGroupsCache({ config, sheetsService, getChats: () => client.getChats() });
      groupsCache.loadFromDisk(); // arranca con el ultimo cache conocido; reload real tras 'ready'
    }
    if (config.blacklist.enabled) {
      blacklistCache = createBlacklistCache({ config, sheetsService });
      blacklistCache.loadFromDisk();
    }
  }
  let ready = false;
  let readyDiagnosticTimer;
  const startedAt = Date.now();
  let modulosIniciados = false; // F0.5: guard anti doble-init ante 'ready' repetido
  let watchdogFailures = 0;     // F0.4: fallos consecutivos del watchdog de estado
  let watchdogTimer;

  function clearReadyDiagnosticTimer() {
    if (!readyDiagnosticTimer) return;
    clearTimeout(readyDiagnosticTimer);
    readyDiagnosticTimer = undefined;
  }

  function startReadyDiagnosticTimer() {
    clearReadyDiagnosticTimer();
    const seconds = config.whatsapp.readyTimeoutSeconds;
    readyDiagnosticTimer = setTimeout(() => {
      if (ready) return;
      console.warn(
        `WhatsApp autenticado, pero el evento ready no llego despues de ${seconds}s. ` +
        'Posible problema de version/cache de WhatsApp Web, sesion o estado de conexion.'
      );
      console.warn('El proceso sigue vivo para observacion; no se borro sesion ni cache.');
      operationalNotifier.notifyError(
        'whatsapp_ready_timeout',
        'WhatsApp autentico pero no llego a ready dentro del tiempo esperado.',
        { timeoutSeconds: seconds }
      ).catch((err) => {
        console.warn('[OPERATIONAL ALERT] error alertando ready timeout:', maskSensitiveText(err && err.message));
      });
    }, seconds * 1000);
    if (readyDiagnosticTimer.unref) readyDiagnosticTimer.unref();
  }

  client.on('qr', (qr) => {
    console.log('WhatsApp QR recibido.');
    console.log('\nEscanea este QR con WhatsApp (Configuracion -> Dispositivos vinculados -> Vincular un dispositivo):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    startReadyDiagnosticTimer();
    console.log('Autenticado. Sesion guardada en', config.paths.whatsappAuthData);
  });

  client.on('auth_failure', (msg) => {
    clearReadyDiagnosticTimer();
    console.error('Falla de autenticacion:', maskSensitiveText(msg));
    operationalNotifier.notifyError(
      'whatsapp_auth_failure',
      'Falla de autenticacion de WhatsApp. Revisar sesion del bot.',
      { reason: msg }
    ).catch((err) => {
      console.warn('[OPERATIONAL ALERT] error alertando auth_failure:', maskSensitiveText(err && err.message));
    });
  });

  client.on('ready', () => {
    ready = true;
    watchdogFailures = 0;
    clearReadyDiagnosticTimer();
    // F0.5: 'ready' puede dispararse mas de una vez (reconexion / re-auth por QR).
    // Sin este guard, cada ready re-arrancaria timers y watchers (doble trabajo).
    if (modulosIniciados) {
      console.log('[READY] re-emitido; modulos ya iniciados, solo marco ready.');
      return;
    }
    modulosIniciados = true;
    console.log('\nBot listo y escuchando.');
    console.log('Grupos configurados:');
    for (const [name, tag] of Object.entries(config.whatsapp.groups)) {
      console.log(`  - "${name}" -> tag "${tag}"`);
    }
    console.log(`Carpeta destino de Drive: ${maskSensitiveText(config.google.driveFolderId)}\n`);
    pendingProcessor.start();
    operationalNotifier.notifyReady().catch((err) => {
      console.warn('[OPERATIONAL NOTIFY] error en ready:', maskSensitiveText(err && err.message));
    });
    operationalNotifier.startOperationalStatusWatcher();
    operationalNotifier.installShutdownHooks();
    // MOD-01: cargar grupos/TAGs desde Sheets (conserva el cache anterior si falla).
    if (groupsCache) {
      groupsCache.reload()
        .then((r) => console.log(`[GROUPS-CACHE] Sheets cargada: ${r.matched} grupos vinculados (${r.unmatchedSheet} en planilla sin match en WhatsApp, ${r.total} filas validas).`))
        .catch((err) => {
          console.error('[GROUPS-CACHE] fallo cargando Sheets; se mantiene el cache anterior:', maskSensitiveText(err && err.message));
          operationalNotifier.notifyError(
            'sheets_groups_load_failed',
            'No se pudieron cargar grupos desde Sheets; se usa el cache anterior.',
            { error: err }
          ).catch(() => {});
        });
    }
    // MOD-02: cargar blacklist + grupos exentos desde la planilla del bot.
    if (blacklistCache) {
      blacklistCache.reload()
        .then((r) => console.log(`[BLACKLIST-CACHE] Sheets cargada: ${r.blocked} bloqueados, ${r.exempt} exentos.`))
        .catch((err) => {
          console.error('[BLACKLIST-CACHE] fallo cargando Sheets; se mantiene el cache anterior:', maskSensitiveText(err && err.message));
          operationalNotifier.notifyError(
            'sheets_blacklist_load_failed',
            'No se pudo cargar la blacklist desde Sheets; se usa el cache anterior.',
            { error: err }
          ).catch(() => {});
        });
    }
    // F0.4: watchdog de estado (detecta "vivo pero sordo").
    startWatchdog();
    // MOD-05: scheduler del informe semanal de errores.
    if (config.weeklyReport.enabled) weeklyReportService.start();
    // F0.5: catch-up del backlog ocurrido durante el outage, diferido tras ready.
    if (config.catchUp.enabled) {
      const t = setTimeout(() => { runCatchUp(); }, config.catchUp.delaySeconds * 1000);
      if (t.unref) t.unref();
    }
    // MOD-01/02: auto-recarga periodica de Sheets -> reconoce grupos nuevos SIN deploy ni
    // comando manual. Basta agregar el bot al grupo listado en la columna K de la planilla
    // y, en la proxima recarga, queda vinculado con su TAG (columna E).
    if ((groupsCache || blacklistCache) && config.sheets.reloadMinutes > 0) {
      let reloading = false;
      const t = setInterval(() => {
        if (reloading) return;
        reloading = true;
        Promise.resolve()
          .then(async () => {
            if (groupsCache) {
              const r = await groupsCache.reload();
              console.log(`[GROUPS-CACHE] auto-recarga: ${r.matched} grupos vinculados.`);
            }
            if (blacklistCache) await blacklistCache.reload();
          })
          .catch((err) => console.warn(`[SHEETS] auto-recarga fallo (se mantiene cache): ${maskSensitiveText(err && err.message)}`))
          .finally(() => { reloading = false; });
      }, config.sheets.reloadMinutes * 60 * 1000);
      if (t.unref) t.unref();
      console.log(`[SHEETS] auto-recarga cada ${config.sheets.reloadMinutes} min activa.`);
    }
  });

  client.on('disconnected', (reason) => {
    clearReadyDiagnosticTimer();
    ready = false;
    console.warn('Desconectado de WhatsApp:', maskSensitiveText(reason));
    operationalNotifier.notifyError(
      'whatsapp_disconnected',
      'WhatsApp se desconecto. Revisar estado del bot.',
      { reason }
    ).catch((err) => {
      console.warn('[OPERATIONAL ALERT] error alertando disconnected:', maskSensitiveText(err && err.message));
    });
    // F0.4: si NO fue LOGOUT (sesion revocada por el usuario), salir para que la
    // plataforma reinicie y reconecte con la sesion persistida. En LOGOUT no sirve
    // reiniciar (haria falta QR), asi que solo se alerta.
    // OJO: depende de que la sesion viva en /data; si no, el restart pediria QR (ver F0.6).
    if (config.autoRecovery.enabled && String(reason) !== 'LOGOUT') {
      console.error('[AUTO-RECOVERY] saliendo (exit 1) en 3s para forzar restart de la plataforma...');
      setTimeout(() => process.exit(1), 3000);
    }
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`WhatsApp loading: ${percent}% - ${maskSensitiveText(message || '-')}`);
  });

  client.on('change_state', (state) => {
    console.log('WhatsApp state changed:', maskSensitiveText(state));
  });

  client.on('remote_session_saved', () => {
    console.log('WhatsApp remote session saved.');
  });

  // F0.3: backpressure. El listener 'message' es fire-and-forget; sin limite, N
  // mensajes simultaneos = N handlers en paralelo (descarga + conversion PDF + dedup),
  // con riesgo de OOM bajo rafaga. Encolamos con p-limit para procesar de a pocos.
  const messageHandler = createMessageHandler({
    config,
    driveService,
    logService,
    processedStore,
    operationalNotifier,
    groupsCache,
    statsStore,
    blacklistCache,
  });
  const handlerLimit = pLimit(config.concurrency.handler);

  // MOD-03: broadcast (necesita grupo de control). Se crea ANTES que commandHandler para
  // que /broadcast quede registrado en el dispatcher.
  if (config.whatsapp.controlGroupName) {
    broadcastHandler = createBroadcastHandler({ config, client, groupsCache });
  }

  // MOD-04: comandos del grupo de control.
  const commandHandler = createCommandHandler({
    config,
    client,
    driveService,
    pendingProcessor,
    groupsCache,
    blacklistCache,
    statsStore,
    startedAt,
    getReady: () => ready,
    broadcastHandler,
  });

  // MOD-05: informe semanal de errores via Claude API (arranca en 'ready').
  const weeklyReportService = createWeeklyReportService({ config, client, getReady: () => ready });

  // Rutea: en el grupo de control, los '/' van a comandos y las respuestas de
  // confirmacion al broadcast (MOD-03); el resto, al pipeline de comprobantes (con
  // backpressure). El chequeo del grupo se hace ANTES de la logica de comprobantes.
  async function handleIncoming(msg) {
    if (config.whatsapp.controlGroupName) {
      const text = (msg.body || '').trim();
      const pendingBroadcast = broadcastHandler && typeof broadcastHandler.isPending === 'function' && broadcastHandler.isPending();
      if (text.startsWith('/') || pendingBroadcast) {
        const chat = await msg.getChat();
        if (chat && chat.name === config.whatsapp.controlGroupName) {
          if (broadcastHandler && typeof broadcastHandler.maybeHandleReply === 'function') {
            const handled = await broadcastHandler.maybeHandleReply(msg, chat);
            if (handled) return;
          }
          if (text.startsWith('/')) {
            await commandHandler.dispatch(msg, chat);
            return;
          }
        }
      }
    }
    await handlerLimit(() => messageHandler(msg));
  }

  client.on('message', (msg) => {
    handleIncoming(msg).catch((err) => {
      console.error('[message] error no capturado:', maskSensitiveText(err && err.message));
    });
  });

  // F0.4: estado real de WhatsApp con timeout (getState puede colgarse).
  async function getStateWithTimeout(ms) {
    return Promise.race([
      Promise.resolve().then(() => client.getState()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getState timeout')), ms)),
    ]);
  }

  // F0.6: en produccion (Railway), avisar si rutas de estado/sesion caen en filesystem
  // efimero (no /data) -> tras un redeploy se pierde idempotencia/sesion (re-subidas o QR).
  function checkPersistencePaths() {
    // Detectar SOLO ejecucion dentro del contenedor de Railway: RAILWAY_ENVIRONMENT lo
    // inyecta Railway en runtime. (RAILWAY_API_TOKEN del CLI esta en maquinas de dev y
    // NO debe disparar este guard -> evitar falso positivo local.)
    const onRailway = config.env === 'railway' || Boolean(process.env.RAILWAY_ENVIRONMENT);
    if (!onRailway) return;
    const critical = {
      processedStore: config.paths.processedStore,
      whatsappAuthData: config.paths.whatsappAuthData,
      whatsappWebCache: config.paths.whatsappWebCache,
      token: config.paths.token,
    };
    const ephemeral = Object.entries(critical)
      .filter(([, p]) => p && String(p).startsWith(config.projectRoot))
      .map(([name]) => name);
    if (ephemeral.length === 0) return;
    console.error(`[PERSISTENCIA] CRITICO: rutas en filesystem efimero (no /data): ${ephemeral.join(', ')}. Tras un redeploy se pierde idempotencia/sesion.`);
    operationalNotifier.notifyError(
      'persistence_paths_ephemeral',
      'Rutas de estado/sesion en filesystem efimero; configurar a /data en Railway.',
      { paths: ephemeral.join(', ') }
    ).catch(() => {});
  }

  // F0.4: /health para el healthcheck de Railway. Reporta el estado REAL de WhatsApp
  // (no solo "arranco"), con gracia durante el arranque para no entrar en restart-loop.
  function startHealthServer() {
    const port = config.autoRecovery.healthPort;
    const server = http.createServer(async (req, res) => {
      let statusCode = 503;
      let body = 'unavailable';
      try {
        if (!ready) {
          const elapsedSec = (Date.now() - startedAt) / 1000;
          if (elapsedSec < config.whatsapp.readyTimeoutSeconds) {
            statusCode = 200; body = 'starting';
          } else {
            statusCode = 503; body = 'not-ready';
          }
        } else {
          const state = await getStateWithTimeout(5000);
          if (state === 'CONNECTED') { statusCode = 200; body = 'connected'; }
          else { statusCode = 503; body = `state:${maskSensitiveText(state)}`; }
        }
      } catch (_) {
        statusCode = 503; body = 'state-error';
      }
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
      res.end(body);
    });
    server.on('error', (err) => {
      console.error('[HEALTH] error del servidor:', maskSensitiveText(err && err.message));
    });
    server.listen(port, () => console.log(`[HEALTH] escuchando en puerto ${port} (GET /health)`));
    return server;
  }

  // F0.4: watchdog. Cada N seg verifica getState; tras M fallos consecutivos, exit(1)
  // para que la plataforma reinicie. Convierte el "vivo pero sordo" en restart visible.
  function startWatchdog() {
    if (!config.autoRecovery.enabled || watchdogTimer) return;
    const intervalMs = config.autoRecovery.watchdogIntervalSeconds * 1000;
    watchdogTimer = setInterval(async () => {
      let ok = false;
      try {
        const state = await getStateWithTimeout(10000);
        ok = state === 'CONNECTED';
        if (!ok) console.warn(`[WATCHDOG] estado no CONNECTED: ${maskSensitiveText(state)}`);
      } catch (err) {
        console.warn(`[WATCHDOG] getState fallo: ${maskSensitiveText(err && err.message)}`);
      }
      if (ok) { watchdogFailures = 0; return; }
      watchdogFailures += 1;
      console.warn(`[WATCHDOG] fallo ${watchdogFailures}/${config.autoRecovery.watchdogMaxFailures}`);
      if (watchdogFailures >= config.autoRecovery.watchdogMaxFailures) {
        console.error('[WATCHDOG] umbral alcanzado; saliendo (exit 1) para restart.');
        operationalNotifier.notifyError(
          'whatsapp_watchdog_exit',
          'Watchdog detecto WhatsApp caido; reiniciando proceso.',
          { failures: watchdogFailures }
        ).catch(() => {});
        setTimeout(() => process.exit(1), 2000);
      }
    }, intervalMs);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }

  // F0.5: catch-up del backlog de outage. Relee los ultimos N min de cada grupo
  // configurado y reencamina los mensajes con media por el mismo handler; la
  // idempotencia (processedStore) evita duplicar lo ya procesado.
  async function runCatchUp() {
    if (!config.catchUp.enabled) return;
    try {
      const cutoffMs = Date.now() - config.catchUp.windowMinutes * 60 * 1000;
      const chats = await client.getChats();
      let fed = 0;
      for (const chat of chats) {
        if (!chat.isGroup || !config.whatsapp.groups[chat.name]) continue;
        let msgs = [];
        try {
          msgs = await chat.fetchMessages({ limit: config.catchUp.fetchLimit });
        } catch (err) {
          console.warn(`[CATCHUP] no se pudo leer "${maskSensitiveText(chat.name, 80)}": ${maskSensitiveText(err && err.message)}`);
          continue;
        }
        for (const m of msgs) {
          const tsMs = Number(m.timestamp) * 1000;
          if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
          if (!m.hasMedia) continue;
          fed += 1;
          handlerLimit(() => messageHandler(m)).catch((err) => {
            console.error('[CATCHUP] error procesando mensaje:', maskSensitiveText(err && err.message));
          });
        }
      }
      console.log(`[CATCHUP] ventana ${config.catchUp.windowMinutes}min: ${fed} mensajes con media reencaminados (dedup via processedStore).`);
    } catch (err) {
      console.error('[CATCHUP] fallo general:', maskSensitiveText(err && err.message));
    }
  }

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    logService.error(`${new Date().toISOString()}\tunhandledRejection\t-\t-\tERROR: ${err && err.message}`);
    operationalNotifier.notifyError(
      'unhandled_rejection',
      'Error inesperado no capturado por el bot.',
      { error: err }
    ).catch((alertErr) => {
      console.warn('[OPERATIONAL ALERT] error alertando unhandledRejection:', maskSensitiveText(alertErr && alertErr.message));
    });
  });

  console.log('Iniciando bot...');
  checkPersistencePaths();
  startHealthServer();
  if (!config.safety.allowRealWhatsappConnection) {
    console.warn('Conexion real a WhatsApp bloqueada por ALLOW_REAL_WHATSAPP_CONNECTION=false.');
    return client;
  }

  client.initialize().catch((err) => {
    const message = maskSensitiveText(err && err.message ? err.message : String(err));
    console.error('Error inicializando WhatsApp:', message);
    logService.error(`${new Date().toISOString()}\twhatsapp_initialize\t-\t-\tERROR: ${message}`);
    operationalNotifier.notifyError(
      'whatsapp_initialize_failed',
      'No se pudo inicializar WhatsApp.',
      { error: err }
    ).catch((alertErr) => {
      console.warn('[OPERATIONAL ALERT] error alertando inicializacion:', maskSensitiveText(alertErr && alertErr.message));
    });
  });
  return client;
}

module.exports = {
  startBot,
};
