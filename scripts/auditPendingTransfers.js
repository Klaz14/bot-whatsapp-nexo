const fs = require('fs');
const { google } = require('googleapis');
const { loadConfig } = require('../src/config/env');
const { auditPendingTransfers, formatPendingAuditReport } = require('../src/services/pendingAuditService');
const { maskSensitiveText } = require('../src/utils/mask');

function createReadOnlyDriveClient(config) {
  const credsRaw = JSON.parse(fs.readFileSync(config.paths.credentials, 'utf8'));
  const oauthBlock = credsRaw.installed || credsRaw.web;
  if (!oauthBlock || !oauthBlock.client_id) {
    throw new Error('credentials.json no parece ser un OAuth Client ID');
  }

  const oauth2 = new google.auth.OAuth2(
    oauthBlock.client_id,
    oauthBlock.client_secret,
    config.google.oauthRedirectUri
  );
  oauth2.setCredentials(JSON.parse(fs.readFileSync(config.paths.token, 'utf8')));
  return google.drive({ version: 'v3', auth: oauth2 });
}

async function main() {
  const config = loadConfig();
  const drive = createReadOnlyDriveClient(config);
  const summary = await auditPendingTransfers(drive, {
    pendingFolderId: config.google.pendingFolderId,
    parentFolderId: config.google.driveFolderId,
  });

  for (const line of formatPendingAuditReport(summary)) {
    console.log(line);
  }
}

main().catch((err) => {
  console.error('[PENDING AUDIT] error:', maskSensitiveText(err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
