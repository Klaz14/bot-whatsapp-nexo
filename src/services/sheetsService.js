// MOD-01: lectura de grupos/TAGs desde una planilla Google Sheets existente.
// Solo LECTURA. No modifica la planilla. Autentica con Service Account (recomendado).
// Columnas configurables: grupo (default K), TAG (default E).

const { google } = require('googleapis');

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const PHONE_RE = /^[\d+,\s]+$/; // fila que es un telefono/contacto, no un grupo

// "A" -> 0, "E" -> 4, "K" -> 10, "AA" -> 26, etc.
function columnLetterToIndex(letter) {
  let idx = 0;
  for (const ch of String(letter || '').toUpperCase()) {
    const code = ch.charCodeAt(0) - 64;
    if (code < 1 || code > 26) continue;
    idx = idx * 26 + code;
  }
  return idx - 1;
}

function createSheetsService(config) {
  let authClient;

  function getAuth() {
    if (authClient) return authClient;
    const keyFile = config.sheets.credentialsPath;
    if (!keyFile) {
      throw new Error('Falta GOOGLE_SHEETS_CREDENTIALS_PATH (JSON de Service Account) para leer Sheets.');
    }
    authClient = new google.auth.GoogleAuth({ keyFile, scopes: [SHEETS_SCOPE] });
    return authClient;
  }

  async function readRows(spreadsheetId, sheetName) {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName, // hoja completa
      majorDimension: 'ROWS',
    });
    return res.data.values || [];
  }

  // Devuelve [{ grupoWhatsapp, tag }] aplicando el filtrado de filas validas del SPEC.
  async function readGroupTagPairs() {
    const rows = await readRows(config.sheets.spreadsheetId, config.sheets.sheetName);
    const gIdx = columnLetterToIndex(config.sheets.groupColumn);
    const tIdx = columnLetterToIndex(config.sheets.tagColumn);
    const pairs = [];

    rows.forEach((row, i) => {
      if (i === 0) return; // header
      const group = String((row[gIdx] !== undefined ? row[gIdx] : '')).trim();
      const tag = String((row[tIdx] !== undefined ? row[tIdx] : '')).trim();
      if (!group) return;                 // col grupo vacia
      if (PHONE_RE.test(group)) return;   // es un telefono, no un grupo
      if (group.includes(',')) return;    // multiples valores separados por coma
      if (!tag || tag === '-') return;    // TAG vacio o solo guion
      pairs.push({ grupoWhatsapp: group, tag });
    });

    return pairs;
  }

  // MOD-02: pestana BOT_BLACKLIST de la planilla NUEVA del bot (config.blacklist.botConfigId).
  // Col A = TELEFONO (cualquier formato), Col C = ACTIVO (si/no). Devuelve telefonos crudos
  // (la normalizacion la hace blacklistCache).
  async function readBlacklist() {
    const rows = await readRows(config.blacklist.botConfigId, config.blacklist.blacklistSheetName);
    const out = [];
    rows.forEach((row, i) => {
      if (i === 0) return; // header
      const tel = String((row[0] !== undefined ? row[0] : '')).trim();
      const activo = String((row[2] !== undefined ? row[2] : '')).trim().toLowerCase();
      if (!tel) return;
      if (activo === 'no') return;
      out.push(tel);
    });
    return out;
  }

  // MOD-02: pestana BOT_EXEMPT. Col A = GRUPO_WHATSAPP (nombre exacto), Col C = ACTIVO.
  async function readExemptGroups() {
    const rows = await readRows(config.blacklist.botConfigId, config.blacklist.exemptSheetName);
    const out = [];
    rows.forEach((row, i) => {
      if (i === 0) return;
      const group = String((row[0] !== undefined ? row[0] : '')).trim();
      const activo = String((row[2] !== undefined ? row[2] : '')).trim().toLowerCase();
      if (!group) return;
      if (activo === 'no') return;
      out.push(group);
    });
    return out;
  }

  return { readRows, readGroupTagPairs, readBlacklist, readExemptGroups };
}

module.exports = { createSheetsService, columnLetterToIndex };
