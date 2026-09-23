import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';

const MAX_PDF_PAGES = 300;
const MAX_PDF_TEXT_CHARS = 200_000;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', self.location.href).toString();

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pageText(items = []) {
  return normalizeText(items.map(item => item?.str || '').join(' '));
}

function classifyError(error) {
  const name = error?.name || '';
  const message = error?.message || String(error || 'Unknown PDF error.');
  if (name === 'PasswordException' || /password/i.test(message)) {
    return {
      kind: 'password',
      message: 'This PDF is password-protected. Sovereign cannot extract it without a password.'
    };
  }
  if (name === 'InvalidPDFException' || /invalid pdf|malformed|bad xref|xref/i.test(message)) {
    return {
      kind: 'malformed',
      message: `This PDF appears to be malformed or unsupported: ${message}`
    };
  }
  if (/worker|module|import|setting up fake worker|loading/i.test(message)) {
    return {
      kind: 'worker',
      message: `PDF parser worker initialization failed: ${message}`
    };
  }
  return {
    kind: 'parser',
    message: `PDF parsing failed: ${message}`
  };
}

async function extractPdf({ id, data }) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    stopAtErrors: false,
    verbosity: 0,
    onPassword() {
      throw new Error('Password required');
    }
  });

  let document;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    throw Object.assign(new Error(classifyError(error).message), { extractionKind: classifyError(error).kind });
  }

  const totalPages = document.numPages || 0;
  const pagesToProcess = Math.min(totalPages, MAX_PDF_PAGES);
  const pages = [];
  const ocrPages = [];
  let textChars = 0;
  let limitReached = false;

  for (let pageNumber = 1; pageNumber <= pagesToProcess; pageNumber += 1) {
    if (textChars >= MAX_PDF_TEXT_CHARS) {
      limitReached = true;
      break;
    }

    self.postMessage({
      type: 'progress',
      id,
      pageNumber,
      totalPages,
      pagesProcessed: pageNumber - 1,
      textChars,
      text: `Extracting page ${pageNumber} of ${totalPages}`
    });

    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent({
      includeMarkedContent: false,
      disableNormalization: false
    });
    const text = pageText(content.items);
    page.cleanup();

    if (!text) {
      ocrPages.push(pageNumber);
      continue;
    }

    const remaining = MAX_PDF_TEXT_CHARS - textChars;
    const pageTextSlice = text.slice(0, remaining);
    if (pageTextSlice.length < text.length) {
      limitReached = true;
    }
    textChars += pageTextSlice.length;
    pages.push({
      pageNumber,
      text: pageTextSlice
    });
  }

  if (pagesToProcess < totalPages) {
    limitReached = true;
  }

  if (typeof document.destroy === 'function') {
    await document.destroy();
  } else if (typeof loadingTask.destroy === 'function') {
    await loadingTask.destroy();
  }

  self.postMessage({
    type: 'done',
    id,
    result: {
      pages,
      totalPages,
      pagesProcessed: pagesToProcess,
      ocrPages,
      limitReached,
      limits: {
        maxPages: MAX_PDF_PAGES,
        maxTextChars: MAX_PDF_TEXT_CHARS
      }
    }
  });
}

self.addEventListener('message', event => {
  const payload = event.data || {};
  if (payload.type !== 'extract-pdf') {
    return;
  }
  extractPdf(payload).catch(error => {
    const classified = error.extractionKind
      ? { kind: error.extractionKind, message: error.message }
      : classifyError(error);
    self.postMessage({
      type: 'error',
      id: payload.id,
      error: classified
    });
  });
});
