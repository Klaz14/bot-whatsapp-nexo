const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { maskSensitiveText } = require('../utils/mask');

function assertDriveConfig(config) {
  if (!config.google.driveFolderId || config.google.driveFolderId === 'YYY') {
    console.error('Edita config.json o GOOGLE_DRIVE_FOLDER_ID y pone un driveFolderId real.');
    process.exit(1);
  }
  if (!fs.existsSync(config.paths.credentials)) {
    console.error('Falta credentials.json en', config.paths.credentials);
    console.error('Segui los pasos del README para crear el OAuth Client ID (tipo Desktop app) y bajar el JSON.');
    process.exit(1);
  }
  if (!fs.existsSync(config.paths.token)) {
    console.error('Falta token.json. Corri primero:  node auth.js');
    process.exit(1);
  }
}

function createDriveService(config) {
  assertDriveConfig(config);

  const credsRaw = JSON.parse(fs.readFileSync(config.paths.credentials, 'utf8'));
  const oauthBlock = credsRaw.installed || credsRaw.web;
  if (!oauthBlock || !oauthBlock.client_id) {
    console.error('credentials.json no parece ser un OAuth Client ID. Ver README.');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    oauthBlock.client_id,
    oauthBlock.client_secret,
    config.google.oauthRedirectUri
  );
  oauth2.setCredentials(JSON.parse(fs.readFileSync(config.paths.token, 'utf8')));
  oauth2.on('tokens', (tokens) => {
    try {
      const existing = JSON.parse(fs.readFileSync(config.paths.token, 'utf8'));
      fs.writeFileSync(config.paths.token, JSON.stringify({ ...existing, ...tokens }, null, 2));
    } catch (e) {
      console.warn('No se pudo persistir nuevo token:', e.message);
    }
  });

  const drive = google.drive({ version: 'v3', auth: oauth2 });

  async function uploadWithRetry(filename, mime, buffer, attempts = 3) {
    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      console.warn('[upload] subida a Drive bloqueada por configuracion de seguridad.');
      return {
        id: 'dry-run',
        webViewLink: '',
      };
    }

    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await drive.files.create({
          requestBody: {
            name: filename,
            parents: [config.google.driveFolderId],
          },
          media: {
            mimeType: mime,
            body: Readable.from(buffer),
          },
          fields: 'id, webViewLink',
          supportsAllDrives: true,
        });
        return res.data;
      } catch (err) {
        lastErr = err;
        if (i < attempts) {
          const wait = 1000 * Math.pow(2, i - 1);
          console.warn(`[upload] intento ${i}/${attempts} fallo: ${maskSensitiveText(err.message)}. Reintento en ${wait}ms`);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    }
    throw lastErr;
  }

  return {
    uploadWithRetry,
  };
}

module.exports = {
  createDriveService,
};
