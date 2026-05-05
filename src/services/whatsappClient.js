const { Client, LocalAuth } = require('whatsapp-web.js');

function createWhatsappClient(config) {
  const localAuthOptions = {
    dataPath: config.paths.whatsappAuthData,
  };

  if (config.whatsapp.clientId) {
    localAuthOptions.clientId = config.whatsapp.clientId;
  }

  const puppeteerOptions = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...config.puppeteer.browserArgs,
    ],
  };

  if (config.puppeteer.executablePath) {
    puppeteerOptions.executablePath = config.puppeteer.executablePath;
  }

  if (config.puppeteer.headless !== undefined) {
    puppeteerOptions.headless = config.puppeteer.headless;
  }

  const clientOptions = {
    authStrategy: new LocalAuth(localAuthOptions),
    puppeteer: puppeteerOptions,
    webVersionCache: { type: config.whatsapp.webVersionCacheType },
  };

  if (config.whatsapp.webVersion) {
    clientOptions.webVersion = config.whatsapp.webVersion;
  }

  if (config.whatsapp.webVersionCacheType === 'local') {
    clientOptions.webVersionCache.path = config.paths.whatsappWebCache;
    clientOptions.webVersionCache.strict = false;
  }

  return new Client(clientOptions);
}

module.exports = {
  createWhatsappClient,
};
