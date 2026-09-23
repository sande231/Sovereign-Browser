const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { app, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-pdf-attachments-profile-'));

fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({
  ai: {
    autoDownloadModel: false,
    setupNoticeSeen: true,
    setupCanceled: false,
    saveChatsOnDevice: false
  },
  search: {},
  downloads: {},
  bookmarks: [],
  startup: { continueWhereLeftOff: false },
  session: { windows: [] }
}, null, 2));

process.env.SOVEREIGN_USER_DATA_DIR = profile;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 12000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

function liveContents() {
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed());
}

function contentsByUrl(part) {
  return liveContents().find(contents => contents.getURL().includes(part));
}

function askTabContents() {
  return liveContents().find(contents => {
    const url = contents.getURL();
    return url.startsWith('sovereign://ask/') && !url.includes('model-setup');
  });
}

function pdfEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function pdfObject(id, body) {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

function buildPdf(pages, options = {}) {
  const objects = [];
  objects.push([1, '<< /Type /Catalog /Pages 2 0 R >>']);
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects.push([2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`]);
  objects.push([3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']);

  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    objects.push([pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`]);
    const commands = page.text
      ? `BT /F1 14 Tf 72 720 Td (${pdfEscape(page.text)}) Tj ET`
      : '0 0 200 200 re f';
    const stream = options.compress === false
      ? Buffer.from(commands)
      : zlib.deflateSync(Buffer.from(commands));
    const filter = options.compress === false ? '' : ' /Filter /FlateDecode';
    objects.push([contentId, `<< /Length ${stream.length}${filter} >>\nstream\n${stream.toString('binary')}\nendstream`]);
  });

  if (options.paddingBytes) {
    const id = 4 + pages.length * 2;
    objects.push([id, `<< /Length ${options.paddingBytes} >>\nstream\n${'0'.repeat(options.paddingBytes)}\nendstream`]);
  }
  if (options.encryptTrailer) {
    const id = 5 + pages.length * 2;
    objects.push([id, '<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>']);
  }

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = new Map();
  for (const [id, objectBody] of objects) {
    offsets.set(id, Buffer.byteLength(body, 'binary'));
    body += pdfObject(id, objectBody);
  }
  const xrefOffset = Buffer.byteLength(body, 'binary');
  const maxId = Math.max(...objects.map(([id]) => id));
  body += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id) || 0;
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const encryptId = options.encryptTrailer ? maxId : 0;
  body += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R${encryptId ? ` /Encrypt ${encryptId} 0 R` : ''} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

function bufferToBrowserFile(buffer, name) {
  return `
    (() => {
      const binary = atob(${JSON.stringify(buffer.toString('base64'))});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new File([bytes], ${JSON.stringify(name)}, { type: 'application/pdf' });
    })()
  `;
}

async function attachPdf(ask, buffer, name) {
  return ask.executeJavaScript(`
    (() => {
      const input = document.querySelector('#attachment-input');
      const transfer = new DataTransfer();
      transfer.items.add(${bufferToBrowserFile(buffer, name)});
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })();
  `, true);
}

