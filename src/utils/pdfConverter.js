// Conversión de PDFs a JPEG vía node-poppler (pdftocairo).
// convertPdfFirstPageToJpg  : primera página → Buffer JPEG (flujo actual, sin cambios).
// getPdfPageCount            : total de páginas de un PDF buffer → number.
// convertPdfPageRangeToJpgs  : rango [fromPage..toPage] → Array<{ buffer, pageNumber }>.
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

// Retorna el número total de páginas del PDF buffer.
// Nunca lanza: si pdfInfo falla (PDF encriptado, corrupto, binario de poppler ausente)
// devuelve 1 como fallback — un PDF que al menos abre en Chromium debe poder convertir
// la página 1, y bloquear el conteo no debe silenciar el mensaje completo.
async function getPdfPageCount(pdfBuffer) {
  const uid = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const tmpPdf = path.join(os.tmpdir(), `pdf_info_${uid}.pdf`);
  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);
    const info = await poppler.pdfInfo(tmpPdf);
    const match = /Pages:\s+(\d+)/i.exec(String(info || ''));
    if (match) {
      const count = parseInt(match[1], 10);
      if (Number.isFinite(count) && count > 0) return count;
    }
    return 1;
  } catch (_) {
    return 1;
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch (_) {}
  }
}

// Convierte las páginas [fromPage..toPage] del PDF buffer a JPEG (200 DPI).
// Retorna Array<{ buffer: Buffer, pageNumber: number }> ordenado por pageNumber.
// pageNumber = número de página GLOBAL en el PDF original (base 1, no relativo al rango).
//
// Sin singleFile, pdftocairo genera <outBase>-NNN.jpg donde NNN es el número de página
// global con cero-padding consistente al total de páginas del documento. Ordenar los
// archivos por nombre alfabéticamente equivale a ordenarlos numéricamente (el cero-padding
// garantiza que el orden lexicográfico = orden numérico). El mapeo pageNumber = fromPage + i
// es correcto porque poppler genera exactamente (toPage - fromPage + 1) archivos para el rango.
//
// El finally borra TODOS los temporales generados para este uid (tanto el PDF de entrada
// como los jpg de salida), incluso si la conversión falla a mitad.
async function convertPdfPageRangeToJpgs(pdfBuffer, fromPage, toPage) {
  if (!Number.isInteger(fromPage) || !Number.isInteger(toPage) || fromPage < 1 || fromPage > toPage) {
    return [];
  }

  const uid = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const tmpPdf = path.join(os.tmpdir(), `pdf_in_${uid}.pdf`);
  const tmpOutBase = path.join(os.tmpdir(), `pdf_out_${uid}`);
  const outBasename = `pdf_out_${uid}`;

  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);

    await poppler.pdfToCairo(tmpPdf, tmpOutBase, {
      jpegFile: true,
      firstPageToConvert: fromPage,
      lastPageToConvert: toPage,
      resolutionXYAxis: 200,
    });

    const generatedFiles = fs.readdirSync(os.tmpdir())
      .filter((f) => f.startsWith(outBasename + '-') && f.endsWith('.jpg'))
      .map((f) => {
        const m = /-(\d+)\.jpg$/.exec(f);
        return { filename: f, num: m ? parseInt(m[1], 10) : 0 };
      })
      .sort((a, b) => a.num - b.num);

    return generatedFiles.map((entry, i) => ({
      buffer: fs.readFileSync(path.join(os.tmpdir(), entry.filename)),
      pageNumber: fromPage + i,
    }));
  } catch (err) {
    const reason = err && err.message
      ? err.message.replace(/\/\S+/g, '<path>').replace(/[^\x20-\x7E]/g, '').slice(0, 120)
      : 'unknown error';
    throw new Error(`PDF range conversion failed (pages ${fromPage}-${toPage}): ${reason}`);
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch (_) {}
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(outBasename + '-') && f.endsWith('.jpg')) {
          try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
}

module.exports = { convertPdfFirstPageToJpg, getPdfPageCount, convertPdfPageRangeToJpgs };
