const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, clipboard, webContents } = require('electron');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-media-chat-profile-'));
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
process.env.SOVEREIGN_MEDIA_TEST_FIXTURES = '1';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await delay(100);
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
    return url.startsWith('sovereign://ask/') &&
      !url.includes('model-setup') &&
      !url.includes('sidebar');
  });
}

async function main() {
  require('../../src/main.js');
  await app.whenReady();

  const chrome = await waitFor(() => contentsByUrl('index.html'));
  await chrome.executeJavaScript("window.sovereign.openSearch({ question: 'media test', mode: 'ask', autoRun: false })", true);
  const askPage = await waitFor(() => askTabContents());

  await askPage.executeJavaScript(`
    document.querySelector('#web-toggle').checked = false;
    document.querySelector('#chat-input').value = 'Show me a map of Nepal.';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Search web for images') ? text : null;
  });
  const localOnlyShape = await askPage.executeJavaScript(`({
    cardCount: document.querySelectorAll('.media-card').length,
    actionText: document.querySelector('.chat-inline-action')?.textContent || '',
    url: location.href
  })`, true);
  if (localOnlyShape.cardCount !== 0 || localOnlyShape.actionText !== 'Search web for images') {
    throw new Error(`Local-only media request did not show the web-search action: ${JSON.stringify(localOnlyShape)}`);
  }
  await waitFor(() => askPage.executeJavaScript("!document.querySelector('#send-chat').disabled", true));

  const enableActionResult = await askPage.executeJavaScript(`(() => {
    const action = document.querySelector('.chat-inline-action');
    action?.click();
    return {
      hasAction: Boolean(action),
      actionText: action?.textContent || '',
      actionHtml: action?.outerHTML || '',
      checked: document.querySelector('#web-toggle').checked,
      disabled: document.querySelector('#web-toggle').disabled,
      status: document.querySelector('#chat-status').innerText,
      url: location.href
    };
  })()`, true);
  if (!enableActionResult.checked) {
    throw new Error(`Enable web search action did not turn on the Ask AI web toggle: ${JSON.stringify(enableActionResult)}`);
  }
  await waitFor(async () => {
    const count = await askPage.executeJavaScript("document.querySelectorAll('.media-card').length", true);
    return count >= 4 ? count : null;
  });
  const imageShape = await askPage.executeJavaScript(`({
    cardCount: document.querySelectorAll('.media-card').length,
    text: document.querySelector('#chat-thread').innerText,
    url: location.href,
    downloadableButtons: Array.from(document.querySelectorAll('.media-card button[data-role="download-media"]')).filter(button => button.textContent === 'Download' && !button.disabled).length,
    thumbnailButtons: Array.from(document.querySelectorAll('.media-card button[data-role="download-media"]')).filter(button => button.textContent === 'Download thumbnail' && !button.disabled).length,
    unavailableButtons: Array.from(document.querySelectorAll('.media-card button[data-role="download-media"]')).filter(button => button.textContent === 'Download unavailable').length,
    copiedUrlButtonCount: document.querySelectorAll('.media-card button[data-role="copy-original-media-url"]').length,
    secondOriginalUrl: document.querySelectorAll('.media-card')[1].dataset.originalUrl,
    fourthOriginalUrl: document.querySelectorAll('.media-card')[3].dataset.originalUrl,
    fourthThumbnailUrl: document.querySelectorAll('.media-card')[3].dataset.thumbnailUrl
  })`, true);
  if (imageShape.cardCount !== 4 || imageShape.downloadableButtons !== 2 || imageShape.thumbnailButtons !== 1 || imageShape.unavailableButtons !== 1 || imageShape.copiedUrlButtonCount !== 3) {
    throw new Error(`Image media cards were not rendered or validated correctly: ${JSON.stringify(imageShape)}`);
  }
  if (!imageShape.url.startsWith('sovereign://ask/') || imageShape.url !== localOnlyShape.url || !imageShape.text.includes('Political map of Nepal') || !imageShape.text.includes('map of Nepal') || !imageShape.text.includes('License unknown') || !imageShape.text.includes('Original image URL was unavailable. Thumbnail download verified.') || imageShape.secondOriginalUrl !== 'https://cdn.example/everest-photo.png' || imageShape.fourthOriginalUrl !== '' || imageShape.fourthThumbnailUrl !== 'https://thumb.example/nepal-thumb.webp') {
    throw new Error(`Image card text/preflight coverage was incomplete: ${JSON.stringify(imageShape)}`);
  }

  await askPage.executeJavaScript(`
    document.querySelectorAll('.media-card')[1].querySelector('button[data-role="copy-original-media-url"]').click();
  `, true);
  await waitFor(() => clipboard.readText() === 'https://cdn.example/everest-photo.png');

  await askPage.executeJavaScript(`
    document.querySelectorAll('.media-card')[1].querySelector('button[data-role="download-media"]').click();
  `, true);
  await waitFor(async () => {
    const status = await askPage.executeJavaScript("document.querySelector('#chat-status').innerText", true);
    return status.includes('Media download started') ? status : null;
  });
  await waitFor(() => askPage.executeJavaScript("!document.querySelector('#send-chat').disabled", true));

  await askPage.executeJavaScript(`
    document.querySelector('#chat-input').value = 'download the second image';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Started downloading result 2') ? text : null;
  });
  const downloadShape = await askPage.executeJavaScript(`({
    text: document.querySelector('#chat-thread').innerText
  })`, true);
  if (!downloadShape.text.includes('Started downloading result 2') || !downloadShape.text.includes('Mount Everest photo')) {
    throw new Error(`Follow-up media download did not resolve the correct prior item: ${JSON.stringify(downloadShape)}`);
  }
  await waitFor(() => askPage.executeJavaScript("!document.querySelector('#send-chat').disabled", true));

  await askPage.executeJavaScript(`
    document.querySelector('#web-toggle').checked = true;
    document.querySelector('#chat-input').value = 'Find a video of Mount Everest.';
    document.querySelector('#chat-form').requestSubmit();
  `, true);
  await waitFor(async () => {
    const text = await askPage.executeJavaScript("document.querySelector('#chat-thread').innerText", true);
    return text.includes('Some results are watch pages') ? text : null;
  });
  const videoShape = await askPage.executeJavaScript(`({
    text: document.querySelector('#chat-thread').innerText,
    videoDownloads: Array.from(document.querySelectorAll('.media-card')).slice(-2).map(card => ({
      title: card.innerText,
      downloadDisabled: Array.from(card.querySelectorAll('button')).find(button => button.textContent.startsWith('Download'))?.disabled
    }))
  })`, true);
  if (!videoShape.text.includes('video results for "Mount Everest"') || !videoShape.text.includes('Watch page or unverified video result.') || videoShape.videoDownloads[0].downloadDisabled !== true || videoShape.videoDownloads[1].downloadDisabled !== false) {
    throw new Error(`Video media cards did not distinguish watch pages from direct downloads: ${JSON.stringify(videoShape)}`);
  }

  console.log(JSON.stringify({
    profile,
    localOnlyShape,
    imageShape,
    downloadShape,
    videoShape
  }, null, 2));

  app.quit();
}

main().catch(error => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
