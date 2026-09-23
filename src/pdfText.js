/**
 * Browser-only PDF → plain text, via pdf.js loaded from a CDN at runtime.
 *
 * This is the one part of the app with an external dependency and it is not
 * unit-testable the way calendarImport.js is: it needs a real browser and a
 * live network fetch to a CDN, neither of which the test runner has. Treat
 * this file as best-effort — every failure mode surfaces a specific message
 * instead of a silent crash, since there is no offline fallback for reading
 * a PDF's text.
 */

const PDFJS_VERSION = '4.7.76';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ `${PDFJS_BASE}/pdf.min.mjs`)
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
        return lib;
      })
      .catch((err) => {
        pdfjsPromise = null; // allow retry on a later attempt
        throw new Error(
          `Could not load the PDF reader from ${PDFJS_BASE} (${err.message}). ` +
            'This needs internet access to a CDN — if it keeps failing, save the file as .md or .txt instead.',
        );
      });
  }
  return pdfjsPromise;
}

/** @param {ArrayBuffer} arrayBuffer @returns {Promise<string>} plain text, pages joined by blank lines */
export async function extractPdfText(arrayBuffer) {
  const pdfjsLib = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    throw new Error(`Could not open that PDF (${err.message}). Is it a text PDF, not a scanned image?`);
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Keep the PDF's line structure: a table row or a "1:05 PM 118 bpm" line
    // must stay one line for the heart-rate and calendar parsers to read it.
    let text = '';
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
      else if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' ';
      text += item.str;
      if (item.hasEOL) text += '\n';
      if (y !== null) lastY = y;
    }
    pages.push(text);
  }
  return pages.join('\n\n');
}
