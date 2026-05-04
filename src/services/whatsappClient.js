const { Client, LocalAuth } = require('whatsapp-web.js');

function createWhatsappClient(config) {
  const localAuthOptions = {
    dataPath: config.paths.whatsappAuthData,
  };

  if (config.whatsapp.clientId) {
    localAuthOptions.clientId = config.whatsapp.clientId;
  }

  return new Client({
    authStrategy: new LocalAuth(localAuthOptions),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });
}

module.exports = {
  createWhatsappClient,
};
