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

  return new Client({
    authStrategy: new LocalAuth(localAuthOptions),
    puppeteer: puppeteerOptions,
  });
}

module.exports = {
  createWhatsappClient,
};