async function askQuestion(ask, question) {
  await ask.executeJavaScript(`
    document.querySelector('#chat-input').value = ${JSON.stringify(question)};
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => ask.executeJavaScript("!document.querySelector('#send-chat').disabled", true));
  return ask.executeJavaScript(`({
    thread: document.querySelector('#chat-thread').innerText,
    status: document.querySelector('#chat-status').innerText,
    prompt: window.SovereignAsk?.lastModelMessages?.().map(message => message.content).join('\\n\\n') || '',
    calls: window.__summarizeCalls.length
  })`, true);
}

async function main() {
  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  await chrome.executeJavaScript("window.sovereign.openSearch({ mode: 'ask' })", true);
  const ask = await waitFor(() => askTabContents());
  await waitFor(() => ask.executeJavaScript("document.querySelector('#attachment-input') !== null", true));

  await ask.executeJavaScript(`
    window.__summarizeCalls = [];
    window.SovereignAIEngine = {
      environment: async () => ({ webgpu: true, secureContext: true, userAgent: 'test' }),
      isModelCached: async () => true,
      loadModel: async progress => { progress?.({ text: 'Loaded mocked PDF model', progress: 1 }); },
      summarize: async (messages, onChunk) => {
        window.__summarizeCalls.push(messages);
        const prompt = messages.map(message => message.content).join('\\n');
        if (!prompt.includes('UPLOADED FILE EXCERPTS')) {
          throw new Error('PDF excerpts were not supplied to the model prompt.');
        }
        if (prompt.includes('What budget does the PDF report?')) {
          onChunk('The supplied PDF excerpts do not mention a project budget, so I cannot answer that from the document.');
        } else if (prompt.includes('What limitation is listed on the later page')) {
          onChunk('The limitation is that ocean sampling excluded winter months and polar regions [1].');
        } else if (prompt.includes('For a follow-up')) {
          onChunk('The follow-up still uses the attached PDF: the study used 128 survey responses and field interviews [1].');
        } else {
          onChunk('## Summary\\n\\n- Atlas revenue was 42 million dollars in 2024 [1].\\n- The method used 128 survey responses and field interviews [2].\\n- A limitation was that ocean sampling excluded winter months and polar regions [3].');
        }
      },
      stop: async () => {},
      unload: async () => {}
    };
    undefined;
  `, true);

  const textPdf = buildPdf([
    { text: 'Page one finding: Atlas revenue was 42 million dollars in 2024.' },
    { text: 'Page two method: The study used 128 survey responses and field interviews.' },
    { text: 'Page three limitation: Ocean sampling excluded winter months and polar regions.' }
  ]);
  await attachPdf(ask, textPdf, 'distinctive-report.pdf');

  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return text.includes('distinctive-report.pdf') && text.includes('ready') ? true : null;
  });

  const summary = await askQuestion(ask, 'Summarize and give me all the important data from the PDF.');
  if (!summary.prompt.includes('PDF page 1') || !summary.prompt.includes('PDF page 2') || !summary.prompt.includes('PDF page 3')) {
    throw new Error(`Whole-document prompt did not include page evidence: ${summary.prompt}`);
  }
  if (!summary.thread.includes('distinctive-report.pdf') || !summary.thread.includes('Atlas revenue') || !summary.thread.includes('PDF page 3')) {
    throw new Error(`Whole-document answer did not render attachment status and page sources: ${summary.thread}`);
  }
  if (!await ask.executeJavaScript("Boolean(document.querySelector('.chat-heading'))", true)) {
    throw new Error('Markdown heading was not rendered as a heading.');
  }

  const laterPage = await askQuestion(ask, 'What limitation is listed on the later page about winter months?');
  if (!laterPage.prompt.includes('PDF page 3') || !laterPage.thread.includes('winter months')) {
    throw new Error(`Later-page question was not grounded in page 3: ${JSON.stringify(laterPage)}`);
  }

  const followup = await askQuestion(ask, 'For a follow-up, what method did it use?');
  if (!followup.prompt.includes('PDF page 2') || !followup.thread.includes('128 survey responses')) {
    throw new Error(`Follow-up did not retain attachment evidence: ${JSON.stringify(followup)}`);
  }

  const impossible = await askQuestion(ask, 'What budget does the PDF report?');
  if (!impossible.thread.includes('do not mention a project budget')) {
    throw new Error(`Insufficient-evidence answer was not shown: ${impossible.thread}`);
  }

  const callsBeforeNoAttachment = await ask.executeJavaScript("window.__summarizeCalls.length", true);
  await ask.executeJavaScript("document.querySelector('#new-chat').click()", true);
  const noAttachment = await askQuestion(ask, 'Summarize the PDF.');
  if (!noAttachment.thread.includes('Please attach') || noAttachment.calls !== callsBeforeNoAttachment) {
    throw new Error(`No-attachment question should not call the model: ${JSON.stringify(noAttachment)}`);
  }

  const imageOnlyPdf = buildPdf([{ text: '' }]);
  await attachPdf(ask, imageOnlyPdf, 'scan.pdf');
  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return text.includes('scan.pdf') && text.includes('OCR') ? true : null;
  });
  const callsBeforeFailed = await ask.executeJavaScript("window.__summarizeCalls.length", true);
  const failed = await askQuestion(ask, 'Summarize the attached PDF.');
  if (!failed.thread.includes('scan.pdf:') || !failed.thread.includes('OCR') || failed.calls !== callsBeforeFailed) {
    throw new Error(`Failed extraction should not call the model: ${JSON.stringify(failed)}`);
  }

  await ask.executeJavaScript("document.querySelector('#new-chat').click()", true);
  const largePdf = buildPdf([
    { text: 'Large page one value: Neptune index is 77.' },
    { text: 'Large later page value: Comet retention is 91 percent.' }
  ], { paddingBytes: 6 * 1024 * 1024 });
  if (largePdf.length <= 5 * 1024 * 1024 || largePdf.length >= 25 * 1024 * 1024) {
    throw new Error(`Large PDF fixture is outside expected range: ${largePdf.length}`);
  }
  await attachPdf(ask, largePdf, 'large-valid-report.pdf');
  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return text.includes('large-valid-report.pdf') && text.includes('ready') ? true : null;
  });
  const large = await askQuestion(ask, 'What is the Comet retention value on the later page of the PDF?');
  if (!large.prompt.includes('PDF page 2') || !large.prompt.includes('Comet retention is 91 percent')) {
    throw new Error(`Large PDF extraction did not include later-page text: ${JSON.stringify(large)}`);
  }

  await ask.executeJavaScript("document.querySelector('#new-chat').click()", true);
  const malformedPdf = Buffer.from('%PDF-1.7\nthis is not a valid cross-reference table\n%%EOF\n');
  await attachPdf(ask, malformedPdf, 'malformed.pdf');
  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return text.includes('malformed.pdf') && /malformed|unsupported|parsing failed|Invalid/i.test(text) ? true : null;
  });

  await ask.executeJavaScript("document.querySelector('#new-chat').click()", true);
  const passwordPdf = buildPdf([{ text: 'Hidden password protected text.' }], { encryptTrailer: true });
  await attachPdf(ask, passwordPdf, 'password-protected.pdf');
  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return text.includes('password-protected.pdf') && /password-protected|password/i.test(text) ? true : null;
  });

  const oversized = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(25 * 1024 * 1024 + 1, 48)]);
  await attachPdf(ask, oversized, 'too-large.pdf');
  await waitFor(async () => {
    const status = await ask.executeJavaScript("document.querySelector('#chat-status').innerText", true);
    return status.includes('25 MB') ? true : null;
  });

  console.log(JSON.stringify({
    profile,
    textPdfBytes: textPdf.length,
    largePdfBytes: largePdf.length,
    summaryPromptHadPages: ['PDF page 1', 'PDF page 2', 'PDF page 3'].every(page => summary.prompt.includes(page)),
    laterPageGrounded: laterPage.prompt.includes('PDF page 3'),
    noAttachmentSkippedModel: noAttachment.calls === callsBeforeNoAttachment,
    failedExtractionSkippedModel: failed.calls === callsBeforeFailed,
    largePdfLaterPage: large.prompt.includes('PDF page 2'),
    passwordProtectedDetected: true
  }, null, 2));

  app.quit();
}

main().catch(error => {
  console.error(error);
  app.exit(1);
});
