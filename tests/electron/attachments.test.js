const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-attachments-profile-'));

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
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await delay(80);
  }
  throw new Error('Timed out waiting for condition.');
}

function liveContents() {
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed());
}

function contentsByUrl(part) {
  return liveContents().find(contents => contents.getURL().includes(part));
}

function askTabContents() {
  return liveContents().find(contents => contents.getURL() === 'sovereign://ask/');
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
      loadModel: async progress => { progress?.({ text: 'Loaded mocked attachment model', progress: 1 }); },
      summarize: async (messages, onChunk) => {
        window.__summarizeCalls.push(messages);
        const prompt = messages.map(message => message.content).join('\\n');
        if (!prompt.includes('UPLOADED FILE EXCERPTS')) {
          throw new Error('Attachment excerpts were not supplied to the model prompt.');
        }
        onChunk('The uploaded notes say Sovereign parses files locally and cites file excerpts [1].');
      },
      stop: async () => {},
      unload: async () => {}
    };
    undefined;
  `, true);

  await ask.executeJavaScript(`
    async function attachTestFiles() {
      const input = document.querySelector('#attachment-input');
      const files = [
        new File(['Sovereign parses attached text locally. The answer should cite this note.'], 'notes.txt', { type: 'text/plain' }),
        new File(['name,value\\nalpha,2\\nbeta,4'], 'data.csv', { type: 'text/csv' }),
        new File(['not allowed'], 'program.exe', { type: 'application/octet-stream' })
      ];
      const transfer = new DataTransfer();
      for (const file of files) {
        transfer.items.add(file);
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    attachTestFiles();
  `, true);

  try {
    await waitFor(async () => {
      const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
      return text.includes('notes.txt') &&
        text.includes('data.csv') &&
        text.includes('Unsupported file type')
        ? true
        : null;
    });
  } catch (error) {
    const debug = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    throw new Error(`Attachment statuses did not render as expected: ${JSON.stringify(debug)}`);
  }

  await ask.executeJavaScript(`
    const exeRow = [...document.querySelectorAll('.attachment-item')].find(row => row.innerText.includes('program.exe'));
    exeRow.querySelector('.compact-action').click();
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7\\n1 0 obj << /Type /Catalog >> endobj'], 'scan.pdf', { type: 'application/pdf' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  `, true);

  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return text.includes('scan.pdf') && /OCR|malformed|unsupported|parsing failed|Invalid/i.test(text) ? true : null;
  });

  await ask.executeJavaScript(`
    const removeButtons = [...document.querySelectorAll('.attachment-item .compact-action')];
    const dataRow = [...document.querySelectorAll('.attachment-item')].find(row => row.innerText.includes('data.csv'));
    dataRow.querySelector('.compact-action').click();
  `, true);

  await waitFor(async () => {
    const text = await ask.executeJavaScript("document.querySelector('#attachment-list').innerText", true);
    return !text.includes('data.csv') ? true : null;
  });

  await ask.executeJavaScript(`
    document.querySelector('#chat-input').value = 'What do the uploaded notes say?';
    document.querySelector('#chat-form').requestSubmit();
  `, true);

  try {
    await waitFor(async () => {
      const text = await ask.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
      return text.includes('parses files locally') && text.includes('SOURCES') && text.includes('notes.txt') ? true : null;
    });
  } catch (error) {
    const debug = await ask.executeJavaScript(`({
      thread: document.querySelector('#chat-thread').innerText,
      status: document.querySelector('#chat-status').innerText,
      model: document.querySelector('#model-status').innerText,
      calls: window.__summarizeCalls?.length || 0
    })`, true);
    throw new Error(`Attachment answer did not render expected output: ${JSON.stringify(debug)}`);
  }

  const result = await ask.executeJavaScript(`({
    attachmentText: document.querySelector('#attachment-list').innerText,
    answerText: document.querySelector('#chat-thread').innerText,
    promptHadFileExcerpts: window.__summarizeCalls.at(-1).some(message => message.content.includes('UPLOADED FILE EXCERPTS'))
  })`, true);

  console.log(JSON.stringify({
    profile,
    promptHadFileExcerpts: result.promptHadFileExcerpts,
    attachmentListIncludesPdfError: /OCR|malformed|unsupported|parsing failed|Invalid/i.test(result.attachmentText),
    answerIncludesFileCitation: result.answerText.includes('[1]')
  }, null, 2));

  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
