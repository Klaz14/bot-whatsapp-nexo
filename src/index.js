const qrcode = require('qrcode-terminal');
const { loadConfig } = require('./config/env');
const { createDriveService } = require('./services/driveService');
const { createLogService } = require('./services/logService');
const { createWhatsappClient } = require('./services/whatsappClient');
const { createMessageHandler } = require('./handlers/messageHandler');

function startBot() {
  const config = loadConfig();
  const driveService = createDriveService(config);
  const logService = createLogService(config);
  const client = createWhatsappClient(config);

  client.on('qr', (qr) => {
    console.log('\nEscanea este QR con WhatsApp (Configuracion -> Dispositivos vinculados -> Vincular un dispositivo):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('Autenticado. Sesion guardada en', config.paths.whatsappAuthData);
  });

  client.on('auth_failure', (msg) => {
    console.error('Falla de autenticacion:', msg);
  });

  client.on('ready', () => {
    console.log('\nBot listo y escuchando.');
    console.log('Grupos configurados:');
    for (const [name, tag] of Object.entries(config.whatsapp.groups)) {
      console.log(`  - "${name}" -> tag "${tag}"`);
    }
    console.log(`Carpeta destino de Drive: ${config.google.driveFolderId}\n`);
  });

  client.on('disconnected', (reason) => {
    console.warn('Desconectado de WhatsApp:', reason);
  });

  client.on('message', createMessageHandler({ config, driveService, logService }));

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    logService.error(`${new Date().toISOString()}\tunhandledRejection\t-\t-\tERROR: ${err && err.message}`);
  });

  console.log('Iniciando bot...');
  if (!config.safety.allowRealWhatsappConnection) {
    console.warn('Conexion real a WhatsApp bloqueada por ALLOW_REAL_WHATSAPP_CONNECTION=false.');
    return client;
  }

  client.initialize();
  return client;
}

module.exports = {
  startBot,
};
