// Convierte la primera página de un PDF a JPEG en memoria.
// Primera página únicamente: el flujo downstream (OCR) espera una imagen por comprobante.
// Requiere poppler-utils instalado en el sistema: Linux → apt-get install poppler-utils poppler-data.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Poppler } = require('node-poppler');

const poppler = new Poppler();

async function convertPdfFirstPageToJpg(pdfBuffer) {
  const uid = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const tmpPdf = path.join(os.tmpdir(), `pdf_in_${uid}.pdf`);
  const tmpOutBase = path.join(os.tmpdir(), `pdf_out_${uid}`);
  const tmpJpg = `${tmpOutBase}.jpg`;

  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);

    await poppler.pdfToCairo(tmpPdf, tmpOutBase, {
      jpegFile: true,
      firstPageToConvert: 1,
      lastPageToConvert: 1,
      resolutionXYAxis: 200,
      singleFile: true,
    });

    return fs.readFileSync(tmpJpg);
  } catch (err) {
    const reason = err && err.message
      ? err.message.replace(/\/\S+/g, '<path>').replace(/[^\x20-\x7E]/g, '').slice(0, 120)
      : 'unknown error';
    throw new Error(`PDF conversion failed: ${reason}`);
  } finally {
    for (const f of [tmpPdf, tmpJpg]) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

module.exports = { convertPdfFirstPageToJpg };
