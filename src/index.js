const qrcode = require('qrcode-terminal');
const { loadConfig } = require('./config/env');
const { createDriveService } = require('./services/driveService');
const { createLogService } = require('./services/logService');
const { createProcessedStore } = require('./services/processedStore');
const { createWhatsappClient } = require('./services/whatsappClient');
const { createPendingProcessor } = require('./services/pendingProcessor');
const { createOperationalNotifier } = require('./services/operationalNotifier');
const { createMessageHandler } = require('./handlers/messageHandler');
const { maskSensitiveText } = require('./utils/mask');

function startBot() {
  const config = loadConfig();
  const driveService = createDriveService(config);
  const logService = createLogService(config);
  const processedStore = createProcessedStore(config);
  const client = createWhatsappClient(config);
  const operationalNotifier = createOperationalNotifier({ config, client });
  const pendingProcessor = createPendingProcessor({ config, driveService, processedStore, operationalNotifier });
  let ready = false;
  let readyDiagnosticTimer;

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
    clearReadyDiagnosticTimer();
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
  });

  client.on('disconnected', (reason) => {
    clearReadyDiagnosticTimer();
    console.warn('Desconectado de WhatsApp:', maskSensitiveText(reason));
    operationalNotifier.notifyError(
      'whatsapp_disconnected',
      'WhatsApp se desconecto. Revisar estado del bot.',
      { reason }
    ).catch((err) => {
      console.warn('[OPERATIONAL ALERT] error alertando disconnected:', maskSensitiveText(err && err.message));
    });
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

  client.on('message', createMessageHandler({
    config,
    driveService,
    logService,
    processedStore,
    operationalNotifier,
  }));

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
