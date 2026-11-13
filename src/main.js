const sensitiveGuard = require('./sensitive-guard');
let privacySettings = { sensitiveTopics: 'strict' };
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const packageMetadata = require('../package.json');
const {
  classifyAddressInput, normalizeAddress, normalizeInternalUrl, normalizeSearchQuestion, looksLikeHostAddress
} = require('./address-input');
const {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  net,
  protocol,
  WebContentsView,
  webContents,
  ipcMain,
  screen,
  session,
  shell
} = require('electron');
const {
  DEFAULT_SEARXNG_ENDPOINT,
  normalizeSearxngEndpoint,
  requestActivityEntry,
  searchSearxng,
  searchSearxngMedia
} = require('./search-backend');
const {
  readSourcePages
} = require('./source-reader');
const privacyReceipts = require('./privacy-receipt');
const { createPermissionController } = require('./permission-policy');
const { createChatStore, legacyChatIds, parseLegacyChats } = require('./chat-store');
const { testHook } = require('./test-hooks');
const dns = require('node:dns').promises;
const { isIP } = require('node:net');
const { safeFetch, checkHopUrl, resolvePublicAddresses } = require('./safe-fetch');
const {
  MAX_ALLOWLIST,
  OFFLINE_MESSAGE,
  SEARXNG_ALLOWLIST_ERROR,
  createNetworkMode,
  hostPortOf,
  initialNetworkState,
  normalizeAllowlist,
  offlineConnectSrc,
  offlineDecision,
  parseAllowlistEntry
} = require('./network-mode');
const testDns = JSON.parse(testHook('SOVEREIGN_TEST_DNS', { isPackaged: app.isPackaged }) || '{}');
const testCaFile = testHook('SOVEREIGN_TEST_CA_FILE', { isPackaged: app.isPackaged });
const testCa = testCaFile ? fs.readFileSync(testCaFile) : undefined;
// Offline mode (docs/HANDOFF.md, "Offline mode"). The real start mode comes from preferences.
const TEST_NETWORK_MODE = testHook('SOVEREIGN_TEST_NETWORK_MODE', { isPackaged: app.isPackaged });
const TEST_OFFLINE_LAYERS = testHook('SOVEREIGN_TEST_OFFLINE_LAYERS', { isPackaged: app.isPackaged }) || 'all';
const networkMode = createNetworkMode({ initial: 'offline' });
let networkSettings = { choiceMade: true, offlineAllowlist: [] };
const OPEN_EXTERNAL_OFFLINE_MESSAGE = "Offline mode is on. Opening another app would leave Sovereign's protection.";
const WEB_OFFLINE_MESSAGE = 'Offline mode is on, so web search is off. Ask AI still works with your files and open pages.';
const MODEL_OFFLINE_MESSAGE = "The AI model isn't on this computer yet. Offline mode is on, so it can't be downloaded. Switch to Online to download it (about 705 MB); you can turn Offline back on afterwards.";
const MODEL_OFFLINE_PAUSED_MESSAGE = 'Model download paused: Offline mode is on.';

// Main-process DNS for safeFetch. Refuses while Offline, before any lookup is made.
async function safeFetchResolve(host, options) {
  networkMode.assertOnline('dns lookup');
  if (!app.isPackaged && Object.hasOwn(testDns, host)) {
    const record = testDns[host];
    return [{ ...record, family: isIP(record.address) }];
  }
  return dns.lookup(host, options);
}

// The only way main-process code calls safeFetch. Refuses while Offline.
async function gatedSafeFetch(url, options = {}) {
  networkMode.assertOnline('page or media fetch');
  return safeFetch(url, { ...options, resolve: safeFetchResolve, ca: testCa });
}
const { datasetUserDataDir, seedDatasetPreferences } = require('./dataset-collection');
const datasetBatchEnabled = Boolean(process.env.SOVEREIGN_DATASET_BATCH);
let datasetWindow = null;
const {
  IGNORED_SCHEMES: PRIVACY_RECEIPT_IGNORED_SCHEMES,
  classifyPrivacyRequest,
  receiptCategoryForAppRequest,
  createUrlReceiptTracker,
  urlKey,
  originFromUrl
} = require('./privacy-attribution');

const guardedDownloadUrls = new Map();
const guardedDownloadRequests = new Map();
const thumbnailReceipts = createUrlReceiptTracker({ maxEntries: 1000 });

const UI_HEIGHT = 92;
const UI_HEIGHT_COMPACT = 174;
const DOWNLOADS_PANEL_HEIGHT = 174;
const FIND_BAR_HEIGHT = 42;
const NETWORK_INTRO_HEIGHT = 42;
const SIDEBAR_WIDTH = 392;
const NEW_TAB_URL = 'sovereign://newtab/';
const SEARCH_PAGE_URL = 'sovereign://search/';
const ASK_PAGE_URL = 'sovereign://ask/';
const MODEL_SETUP_PAGE_URL = 'sovereign://ask/model-setup.html';
const DOWNLOADS_PAGE_URL = 'sovereign://downloads/';
const SETTINGS_PAGE_URL = 'sovereign://settings/';
const BOOKMARKS_PAGE_URL = 'sovereign://bookmarks/';
const DEFAULT_HOME = NEW_TAB_URL;
const AI_TEXT_LIMIT = 14000;
const AI_EXTRACT_WORLD_ID = 2026;
const FIND_WORLD_ID = 2027;
const MAX_CONTEXT_DATA_URL_BYTES = 50 * 1024 * 1024;
const ENABLE_DETACH_DIAGNOSTICS = false;
const DETACH_LOG_PREFIX = '[Sovereign detach]';
const AI_LOG_PREFIX = '[Sovereign AI]';
const MEDIA_TEST_FIXTURES = process.env.SOVEREIGN_MEDIA_TEST_FIXTURES === '1';
const AUDIT_PROXY_BYPASS_RULES = '<local>;localhost;127.0.0.1;[::1]';

function normalizeAuditProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname) {
      return null;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return {
      url: parsed.toString(),
      proxyRules: `http=${parsed.protocol}//${parsed.host};https=${parsed.protocol}//${parsed.host}`
    };
  } catch {
    return null;
  }
}

// Development only: ignored in packaged builds (testHook returns '' when packaged).
const AUDIT_PROXY = normalizeAuditProxy(testHook('SOVEREIGN_AUDIT_PROXY', { isPackaged: app.isPackaged }));
const AUDIT_PROXY_HOST_PORT = (() => {
  try {
    const parsed = new URL(AUDIT_PROXY?.url || '');
    return parsed.port ? `${parsed.hostname.toLowerCase()}:${parsed.port}` : '';
  } catch {
    return '';
  }
})();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sovereign',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

const DEFAULT_AI_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const AI_MODELS = [
  {
    id: DEFAULT_AI_MODEL_ID,
    name: 'Llama 3.2 1B Instruct q4f16_1',
    approximateDownloadSize: 'about 705 MB for model files, plus a small WebGPU runtime library',
    vramRequiredMB: 879.04,
    cacheBackend: 'WebLLM local browser cache',
    license: 'Llama 3.2 Community License',
    status: 'Default, currently tested in Sovereign'
  },
  {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    name: 'Llama 3.2 3B Instruct q4f16_1',
    approximateDownloadSize: 'larger optional download; WebLLM lists about 2263.69 MB VRAM required',
    vramRequiredMB: 2263.69,
    cacheBackend: 'WebLLM local browser cache',
    license: 'Llama 3.2 Community License',
    status: 'Optional candidate; not auto-downloaded until selected'
  }
];

let nextWindowId = 1;
let nextTabId = 1;
const windows = new Map();
const tabOwners = new Map();
const aiStates = new Map();
const findStates = new Map();
const aiWebContentsIds = new Set();
const aiNetworkEvents = [];
const searchActivityEvents = [];
const activeSearchRequests = new Map();
const activePrivacyReceiptsByWebContentsId = new Map();
let unattributedPrivacyRequestSkips = 0;
const askHandoffs = new Map();
const downloads = new Map();
const activeDownloadItems = new Map();
let nextDownloadId = 1;
const downloadHandledSessions = new WeakSet();
const auditProxySessions = new WeakMap();
const pendingDownloadIntents = [];
const PREFERENCES_FILE = 'preferences.json';
let searchSettings = {
  endpoint: DEFAULT_SEARXNG_ENDPOINT
};
let downloadSettings = {
  askWhereToSave: false,
  defaultDirectory: ''
};
let bookmarks = [];
let startupSettings = {
  continueWhereLeftOff: false
};
let aiSettings = {
  autoDownloadModel: true,
  setupNoticeSeen: false,
  setupCanceled: false,
  saveChatsOnDevice: false,
  selectedModelId: DEFAULT_AI_MODEL_ID
};
let savedSession = {
  windows: []
};
let saveSessionTimer = null;
let isAppQuitting = false;
const recentlyClosedTabs = [];
const pendingFindJobs = [];
let findQueueTimer = null;
let modelSetupWindow = null;
let modelSetupReady = false;
let modelSetupPendingCommand = null;
let modelSetupWebContentsId = null;
let modelSetupState = {
  status: 'idle',
  cached: false,
  loaded: false,
  progress: null,
  text: 'Not checked yet.',
  error: '',
  canCancel: false,
  canRetry: true,
  canPause: false,
  updatedAt: new Date().toISOString()
};

function activeAiModel() {
  return AI_MODELS.find(model => model.id === aiSettings.selectedModelId) || AI_MODELS[0];
}

function askHandoffId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeAskHandoff(input = {}) {
  const rawFiles = Array.isArray(input.files) ? input.files : [];
  return {
    createdAt: Date.now(),
    files: rawFiles.slice(0, 3).map(file => ({
      name: String(file?.name || 'attachment').replace(/\s+/g, ' ').trim().slice(0, 180) || 'attachment',
      type: String(file?.type || '').slice(0, 120),
      size: Number.isFinite(file?.size) ? Math.max(0, Math.min(file.size, 25 * 1024 * 1024)) : 0,
      dataUrl: String(file?.dataUrl || '').slice(0, 36 * 1024 * 1024),
      status: String(file?.status || 'ready').slice(0, 40),
      error: String(file?.error || '').slice(0, 300)
    })).filter(file => file.status === 'ready' && /^data:/i.test(file.dataUrl))
  };
}

function pruneAskHandoffs() {
  const now = Date.now();
  for (const [id, handoff] of askHandoffs.entries()) {
    if (!handoff?.createdAt || now - handoff.createdAt > 10 * 60 * 1000) {
      askHandoffs.delete(id);
    }
  }
}

if (process.env.SOVEREIGN_USER_DATA_DIR) {
  app.setPath('userData', process.env.SOVEREIGN_USER_DATA_DIR);
} else if (datasetBatchEnabled) {
  const dir = datasetUserDataDir(app.getPath('appData'));
  seedDatasetPreferences({ normalPrefsPath: path.join(app.getPath('userData'), 'preferences.json'), datasetDir: dir });
  app.setPath('userData', dir);
  console.log(`Dataset collection uses its own profile: ${dir}`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  console.log('Sovereign is already running with this profile; focusing the existing window.');
  app.quit();
}

function focusExistingWindow() {
  if (!hasSingleInstanceLock) return;
  let target;
  if (datasetBatchEnabled) {
    target = datasetWindow;
  } else {
    target = [...windows.values()].reverse().find(state => !state.window.isDestroyed())?.window;
    if (!target) {
      createWindow();
      return;
    }
  }
  if (target && !target.isDestroyed()) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
}

app.on('second-instance', () => focusExistingWindow());

const logStreams = new Map();

function logStreamState(stream) {
  if (!logStreams.has(stream)) {
    logStreams.set(stream, { disabled: false, listening: false });
  }
  return logStreams.get(stream);
}

function disableLogStream(stream) {
  if (stream) {
    logStreamState(stream).disabled = true;
  }
}

function watchLogStream(stream) {
  if (!stream || typeof stream.on !== 'function') {
    return;
  }
  const state = logStreamState(stream);
  if (state.listening) {
    return;
  }
  state.listening = true;
  stream.on('error', () => {
    disableLogStream(stream);
  });
}

watchLogStream(process.stdout);
watchLogStream(process.stderr);

function sanitizeLogString(value) {
  return String(value || '')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, match => safeUrlLabel(match) || '[redacted-url]')
    .replace(/\bblob:[^\s"'<>]+/gi, '[redacted-blob-url]')
    .slice(0, 800);
}

function safeLogValue(value, depth = 0, key = '') {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    if (/url|href|uri/i.test(key)) {
      return safeUrlLabel(value) || '[redacted-url]';
    }
    return sanitizeLogString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: String(value.message || '').slice(0, 800),
      code: value.code || ''
    };
  }
  if (Array.isArray(value)) {
    return depth > 2 ? '[array]' : value.slice(0, 12).map(item => safeLogValue(item, depth + 1, key));
  }
  if (typeof value === 'object') {
    if (depth > 2) {
      return '[object]';
    }
    const clean = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 24)) {
      clean[entryKey] = safeLogValue(entryValue, depth + 1, entryKey);
    }
    return clean;
  }
  return String(value).slice(0, 200);
}

function safeWrite(stream, line) {
  if (!stream) {
    return;
  }
  const state = logStreamState(stream);
  if (state.disabled || stream.destroyed || stream.writableEnded || stream.writable === false) {
    return;
  }
  try {
    stream.write(`${line}\n`, error => {
      if (error) {
        disableLogStream(stream);
      }
    });
  } catch {
    disableLogStream(stream);
  }
}

function safeMainLog(prefix, message, details = {}) {
  const cleanDetails = safeLogValue(details);
  const hasDetails = cleanDetails !== null && cleanDetails !== undefined && (
    typeof cleanDetails !== 'object' || Object.keys(cleanDetails).length > 0
  );
  const detailText = hasDetails
    ? ` ${JSON.stringify(cleanDetails)}`
    : '';
  safeWrite(process.stdout, `${prefix} ${sanitizeLogString(message)}${detailText}`);
}

function logDetach(message, details = {}) {
  if (ENABLE_DETACH_DIAGNOSTICS) {
    safeMainLog(DETACH_LOG_PREFIX, message, details);
  }
}

function logAi(message, details = {}) {
  safeMainLog(AI_LOG_PREFIX, message, details);
}

function safeUrlLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return '';
  }
}

function setupInternalProtocol() {
  const pageFiles = new Map([
    ['newtab', 'newtab.html'],
    ['search', 'search.html'],
    ['ask', 'ask.html'],
    ['downloads', 'downloads.html'],
    ['settings', 'settings.html'],
    ['bookmarks', 'bookmarks.html']
  ]);

  protocol.handle('sovereign', request => {
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('Bad Sovereign URL', { status: 400 });
    }

    const host = parsed.hostname;
    const pathname = decodeURIComponent(parsed.pathname || '/');
    const staticPath = pathname === '/' || pathname === ''
      ? pageFiles.get(host)
      : pathname.replace(/^\/+/, '');

    if (!pageFiles.has(host) || !staticPath) {
      return new Response('Sovereign page not found', { status: 404 });
    }

    const filePath = path.resolve(__dirname, staticPath);
    const relative = path.relative(__dirname, filePath);
    const isSafe = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!isSafe) {
      return new Response('Blocked Sovereign resource', { status: 400 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function tabDebugInfo(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) {
    return null;
  }

  const history = tab.view.webContents.navigationHistory;
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    webContentsId: tab.view.webContents.id,
    title: tab.title,
    url: safeUrlLabel(tab.url),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  };
}

function findWindowStateBySender(sender) {
  for (const state of windows.values()) {
    const uiContents = state.uiView?.webContents;
    const sidebarContents = state.sidebarView?.webContents;
    if (uiContents && !uiContents.isDestroyed() && uiContents.id === sender.id) {
      return state;
    }
    if (sidebarContents && !sidebarContents.isDestroyed() && sidebarContents.id === sender.id) {
      return state;
    }
    for (const tab of state.tabs.values()) {
      const tabContents = tab.view?.webContents;
      if (tabContents && !tabContents.isDestroyed() && tabContents.id === sender.id) {
        return state;
      }
    }
  }

  return null;
}

function findTabBySender(sender) {
  for (const state of windows.values()) {
    for (const tab of state.tabs.values()) {
      const tabContents = tab.view?.webContents;
      if (tabContents && !tabContents.isDestroyed() && tabContents.id === sender.id) {
        return { state, tab };
      }
    }
  }

  return { state: null, tab: null };
}

function getTabOwner(tab) {
  return windows.get(tab.windowId) || null;
}

function getWindowBounds(state) {
  if (!state?.window || state.window.isDestroyed()) {
    return { width: 1200, height: 800 };
  }

  return state.window.getContentBounds();
}

function getPageWidth(state, totalWidth) {
  return state.sidebarVisible ? Math.max(0, totalWidth - SIDEBAR_WIDTH) : totalWidth;
}

function getChromeHeight(state, totalWidth) {
  const baseHeight = totalWidth <= 860 ? UI_HEIGHT_COMPACT : UI_HEIGHT;
  return baseHeight +
    (!networkSettings.choiceMade || state?.networkConfirmVisible ? NETWORK_INTRO_HEIGHT : 0) +
    (state?.findBarVisible ? FIND_BAR_HEIGHT : 0) +
    (state?.downloadsPanelVisible ? DOWNLOADS_PANEL_HEIGHT : 0);
}

function layoutViews(state) {
  if (!state?.window || state.window.isDestroyed() || !state.uiView) {
    return;
  }

  const { width, height } = getWindowBounds(state);
  const uiHeight = getChromeHeight(state, width);
  const pageWidth = getPageWidth(state, width);
  state.uiView.setBounds({ x: 0, y: 0, width, height: uiHeight });

  const activeTab = state.tabs.get(state.activeTabId);
  if (activeTab) {
    activeTab.view.setBounds({
      x: 0,
      y: uiHeight,
      width: pageWidth,
      height: Math.max(0, height - uiHeight)
    });
  }

  if (state.sidebarVisible && state.sidebarView) {
    state.sidebarView.setBounds({
      x: pageWidth,
      y: uiHeight,
      width: SIDEBAR_WIDTH,
      height: Math.max(0, height - uiHeight)
    });
  }
}

function tabSnapshot(tab) {
  const wc = tab.view.webContents;
  return {
    id: tab.id,
    title: tab.title || 'New Tab',
    url: tab.url || '',
    kind: tab.kind || 'web',
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    bookmarkable: isBookmarkableUrl(tab.url),
    bookmarked: isBookmarkedUrl(tab.url)
  };
}

function windowSnapshot(state) {
  return {
    activeTabId: state?.activeTabId ?? null,
    tabs: state ? [...state.tabs.values()].map(tabSnapshot) : [],
    sidebarVisible: Boolean(state?.sidebarVisible),
    downloadsPanelVisible: Boolean(state?.downloadsPanelVisible),
    findBarVisible: Boolean(state?.findBarVisible),
    auditMode: {
      active: Boolean(AUDIT_PROXY),
      proxy: AUDIT_PROXY?.url || ''
    },
    network: networkStateSnapshot(),
    error: null
  };
}

function defaultAiState(tabId) {
  return {
    tabId,
    status: 'idle',
    source: null,
    summary: '',
    error: '',
    progress: null,
    modelId: activeAiModel().id,
    generationId: null,
    summaryVersion: null,
    generatedAt: null,
    promptDiagnostics: null,
    updatedAt: null
  };
}

function getAiState(tabId) {
  if (!aiStates.has(tabId)) {
    aiStates.set(tabId, defaultAiState(tabId));
  }

  return aiStates.get(tabId);
}

function activeTabMeta(state) {
  const tab = state?.tabs.get(state.activeTabId);
  if (!tab) {
    return null;
  }

  return {
    id: tab.id,
    title: tab.title || 'New Tab',
    url: tab.url || ''
  };
}

function aiSnapshot(state) {
  const active = activeTabMeta(state);
  return {
    sidebarVisible: Boolean(state?.sidebarVisible),
    model: activeAiModel(),
    models: AI_MODELS,
    activeTab: active,
    tabState: active ? getAiState(active.id) : null,
    networkEvents: aiNetworkEvents.slice(-30),
    privacy: {
      localGeneration: true,
      cloudFallback: false,
      note: 'Model setup downloads model files. Summary generation runs locally in Sovereign.'
    }
  };
}

function sendState(state) {
  const uiContents = state?.uiView?.webContents;
  if (!uiContents || uiContents.isDestroyed()) {
    return;
  }

  uiContents.send('browser:state', windowSnapshot(state));
  scheduleSaveOpenSession();
}

function sendAiState(state) {
  const sidebarContents = state?.sidebarView?.webContents;
  if (!sidebarContents || sidebarContents.isDestroyed()) {
    return;
  }

  sidebarContents.send('ai:state', aiSnapshot(state));
}

function broadcastAiState() {
  for (const state of windows.values()) {
    sendAiState(state);
  }
}

function searchSettingsSnapshot() {
  return {
    endpoint: searchSettings.endpoint,
    defaultEndpoint: DEFAULT_SEARXNG_ENDPOINT
  };
}

function preferencesPath() {
  return path.join(app.getPath('userData'), PREFERENCES_FILE);
}

function defaultDownloadDirectory() {
  return process.env.SOVEREIGN_TEST_DOWNLOAD_DIR || app.getPath('downloads');
}

function sanitizeDownloadDirectory(value) {
  const directory = String(value || '').trim();
  return directory && path.isAbsolute(directory) ? directory : '';
}

function effectiveDownloadDirectory() {
  return sanitizeDownloadDirectory(downloadSettings.defaultDirectory) || defaultDownloadDirectory();
}

function downloadSettingsSnapshot() {
  return {
    askWhereToSave: Boolean(downloadSettings.askWhereToSave),
    defaultDirectory: effectiveDownloadDirectory(),
    systemDownloadsDirectory: app.getPath('downloads')
  };
}

function startupSettingsSnapshot() {
  return {
    continueWhereLeftOff: Boolean(startupSettings.continueWhereLeftOff)
  };
}

function aiSettingsSnapshot() {
  return {
    autoDownloadModel: aiSettings.autoDownloadModel !== false,
    setupNoticeSeen: Boolean(aiSettings.setupNoticeSeen),
    setupCanceled: Boolean(aiSettings.setupCanceled),
    saveChatsOnDevice: Boolean(aiSettings.saveChatsOnDevice),
    selectedModelId: activeAiModel().id
  };
}

function modelSetupSnapshot() {
  return {
    ...modelSetupState,
    model: activeAiModel(),
    models: AI_MODELS,
    settings: aiSettingsSnapshot(),
    note: 'AI setup downloads the configured local model files. Answers and summaries run locally after setup; browsing itself still uses the network.'
  };
}

function sanitizeModelSetupPatch(patch = {}) {
  const input = patch && typeof patch === 'object' ? patch : {};
  const allowedStatuses = new Set(['idle', 'checking', 'downloading', 'ready', 'error', 'canceled']);
  const status = allowedStatuses.has(input.status) ? input.status : modelSetupState.status;
  const progress = input.progress && typeof input.progress === 'object'
    ? {
        progress: Number.isFinite(input.progress.progress) ? Math.max(0, Math.min(1, input.progress.progress)) : null,
        text: typeof input.progress.text === 'string' ? input.progress.text.slice(0, 240) : ''
      }
    : (input.progress === null ? null : modelSetupState.progress);

  const cached = typeof input.cached === 'boolean' ? input.cached : modelSetupState.cached;
  const offlineBlocked = networkMode.isOffline() && !cached && ['idle', 'canceled'].includes(status);
  return {
    status,
    cached,
    offline: networkMode.isOffline(),
    offlineBlocked,
    loaded: typeof input.loaded === 'boolean' ? input.loaded : modelSetupState.loaded,
    progress,
    text: offlineBlocked && status === 'idle'
      ? MODEL_OFFLINE_MESSAGE
      : typeof input.text === 'string'
        ? input.text.slice(0, 360)
        : modelSetupState.text === MODEL_OFFLINE_MESSAGE ? 'Local model files are not downloaded yet.' : modelSetupState.text,
    error: typeof input.error === 'string' ? input.error.slice(0, 1200) : (status === 'error' ? modelSetupState.error : ''),
    canCancel: typeof input.canCancel === 'boolean' ? input.canCancel : status === 'downloading',
    canRetry: typeof input.canRetry === 'boolean' ? input.canRetry : ['idle', 'error', 'canceled'].includes(status),
    canPause: false,
    updatedAt: new Date().toISOString()
  };
}

function broadcastModelSetupState() {
  const snapshot = modelSetupSnapshot();
  for (const state of windows.values()) {
    const uiContents = state.uiView?.webContents;
    if (uiContents && !uiContents.isDestroyed()) {
      uiContents.send('model-setup:state', snapshot);
    }
    const sidebarContents = state.sidebarView?.webContents;
    if (sidebarContents && !sidebarContents.isDestroyed()) {
      sidebarContents.send('model-setup:state', snapshot);
    }
    for (const tab of state.tabs.values()) {
      if (['ask', 'settings'].includes(tab.kind) && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('model-setup:state', snapshot);
      }
    }
  }
}

function updateModelSetupState(patch = {}) {
  modelSetupState = sanitizeModelSetupPatch(patch);
  broadcastModelSetupState();
  return modelSetupSnapshot();
}

function isModelSetupSender(sender) {
  return Boolean(sender?.id && modelSetupWebContentsId && sender.id === modelSetupWebContentsId);
}

function usableWindowWebContents(win) {
  if (!win || win.isDestroyed()) {
    return null;
  }
  try {
    const contents = win.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  } catch {
    return null;
  }
}

function destroyModelSetupWindow() {
  const win = modelSetupWindow;
  modelSetupWindow = null;
  modelSetupReady = false;
  modelSetupPendingCommand = null;
  modelSetupWebContentsId = null;
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
}

function sendModelSetupCommand(command) {
  modelSetupPendingCommand = command;
  const contents = usableWindowWebContents(modelSetupWindow);
  if (modelSetupReady && contents) {
    contents.send('model-setup:command', command);
  }
}

function createModelSetupWindow() {
  if (modelSetupWindow && !modelSetupWindow.isDestroyed()) {
    return modelSetupWindow;
  }

  modelSetupReady = false;
  const setupWindow = new BrowserWindow({
    width: 360,
    height: 220,
    show: false,
    title: 'Sovereign AI Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  modelSetupWindow = setupWindow;

  const setupContents = usableWindowWebContents(setupWindow);
  const setupContentsId = setupContents?.id || null;
  modelSetupWebContentsId = setupContentsId;
  if (setupContentsId) {
    aiWebContentsIds.add(setupContentsId);
  }

  const onSetupConsoleMessage = event => {
    const text = event?.message;
    if (typeof text === 'string' && text.includes(AI_LOG_PREFIX)) {
      logAi('setup worker', text.replace(AI_LOG_PREFIX, '').trim());
    }
  };

  const cleanupSetupWindow = () => {
    if (setupContentsId) {
      aiWebContentsIds.delete(setupContentsId);
    }
    if (setupContents && !setupContents.isDestroyed()) {
      setupContents.removeListener('console-message', onSetupConsoleMessage);
    }
    if (modelSetupWindow === setupWindow) {
      modelSetupWindow = null;
      modelSetupReady = false;
      modelSetupPendingCommand = null;
      modelSetupWebContentsId = null;
    }
  };
  setupWindow.once('closed', cleanupSetupWindow);

  setupContents?.on('console-message', onSetupConsoleMessage);
  setupWindow.loadURL(MODEL_SETUP_PAGE_URL).catch(error => {
    if (isAppQuitting || setupWindow.isDestroyed() || modelSetupWindow !== setupWindow) {
      return;
    }
    updateModelSetupState({
      status: 'error',
      text: 'Could not start the local model setup worker.',
      error: error.message || String(error),
      canRetry: true
    });
  });
  return setupWindow;
}

function shouldAutoStartModelSetup() {
  return aiSettings.autoDownloadModel !== false && !aiSettings.setupCanceled;
}

function ensureModelSetupService(options = {}) {
  const forceStart = Boolean(options.forceStart);
  // While Offline only the local cache check runs; nothing is downloaded.
  const autoStart = !networkMode.isOffline() && (forceStart || (options.autoStart !== false && shouldAutoStartModelSetup()));
  const alreadyRunning = ['checking', 'downloading'].includes(modelSetupState.status);
  if (alreadyRunning && !forceStart) {
    return modelSetupSnapshot();
  }

  if (forceStart) {
    aiSettings.setupCanceled = false;
    savePreferences();
  }

  createModelSetupWindow();
  updateModelSetupState({
    status: 'checking',
    cached: Boolean(modelSetupState.cached),
    loaded: false,
    progress: null,
    text: 'Checking local model cache...',
    error: '',
    canCancel: autoStart,
    canRetry: false
  });
  sendModelSetupCommand({
    type: autoStart ? 'check-and-download' : 'check',
    model: activeAiModel()
  });
  return modelSetupSnapshot();
}

function cancelModelSetup(reason = 'AI model setup canceled.') {
  aiSettings.setupCanceled = true;
  savePreferences();
  destroyModelSetupWindow();
  updateModelSetupState({
    status: 'canceled',
    cached: false,
    loaded: false,
    progress: null,
    text: reason,
    error: '',
    canCancel: false,
    canRetry: true
  });
  return modelSetupSnapshot();
}

function assignPrivacyReceiptToSender(sender, receiptId) {
  if (!sender?.id || !receiptId) {
    return;
  }
  const alreadyTracked = activePrivacyReceiptsByWebContentsId.has(sender.id);
  activePrivacyReceiptsByWebContentsId.set(sender.id, String(receiptId));
  if (alreadyTracked) return;
  sender.once?.('destroyed', () => {
    activePrivacyReceiptsByWebContentsId.delete(sender.id);
    for (const [id, grant] of allowedSearchRequests) if (grant.senderId === sender.id) allowedSearchRequests.delete(id);
    for (const [key, grant] of allowedMediaUrls) if (grant.senderId === sender.id) allowedMediaUrls.delete(key);
  });
}

function privacyReceiptIdForSender(sender) {
  return sender?.id ? activePrivacyReceiptsByWebContentsId.get(sender.id) || '' : '';
}

function makeReceiptFetch(receiptId, category, whatWasSent, fetchImpl = (url, options) => net.fetch(url, options)) {
  return (url, options = {}) => {
    networkMode.assertOnline(category);
    return privacyReceipts.fetchWithReceipt(fetchImpl, receiptId, url, options, {
      category,
      whatWasSent
    });
  };
}

function receiptCategoryForTrustedRequest(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (
    host.includes('huggingface.co') ||
    host.endsWith('hf.co') ||
    host.includes('cdn-lfs') ||
    host.includes('huggingfaceusercontent.com') ||
    host.includes('mlc.ai') ||
    host.includes('webllm') ||
    host.includes('githubusercontent.com')
  ) {
    return 'model-download';
  }
  return 'other';
}

function openWebTabOrigins() {
  const origins = new Set();
  for (const state of windows.values()) {
    for (const tab of state.tabs.values()) {
      const contents = tab.view?.webContents;
      const currentUrl = contents && !contents.isDestroyed() ? contents.getURL() : tab.url;
      if (tab.kind === 'web' || /^https?:\/\//i.test(String(currentUrl || ''))) {
        const origin = originFromUrl(currentUrl || tab.url);
        if (origin) {
          origins.add(origin);
        }
      }
    }
  }
  return origins;
}

function contextForPrivacyRequest(details) {
  const webContentsId = Number(details.webContentsId || 0);
  const { tab } = findTabByWebContentsId(webContentsId);
  let currentUrl = '';
  let isUiView = false;
  let isSidebarView = false;
  for (const state of windows.values()) {
    const uiContents = state.uiView?.webContents;
    const sidebarContents = state.sidebarView?.webContents;
    if (uiContents && !uiContents.isDestroyed() && uiContents.id === webContentsId) {
      isUiView = true;
      currentUrl = uiContents.getURL();
    }
    if (sidebarContents && !sidebarContents.isDestroyed() && sidebarContents.id === webContentsId) {
      isSidebarView = true;
      currentUrl = sidebarContents.getURL();
    }
  }
  const contents = tab?.view?.webContents;
  if (!currentUrl && contents && !contents.isDestroyed()) {
    currentUrl = contents.getURL();
  }
  const isAiView = aiWebContentsIds.has(webContentsId);
  if (!currentUrl && isAiView && modelSetupWebContentsId === webContentsId) {
    currentUrl = MODEL_SETUP_PAGE_URL;
  }

  return {
    hasWebContents: Boolean(webContentsId && (tab || isUiView || isSidebarView || isAiView)),
    tabKind: tab?.kind || '',
    currentUrl,
    isUiView,
    isSidebarView,
    isAiView,
    activeReceiptId: webContentsId ? activePrivacyReceiptsByWebContentsId.get(webContentsId) || '' : '',
    openWebOrigins: openWebTabOrigins(),
    appRoot: path.resolve(__dirname, '..')
  };
}

function recordPrivacyWebRequest(details) {
  const context = contextForPrivacyRequest(details);
  const target = classifyPrivacyRequest(details, context);
  if (target.action === 'debug-skip') {
    unattributedPrivacyRequestSkips += 1;
    return;
  }
  if (target.action === 'ignore') {
    return;
  }
  const category = receiptCategoryForAppRequest({
    url: details.url,
    resourceType: details.resourceType,
    tabKind: context.tabKind,
    baseCategory: receiptCategoryForTrustedRequest(details.url)
  });
  const entry = {
    category,
    method: details.method || 'GET',
    url: details.url,
    whatWasSent: target.unattributed
      ? 'other (unattributed) app-session request – no cookies, headers, or body logged'
      : category === 'image'
        ? 'image thumbnail preview – no query, prompt, or AI output sent'
      : category === 'model-download'
        ? 'model/runtime file request – no page content, prompt, or AI output sent'
        : 'trusted app/AI request – no cookies, auth headers, request body, prompt, or AI output logged'
  };

  const thumbnailReceiptId = details.webContentsId
    ? thumbnailReceipts.lookup(urlKey(details.url, String(details.webContentsId))) : '';
  if (thumbnailReceiptId && privacyReceipts.getReceipt(thumbnailReceiptId)) {
    privacyReceipts.addEntry(thumbnailReceiptId, entry);
    return;
  }
  if (target.action === 'receipt' && target.receiptId) {
    privacyReceipts.addEntry(target.receiptId, entry);
    return;
  }
  privacyReceipts.addBackgroundEntry(entry);
}

function recordPrivacyRedirect(details) {
  try {
    if (details.webContentsId) {
      const scope = String(details.webContentsId);
      thumbnailReceipts.follow(urlKey(details.url, scope), urlKey(details.redirectURL, scope));
      return;
    }
  } catch (error) {
    logAi('privacy redirect attribution failed', { error: error?.message || String(error) });
  }
}

function sendPrivacyReceipt(receipt) {
  for (const state of windows.values()) {
    const targets = [state.uiView?.webContents, state.sidebarView?.webContents];
    for (const tab of state.tabs.values()) {
      if (tab.kind !== 'web') {
        targets.push(tab.view?.webContents);
      }
    }
    for (const contents of targets) {
      if (contents && !contents.isDestroyed()) {
        contents.send('privacy:receipt-updated', receipt);
      }
    }
  }
}

privacyReceipts.onUpdate(sendPrivacyReceipt);

function setupAuditProxyForSession(targetSession = session.defaultSession) {
  if (!AUDIT_PROXY || !targetSession) {
    return Promise.resolve();
  }
  if (auditProxySessions.has(targetSession)) {
    return auditProxySessions.get(targetSession);
  }

  const promise = targetSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: AUDIT_PROXY.proxyRules,
    proxyBypassRules: AUDIT_PROXY_BYPASS_RULES
  }).then(async () => {
    if (typeof targetSession.closeAllConnections === 'function') {
      await targetSession.closeAllConnections();
    }
    logAi('audit proxy active for session', {
      proxy: AUDIT_PROXY.url,
      bypass: AUDIT_PROXY_BYPASS_RULES
    });
  }).catch(error => {
    logAi('audit proxy setup failed', {
      error: error?.message || String(error)
    });
  });
  auditProxySessions.set(targetSession, promise);
  return promise;
}

function updateAiSettings(patch = {}) {
  const input = patch && typeof patch === 'object' ? patch : {};
  const previousAuto = aiSettings.autoDownloadModel !== false;
  if (typeof input.autoDownloadModel === 'boolean') {
    aiSettings.autoDownloadModel = input.autoDownloadModel;
    if (input.autoDownloadModel) {
      aiSettings.setupCanceled = false;
    }
  }
  if (typeof input.setupNoticeSeen === 'boolean') {
    aiSettings.setupNoticeSeen = input.setupNoticeSeen;
  }
  if (typeof input.saveChatsOnDevice === 'boolean') {
    aiSettings.saveChatsOnDevice = input.saveChatsOnDevice;
  }
  if (typeof input.selectedModelId === 'string') {
    const selected = AI_MODELS.find(model => model.id === input.selectedModelId);
    if (selected && selected.id !== activeAiModel().id) {
      aiSettings.selectedModelId = selected.id;
      aiSettings.setupCanceled = false;
      destroyModelSetupWindow();
      modelSetupState = {
        status: 'idle',
        cached: false,
        loaded: false,
        progress: null,
        text: 'Model changed. Cache has not been checked yet.',
        error: '',
        canCancel: false,
        canRetry: true,
        canPause: false,
        updatedAt: new Date().toISOString()
      };
    }
  }
  savePreferences();
  broadcastModelSetupState();
  if (!previousAuto && aiSettings.autoDownloadModel !== false && !modelSetupState.cached) {
    ensureModelSetupService({ autoStart: true });
  }
  return aiSettingsSnapshot();
}

function sanitizeBookmarkTitle(value) {
  return String(value || 'Untitled')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'Untitled';
}

function normalizeBookmarkUrl(value) {
  const checked = normalizeAddress(value);
  return checked.ok ? checked.url : '';
}

function isBookmarkableUrl(value) {
  return Boolean(normalizeBookmarkUrl(value));
}

function bookmarkKey(value) {
  const normalized = normalizeBookmarkUrl(value);
  return normalized ? normalized.replace(/\/$/, '') : '';
}

function sanitizeBookmarks(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const seen = new Set();
  return items.slice(0, 1000).map((item, index) => {
    const url = normalizeBookmarkUrl(item?.url);
    const key = bookmarkKey(url);
    if (!url || !key || seen.has(key)) {
      return null;
    }
    seen.add(key);
    const now = new Date().toISOString();
    return {
      id: String(item?.id || `bookmark-${Date.now()}-${index}`).slice(0, 80),
      title: sanitizeBookmarkTitle(item?.title),
      url,
      createdAt: typeof item?.createdAt === 'string' ? item.createdAt.slice(0, 80) : now,
      updatedAt: typeof item?.updatedAt === 'string' ? item.updatedAt.slice(0, 80) : now
    };
  }).filter(Boolean);
}

function bookmarksSnapshot() {
  return {
    bookmarks: bookmarks
      .slice()
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
  };
}

function findBookmarkByUrl(url) {
  const key = bookmarkKey(url);
  if (!key) {
    return null;
  }
  return bookmarks.find(bookmark => bookmarkKey(bookmark.url) === key) || null;
}

function isBookmarkedUrl(url) {
  return Boolean(findBookmarkByUrl(url));
}

function broadcastBookmarksState() {
  const snapshot = bookmarksSnapshot();
  for (const state of windows.values()) {
    if (state.uiView && !state.uiView.webContents.isDestroyed()) {
      sendState(state);
    }
    for (const tab of state.tabs.values()) {
      if (tab.kind === 'bookmarks' && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('bookmarks:state', snapshot);
      }
    }
  }
}

function loadPreferences() {
  try {
    const raw = fs.readFileSync(preferencesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    privacySettings = { sensitiveTopics: parsed?.privacy?.sensitiveTopics === 'standard' ? 'standard' : 'strict' };
    const downloadsPrefs = parsed?.downloads && typeof parsed.downloads === 'object'
      ? parsed.downloads
      : {};
    const searchPrefs = parsed?.search && typeof parsed.search === 'object'
      ? parsed.search
      : {};
    const startupPrefs = parsed?.startup && typeof parsed.startup === 'object'
      ? parsed.startup
      : {};
    const aiPrefs = parsed?.ai && typeof parsed.ai === 'object'
      ? parsed.ai
      : {};
    const sessionPrefs = parsed?.session && typeof parsed.session === 'object'
      ? parsed.session
      : {};
    downloadSettings = {
      askWhereToSave: Boolean(downloadsPrefs.askWhereToSave),
      defaultDirectory: sanitizeDownloadDirectory(downloadsPrefs.defaultDirectory)
    };
    if (typeof searchPrefs.endpoint === 'string') {
      searchSettings.endpoint = normalizeSearxngEndpoint(searchPrefs.endpoint);
    }
    bookmarks = sanitizeBookmarks(parsed?.bookmarks);
    startupSettings = {
      continueWhereLeftOff: Boolean(startupPrefs.continueWhereLeftOff)
    };
    aiSettings = {
      autoDownloadModel: aiPrefs.autoDownloadModel !== false,
      setupNoticeSeen: Boolean(aiPrefs.setupNoticeSeen),
      setupCanceled: Boolean(aiPrefs.setupCanceled),
      saveChatsOnDevice: Boolean(aiPrefs.saveChatsOnDevice),
      selectedModelId: AI_MODELS.some(model => model.id === aiPrefs.selectedModelId)
        ? aiPrefs.selectedModelId
        : DEFAULT_AI_MODEL_ID
    };
    savedSession = sanitizeSavedSession(sessionPrefs);
    applyLoadedNetworkState(initialNetworkState({ prefsFileExisted: true, parsed }), parsed?.network?.offlineAllowlist);
  } catch (error) {
    // No file: a new install starts Offline. An unreadable file also starts Offline (fail closed).
    applyLoadedNetworkState(initialNetworkState({ prefsFileExisted: error?.code !== 'ENOENT', parsed: null }), []);
    downloadSettings = {
      askWhereToSave: false,
      defaultDirectory: ''
    };
    bookmarks = [];
    startupSettings = {
      continueWhereLeftOff: false
    };
    aiSettings = {
      autoDownloadModel: true,
      setupNoticeSeen: false,
      setupCanceled: false,
      saveChatsOnDevice: false,
      selectedModelId: DEFAULT_AI_MODEL_ID
    };
    savedSession = {
      windows: []
    };
  }
}

function savePreferences() {
  const file = preferencesPath();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const payload = {
    search: {
      endpoint: searchSettings.endpoint
    },
    downloads: {
      askWhereToSave: Boolean(downloadSettings.askWhereToSave),
      defaultDirectory: sanitizeDownloadDirectory(downloadSettings.defaultDirectory)
    },
    bookmarks,
    startup: startupSettingsSnapshot(),
    ai: aiSettingsSnapshot(),
    network: {
      mode: networkMode.mode,
      choiceMade: Boolean(networkSettings.choiceMade),
      offlineAllowlist: [...networkSettings.offlineAllowlist]
    },
    privacy: { ...privacySettings },
    session: savedSession
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function updateDownloadSettings(patch = {}) {
  const input = patch && typeof patch === 'object' ? patch : {};
  if (typeof input.askWhereToSave === 'boolean') {
    downloadSettings.askWhereToSave = input.askWhereToSave;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'defaultDirectory')) {
    downloadSettings.defaultDirectory = sanitizeDownloadDirectory(input.defaultDirectory);
  }
  savePreferences();
  return downloadSettingsSnapshot();
}

function updateStartupSettings(patch = {}) {
  const input = patch && typeof patch === 'object' ? patch : {};
  if (typeof input.continueWhereLeftOff === 'boolean') {
    startupSettings.continueWhereLeftOff = input.continueWhereLeftOff;
  }
  savePreferences();
  return startupSettingsSnapshot();
}

function addOrUpdateBookmark({ title, url }) {
  const cleanUrl = normalizeBookmarkUrl(url);
  if (!cleanUrl) {
    throw new Error('Only normal http and https pages can be bookmarked.');
  }

  const now = new Date().toISOString();
  const existing = findBookmarkByUrl(cleanUrl);
  if (existing) {
    existing.title = sanitizeBookmarkTitle(title || existing.title);
    existing.updatedAt = now;
  } else {
    bookmarks.unshift({
      id: `bookmark-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      title: sanitizeBookmarkTitle(title),
      url: cleanUrl,
      createdAt: now,
      updatedAt: now
    });
  }
  bookmarks = sanitizeBookmarks(bookmarks);
  savePreferences();
  broadcastBookmarksState();
  return bookmarksSnapshot();
}

function removeBookmark(idOrUrl) {
  const value = String(idOrUrl || '');
  const key = bookmarkKey(value);
  const before = bookmarks.length;
  bookmarks = bookmarks.filter(bookmark => bookmark.id !== value && (!key || bookmarkKey(bookmark.url) !== key));
  if (bookmarks.length !== before) {
    savePreferences();
    broadcastBookmarksState();
  }
  return bookmarksSnapshot();
}

function renameBookmark(id, title) {
  const bookmark = bookmarks.find(item => item.id === String(id || ''));
  if (!bookmark) {
    throw new Error('Bookmark was not found.');
  }
  bookmark.title = sanitizeBookmarkTitle(title);
  bookmark.updatedAt = new Date().toISOString();
  savePreferences();
  broadcastBookmarksState();
  return bookmarksSnapshot();
}

function toggleBookmarkForActiveTab(state) {
  const tab = state?.tabs.get(state.activeTabId);
  if (!tab) {
    throw new Error('No active tab is available to bookmark.');
  }
  const existing = findBookmarkByUrl(tab.url);
  if (existing) {
    removeBookmark(existing.id);
    return { bookmarked: false, ...bookmarksSnapshot() };
  }
  addOrUpdateBookmark({
    title: tab.title || tab.url || 'Untitled',
    url: tab.url
  });
  return { bookmarked: true, ...bookmarksSnapshot() };
}

function sanitizeRestorableUrl(url) {
  const internal = normalizeInternalUrl(url);
  if (internal) {
    const kind = internalKindFromUrl(internal);
    if (['home', 'downloads', 'settings', 'bookmarks'].includes(kind)) {
      return internal;
    }
    if (kind === 'search' || kind === 'ask') {
      return kind === 'ask' ? ASK_PAGE_URL : SEARCH_PAGE_URL;
    }
  }

  const checked = normalizeAddress(url);
  return checked.ok ? checked.url : '';
}

function sanitizeSavedSession(input) {
  const windowsInput = Array.isArray(input?.windows) ? input.windows : [];
  const cleanWindows = windowsInput.slice(0, 8).map(windowState => {
    const tabs = Array.isArray(windowState?.tabs)
      ? windowState.tabs.slice(0, 40).map(item => {
          const url = sanitizeRestorableUrl(item?.url);
          return url
            ? {
                url,
                title: sanitizeBookmarkTitle(item?.title || url)
              }
            : null;
        }).filter(Boolean)
      : [];
    if (tabs.length === 0) {
      return null;
    }
    const activeIndex = Number.isInteger(windowState?.activeIndex)
      ? Math.max(0, Math.min(windowState.activeIndex, tabs.length - 1))
      : 0;
    return {
      bounds: {
        width: Number.isFinite(windowState?.bounds?.width) ? windowState.bounds.width : undefined,
        height: Number.isFinite(windowState?.bounds?.height) ? windowState.bounds.height : undefined,
        x: Number.isFinite(windowState?.bounds?.x) ? windowState.bounds.x : undefined,
        y: Number.isFinite(windowState?.bounds?.y) ? windowState.bounds.y : undefined
      },
      activeIndex,
      tabs
    };
  }).filter(Boolean);

  return {
    windows: cleanWindows
  };
}

function captureOpenSession() {
  const snapshot = {
    windows: []
  };

  for (const state of windows.values()) {
    if (!state.window || state.window.isDestroyed()) {
      continue;
    }
    const tabs = [];
    let activeIndex = 0;
    for (const tab of state.tabs.values()) {
      const url = sanitizeRestorableUrl(tab.url);
      if (!url) {
        continue;
      }
      if (tab.id === state.activeTabId) {
        activeIndex = tabs.length;
      }
      tabs.push({
        url,
        title: sanitizeBookmarkTitle(tab.title || url)
      });
    }
    if (tabs.length > 0) {
      snapshot.windows.push({
        bounds: state.window.getBounds(),
        activeIndex,
        tabs
      });
    }
  }

  return sanitizeSavedSession(snapshot);
}

function saveOpenSessionNow() {
  if (!app.isReady() || datasetBatchEnabled) {
    return;
  }
  savedSession = captureOpenSession();
  savePreferences();
}

function scheduleSaveOpenSession() {
  if (isAppQuitting) {
    return;
  }
  if (saveSessionTimer) {
    clearTimeout(saveSessionTimer);
  }
  saveSessionTimer = setTimeout(() => {
    saveSessionTimer = null;
    saveOpenSessionNow();
  }, 350);
}

function rememberClosedTab(tab) {
  const url = sanitizeRestorableUrl(tab?.url);
  if (!url || url === DEFAULT_HOME) {
    return;
  }
  recentlyClosedTabs.push({
    url,
    title: sanitizeBookmarkTitle(tab?.title || url),
    closedAt: new Date().toISOString()
  });
  while (recentlyClosedTabs.length > 20) {
    recentlyClosedTabs.shift();
  }
}

function pushSearchActivity(entry) {
  searchActivityEvents.push(entry);
  while (searchActivityEvents.length > 100) {
    searchActivityEvents.shift();
  }
  for (const state of windows.values()) {
    for (const tab of state.tabs.values()) {
      if (tab.kind === 'search' && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('search:activity', searchActivityEvents.slice(-30));
      }
    }
  }
}

function findTabByWebContentsId(webContentsId) {
  for (const state of windows.values()) {
    for (const tab of state.tabs.values()) {
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed() && contents.id === webContentsId) {
        return { state, tab };
      }
    }
  }
  return { state: null, tab: null };
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'download';
}

function uniqueDownloadPath(filename, directory = app.getPath('downloads')) {
  const downloadsDir = directory;
  const clean = sanitizeFilename(filename);
  const ext = path.extname(clean);
  const stem = path.basename(clean, ext) || 'download';
  let candidate = path.join(downloadsDir, clean);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(downloadsDir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function chooseSavePathForFilename(rawFilename, ownerState, options = {}) {
  const filename = sanitizeFilename(rawFilename);
  const shouldAsk = Boolean(options.forceAsk || downloadSettings.askWhereToSave);

  if (shouldAsk && process.env.SOVEREIGN_TEST_SAVE_DIALOG_DIR) {
    const testDialogDir = process.env.SOVEREIGN_TEST_SAVE_DIALOG_DIR;
    fs.mkdirSync(testDialogDir, { recursive: true });
    return uniqueDownloadPath(filename, testDialogDir);
  }

  if (!shouldAsk && process.env.SOVEREIGN_TEST_DOWNLOAD_DIR) {
    const testDir = process.env.SOVEREIGN_TEST_DOWNLOAD_DIR;
    fs.mkdirSync(testDir, { recursive: true });
    return uniqueDownloadPath(filename, testDir);
  }

  const directory = effectiveDownloadDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const defaultPath = uniqueDownloadPath(filename, directory);

  if (!shouldAsk) {
    return defaultPath;
  }

  const saveDialogOptions = {
    title: options.title || 'Save Download',
    defaultPath,
    buttonLabel: 'Save',
    properties: ['showOverwriteConfirmation']
  };
  const savePath = ownerState?.window
    ? dialog.showSaveDialogSync(ownerState.window, saveDialogOptions)
    : dialog.showSaveDialogSync(saveDialogOptions);

  if (!savePath) {
    return '';
  }

  return fs.existsSync(savePath)
    ? uniqueDownloadPath(path.basename(savePath), path.dirname(savePath))
    : savePath;
}

function chooseDownloadPath(item, ownerState, options = {}) {
  return chooseSavePathForFilename(options.suggestedFilename || item.getFilename(), ownerState, options);
}

function downloadRecordFromItem(id, item, patch = {}) {
  const totalBytes = item.getTotalBytes();
  const receivedBytes = item.getReceivedBytes();
  const percent = item.getPercentComplete();
  const savePath = patch.savePath || item.getSavePath() || '';
  return {
    id,
    filename: sanitizeFilename(savePath ? path.basename(savePath) : item.getFilename()),
    url: item.getURL(),
    urlChain: typeof item.getURLChain === 'function' ? item.getURLChain() : [],
    mimeType: item.getMimeType(),
    contentDisposition: item.getContentDisposition(),
    savePath,
    state: item.getState(),
    status: item.isPaused() ? 'paused' : item.getState(),
    receivedBytes,
    totalBytes,
    percent: Number.isFinite(percent) ? percent : (totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : -1),
    bytesPerSecond: item.getCurrentBytesPerSecond(),
    paused: item.isPaused(),
    canResume: item.canResume(),
    startedAt: new Date(item.getStartTime() * 1000).toISOString(),
    endedAt: item.getEndTime() ? new Date(item.getEndTime() * 1000).toISOString() : '',
    error: '',
    sourceWindowId: null,
    sourceTabId: null,
    sourceTitle: '',
    ...patch
  };
}

function extensionForMime(mimeType) {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const map = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/jpg', '.jpg'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['image/avif', '.avif'],
    ['image/svg+xml', '.svg'],
    ['image/bmp', '.bmp'],
    ['image/x-icon', '.ico'],
    ['text/plain', '.txt'],
    ['application/pdf', '.pdf'],
    ['application/zip', '.zip']
  ]);
  return map.get(normalized) || '';
}

function filenameFromUrl(resourceUrl, fallback = 'download', mimeType = '') {
  let name = '';
  try {
    const parsed = new URL(resourceUrl);
    const pathname = decodeURIComponent(parsed.pathname || '');
    name = path.basename(pathname);
  } catch {
    name = '';
  }

  const ext = path.extname(name);
  const mimeExt = extensionForMime(mimeType);
  if (!name || name === '/' || name === '.') {
    name = fallback;
  }
  if (!path.extname(name) && mimeExt) {
    name = `${name}${mimeExt}`;
  } else if (!path.extname(name) && !mimeExt && fallback && path.extname(fallback)) {
    name = fallback;
  } else if (ext && mimeExt && ext.toLowerCase() !== mimeExt && /^image(?:\.|$)/i.test(fallback)) {
    name = `${path.basename(name, ext)}${mimeExt}`;
  }
  return sanitizeFilename(name);
}

function compactDownloadUrl(url) {
  const value = String(url || '');
  if (/^data:/i.test(value)) {
    const match = /^data:([^;,]+)?/i.exec(value);
    return `data:${match?.[1] || 'application/octet-stream'};...`;
  }
  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
}

function sameDownloadUrl(left, right) {
  return String(left || '') === String(right || '');
}

function queueDownloadIntent(webContentsId, url, intent = {}) {
  pendingDownloadIntents.push({
    webContentsId,
    url: String(url || ''),
    createdAt: Date.now(),
    ...intent
  });
  while (pendingDownloadIntents.length > 40) {
    pendingDownloadIntents.shift();
  }
}

function takeDownloadIntent(webContentsId, item) {
  const now = Date.now();
  for (let index = pendingDownloadIntents.length - 1; index >= 0; index -= 1) {
    if (now - pendingDownloadIntents[index].createdAt > 30000) {
      pendingDownloadIntents.splice(index, 1);
    }
  }

  const itemUrl = item.getURL();
  const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
  const index = pendingDownloadIntents.findIndex(intent => (
    intent.webContentsId === webContentsId &&
    (
      sameDownloadUrl(intent.url, itemUrl) ||
      chain.some(chainUrl => sameDownloadUrl(chainUrl, intent.url))
    )
  ));
  if (index === -1) {
    return null;
  }
  return pendingDownloadIntents.splice(index, 1)[0];
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!match) {
    throw new Error('This data image is not a valid data URL.');
  }
  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const estimatedBytes = isBase64
    ? Math.ceil(payload.length * 0.75)
    : Buffer.byteLength(payload, 'utf8');
  if (estimatedBytes > MAX_CONTEXT_DATA_URL_BYTES) {
    throw new Error('That image is too large to save from the context menu.');
  }
  const buffer = isBase64
    ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mimeType, buffer };
}

async function saveBufferAsDownload({ ownerState, ownerTab, sourceUrl, filename, mimeType, buffer, forceAsk = true }) {
  const id = nextDownloadId;
  nextDownloadId += 1;
  const startedAt = new Date().toISOString();
  const cleanFilename = sanitizeFilename(filename || filenameFromUrl(sourceUrl, 'image', mimeType));
  const record = {
    id,
    filename: cleanFilename,
    url: compactDownloadUrl(sourceUrl),
    urlChain: [compactDownloadUrl(sourceUrl)],
    mimeType,
    contentDisposition: '',
    savePath: '',
    state: 'starting',
    status: 'Choose a save location',
    receivedBytes: 0,
    totalBytes: buffer.length,
    percent: 0,
    bytesPerSecond: 0,
    paused: false,
    canResume: false,
    startedAt,
    endedAt: '',
    error: '',
    sourceWindowId: ownerState?.id || null,
    sourceTabId: ownerTab?.id || null,
    sourceTitle: ownerTab?.title || ''
  };

  downloads.set(id, record);
  if (ownerState) {
    setDownloadsPanelVisible(ownerState, true);
  }
  broadcastDownloadsState();

  let savePath = '';
  try {
    savePath = chooseSavePathForFilename(cleanFilename, ownerState, {
      forceAsk,
      title: 'Save Image'
    });
  } catch (error) {
    updateDownload(id, {
      state: 'interrupted',
      status: 'interrupted',
      error: `Could not choose a save location: ${error.message || error}`,
      endedAt: new Date().toISOString()
    });
    return;
  }

  if (!savePath) {
    updateDownload(id, {
      state: 'cancelled',
      status: 'cancelled',
      error: 'Save canceled.',
      endedAt: new Date().toISOString()
    });
    return;
  }

  updateDownload(id, {
    savePath,
    state: 'progressing',
    status: 'Saving',
    receivedBytes: 0,
    totalBytes: buffer.length,
    percent: 0
  });

  try {
    await fs.promises.writeFile(savePath, buffer);
    updateDownload(id, {
      filename: path.basename(savePath),
      savePath,
      state: 'completed',
      status: 'completed',
      receivedBytes: buffer.length,
      totalBytes: buffer.length,
      percent: 100,
      endedAt: new Date().toISOString()
    });
  } catch (error) {
    updateDownload(id, {
      savePath,
      state: 'interrupted',
      status: 'interrupted',
      error: `Could not save the file: ${error.message || error}`,
      endedAt: new Date().toISOString()
    });
  }
}

function validContextResourceUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:', 'blob:', 'data:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function contextResourceFilename(url, fallback, mimeType = '') {
  if (/^data:/i.test(String(url || ''))) {
    return filenameFromUrl('', fallback, mimeType);
  }
  if (/^blob:/i.test(String(url || ''))) {
    return filenameFromUrl('', fallback, mimeType);
  }
  return filenameFromUrl(url, fallback, mimeType);
}

async function downloadContextResource(tab, resourceUrl, options = {}) {
  if (!tab || tab.view.webContents.isDestroyed()) {
    throw new Error('The originating tab is no longer available.');
  }
  if (!validContextResourceUrl(resourceUrl)) {
    throw new Error('Sovereign can save images and links that use HTTP, HTTPS, blob, or data URLs.');
  }

  const ownerState = getTabOwner(tab);
  const wc = tab.view.webContents;
  const url = String(resourceUrl || '');

  if (/^data:/i.test(url)) {
    const { mimeType, buffer } = parseDataUrl(url);
    await saveBufferAsDownload({
      ownerState,
      ownerTab: tab,
      sourceUrl: url,
      filename: options.suggestedFilename || contextResourceFilename(url, 'image', mimeType),
      mimeType,
      buffer,
      forceAsk: options.forceAsk !== false
    });
    return;
  }

  queueDownloadIntent(wc.id, url, {
    forceAsk: options.forceAsk !== false,
    suggestedFilename: options.suggestedFilename || '',
    ownerWindowId: ownerState?.id || null,
    ownerTabId: tab.id,
    title: options.title || ''
  });
  setupDownloadHandlingForSession(wc.session);
  wc.downloadURL(url);
}

function downloadsSnapshot() {
  return {
    downloads: [...downloads.values()].sort((left, right) => right.id - left.id)
  };
}

function broadcastDownloadsState() {
  const snapshot = downloadsSnapshot();
  for (const state of windows.values()) {
    if (state.uiView && !state.uiView.webContents.isDestroyed()) {
      state.uiView.webContents.send('downloads:state', snapshot);
    }
    for (const tab of state.tabs.values()) {
      if (tab.kind === 'downloads' && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('downloads:state', snapshot);
      }
    }
  }
}

function updateDownload(id, patch = {}) {
  const current = downloads.get(id);
  if (!current) {
    return;
  }
  downloads.set(id, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
  broadcastDownloadsState();
}

function setupDownloadHandlingForSession(targetSession = session.defaultSession) {
  setupAuditProxyForSession(targetSession);
  if (!targetSession || downloadHandledSessions.has(targetSession)) {
    return;
  }
  downloadHandledSessions.add(targetSession);

  targetSession.on('will-download', (_event, item, webContents) => {
    if (networkMode.isOffline() && !networkDecision(item.getURL()).allow) {
      const blockedId = nextDownloadId;
      nextDownloadId += 1;
      downloads.set(blockedId, downloadRecordFromItem(blockedId, item, {
        state: 'cancelled',
        status: 'Blocked: Offline mode',
        error: 'Blocked: Offline mode',
        savePath: '',
        filename: sanitizeFilename(item.getFilename())
      }));
      item.cancel();
      broadcastDownloadsState();
      return;
    }
    const chain = item.getURLChain();
    for (const [id, guard] of guardedDownloadRequests) {
      if (guard.webContentsId === webContents?.id && chain.includes(guard.lastUrl)) guardedDownloadRequests.delete(id);
    }
    for (const url of chain) guardedDownloadUrls.delete(urlKey(url, String(webContents?.id)));
    const id = nextDownloadId;
    nextDownloadId += 1;
    const owner = findTabByWebContentsId(webContents?.id);
    const intent = takeDownloadIntent(webContents?.id, item);
    const intentOwnerState = intent?.ownerWindowId ? windows.get(intent.ownerWindowId) : null;
    const ownerState = owner.state || intentOwnerState;
    const ownerTab = owner.tab || (intent?.ownerTabId ? ownerState?.tabs.get(intent.ownerTabId) : null);
    const record = downloadRecordFromItem(id, item, {
      state: 'starting',
      status: 'Choose a save location',
      savePath: '',
      filename: sanitizeFilename(intent?.suggestedFilename || item.getFilename()),
      sourceWindowId: ownerState?.id || null,
      sourceTabId: ownerTab?.id || null,
      sourceTitle: ownerTab?.title || ''
    });

    downloads.set(id, record);
    activeDownloadItems.set(id, item);
    if (ownerState) {
      setDownloadsPanelVisible(ownerState, true);
    } else {
      const fallbackState = focusedWindowState();
      if (fallbackState) {
        setDownloadsPanelVisible(fallbackState, true);
      }
    }
    broadcastDownloadsState();

    let savePath = '';
    try {
      savePath = chooseDownloadPath(item, ownerState, {
        forceAsk: Boolean(intent?.forceAsk),
        suggestedFilename: intent?.suggestedFilename || ''
      });
    } catch (error) {
      activeDownloadItems.delete(id);
      updateDownload(id, {
        state: 'interrupted',
        status: 'interrupted',
        error: `Could not choose a save location: ${error.message || error}`
      });
      item.cancel();
      return;
    }

    if (!savePath) {
      activeDownloadItems.delete(id);
      updateDownload(id, {
        state: 'cancelled',
        status: 'cancelled',
        error: 'Save canceled.'
      });
      item.cancel();
      return;
    }

    item.setSavePath(savePath);
    updateDownload(id, {
      ...downloadRecordFromItem(id, item),
      savePath,
      filename: path.basename(savePath),
      state: 'progressing',
      status: 'Downloading'
    });

    item.on('updated', (_downloadEvent, state) => {
      updateDownload(id, {
        ...downloadRecordFromItem(id, item),
        state,
        status: item.isPaused() ? (offlinePausedDownloads.has(id) ? 'Paused: Offline mode' : 'paused') : state,
        offlinePaused: item.isPaused() && offlinePausedDownloads.has(id),
        error: state === 'interrupted' ? 'Download was interrupted.' : ''
      });
    });

    item.on('done', (_downloadEvent, state) => {
      activeDownloadItems.delete(id);
      offlinePausedDownloads.delete(id);
      updateDownload(id, {
        ...downloadRecordFromItem(id, item),
        state,
        status: state,
        error: state === 'interrupted' ? 'Download was interrupted.' : '',
        endedAt: new Date().toISOString()
      });
    });
  });
}

function setupDownloadHandling() {
  setupDownloadHandlingForSession(session.defaultSession);
}

function validateDownloadUrlInput(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS file URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('Download URLs must use HTTP or HTTPS.');
  }
  parsed.hash = '';
  return parsed.toString();
}

function contentDispositionIsAttachment(value) {
  return /\battachment\b/i.test(String(value || ''));
}

function isImageMimeType(value) {
  return /^image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon)\b/i.test(String(value || ''));
}

function isVideoMimeType(value) {
  return /^video\/(?:mp4|webm|ogg|quicktime|x-m4v|mpeg)\b/i.test(String(value || ''));
}

function isMediaMimeType(value, mediaType = '') {
  return mediaType === 'videos'
    ? isVideoMimeType(value)
    : isImageMimeType(value);
}

function cancelPreflightBody(response) {
  try {
    response?.body?.cancel?.();
  } catch {
    // Best effort: the response body is only probed to inspect headers.
  }
}

async function fetchForDownloadPreflight(targetSession, url, options) {
  if (!networkDecision(url).allow) networkMode.assertOnline('download check');
  const downloadSession = targetSession && typeof targetSession.fetch === 'function'
    ? targetSession
    : session.defaultSession;
  return downloadSession.fetch(url, options);
}

async function preflightDownloadUrl(url, targetSession = session.defaultSession) {
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    response = await fetchForDownloadPreflight(targetSession, url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new Error(`Could not check the URL before downloading: ${error.message}`);
  }
  clearTimeout(timeout);

  if ([405, 501].includes(response.status)) {
    cancelPreflightBody(response);
    const fallbackController = new AbortController();
    const fallbackTimeout = setTimeout(() => fallbackController.abort(), 12000);
    try {
      response = await fetchForDownloadPreflight(targetSession, url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Range: 'bytes=0-0' },
        signal: fallbackController.signal
      });
    } catch (error) {
      clearTimeout(fallbackTimeout);
      throw new Error(`Could not check the URL before downloading: ${error.message}`);
    }
    clearTimeout(fallbackTimeout);
  }

  if (!response.ok) {
    cancelPreflightBody(response);
    throw new Error(`The server returned HTTP ${response.status} before download.`);
  }

  const contentType = response.headers.get('content-type') || '';
  const disposition = response.headers.get('content-disposition') || '';
  const length = response.headers.get('content-length') || '';
  const looksHtml = /\btext\/html\b/i.test(contentType);
  if (looksHtml && !contentDispositionIsAttachment(disposition)) {
    cancelPreflightBody(response);
    throw new Error('That URL appears to be an HTML page, not a file download.');
  }
  cancelPreflightBody(response);

  return {
    contentType,
    disposition,
    length,
    finalUrl: response.url || url
  };
}

async function preflightMediaUrl(url, mediaType = 'images', _targetSession, receiptDetails = null) {
  const fetchMedia = (method, headers) => gatedSafeFetch(url, {
    method, headers,
    onHop: hop => {
      const base = receiptDetails?.whatWasSent || 'media validation request – no query, prompt, or AI output sent';
      const entry = {
        category: 'image', method, url: hop.url,
        whatWasSent: `${base}${method === 'GET' ? ' (GET range fallback)' : ''}${hop.index ? ` (redirect from ${hop.fromHost})` : ''}`
      };
      if (receiptDetails?.receiptId) privacyReceipts.addEntry(receiptDetails.receiptId, entry);
      else privacyReceipts.addBackgroundEntry(entry);
    }
  });
  let fetched = await fetchMedia('HEAD');
  if ([405, 501].includes(fetched.response.status)) {
    cancelPreflightBody(fetched.response);
    fetched = await fetchMedia('GET', { Range: 'bytes=0-0' });
  }
  const { response, finalUrl } = fetched;
  cancelPreflightBody(response);
  if (!response.ok) throw new Error(`The server returned HTTP ${response.status} before download.`);
  const contentType = response.headers.get('content-type') || '';
  const disposition = response.headers.get('content-disposition') || '';
  const length = response.headers.get('content-length') || '';
  if (/\btext\/html\b/i.test(contentType) && !contentDispositionIsAttachment(disposition)) {
    throw new Error('That URL appears to be an HTML page, not a file download.');
  }
  if (!isMediaMimeType(contentType, mediaType)) {
    throw new Error(`The linked resource is not a direct ${mediaType === 'videos' ? 'video' : 'image'} file. Server content type: ${contentType || 'unknown'}.`);
  }
  return { contentType, disposition, length, finalUrl, url: finalUrl, downloadable: true };
}

function mediaFixtureResults(query, category) {
  if (!MEDIA_TEST_FIXTURES) {
    return null;
  }
  if (query === 'fixture-unreachable') {
    throw new Error('ECONNREFUSED');
  }
  if (query === 'fixture-empty') {
    return {
      query,
      endpoint: searchSettings.endpoint,
      category,
      results: [],
      unresponsiveEngines: [],
      durationMs: 0
    };
  }
  const type = category === 'videos' ? 'videos' : 'images';
  const results = type === 'videos'
    ? [
        {
          id: 1,
          stableId: 'videos-1-video.example',
          type,
          title: 'Everest documentary watch page',
          sourceUrl: 'https://video.example/watch/everest',
          pageUrl: 'https://video.example/watch/everest',
          hasSourcePage: true,
          mediaUrl: '',
          originalMediaUrl: '',
          thumbnailUrl: 'https://video.example/thumb.jpg',
          sourceDomain: 'video.example',
          creator: '',
          license: 'License unknown'
        },
        {
          id: 2,
          stableId: 'videos-2-media.example',
          type,
          title: 'Direct sample video',
          sourceUrl: 'https://media.example/video-page',
          mediaUrl: 'https://media.example/direct.mp4',
          originalMediaUrl: 'https://media.example/direct.mp4',
          thumbnailUrl: '',
          sourceDomain: 'media.example',
          creator: '',
          license: 'CC BY'
        }
      ]
    : [
        {
          id: 1,
          stableId: 'images-1-maps.example',
          type,
          title: 'Political map of Nepal',
          sourceUrl: 'https://maps.example/nepal',
          pageUrl: 'https://maps.example/nepal',
          hasSourcePage: true,
          mediaUrl: 'https://cdn.example/nepal-map.jpg',
          originalMediaUrl: 'https://cdn.example/nepal-map.jpg',
          thumbnailUrl: 'https://cdn.example/nepal-map-thumb.jpg',
          sourceDomain: 'maps.example',
          creator: 'Test Cartographer',
          license: 'CC BY-SA'
        },
        {
          id: 2,
          stableId: 'images-2-photos.example',
          type,
          title: 'Mount Everest photo',
          sourceUrl: 'https://photos.example/everest',
          pageUrl: 'https://photos.example/everest',
          hasSourcePage: true,
          mediaUrl: 'https://cdn.example/everest-photo.png',
          originalMediaUrl: 'https://cdn.example/everest-photo.png',
          thumbnailUrl: 'https://cdn.example/everest-thumb.png',
          sourceDomain: 'photos.example',
          creator: '',
          license: 'License unknown'
        },
        {
          id: 3,
          stableId: 'images-3-broken.example',
          type,
          title: 'Broken HTML response',
          sourceUrl: 'https://broken.example/page',
          pageUrl: 'https://broken.example/page',
          hasSourcePage: true,
          mediaUrl: 'https://broken.example/not-media.html',
          originalMediaUrl: 'https://broken.example/not-media.html',
          thumbnailUrl: '',
          sourceDomain: 'broken.example',
          creator: '',
          license: 'License unknown'
        },
        {
          id: 4,
          stableId: 'images-4-thumb.example',
          type,
          title: 'Thumbnail-only Nepal image',
          sourceUrl: 'https://thumb.example/nepal-gallery',
          pageUrl: 'https://thumb.example/nepal-gallery',
          hasSourcePage: true,
          mediaUrl: '',
          originalMediaUrl: '',
          thumbnailUrl: 'https://thumb.example/nepal-thumb.webp',
          sourceDomain: 'thumb.example',
          creator: '',
          license: 'License unknown'
        }
      ];
  return {
    query: normalizeSearchQuestion(query),
    endpoint: 'fixture://media-search',
    category: type,
    results,
    durationMs: 0,
    activity: searchActivityEvents.slice(-30)
  };
}

async function preflightMediaUrlForRequest(url, mediaType, targetSession, receiptDetails = null) {
  if (MEDIA_TEST_FIXTURES) {
    const checked = String(url || '');
    if (checked.includes('not-media')) {
      throw new Error('The linked resource is not a direct image file.');
    }
    if (!/^https:\/\//i.test(checked)) {
      throw new Error('Only HTTPS media fixture URLs are accepted.');
    }
    const contentType = checked.endsWith('.mp4') ? 'video/mp4' : checked.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return {
      contentType,
      disposition: '',
      length: checked.endsWith('.mp4') ? '2048' : '1024',
      url: checked,
      finalUrl: checked,
      downloadable: true
    };
  }
  return preflightMediaUrl(url, mediaType, targetSession, receiptDetails);
}

function downloadItemForAction(downloadId) {
  const id = Number(downloadId);
  if (!Number.isInteger(id)) {
    throw new Error('Download id is invalid.');
  }
  return activeDownloadItems.get(id);
}

function sendError(state, message) {
  const uiContents = state?.uiView?.webContents;
  if (!uiContents || uiContents.isDestroyed()) {
    return;
  }

  uiContents.send('browser:error', message);
}

function sendTabState(tab) {
  const owner = getTabOwner(tab);
  if (owner) {
    sendState(owner);
    sendAiState(owner);
  }
}

function sendTabError(tab, message) {
  const owner = getTabOwner(tab);
  if (owner) {
    sendError(owner, message);
  }
}

function safeWriteClipboardText(text) {
  try {
    clipboard.writeText(String(text || ''));
    return true;
  } catch {
    return false;
  }
}

function copyImageAt(tab, params) {
  if (!tab || tab.view.webContents.isDestroyed()) {
    return;
  }
  if (!params?.hasImageContents && params?.mediaType !== 'image') {
    sendTabError(tab, 'No image was found at that point.');
    return;
  }
  try {
    tab.view.webContents.copyImageAt(Math.round(params.x || 0), Math.round(params.y || 0));
    sendTabError(tab, 'Image copied.');
  } catch (error) {
    sendTabError(tab, `Could not copy that image: ${error.message || error}`);
  }
}

function copyImageAddress(tab, params) {
  const srcUrl = String(params?.srcURL || '');
  if (!srcUrl) {
    sendTabError(tab, 'That image does not expose a copyable address.');
    return;
  }
  if (safeWriteClipboardText(srcUrl)) {
    sendTabError(tab, 'Image address copied.');
  } else {
    sendTabError(tab, 'Could not write the image address to the clipboard.');
  }
}

function openImageInNewTab(tab, params) {
  const srcUrl = String(params?.srcURL || '');
  if (!srcUrl) {
    sendTabError(tab, 'That image does not expose an address Sovereign can open.');
    return;
  }
  const checked = normalizeAddress(srcUrl);
  const owner = getTabOwner(tab);
  if (checked.ok && owner) {
    createTab(owner, checked.url, true);
    return;
  }
  sendTabError(tab, 'Sovereign can open HTTP and HTTPS image addresses in a new tab. Blob and data images can be saved or copied from their original page.');
}

function imageMimeFromContext(params) {
  const srcUrl = String(params?.srcURL || '');
  if (/^data:/i.test(srcUrl)) {
    const match = /^data:([^;,]*)/i.exec(srcUrl);
    return match?.[1] || '';
  }
  return '';
}

async function saveImageFromContext(tab, params) {
  const srcUrl = String(params?.srcURL || '');
  if (!srcUrl) {
    throw new Error('That image does not expose a savable address. Copy Image may still work for visible image content.');
  }
  const mimeType = imageMimeFromContext(params);
  await downloadContextResource(tab, srcUrl, {
    forceAsk: true,
    suggestedFilename: contextResourceFilename(srcUrl, 'image.png', mimeType),
    title: 'Save Image'
  });
}

async function saveLinkFromContext(tab, params) {
  const linkUrl = String(params?.linkURL || '');
  if (!linkUrl) {
    throw new Error('No link was found at that point.');
  }
  await downloadContextResource(tab, linkUrl, {
    forceAsk: true,
    suggestedFilename: contextResourceFilename(linkUrl, 'download'),
    title: 'Save Link'
  });
}

function runContextMenuTestAction(tab, params) {
  const action = String(process.env.SOVEREIGN_TEST_CONTEXT_MENU_ACTION || '').trim();
  if (!action) {
    return false;
  }

  Promise.resolve().then(async () => {
    if (action === 'save-image') {
      await saveImageFromContext(tab, params);
    } else if (action === 'save-link') {
      await saveLinkFromContext(tab, params);
    } else if (action === 'copy-image-address') {
      copyImageAddress(tab, params);
    } else if (action === 'copy-image') {
      copyImageAt(tab, params);
    } else if (action === 'open-image-new-tab') {
      openImageInNewTab(tab, params);
    }
  }).catch(error => {
    sendTabError(tab, error.message || String(error));
  });
  return true;
}

function editContextMenuItems(params = {}) {
  const flags = params.editFlags || {};
  const editable = Boolean(params.isEditable);
  const hasSelection = Boolean(params.selectionText);
  const wantsEditMenu = editable ||
    hasSelection ||
    Boolean(flags.canCopy || flags.canPaste || flags.canCut || flags.canSelectAll);

  if (!wantsEditMenu) {
    return [];
  }

  if (!editable) {
    return [
      {
        label: 'Copy',
        role: 'copy',
        enabled: hasSelection || Boolean(flags.canCopy)
      },
      {
        type: 'separator'
      },
      {
        label: 'Select All',
        role: 'selectAll',
        enabled: Boolean(flags.canSelectAll)
      }
    ];
  }

  return [
    {
      label: 'Undo',
      role: 'undo',
      enabled: Boolean(flags.canUndo)
    },
    {
      label: 'Redo',
      role: 'redo',
      enabled: Boolean(flags.canRedo)
    },
    {
      type: 'separator'
    },
    {
      label: 'Cut',
      role: 'cut',
      enabled: Boolean(flags.canCut)
    },
    {
      label: 'Copy',
      role: 'copy',
      enabled: Boolean(flags.canCopy)
    },
    {
      label: 'Paste',
      role: 'paste',
      enabled: Boolean(flags.canPaste)
    },
    {
      label: 'Paste and Match Style',
      role: 'pasteAndMatchStyle',
      enabled: Boolean(flags.canPaste)
    },
    {
      label: 'Delete',
      role: 'delete',
      enabled: Boolean(flags.canDelete)
    },
    {
      type: 'separator'
    },
    {
      label: 'Select All',
      role: 'selectAll',
      enabled: Boolean(flags.canSelectAll)
    }
  ];
}

function appendMenuSeparator(template) {
  if (template.length > 0 && template.at(-1)?.type !== 'separator') {
    template.push({ type: 'separator' });
  }
}

function cleanMenuTemplate(template) {
  const result = [];
  for (const item of template) {
    if (item.type === 'separator') {
      if (result.length === 0 || result.at(-1)?.type === 'separator') {
        continue;
      }
    }
    result.push(item);
  }
  while (result.at(-1)?.type === 'separator') {
    result.pop();
  }
  return result;
}

function showPageContextMenu(tab, params) {
  if (!tab || tab.view.webContents.isDestroyed()) {
    return;
  }
  if (runContextMenuTestAction(tab, params)) {
    return;
  }

  const hasImage = Boolean(params?.srcURL || params?.hasImageContents || params?.mediaType === 'image');
  const hasLink = Boolean(params?.linkURL);
  const editItems = editContextMenuItems(params);
  if (!hasImage && !hasLink && editItems.length === 0) {
    return;
  }

  const template = [];
  template.push(...editItems);
  if (editItems.length > 0 && (hasImage || hasLink)) {
    appendMenuSeparator(template);
  }

  if (hasImage) {
    template.push(
      {
        label: 'Save Image As...',
        enabled: Boolean(params.srcURL),
        click: () => {
          saveImageFromContext(tab, params).catch(error => {
            sendTabError(tab, error.message || String(error));
          });
        }
      },
      {
        label: 'Copy Image',
        enabled: Boolean(params.hasImageContents || params.mediaType === 'image'),
        click: () => copyImageAt(tab, params)
      },
      {
        label: 'Copy Image Address',
        enabled: Boolean(params.srcURL),
        click: () => copyImageAddress(tab, params)
      },
      {
        label: 'Open Image in New Tab',
        enabled: Boolean(params.srcURL && /^https?:\/\//i.test(params.srcURL)),
        click: () => openImageInNewTab(tab, params)
      }
    );
  }

  if (hasImage && hasLink) {
    template.push({ type: 'separator' });
  }

  if (hasLink) {
    template.push({
      label: 'Save Link As...',
      click: () => {
        saveLinkFromContext(tab, params).catch(error => {
          sendTabError(tab, error.message || String(error));
        });
      }
    });
  }

  const owner = getTabOwner(tab);
  const menu = Menu.buildFromTemplate(cleanMenuTemplate(template));
  menu.popup({
    window: owner?.window,
    frame: params?.frame,
    sourceType: params?.menuSourceType
  });
}

function sendFindResult(state, result = {}) {
  const contents = state?.uiView?.webContents;
  if (!contents || contents.isDestroyed()) {
    return;
  }
  contents.send('find:result', {
    query: state.findQuery || '',
    activeMatchOrdinal: Number(result.activeMatchOrdinal || 0),
    matches: Number(result.matches || 0),
    finalUpdate: Boolean(result.finalUpdate),
    searching: Boolean(result.requestId && !result.finalUpdate)
  });
}

function processFindQueue() {
  const job = pendingFindJobs.shift();
  if (!job) {
    return;
  }
  const targetContents = webContents.getAllWebContents()
    .find(contents => !contents.isDestroyed() && contents.id === job.webContentsId);
  if (!targetContents || targetContents.isDestroyed()) {
    return;
  }
  const { state, tab } = findTabByWebContentsId(job.webContentsId);
  const script = `
(() => {
  const query = ${JSON.stringify(job.query)};
  const forward = ${job.forward ? 'true' : 'false'};
  const reset = ${job.findNext ? 'false' : 'true'};

  function countLiteralMatches(text, needle) {
    const haystack = String(text || '').toLocaleLowerCase();
    const target = String(needle || '').toLocaleLowerCase();
    if (!target) {
      return 0;
    }
    let count = 0;
    let index = 0;
    while (index <= haystack.length) {
      const found = haystack.indexOf(target, index);
      if (found === -1) {
        break;
      }
      count += 1;
      index = found + Math.max(target.length, 1);
    }
    return count;
  }

  if (!query) {
    window.getSelection()?.removeAllRanges();
    return { matches: 0 };
  }

  const root = document.body || document.documentElement;
  const matches = countLiteralMatches(root?.innerText || root?.textContent || '', query);
  if (matches > 0) {
    if (reset) {
      window.getSelection()?.removeAllRanges();
      window.scrollTo(0, 0);
    }
    window.find(query, false, !forward, true, false, true, false);
  }
  return { matches };
})()
`;
  targetContents.executeJavaScriptInIsolatedWorld(
    FIND_WORLD_ID,
    [{ code: script, url: 'sovereign://find-in-page.js' }],
    false
  ).then(result => {
    const matches = Number(result?.matches || 0);
    const current = findStates.get(job.webContentsId) || { query: '', ordinal: 0 };
    let ordinal = 0;
    if (matches > 0) {
      if (!job.findNext || current.query !== job.query || current.ordinal < 1) {
        ordinal = job.forward ? 1 : matches;
      } else {
        const delta = job.forward ? 1 : -1;
        ordinal = ((current.ordinal - 1 + delta + matches) % matches) + 1;
      }
    }
    findStates.set(job.webContentsId, {
      query: job.query,
      ordinal,
      matches
    });
    if (state?.activeTabId === tab?.id) {
      sendFindResult(state, {
        matches,
        activeMatchOrdinal: ordinal,
        finalUpdate: true
      });
    }
  }).catch(error => {
    if (state) {
      sendError(state, `Find failed: ${error.message || error}`);
      sendFindResult(state, { matches: 0, activeMatchOrdinal: 0, finalUpdate: true });
    }
  });
}

function ensureFindQueueTimer() {
  if (findQueueTimer) {
    return;
  }
  findQueueTimer = setInterval(processFindQueue, 60);
  if (typeof findQueueTimer.unref === 'function') {
    findQueueTimer.unref();
  }
}

function clearFindSelection(tab) {
  const contents = tab?.view?.webContents;
  if (!contents || contents.isDestroyed()) {
    return;
  }
  findStates.delete(contents.id);
  contents.stopFindInPage('clearSelection');
  contents.executeJavaScriptInIsolatedWorld(
    FIND_WORLD_ID,
    [{ code: 'window.getSelection()?.removeAllRanges();', url: 'sovereign://find-in-page.js' }],
    false
  ).catch(() => {});
}

function setFindBarVisible(state, visible) {
  if (!state || state.window.isDestroyed()) {
    return;
  }
  state.findBarVisible = Boolean(visible);
  if (!state.findBarVisible) {
    const tab = state.tabs.get(state.activeTabId);
    clearFindSelection(tab);
    state.findQuery = '';
    sendFindResult(state, { finalUpdate: true });
  }
  layoutViews(state);
  sendState(state);
  if (state.findBarVisible) {
    state.uiView?.webContents.send('browser:show-find-bar');
  }
}

function runFindInActiveTab(state, query, options = {}) {
  const tab = state?.tabs.get(state.activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) {
    return;
  }

  const cleanQuery = String(query || '').slice(0, 200);
  state.findQuery = cleanQuery;
  if (!cleanQuery) {
    tab.view.webContents.stopFindInPage('clearSelection');
    sendFindResult(state, { finalUpdate: true });
    return;
  }

  pendingFindJobs.push({
    webContentsId: tab.view.webContents.id,
    query: cleanQuery,
    forward: options.forward !== false,
    findNext: Boolean(options.findNext)
  });
  while (pendingFindJobs.length > 10) {
    pendingFindJobs.shift();
  }
}

function attachTabEvents(tab) {
  const wc = tab.view.webContents;

  wc.on('page-title-updated', (_event, title) => {
    tab.title = title || tab.title;
    sendTabState(tab);
  });

  wc.on('did-start-loading', () => sendTabState(tab));
  wc.on('did-stop-loading', () => sendTabState(tab));

  wc.on('found-in-page', (_event, result) => {
    const owner = getTabOwner(tab);
    if (owner?.activeTabId === tab.id) {
      sendFindResult(owner, result);
    }
  });

  wc.on('context-menu', (_event, params) => {
    showPageContextMenu(tab, params);
  });

  wc.on('did-navigate', (_event, url) => {
    tab.url = url;
    sendTabState(tab);
  });

  wc.on('did-navigate-in-page', (_event, url) => {
    tab.url = url;
    sendTabState(tab);
  });

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      tab.title = 'Load Failed';
      tab.url = validatedURL || tab.url;
      const offlineMessage = errorCode === -20 && networkMode.isOffline()
        ? offlineLoadMessage(validatedURL || tab.url)
        : '';
      if (offlineMessage) tab.title = 'Offline';
      sendTabError(tab, offlineMessage || errorDescription || 'The page could not be loaded.');
      sendTabState(tab);
    }
  });

  wc.on('will-navigate', (event, url) => {
    const checked = normalizeAddress(url);
    if (!checked.ok) {
      event.preventDefault();
      sendTabError(tab, checked.error);
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (/^blob:/i.test(url)) {
      setupDownloadHandlingForSession(wc.session);
      wc.downloadURL(url);
      return { action: 'deny' };
    }

    const checked = normalizeAddress(url);
    const owner = getTabOwner(tab);
    if (checked.ok && owner) {
      createTab(owner, checked.url, true);
    } else if (!checked.ok) {
      sendTabError(tab, checked.error);
    }
    return { action: 'deny' };
  });
}

function createWebView() {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  setupDownloadHandlingForSession(view.webContents.session);
  return view;
}

function createTrustedInternalView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  setupDownloadHandlingForSession(view.webContents.session);
  return view;
}

function internalTabTitle(kind) {
  if (kind === 'home') {
    return 'Sovereign';
  }
  if (kind === 'downloads') {
    return 'Downloads';
  }
  if (kind === 'settings') {
    return 'Settings';
  }
  if (kind === 'bookmarks') {
    return 'Bookmarks';
  }
  if (kind === 'ask') {
    return 'Ask AI';
  }
  return 'Sovereign Search';
}

function internalUrlForKind(kind, options = {}) {
  if (kind === 'home') {
    return NEW_TAB_URL;
  }
  if (kind === 'downloads') {
    return DOWNLOADS_PAGE_URL;
  }
  if (kind === 'settings') {
    return SETTINGS_PAGE_URL;
  }
  if (kind === 'bookmarks') {
    return BOOKMARKS_PAGE_URL;
  }
  if (kind === 'ask') {
    const url = new URL(ASK_PAGE_URL);
    const question = normalizeSearchQuestion(options.question);
    if (question) {
      url.searchParams.set('q', question);
    }
    if (options.autoRun) {
      url.searchParams.set('run', '1');
    }
    if (options.handoffId) {
      url.searchParams.set('handoff', String(options.handoffId).slice(0, 120));
    }
    return url.toString();
  }

  const url = new URL(SEARCH_PAGE_URL);
  const question = normalizeSearchQuestion(options.question);
  if (question) {
    url.searchParams.set('q', question);
  }
  if (options.autoRun) {
    url.searchParams.set('run', '1');
  }
  return url.toString();
}

function internalKindFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'sovereign:') {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'newtab') {
      return 'home';
    }
    if (host === 'downloads') {
      return 'downloads';
    }
    if (host === 'settings') {
      return 'settings';
    }
    if (host === 'bookmarks') {
      return 'bookmarks';
    }
    if (host === 'ask') {
      return 'ask';
    }
    if (host === 'search') {
      return 'search';
    }
  } catch {
    return '';
  }
  return '';
}

function attachSearchTabEvents(tab) {
  const wc = tab.view.webContents;

  wc.on('did-start-loading', () => sendTabState(tab));
  wc.on('did-stop-loading', () => sendTabState(tab));
  wc.on('context-menu', (_event, params) => {
    showPageContextMenu(tab, params);
  });
  wc.on('found-in-page', (_event, result) => {
    const owner = getTabOwner(tab);
    if (owner?.activeTabId === tab.id) {
      sendFindResult(owner, result);
    }
  });
  wc.on('page-title-updated', () => {
    tab.title = internalTabTitle(tab.kind);
    sendTabState(tab);
  });
  wc.on('did-finish-load', () => {
    tab.title = internalTabTitle(tab.kind);
    sendTabState(tab);
    if (tab.kind === 'search') {
      wc.send('search:activity', searchActivityEvents.slice(-30));
    } else if (tab.kind === 'downloads') {
      wc.send('downloads:state', downloadsSnapshot());
    } else if (tab.kind === 'bookmarks') {
      wc.send('bookmarks:state', bookmarksSnapshot());
    }
    if (tab.kind === 'home') {
      wc.focus();
      wc.executeJavaScript('window.SovereignNewTab?.focusSearch?.()', true).catch(() => {});
    }
  });
  wc.on('will-navigate', event => {
    event.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showTab(state, tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab || state.activeTabId === tabId) {
    layoutViews(state);
    sendState(state);
    sendAiState(state);
    return;
  }

  const previous = state.tabs.get(state.activeTabId);
  if (previous) {
    state.window.contentView.removeChildView(previous.view);
  }

  state.activeTabId = tabId;
  state.window.contentView.addChildView(tab.view);
  layoutViews(state);
  sendState(state);
  sendAiState(state);
  if (state.findBarVisible && state.findQuery) {
    runFindInActiveTab(state, state.findQuery, { findNext: false });
  } else if (state.findBarVisible) {
    sendFindResult(state, { finalUpdate: true });
  }
}

function createInternalTab(state, kind = 'home', makeActive = true, options = {}) {
  const url = internalUrlForKind(kind, options);
  const tab = {
    id: nextTabId,
    windowId: state.id,
    kind,
    title: internalTabTitle(kind),
    url,
    view: createTrustedInternalView()
  };
  nextTabId += 1;

  state.tabs.set(tab.id, tab);
  tabOwners.set(tab.id, state.id);
  getAiState(tab.id);
  attachSearchTabEvents(tab);

  if (makeActive || state.activeTabId === null) {
    showTab(state, tab.id);
  } else {
    sendState(state);
    sendAiState(state);
  }

  tab.view.webContents.loadURL(url).catch(() => {});
  return tab;
}

function createSearchTab(state, makeActive = true, options = {}) {
  return createInternalTab(state, 'search', makeActive, options);
}

function createTab(state, address = DEFAULT_HOME, makeActive = true) {
  const internalKind = internalKindFromUrl(address || DEFAULT_HOME);
  if (internalKind) {
    let options = {};
    if (internalKind === 'search') {
      try {
        const parsed = new URL(address);
        options = {
          question: parsed.searchParams.get('q') || '',
          autoRun: parsed.searchParams.get('run') === '1'
        };
      } catch {
        options = {};
      }
    } else if (internalKind === 'ask') {
      try {
        const parsed = new URL(address);
        options = {
          question: parsed.searchParams.get('q') || '',
          autoRun: parsed.searchParams.get('run') === '1'
        };
      } catch {
        options = {};
      }
    }
    return createInternalTab(state, internalKind, makeActive, options);
  }

  const checked = normalizeAddress(address);
  if (!checked.ok) {
    sendError(state, checked.error);
    return null;
  }

  const tab = {
    id: nextTabId,
    windowId: state.id,
    kind: 'web',
    title: 'New Tab',
    url: checked.url,
    view: createWebView()
  };
  nextTabId += 1;

  state.tabs.set(tab.id, tab);
  tabOwners.set(tab.id, state.id);
  getAiState(tab.id);
  attachTabEvents(tab);
  logDetach('created tab', {
    windowId: state.id,
    tab: tabDebugInfo(tab)
  });

  if (makeActive || state.activeTabId === null) {
    showTab(state, tab.id);
  } else {
    sendState(state);
    sendAiState(state);
  }

  tab.view.webContents.loadURL(checked.url).catch(() => {});
  return tab;
}

function pickReplacementTabId(state) {
  return [...state.tabs.keys()].at(-1) ?? null;
}

function closeEmptyWindow(state) {
  state.activeTabId = null;
  sendState(state);
  sendAiState(state);

  if (!state.window.isDestroyed()) {
    state.window.close();
  }
}

function focusedWindowState() {
  for (const state of windows.values()) {
    if (state.window && !state.window.isDestroyed() && state.window.isFocused()) {
      return state;
    }
  }
  return [...windows.values()].find(state => state.window && !state.window.isDestroyed()) || null;
}

function focusAddressBar(state = focusedWindowState()) {
  const contents = state?.uiView?.webContents;
  if (contents && !contents.isDestroyed()) {
    contents.focus();
    contents.send('browser:focus-address');
  }
}

function reloadActiveTab(state = focusedWindowState()) {
  const tab = state?.tabs.get(state.activeTabId);
  if (tab && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.reload();
  }
}

function closeActiveTab(state = focusedWindowState()) {
  if (state?.activeTabId !== null) {
    closeTab(state, state.activeTabId);
  }
}

function reopenClosedTab(state = focusedWindowState()) {
  const entry = recentlyClosedTabs.pop();
  if (!entry) {
    return;
  }
  const targetState = state || createWindow();
  createTab(targetState, entry.url, true);
}

function setupApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            const state = focusedWindowState() || createWindow();
            createTab(state, DEFAULT_HOME, true);
          }
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => closeActiveTab()
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => reopenClosedTab()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Page',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            const state = focusedWindowState();
            if (!state) {
              return;
            }
            try {
              toggleBookmarkForActiveTab(state);
            } catch (error) {
              sendError(state, error.message || String(error));
            }
          }
        },
        {
          label: 'Show Bookmarks',
          click: () => openInternalPage(focusedWindowState(), 'bookmarks')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Find in Page',
          accelerator: 'CmdOrCtrl+F',
          click: () => setFindBarVisible(focusedWindowState(), true)
        },
        {
          label: 'Focus Address Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => focusAddressBar()
        },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => reloadActiveTab()
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openInternalPage(state, kind) {
  if (!state) {
    return;
  }
  createInternalTab(state, kind, true);
}

function setDownloadsPanelVisible(state, visible) {
  if (!state || state.window.isDestroyed()) {
    return;
  }
  state.downloadsPanelVisible = Boolean(visible);
  layoutViews(state);
  sendState(state);
  const snapshot = downloadsSnapshot();
  if (state.uiView && !state.uiView.webContents.isDestroyed()) {
    state.uiView.webContents.send('downloads:state', snapshot);
  }
}

function closeTab(state, tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) {
    return;
  }

  const wasActive = state.activeTabId === tabId;
  if (wasActive) {
    state.window.contentView.removeChildView(tab.view);
  }
  rememberClosedTab(tab);

  state.tabs.delete(tabId);
  tabOwners.delete(tabId);
  aiStates.delete(tabId);
  findStates.delete(tab.view.webContents.id);

  if (!tab.view.webContents.isDestroyed()) {
    tab.view.webContents.destroy();
  }

  if (state.tabs.size === 0) {
    state.activeTabId = null;
    createTab(state, DEFAULT_HOME, true);
    return;
  }

  if (wasActive) {
    state.activeTabId = null;
    showTab(state, pickReplacementTabId(state));
  } else {
    sendState(state);
    sendAiState(state);
  }
}

function replaceTabWithWebView(state, tab) {
  if (!['search', 'ask', 'home', 'downloads', 'settings', 'bookmarks'].includes(tab.kind)) {
    return;
  }

  const wasActive = state.activeTabId === tab.id;
  if (wasActive) {
    state.window.contentView.removeChildView(tab.view);
  }
  if (!tab.view.webContents.isDestroyed()) {
    tab.view.webContents.destroy();
  }

  tab.kind = 'web';
  tab.title = 'New Tab';
  tab.view = createWebView();
  attachTabEvents(tab);

  if (wasActive) {
    state.window.contentView.addChildView(tab.view);
    layoutViews(state);
  }
}

function navigateActive(state, input) {
  const tab = state.tabs.get(state.activeTabId);
  const classified = classifyAddressInput(input);
  if (classified.kind === 'search') {
    createSearchTab(state, true, {
      question: classified.question,
      mode: classified.mode,
      autoRun: true
    });
    return;
  }
  if (classified.kind === 'internal') {
    const kind = internalKindFromUrl(classified.url);
    createInternalTab(state, kind || 'home', true);
    return;
  }
  if (classified.kind === 'error') {
    sendError(state, classified.error);
    return;
  }

  if (tab) {
    replaceTabWithWebView(state, tab);
    tab.url = classified.url;
    tab.view.webContents.loadURL(classified.url).catch(() => {});
    sendState(state);
    sendAiState(state);
  }
}

function createChromeView(state) {
  state.uiView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      webviewTag: false
    }
  });

  state.window.contentView.addChildView(state.uiView);
  state.uiView.webContents.on('console-message', event => {
    const text = event?.message;
    if (typeof text === 'string' && text.includes(DETACH_LOG_PREFIX)) {
      logDetach(`renderer window ${state.id}`, text.replace(DETACH_LOG_PREFIX, '').trim());
    }
  });
  state.uiView.webContents.on('did-finish-load', () => {
    logDetach('chrome ready', { windowId: state.id });
    sendState(state);
  });
  state.uiView.webContents.loadFile(path.join(__dirname, 'index.html'));
}

function createSidebarView(state) {
  if (state.sidebarView && !state.sidebarView.webContents.isDestroyed()) {
    return state.sidebarView;
  }

  state.sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      webviewTag: false
    }
  });

  aiWebContentsIds.add(state.sidebarView.webContents.id);
  state.sidebarView.webContents.on('destroyed', () => {
    aiWebContentsIds.delete(state.sidebarView.webContents.id);
  });
  state.sidebarView.webContents.on('console-message', event => {
    const text = event?.message;
    if (typeof text === 'string' && text.includes(AI_LOG_PREFIX)) {
      logAi(`sidebar window ${state.id}`, text.replace(AI_LOG_PREFIX, '').trim());
    }
  });
  state.sidebarView.webContents.on('did-finish-load', () => {
    sendAiState(state);
  });
  state.sidebarView.webContents.loadURL('sovereign://ask/sidebar.html').catch(error => {
    logAi('sidebar load failed', error);
  });
  return state.sidebarView;
}

function setSidebarVisible(state, visible) {
  if (visible) {
    const sidebarView = createSidebarView(state);
    if (!state.sidebarAttached) {
      state.window.contentView.addChildView(sidebarView);
      state.sidebarAttached = true;
    }
  } else if (state.sidebarView && state.sidebarAttached) {
    state.window.contentView.removeChildView(state.sidebarView);
    state.sidebarAttached = false;
  }

  state.sidebarVisible = visible;
  layoutViews(state);
  sendState(state);
  sendAiState(state);
}

function toggleSidebar(state) {
  setSidebarVisible(state, !state.sidebarVisible);
}

function destroyWindowTabs(state) {
  for (const tab of state.tabs.values()) {
    tabOwners.delete(tab.id);
    aiStates.delete(tab.id);
    findStates.delete(tab.view.webContents.id);
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.destroy();
    }
  }

  if (state.sidebarView && !state.sidebarView.webContents.isDestroyed()) {
    aiWebContentsIds.delete(state.sidebarView.webContents.id);
    state.sidebarView.webContents.destroy();
  }

  state.tabs.clear();
  state.activeTabId = null;
}

function makeDetachedWindowBounds(sourceState, position = {}) {
  const pointer = position && typeof position === 'object' ? position : {};
  const sourceBounds = sourceState.window.getBounds();
  const width = Math.max(sourceBounds.width, 760);
  const height = Math.max(sourceBounds.height, 500);
  const fallbackX = sourceBounds.x + 32;
  const fallbackY = sourceBounds.y + 32;
  const rawX = Number.isFinite(pointer.screenX) ? pointer.screenX - 180 : fallbackX;
  const rawY = Number.isFinite(pointer.screenY) ? pointer.screenY - 28 : fallbackY;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(rawX),
    y: Math.round(rawY)
  });
  const area = display.workArea;

  return {
    x: Math.max(area.x, Math.min(Math.round(rawX), area.x + area.width - 260)),
    y: Math.max(area.y, Math.min(Math.round(rawY), area.y + area.height - 180)),
    width,
    height
  };
}

function createWindow(options = {}) {
  const state = {
    id: nextWindowId,
    window: new BaseWindow({
      width: options.width || 1200,
      height: options.height || 820,
      x: options.x,
      y: options.y,
      minWidth: 760,
      minHeight: 500,
      title: 'Sovereign',
      backgroundColor: '#f7f3ea'
    }),
    uiView: null,
    sidebarView: null,
    sidebarVisible: false,
    sidebarAttached: false,
    downloadsPanelVisible: false,
    findBarVisible: false,
    findQuery: '',
    activeTabId: null,
    tabs: new Map()
  };
  nextWindowId += 1;
  windows.set(state.id, state);
  logDetach('created window', {
    windowId: state.id,
    skipInitialTab: Boolean(options.skipInitialTab),
    bounds: {
      x: options.x,
      y: options.y,
      width: options.width || 1200,
      height: options.height || 820
    }
  });

  createChromeView(state);

  if (!options.skipInitialTab) {
    createTab(state, DEFAULT_HOME, true);
  }

  layoutViews(state);
  state.window.show();

  state.window.on('resize', () => layoutViews(state));
  state.window.on('maximize', () => layoutViews(state));
  state.window.on('unmaximize', () => layoutViews(state));
  state.window.on('closed', () => {
    destroyWindowTabs(state);
    windows.delete(state.id);
    if (!isAppQuitting) {
      scheduleSaveOpenSession();
      if (windows.size === 0 && process.platform !== 'darwin') {
        app.quit();
      }
    }
  });

  return state;
}

function moveTabToWindow(sourceState, targetState, tabId) {
  const tab = sourceState.tabs.get(tabId);
  if (!tab || sourceState.id === targetState.id) {
    logDetach('move skipped', {
      sourceWindowId: sourceState.id,
      targetWindowId: targetState.id,
      tabId,
      reason: tab ? 'same-window' : 'missing-tab'
    });
    return;
  }

  const wasActive = sourceState.activeTabId === tabId;
  logDetach('move begin', {
    sourceWindowId: sourceState.id,
    targetWindowId: targetState.id,
    wasActive,
    sourceTabCount: sourceState.tabs.size,
    targetTabCount: targetState.tabs.size,
    tab: tabDebugInfo(tab)
  });

  if (wasActive) {
    sourceState.window.contentView.removeChildView(tab.view);
  }

  sourceState.tabs.delete(tabId);
  tab.windowId = targetState.id;
  tabOwners.set(tab.id, targetState.id);
  targetState.tabs.set(tab.id, tab);

  targetState.activeTabId = null;
  showTab(targetState, tab.id);
  targetState.window.focus();
  logDetach('move attached existing WebContentsView to target', {
    sourceWindowId: sourceState.id,
    targetWindowId: targetState.id,
    sourceTabCount: sourceState.tabs.size,
    targetTabCount: targetState.tabs.size,
    tab: tabDebugInfo(tab)
  });

  if (sourceState.tabs.size === 0) {
    logDetach('source window empty after move; closing source window', {
      sourceWindowId: sourceState.id,
      movedTabId: tab.id
    });
    closeEmptyWindow(sourceState);
    return;
  }

  if (wasActive) {
    sourceState.activeTabId = null;
    showTab(sourceState, pickReplacementTabId(sourceState));
  } else {
    sendState(sourceState);
    sendAiState(sourceState);
  }
}

function detachTabToNewWindow(sourceState, tabId, position) {
  const tab = sourceState.tabs.get(tabId);
  if (!tab) {
    logDetach('detach skipped: missing tab', {
      sourceWindowId: sourceState.id,
      tabId
    });
    return;
  }

  const bounds = makeDetachedWindowBounds(sourceState, position);
  logDetach('detach requested', {
    sourceWindowId: sourceState.id,
    tabId,
    position,
    bounds,
    tab: tabDebugInfo(tab)
  });
  const targetState = createWindow({ ...bounds, skipInitialTab: true });
  moveTabToWindow(sourceState, targetState, tab.id);
}

function restoreSavedSessionWindows() {
  if (!startupSettings.continueWhereLeftOff || savedSession.windows.length === 0) {
    return false;
  }

  let restoredAny = false;
  for (const windowState of savedSession.windows) {
    const state = createWindow({
      ...(windowState.bounds || {}),
      skipInitialTab: true
    });
    for (const tabState of windowState.tabs) {
      const tab = createTab(state, tabState.url, false);
      if (tab && tabState.title) {
        tab.title = sanitizeBookmarkTitle(tabState.title);
      }
    }
    if (state.tabs.size === 0) {
      createTab(state, DEFAULT_HOME, true);
    } else {
      const activeTab = [...state.tabs.values()][windowState.activeIndex] || [...state.tabs.values()][0];
      showTab(state, activeTab.id);
    }
    restoredAny = true;
  }

  return restoredAny;
}

function showTabContextMenu(state, tabId) {
  const tab = state.tabs.get(tabId);
  if (!tab) {
    logDetach('context menu skipped: missing tab', {
      windowId: state.id,
      tabId
    });
    return;
  }

  logDetach('show context menu', {
    windowId: state.id,
    tab: tabDebugInfo(tab)
  });
  const menu = Menu.buildFromTemplate([
    {
      label: 'Move to New Window',
      click: () => detachTabToNewWindow(state, tab.id)
    }
  ]);

  menu.popup({ window: state.window });
}

function pageExtractionScript() {
  return `
(() => {
  const MAX_CHARS = ${AI_TEXT_LIMIT};
  const SKIP_SELECTOR = [
    'header',
    'nav',
    'footer',
    'aside',
    'form',
    'table',
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'input',
    'textarea',
    'select',
    'option',
    'button',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[role="navigation"]',
    '[role="search"]',
    '[hidden]',
    '[aria-hidden="true"]',
    '.infobox',
    '.sidebar',
    '.navbox',
    '.vertical-navbox',
    '.toc',
    '.metadata',
    '.ambox',
    '.hatnote',
    '.mw-editsection',
    '.reference',
    '.reflist',
    '.noprint'
  ].join(',');

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }
    const style = window.getComputedStyle(element);
    const rendered = !element.getClientRects || element.getClientRects().length > 0 || element === document.body;
    return rendered &&
      style &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0';
  }

  function shouldSkip(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) {
      return true;
    }
    if (element.closest(SKIP_SELECTOR)) {
      return true;
    }
    return !isVisible(element);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim();
  }

  const root = document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('#mw-content-text .mw-parser-output') ||
    document.querySelector('#mw-content-text') ||
    document.body ||
    document.documentElement;

  const blockSelector = [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'li',
    'blockquote',
    'dd',
    'dt',
    'figcaption'
  ].join(',');
  let blocks = Array.from(root.querySelectorAll(blockSelector));
  if (blocks.length === 0) {
    blocks = [root];
  }

  const chunks = [];
  const seen = new Set();
  let total = 0;
  let truncated = false;

  for (const block of blocks) {
    if (shouldSkip(block)) {
      continue;
    }

    const text = normalizeText(block.innerText || block.textContent);
    if (!text) {
      continue;
    }

    const dedupeKey = text.slice(0, 180);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    if (total + text.length + 1 > MAX_CHARS) {
      const remaining = MAX_CHARS - total - 1;
      if (remaining > 80) {
        chunks.push(text.slice(0, remaining));
      }
      truncated = true;
      break;
    }

    chunks.push(text);
    total += text.length + 1;
  }

  const combined = chunks.join('\\n').replace(/\\n{3,}/g, '\\n\\n').slice(0, MAX_CHARS);
  return {
    title: document.title || '',
    url: location.href,
    text: combined,
    charCount: combined.length,
    truncated
  };
})()
`;
}

async function extractActivePageText(state) {
  const tab = state?.tabs.get(state.activeTabId);
  if (!tab || tab.view.webContents.isDestroyed()) {
    throw new Error('No active page is available to summarize.');
  }

  const result = await tab.view.webContents.executeJavaScriptInIsolatedWorld(
    AI_EXTRACT_WORLD_ID,
    [{ code: pageExtractionScript(), url: 'sovereign://page-text-extractor.js' }],
    false
  );

  const text = String(result?.text || '').trim();
  if (!text) {
    throw new Error('No readable page text was found. Sovereign skips scripts, form inputs, and hidden text.');
  }

  return {
    tabId: tab.id,
    title: String(result?.title || tab.title || 'Untitled page'),
    url: String(result?.url || tab.url || ''),
    text,
    charCount: Number(result?.charCount || text.length),
    truncated: Boolean(result?.truncated),
    extractedAt: new Date().toISOString()
  };
}

function sanitizeAiPatch(patch) {
  const input = patch && typeof patch === 'object' ? patch : {};
  const clean = {};
  const allowedStatuses = new Set(['idle', 'extracting', 'loading-model', 'summarizing', 'complete', 'stopped', 'error']);

  if (allowedStatuses.has(input.status)) {
    clean.status = input.status;
  }
  if (typeof input.summary === 'string') {
    clean.summary = input.summary.slice(0, 30000);
  }
  if (typeof input.error === 'string') {
    clean.error = input.error.slice(0, 1200);
  }
  if (typeof input.generationId === 'string') {
    clean.generationId = input.generationId.slice(0, 80);
  }
  if (typeof input.summaryVersion === 'string') {
    clean.summaryVersion = input.summaryVersion.slice(0, 120);
  }
  if (typeof input.generatedAt === 'string') {
    clean.generatedAt = input.generatedAt.slice(0, 80);
  }
  if (input.promptDiagnostics && typeof input.promptDiagnostics === 'object') {
    clean.promptDiagnostics = {
      promptLength: Number.isFinite(input.promptDiagnostics.promptLength) ? input.promptDiagnostics.promptLength : null,
      sourceTextLength: Number.isFinite(input.promptDiagnostics.sourceTextLength) ? input.promptDiagnostics.sourceTextLength : null,
      sourceContainsCompactStandardLibrary: Boolean(input.promptDiagnostics.sourceContainsCompactStandardLibrary),
      promptContainsCompactStandardLibrary: Boolean(input.promptDiagnostics.promptContainsCompactStandardLibrary),
      sourceContainsExtensiveStandardLibrary: Boolean(input.promptDiagnostics.sourceContainsExtensiveStandardLibrary),
      promptContainsExtensiveStandardLibrary: Boolean(input.promptDiagnostics.promptContainsExtensiveStandardLibrary)
    };
  } else if (input.promptDiagnostics === null) {
    clean.promptDiagnostics = null;
  }
  if (input.progress && typeof input.progress === 'object') {
    clean.progress = {
      text: typeof input.progress.text === 'string' ? input.progress.text.slice(0, 240) : '',
      progress: Number.isFinite(input.progress.progress) ? input.progress.progress : null
    };
  } else if (input.progress === null) {
    clean.progress = null;
  }
  if (input.source && typeof input.source === 'object') {
    clean.source = {
      title: typeof input.source.title === 'string' ? input.source.title.slice(0, 300) : '',
      url: typeof input.source.url === 'string' ? input.source.url.slice(0, 1200) : '',
      extractedAt: typeof input.source.extractedAt === 'string' ? input.source.extractedAt.slice(0, 80) : '',
      charCount: Number.isFinite(input.source.charCount) ? input.source.charCount : null,
      truncated: Boolean(input.source.truncated)
    };
  }

  clean.modelId = activeAiModel().id;
  clean.updatedAt = new Date().toISOString();
  return clean;
}

function updateAiState(tabId, patch) {
  const current = getAiState(tabId);
  aiStates.set(tabId, {
    ...current,
    ...sanitizeAiPatch(patch)
  });
  broadcastAiState();
}

function recordAiNetwork(details) {
  let parsed;
  try {
    parsed = new URL(details.url);
  } catch {
    parsed = { origin: 'unknown', pathname: '' };
  }

  const entry = {
    at: new Date().toISOString(),
    method: details.method,
    resourceType: details.resourceType,
    origin: parsed.origin,
    path: String(parsed.pathname || '').slice(0, 140)
  };
  aiNetworkEvents.push(entry);
  while (aiNetworkEvents.length > 100) {
    aiNetworkEvents.shift();
  }
  logAi('network request from AI runtime', entry);
}

// One listener set per session (Electron allows a single onBeforeRequest listener per session).
// Layer 1 of Offline mode: every request is checked here before anything else.
function setupNetworkMonitorForSession(ses) {
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!networkMode.isOffline() || !offlineLayerOn('webrequest') || !/^https?:/i.test(details.url)) {
      callback({});
      return;
    }
    const responseHeaders = { ...details.responseHeaders };
    const key = Object.keys(responseHeaders).find(name => name.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
    responseHeaders[key] = [...(responseHeaders[key] || []), offlineConnectSrc(details.url, networkSettings.offlineAllowlist)];
    callback({ responseHeaders });
  });
  ses.webRequest.onCompleted(details => guardedDownloadRequests.delete(details.id));
  ses.webRequest.onErrorOccurred(details => guardedDownloadRequests.delete(details.id));
  ses.webRequest.onBeforeRedirect(details => recordPrivacyRedirect(details));
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (networkMode.isOffline() && offlineLayerOn('webrequest') && !networkDecision(details.url).allow) {
      recordOfflineBlocked(details);
      callback({ cancel: true });
      return;
    }
    if (aiWebContentsIds.has(details.webContentsId)) {
      recordAiNetwork(details);
      broadcastAiState();
    }
    const key = urlKey(details.url, String(details.webContentsId));
    const registered = guardedDownloadUrls.get(key);
    if (registered) {
      guardedDownloadUrls.delete(key);
      if (Date.now() - registered.created < 60000) {
        guardedDownloadRequests.set(details.id, { receiptId: registered.receiptId, hops: 0, lastUrl: details.url, webContentsId: details.webContentsId });
      }
    }
    const guard = guardedDownloadRequests.get(details.id);
    if (guard && details.url !== guard.lastUrl) {
      guard.hops += 1;
      if (guard.hops > 5) { callback({ cancel: true }); return; }
      const previousUrl = guard.lastUrl;
      (async () => {
        const parsed = checkHopUrl(details.url, { previousUrl });
        await resolvePublicAddresses(parsed.hostname, safeFetchResolve);
        const entry = {
          category: 'image', method: details.method || 'GET', url: details.url,
          whatWasSent: `media file download request – no prompt or AI output sent (redirect from ${new URL(previousUrl).host})`
        };
        if (guard.receiptId) privacyReceipts.addEntry(guard.receiptId, entry);
        else privacyReceipts.addBackgroundEntry(entry);
        guard.lastUrl = details.url;
      })().then(() => callback({}), () => callback({ cancel: true }));
      return;
    }
    recordPrivacyWebRequest(details);
    callback({});
  });
}

// ---------------------------------------------------------------------------------------------
// Offline mode. Layers (PLAN §3.2): 1 webRequest cancel, 2 proxy black-hole, 3 DNS, 4 WebRTC,
// 5 main-process code gate (assertOnline), 6 Offline connect-src CSP. Spellchecker downloads stop too.
const OFFLINE_PROXY_RULES = '127.0.0.1:9';
const networkSessions = new Set();
const pendingNetworkSessions = [];
const networkSessionQueues = new WeakMap();
const offlineProxySessions = new WeakSet();
const spellcheckerStateBeforeOffline = new WeakMap();
const offlinePausedDownloads = new Set();
let hostResolverChanged = false;

function offlineLayerOn(name) {
  return TEST_OFFLINE_LAYERS === 'all' || TEST_OFFLINE_LAYERS.split(',').includes(name);
}

function blockedLocalHostPorts() {
  const list = [];
  const searx = hostPortOf(searchSettings.endpoint);
  if (searx) list.push({ entry: searx, error: SEARXNG_ALLOWLIST_ERROR });
  if (AUDIT_PROXY_HOST_PORT) list.push({ entry: AUDIT_PROXY_HOST_PORT, error: "The audit proxy can't be allowed in Offline mode." });
  return list;
}

function networkDecision(url) {
  return offlineDecision(url, {
    allowlist: networkSettings.offlineAllowlist,
    blockedOrigins: blockedLocalHostPorts().map(item => item.entry)
  });
}

function offlineLoadMessage(url) {
  const { reason } = networkDecision(url);
  if (reason === 'local-not-allowed') {
    return "This local address isn't on your Offline allowlist. You can add it in Settings.";
  }
  if (reason === 'blocked-local-service') {
    return "Offline mode is on. This local service forwards to the internet, so it can't load.";
  }
  return "Offline mode is on, so this site can't load. Switch to Online to open it.";
}

function networkStateSnapshot() {
  return {
    mode: networkMode.mode,
    offline: networkMode.isOffline(),
    choiceMade: Boolean(networkSettings.choiceMade),
    offlineAllowlist: [...networkSettings.offlineAllowlist],
    maxAllowlist: MAX_ALLOWLIST,
    auditProxy: Boolean(AUDIT_PROXY)
  };
}

function applyLoadedNetworkState(initial, allowlist) {
  const testMode = ['offline', 'online'].includes(TEST_NETWORK_MODE) ? TEST_NETWORK_MODE : '';
  networkSettings = {
    choiceMade: Boolean(initial.choiceMade) || Boolean(testMode),
    offlineAllowlist: normalizeAllowlist(allowlist, { blockedHostPorts: blockedLocalHostPorts() })
  };
  networkMode.set(testMode || initial.mode);
}

// Blocked attempts keep the origin only (privacy-receipt.js strips path and query).
function recordOfflineBlocked(details) {
  const entry = {
    category: 'blocked',
    method: details.method || 'GET',
    url: details.url,
    resourceType: details.resourceType || ''
  };
  try {
    const target = classifyPrivacyRequest(details, contextForPrivacyRequest(details));
    if (target.action === 'receipt' && target.receiptId && privacyReceipts.getReceipt(target.receiptId)) {
      privacyReceipts.addEntry(target.receiptId, entry);
      return;
    }
  } catch {
    // Attribution is best effort; the attempt is still recorded below.
  }
  privacyReceipts.addOfflineBlockedEntry(entry);
}

// Search, media and source reading refuse before any request while Offline.
function refuseWebWhileOffline(sender, url) {
  if (!networkMode.isOffline()) return;
  if (url) recordOfflineBlocked({ url, method: 'GET', resourceType: 'app', webContentsId: sender?.id });
  throw Object.assign(new Error(WEB_OFFLINE_MESSAGE), { code: 'OFFLINE_MODE' });
}

function applySpellcheckerMode(ses, offline) {
  if (!ses || typeof ses.setSpellCheckerEnabled !== 'function') return;
  try {
    if (offline) {
      if (!spellcheckerStateBeforeOffline.has(ses)) {
        spellcheckerStateBeforeOffline.set(ses, ses.isSpellCheckerEnabled());
      }
      ses.setSpellCheckerEnabled(false);
    } else if (spellcheckerStateBeforeOffline.has(ses)) {
      ses.setSpellCheckerEnabled(spellcheckerStateBeforeOffline.get(ses));
      spellcheckerStateBeforeOffline.delete(ses);
    }
  } catch (error) {
    logAi('spellchecker mode change failed', { error: error?.message || String(error) });
  }
}

// Layer 3: Chromium's own DNS goes to an unreachable local DoH server while Offline.
function applyHostResolverMode() {
  if (typeof app.configureHostResolver !== 'function') return;
  try {
    if (networkMode.isOffline() && offlineLayerOn('proxy')) {
      app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: ['https://127.0.0.1:9/dns-query'] });
      hostResolverChanged = true;
    } else if (hostResolverChanged) {
      app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: [] });
      hostResolverChanged = false;
    }
  } catch (error) {
    logAi('host resolver mode change failed', { error: error?.message || String(error) });
  }
}

// Layer 4: no non-proxied UDP (STUN/ICE) while Offline.
function applyWebRtcPolicy(contents) {
  try {
    if (contents && !contents.isDestroyed() && typeof contents.setWebRTCIPHandlingPolicy === 'function') {
      contents.setWebRTCIPHandlingPolicy(networkMode.isOffline() ? 'disable_non_proxied_udp' : 'default');
    }
  } catch {
    // Some internal contents do not support WebRTC policy changes.
  }
}

// Layer 2 plus spellchecker for one session. Serialised per session so rapid toggles stay ordered.
function applyNetworkModeToSession(ses) {
  const previous = networkSessionQueues.get(ses) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const offline = networkMode.isOffline();
    applySpellcheckerMode(ses, offline);
    if (offline && !AUDIT_PROXY && offlineLayerOn('proxy')) {
      // Port 9 has nothing listening; loopback is bypassed implicitly by Chromium.
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: OFFLINE_PROXY_RULES, proxyBypassRules: '' });
      offlineProxySessions.add(ses);
    } else if (offlineProxySessions.has(ses)) {
      offlineProxySessions.delete(ses);
      await ses.setProxy(AUDIT_PROXY
        ? { mode: 'fixed_servers', proxyRules: AUDIT_PROXY.proxyRules, proxyBypassRules: AUDIT_PROXY_BYPASS_RULES }
        : { mode: 'system' });
    }
    if (typeof ses.closeAllConnections === 'function') {
      await ses.closeAllConnections();
    }
  }).catch(error => {
    logAi('network mode apply failed', { error: error?.message || String(error) });
  });
  networkSessionQueues.set(ses, next);
  return next;
}

function trackNetworkSession(ses) {
  if (!ses || networkSessions.has(ses)) {
    return networkSessionQueues.get(ses) || Promise.resolve();
  }
  networkSessions.add(ses);
  setupNetworkMonitorForSession(ses);
  return applyNetworkModeToSession(ses);
}

// closeAllConnections() does not close open WebSockets (verified with a probe, Electron 38), and
// neither does network emulation. Unloading the page does, so web tabs are reloaded: a blocked
// page then shows the offline message, an allowlisted local page loads again without its sockets.
function webTabsForOfflineReload() {
  const tabs = [];
  for (const state of windows.values()) {
    for (const tab of state.tabs.values()) {
      const contents = tab.view?.webContents;
      if (!contents || contents.isDestroyed()) continue;
      let url = '';
      try { url = contents.getURL(); } catch { url = ''; }
      if (/^https?:/i.test(url)) tabs.push(contents);
    }
  }
  return tabs;
}

function reloadWebTabsForOffline() {
  for (const contents of webTabsForOfflineReload()) contents.reload();
}

function pauseDownloadsForOffline() {
  for (const [id, item] of activeDownloadItems) {
    try {
      if (item.getState() === 'progressing' && !item.isPaused() && !networkDecision(item.getURL()).allow) {
        offlinePausedDownloads.add(id);
        item.pause();
        updateDownload(id, { ...downloadRecordFromItem(id, item), status: 'Paused: Offline mode', offlinePaused: true });
      }
    } catch {
      // A finished item can race with the switch; nothing to pause.
    }
  }
}

function broadcastNetworkState() {
  const snapshot = networkStateSnapshot();
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    let url = '';
    try { url = contents.getURL(); } catch { url = ''; }
    if (url.startsWith('sovereign://') || url.startsWith('file://')) {
      contents.send('network:state', snapshot);
    }
  }
  for (const state of windows.values()) {
    layoutViews(state);
    sendState(state);
  }
}

function offlineReloadTabCount() {
  return webTabsForOfflineReload().length;
}

async function setNetworkMode(next, { choice = true, requireConfirm = false, confirmed = false } = {}) {
  if (next === 'offline' && !networkMode.isOffline() && requireConfirm && !confirmed) {
    const tabCount = offlineReloadTabCount();
    if (tabCount > 0) return {
      ok: false, needsConfirm: true, tabCount,
      message: `Switching to Offline will reload ${tabCount} open website tab${tabCount === 1 ? '' : 's'}. Unsaved text in forms may be lost.`,
      state: networkStateSnapshot()
    };
  }
  if (choice) networkSettings.choiceMade = true;
  const changed = networkMode.set(next);
  if (changed) {
    // Layer 1 and the code gate block from this line on; the rest tidies up.
    const offline = networkMode.isOffline();
    privacyReceipts.setOffline(offline);
    applyHostResolverMode();
    for (const contents of webContents.getAllWebContents()) applyWebRtcPolicy(contents);
    await Promise.all([...networkSessions].map(applyNetworkModeToSession));
    if (offline) {
      for (const controller of activeSearchRequests.values()) controller.abort();
      reloadWebTabsForOffline();
      // A check that later starts downloading is caught in the worker-state handler.
      if (modelSetupState.status === 'downloading') cancelModelSetup(MODEL_OFFLINE_PAUSED_MESSAGE);
      pauseDownloadsForOffline();
    } else {
      for (const id of offlinePausedDownloads) {
        if (downloads.has(id)) updateDownload(id, { offlinePaused: false, status: 'paused' });
      }
      offlinePausedDownloads.clear();
    }
    updateModelSetupState({});
  }
  savePreferences();
  broadcastNetworkState();
  return networkStateSnapshot();
}

ipcMain.on('network:confirm-visible', (event, visible) => {
  const state = findWindowStateBySender(event.sender);
  if (!state || state.uiView.webContents !== event.sender) return;
  state.networkConfirmVisible = visible === true;
  layoutViews(state);
});

ipcMain.handle('network:get-state', () => networkStateSnapshot());

ipcMain.handle('network:set-mode', (_event, mode, options) => setNetworkMode(mode === 'online' ? 'online' : 'offline', { requireConfirm: true, confirmed: options?.confirmed === true }));

// "Stay online" and closing the strip both mean Online (asked once, PLAN §2).
ipcMain.handle('network:dismiss-intro', (_event, choice, options) => setNetworkMode(choice === 'offline' ? 'offline' : 'online', { requireConfirm: true, confirmed: options?.confirmed === true }));

ipcMain.handle('network:add-allowed', (_event, text) => {
  const parsed = parseAllowlistEntry(text, { blockedHostPorts: blockedLocalHostPorts() });
  if (!parsed.ok) return { ok: false, error: parsed.error, state: networkStateSnapshot() };
  if (networkSettings.offlineAllowlist.includes(parsed.entry)) {
    return { ok: false, error: 'That address is already on the list.', state: networkStateSnapshot() };
  }
  if (networkSettings.offlineAllowlist.length >= MAX_ALLOWLIST) {
    return { ok: false, error: `You can allow at most ${MAX_ALLOWLIST} local addresses.`, state: networkStateSnapshot() };
  }
  networkSettings.offlineAllowlist = [...networkSettings.offlineAllowlist, parsed.entry];
  savePreferences();
  broadcastNetworkState();
  return { ok: true, entry: parsed.entry, state: networkStateSnapshot() };
});

ipcMain.handle('network:remove-allowed', async (_event, entry) => {
  const value = String(entry || '');
  networkSettings.offlineAllowlist = networkSettings.offlineAllowlist.filter(item => item !== value);
  savePreferences();
  if (networkMode.isOffline()) {
    await Promise.all([...networkSessions].map(applyNetworkModeToSession));
  }
  broadcastNetworkState();
  return { ok: true, state: networkStateSnapshot() };
});

// Test-only: answer website permission prompts without a native dialog ('allow' or 'deny').
const PERMISSION_TEST_ANSWER = ['allow', 'deny'].includes(process.env.SOVEREIGN_PERMISSION_TEST_ANSWER)
  ? process.env.SOVEREIGN_PERMISSION_TEST_ANSWER
  : '';
const permissionSessions = new WeakSet();

function permissionPromptWindow(contents) {
  const { state } = findTabByWebContentsId(contents?.id);
  if (state?.window && !state.window.isDestroyed()) {
    return state.window;
  }
  const owner = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
  return owner || BrowserWindow.getFocusedWindow() || null;
}

async function promptForWebsitePermission({ webContents: contents, message, detail }) {
  if (PERMISSION_TEST_ANSWER) {
    return PERMISSION_TEST_ANSWER;
  }
  const options = {
    type: 'question',
    title: 'Website permission',
    message,
    detail,
    buttons: ['Deny', 'Allow once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const parent = permissionPromptWindow(contents);
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === 1 ? 'allow' : 'deny';
}

const permissionController = createPermissionController({
  prompt: promptForWebsitePermission,
  record: entry => privacyReceipts.addPermissionEntry(entry)
});

function lastFunctionArgument(args) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === 'function') {
      return args[index];
    }
  }
  return null;
}

function contentsFromFrame(frame) {
  try {
    return frame ? webContents.fromFrame(frame) : null;
  } catch {
    return null;
  }
}

function setupPermissionHandling(targetSession) {
  if (!targetSession || permissionSessions.has(targetSession)) {
    return;
  }
  permissionSessions.add(targetSession);
  targetSession.setPermissionRequestHandler(permissionController.request);
  targetSession.setPermissionCheckHandler(permissionController.check);
  targetSession.setDevicePermissionHandler(() => false);
  for (const eventName of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
    targetSession.on(eventName, (event, ...args) => {
      event.preventDefault();
      const contents = args.find(arg => arg && typeof arg.getURL === 'function') || contentsFromFrame(args[0]?.frame);
      permissionController.recordAutoDenied(contents, eventName.replace('select-', '').replace('-device', '').replace('-port', ''));
      const callback = lastFunctionArgument(args);
      if (callback) {
        callback('');
      }
    });
  }
  targetSession.setDisplayMediaRequestHandler((request, callback) => {
    permissionController.recordAutoDenied(contentsFromFrame(request?.frame), 'screen capture');
    try {
      callback({});
    } catch {
      // Declining without a stream is enough to reject getDisplayMedia().
    }
  });
}

// Electron picks the first Bluetooth device automatically unless this event is handled.
app.on('web-contents-created', (_event, contents) => {
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    permissionController.recordAutoDenied(contents, 'bluetooth');
    callback('');
  });
});

app.on('session-created', ses => {
  setupPermissionHandling(ses);
  // Spellchecker first, synchronously, so no dictionary download starts while Offline.
  if (networkMode.isOffline()) applySpellcheckerMode(ses, true);
  if (app.isReady()) trackNetworkSession(ses);
  else pendingNetworkSessions.push(ses);
});

async function runDatasetCollection() {
  const { collectDataset, expandPath } = require('./dataset-collection');
  const outputPath = expandPath(process.env.SOVEREIGN_DATASET_OUT || '~/sovereign-finetune/data/collected.jsonl');
  datasetWindow = new BrowserWindow({
    width: 560, height: 240, title: 'Dataset collection',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  datasetWindow.on('closed', () => {
    for (const controller of activeSearchRequests.values()) controller.abort();
    app.quit();
  });
  try {
    await datasetWindow.loadFile(path.join(__dirname, 'dataset-collection.html'));
    const event = { sender: datasetWindow.webContents };
    let datasetSearchId = '';
    let datasetSearchGrant = null;
    await collectDataset({
      questionsPath: expandPath(process.env.SOVEREIGN_DATASET_BATCH),
      outputPath,
      query: async request => {
        const result = await handleSearchQuery(event, { ...request, endpoint: searchSettings.endpoint });
        datasetSearchId = request.requestId;
        datasetSearchGrant = allowedSearchRequests.get(datasetSearchId);
        return result;
      },
      readSources: request => {
        // Trusted batch retries may reuse only the original search's URLs and expiry.
        if (datasetSearchGrant) allowedSearchRequests.set(datasetSearchId, datasetSearchGrant);
        return handleReadSources(event, { ...request, requestId: datasetSearchId });
      },
      onProgress: async (done, total) => {
        const label = `Dataset collection — ${done} / ${total}`;
        console.log(label);
        if (!datasetWindow.isDestroyed()) {
          datasetWindow.setTitle(label);
          await datasetWindow.webContents.executeJavaScript(`document.getElementById('progress').textContent = ${JSON.stringify(`${done} / ${total}`)}`);
        }
      }
    });
  } catch (error) {
    console.error('Dataset collection stopped:', error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.setName('Sovereign');
  setupPermissionHandling(session.defaultSession);
  loadPreferences();
  await setupAuditProxyForSession(session.defaultSession);
  privacyReceipts.setOffline(networkMode.isOffline());
  applyHostResolverMode();
  await trackNetworkSession(session.defaultSession);
  await Promise.all(pendingNetworkSessions.splice(0).map(trackNetworkSession));
  setupInternalProtocol();
  setupApplicationMenu();
  setupDownloadHandling();
  ensureFindQueueTimer();
  if (datasetBatchEnabled) {
    await runDatasetCollection();
    return;
  }
  ensureModelSetupService({ autoStart: true });
  if (!restoreSavedSessionWindows()) {
    createWindow();
  }
  finishPendingLegacyChatDelete();

  app.on('activate', () => {
    if (windows.size === 0) {
      createWindow();
    }
  });
});

app.on('web-contents-created', (_event, contents) => {
  setupAuditProxyForSession(contents.session);
  setupDownloadHandlingForSession(contents.session);
  trackNetworkSession(contents.session);
  applyWebRtcPolicy(contents);
  contents.on('will-attach-webview', event => {
    event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (!hasSingleInstanceLock) return;
  isAppQuitting = true;
  if (saveSessionTimer) {
    clearTimeout(saveSessionTimer);
    saveSessionTimer = null;
  }
  for (const id of pendingChatConsents.keys()) discardPendingChat(id);
  saveOpenSessionNow();
  destroyModelSetupWindow();
});

ipcMain.handle('browser:get-state', event => {
  const state = findWindowStateBySender(event.sender);
  return windowSnapshot(state);
});

ipcMain.on('browser:new-tab', (event, url) => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    createTab(state, url || DEFAULT_HOME, true);
  }
});

ipcMain.on('browser:open-search', (event, payload) => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    if (state.sidebarVisible) {
      setSidebarVisible(state, false);
    }
    const input = payload && typeof payload === 'object' ? payload : { question: payload };
    if (input.navigateIfAddress === true && !input.handoffId) {
      const classified = classifyAddressInput(input.question);
      if (classified.kind !== 'search') {
        navigateActive(state, input.question);
        return;
      }
    }
    if (input.mode === 'ask') {
      createInternalTab(state, 'ask', true, {
        question: input.question,
        autoRun: Boolean(input.autoRun),
        handoffId: input.handoffId
      });
    } else {
      createSearchTab(state, true, {
        question: input.question,
        autoRun: Boolean(input.autoRun)
      });
    }
  }
});

ipcMain.on('browser:open-downloads', event => {
  openInternalPage(findWindowStateBySender(event.sender), 'downloads');
});

ipcMain.on('browser:set-downloads-panel-visible', (event, visible) => {
  setDownloadsPanelVisible(findWindowStateBySender(event.sender), visible);
});

ipcMain.on('browser:toggle-downloads-panel', event => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    setDownloadsPanelVisible(state, !state.downloadsPanelVisible);
  }
});

ipcMain.on('browser:open-settings', event => {
  openInternalPage(findWindowStateBySender(event.sender), 'settings');
});

ipcMain.on('browser:open-bookmarks', event => {
  openInternalPage(findWindowStateBySender(event.sender), 'bookmarks');
});

ipcMain.handle('browser:toggle-bookmark', event => {
  const state = findWindowStateBySender(event.sender);
  if (!state) {
    throw new Error('Sovereign could not identify the current browser window.');
  }
  return toggleBookmarkForActiveTab(state);
});

ipcMain.handle('browser:copy-text', (_event, text) => {
  clipboard.writeText(String(text || '').slice(0, 50000));
  return true;
});

ipcMain.on('browser:reopen-closed-tab', event => {
  reopenClosedTab(findWindowStateBySender(event.sender));
});

ipcMain.on('browser:set-find-bar-visible', (event, visible) => {
  setFindBarVisible(findWindowStateBySender(event.sender), visible);
});

ipcMain.on('browser:find-in-page', (event, query) => {
  runFindInActiveTab(findWindowStateBySender(event.sender), query, { findNext: false });
});

ipcMain.on('browser:find-next', (event, query) => {
  runFindInActiveTab(findWindowStateBySender(event.sender), query, {
    findNext: true,
    forward: true
  });
});

ipcMain.on('browser:find-previous', (event, query) => {
  runFindInActiveTab(findWindowStateBySender(event.sender), query, {
    findNext: true,
    forward: false
  });
});

ipcMain.on('browser:stop-find', event => {
  const state = findWindowStateBySender(event.sender);
  const tab = state?.tabs.get(state.activeTabId);
  clearFindSelection(tab);
});

ipcMain.on('browser:switch-tab', (event, tabId) => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    showTab(state, Number(tabId));
  }
});

ipcMain.on('browser:close-tab', (event, tabId) => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    closeTab(state, Number(tabId));
  }
});

ipcMain.on('browser:detach-tab', (event, tabId, position) => {
  const state = findWindowStateBySender(event.sender);
  logDetach('ipc browser:detach-tab', {
    foundWindow: Boolean(state),
    windowId: state?.id,
    tabId,
    position
  });
  if (state) {
    detachTabToNewWindow(state, Number(tabId), position);
  }
});

ipcMain.on('browser:show-tab-menu', (event, tabId) => {
  const state = findWindowStateBySender(event.sender);
  logDetach('ipc browser:show-tab-menu', {
    foundWindow: Boolean(state),
    windowId: state?.id,
    tabId
  });
  if (state) {
    showTabContextMenu(state, Number(tabId));
  }
});

ipcMain.on('browser:toggle-sidebar', event => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    toggleSidebar(state);
  }
});

ipcMain.on('browser:navigate', (event, input) => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    navigateActive(state, input);
  }
});

ipcMain.on('browser:back', event => {
  const state = findWindowStateBySender(event.sender);
  const tab = state?.tabs.get(state.activeTabId);
  const history = tab?.view.webContents.navigationHistory;
  if (history?.canGoBack()) {
    history.goBack();
  }
});

ipcMain.on('browser:forward', event => {
  const state = findWindowStateBySender(event.sender);
  const tab = state?.tabs.get(state.activeTabId);
  const history = tab?.view.webContents.navigationHistory;
  if (history?.canGoForward()) {
    history.goForward();
  }
});

ipcMain.on('browser:reload', event => {
  const state = findWindowStateBySender(event.sender);
  const tab = state?.tabs.get(state.activeTabId);
  if (tab) {
    tab.view.webContents.reload();
  }
});

ipcMain.handle('ai:get-state', event => {
  const state = findWindowStateBySender(event.sender);
  return aiSnapshot(state);
});

ipcMain.handle('ai:extract-active-page-text', async event => {
  const state = findWindowStateBySender(event.sender);
  if (!state) {
    throw new Error('Sovereign could not identify the current browser window.');
  }

  return extractActivePageText(state);
});

ipcMain.on('ai:update-tab-state', (_event, tabId, patch) => {
  const numericTabId = Number(tabId);
  if (tabOwners.has(numericTabId) || aiStates.has(numericTabId)) {
    updateAiState(numericTabId, patch);
  }
});

ipcMain.handle('ai:get-network-log', () => aiNetworkEvents.slice(-100));

ipcMain.handle('privacy:get-settings', () => ({ ...privacySettings }));
ipcMain.handle('privacy:update-settings', (_event, patch) => {
  if (['strict', 'standard'].includes(patch?.sensitiveTopics)) {
    privacySettings = { sensitiveTopics: patch.sensitiveTopics };
    savePreferences();
    for (const state of windows.values()) for (const tab of state.tabs.values()) {
      if (['ask', 'search', 'settings'].includes(tab.kind) && !tab.view.webContents.isDestroyed()) tab.view.webContents.send('privacy:settings', { ...privacySettings });
    }
  }
  return { ...privacySettings };
});

ipcMain.handle('privacy:get-latest-receipt', () => privacyReceipts.getLatestReceipt());

ipcMain.handle('privacy:get-receipts', () => privacyReceipts.getReceipts());

ipcMain.handle('privacy:start-activity', (event, request) => {
  const { tab } = findTabBySender(event.sender);
  if (!tab || !['ask', 'search'].includes(tab.kind)) {
    throw new Error('Privacy receipts can only be started from Sovereign Search and Ask AI tabs.');
  }
  const input = request && typeof request === 'object' ? request : {};
  const receiptId = String(input.requestId || '').slice(0, 100);
  if (!receiptId) {
    throw new Error('Privacy receipt activity is missing an id.');
  }
  const receiptType = input.type === 'search' ? 'search' : 'ask';
  const receipt = privacyReceipts.createReceipt({
    id: receiptId,
    type: receiptType,
    label: input.purpose === 'saved-chat-media' ? 'Saved chat image previews' : receiptType === 'ask' ? 'Ask AI' : 'Search',
    query: input.crisis ? '' : String(input.query || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    localOnly: Boolean(input.localOnly),
    chatId: input.chatId,
    crisis: input.crisis === true
  });
  assignPrivacyReceiptToSender(event.sender, receipt.id);
  if (input.purpose === 'saved-chat-media' && Array.isArray(input.thumbnailUrls)) {
    const saved = chatStore().list().find(chat => chat.id === input.chatId);
    if (saved) rememberAllowedSearch(event.sender, receiptId, saved.messages.flatMap(message => message.mediaResults || []), true);
    for (const url of input.thumbnailUrls.filter(value => typeof value === 'string').slice(0, 200)) {
      thumbnailReceipts.remember(urlKey(url, String(event.sender.id)), receipt.id);
    }
  }
  return receipt;
});

ipcMain.handle('privacy:export-receipts', async event => {
  const state = findWindowStateBySender(event.sender);
  const defaultPath = path.join(
    app.getPath('downloads'),
    `sovereign-privacy-receipts-${new Date().toISOString().slice(0, 10)}.json`
  );
  const dialogOptions = {
    title: 'Export Privacy Receipts',
    defaultPath,
    buttonLabel: 'Export',
    filters: [
      { name: 'JSON', extensions: ['json'] }
    ]
  };
  const result = state?.window && !state.window.isDestroyed()
    ? await dialog.showSaveDialog(state.window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }

  const payload = privacyReceipts.exportPayload({
    appVersion: packageMetadata.version || app.getVersion()
  });
  payload.debug = {
    unattributedRequestsSkipped: unattributedPrivacyRequestSkips,
    ignoredSchemes: [...PRIVACY_RECEIPT_IGNORED_SCHEMES]
  };
  fs.writeFileSync(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    path: result.filePath,
    receiptCount: payload.receipts.length
  };
});

ipcMain.handle('model-setup:get-state', () => modelSetupSnapshot());

ipcMain.handle('model-setup:start', () => ensureModelSetupService({ forceStart: true }));

ipcMain.handle('model-setup:cancel', () => cancelModelSetup());

ipcMain.handle('model-setup:update-settings', (_event, patch) => updateAiSettings(patch));

ipcMain.on('model-setup:worker-ready', event => {
  if (!isModelSetupSender(event.sender)) {
    return;
  }
  modelSetupReady = true;
  if (modelSetupPendingCommand) {
    event.sender.send('model-setup:command', modelSetupPendingCommand);
  }
});

ipcMain.on('model-setup:worker-state', (event, patch) => {
  if (!isModelSetupSender(event.sender)) {
    return;
  }
  const snapshot = updateModelSetupState(patch);
  if (snapshot.status === 'downloading' && networkMode.isOffline()) {
    cancelModelSetup(MODEL_OFFLINE_PAUSED_MESSAGE);
    return;
  }
  if (snapshot.status === 'ready') {
    aiSettings.setupCanceled = false;
    savePreferences();
  }
});

ipcMain.handle('search:get-settings', () => ({
  settings: searchSettingsSnapshot(),
  activity: searchActivityEvents.slice(-30)
}));

ipcMain.handle('search:update-settings', (_event, patch) => {
  const input = patch && typeof patch === 'object' ? patch : {};
  if (typeof input.endpoint === 'string') {
    searchSettings = {
      ...searchSettings,
      endpoint: normalizeSearxngEndpoint(input.endpoint)
    };
    // SearXNG forwards to the internet, so it can never stay on the Offline allowlist.
    const searxHostPort = hostPortOf(searchSettings.endpoint);
    const removedOfflineAllowlistEntry = networkSettings.offlineAllowlist.includes(searxHostPort) ? searxHostPort : '';
    if (removedOfflineAllowlistEntry) {
      networkSettings.offlineAllowlist = networkSettings.offlineAllowlist.filter(entry => entry !== searxHostPort);
    }
    savePreferences();
    if (removedOfflineAllowlistEntry) {
      broadcastNetworkState();
      return { ...searchSettingsSnapshot(), removedOfflineAllowlistEntry };
    }
  }

  return searchSettingsSnapshot();
});

// Adds the upstream engines SearXNG reported to the receipt. Never fails the search.
function recordSearxngForwardingSafely(receiptId, result) {
  try {
    privacyReceipts.recordSearxngForwarding(receiptId, {
      url: result?.endpoint || '',
      engines: result?.upstreamEngines || []
    });
  } catch (error) {
    console.warn('Could not record SearXNG forwarding in the privacy receipt:', error?.message || error);
  }
}

// Grants are scoped to the sender, bounded and expire; reading consumes a grant.
const allowedSearchRequests = new Map();
const allowedMediaUrls = new Map();
function rememberAllowedSearch(sender, requestId, results, media = false) {
  const now = Date.now();
  for (const [key, grant] of allowedSearchRequests) if (grant.expires <= now) allowedSearchRequests.delete(key);
  for (const [key, grant] of allowedMediaUrls) if (grant.expires <= now) allowedMediaUrls.delete(key);
  const expires = now + 5 * 60 * 1000;
  allowedSearchRequests.set(requestId, { senderId: sender.id, expires, urls: new Set((results || []).map(item => item.url)) });
  if (media) for (const item of results || []) for (const url of [item.mediaUrl, item.originalMediaUrl, item.thumbnailUrl, item.downloadUrl]) {
    if (url) allowedMediaUrls.set(urlKey(url, String(sender.id)), { expires, senderId: sender.id });
  }
  while (allowedSearchRequests.size > 100) allowedSearchRequests.delete(allowedSearchRequests.keys().next().value);
  while (allowedMediaUrls.size > 1000) allowedMediaUrls.delete(allowedMediaUrls.keys().next().value);
}
function requireAllowedMedia(sender, url) {
  const grant = allowedMediaUrls.get(urlKey(url, String(sender.id)));
  if (!grant || grant.expires <= Date.now()) throw new Error('Media request requires an allowed search.');
}
function sensitiveGate(sender, text, options = {}) {
  const result = sensitiveGuard.classifyQuestion(text, { strictness: privacySettings.sensitiveTopics });
  if (options.crisisOnly && result.level !== 'crisis') return { ok: true };
  const modelFlag = Object.hasOwn(sensitiveGuard.LABELS, options.modelFlag) && !['self-harm', 'harm-to-others', 'abuse'].includes(options.modelFlag) ? options.modelFlag : '';
  if (result.level !== 'crisis' && modelFlag && !result.categories.includes(modelFlag)) {
    result.level = 'sensitive';
    result.categories = Object.keys(sensitiveGuard.LABELS).filter(category => category === modelFlag || result.categories.includes(category));
  }
  const query = options.override === true ? sensitiveGuard.removeIdentifiers(text).text : String(text || '').replace(/\s+/g, ' ').trim();
  if (result.level === 'crisis' || (result.level === 'sensitive' && options.override !== true)) {
    // Do not reuse caller ids: an earlier receipt may already contain query text.
    const receipt = privacyReceipts.createReceipt({ type: findTabBySender(sender).tab?.kind === 'search' ? 'search' : 'ask', label: 'Sensitive topic', query: '', chatId: options.chatId, crisis: result.level === 'crisis', localOnly: true });
    if (result.level !== 'crisis') privacyReceipts.addEntry(receipt.id, {
      category: 'sensitive', topic: sensitiveGuard.categoryLabels(result.categories),
      url: options.endpoint || searchSettings.endpoint
    });
    assignPrivacyReceiptToSender(sender, receipt.id);
    return { ok: false, sensitive: true, ...result, modelFlag: Boolean(modelFlag), suggestedQuery: sensitiveGuard.removeIdentifiers(text).text };
  }
  return { ok: true, query, sensitiveOverride: options.override === true };
}

async function handleSearchQuery(event, request) {
  const tab = datasetWindow && event.sender === datasetWindow.webContents
    ? { kind: 'ask' }
    : findTabBySender(event.sender).tab;
  if (!tab || !['search', 'ask'].includes(tab.kind)) {
    throw new Error('Search requests are only available from Sovereign Search and Ask AI tabs.');
  }

  const input = request && typeof request === 'object' ? request : {};
  const crisis = sensitiveGate(event.sender, input.query, { ...input, crisisOnly: true });
  if (!crisis.ok) return crisis;
  const requestId = String(input.requestId || '').slice(0, 80);
  if (!requestId) {
    throw new Error('Search request is missing an id.');
  }
  if (activeSearchRequests.has(requestId)) {
    throw new Error('That search request is already running.');
  }

  const endpoint = normalizeSearxngEndpoint(input.endpoint || searchSettings.endpoint);
  refuseWebWhileOffline(event.sender, endpoint);
  allowedSearchRequests.delete(requestId);
  const gate = sensitiveGate(event.sender, input.query, input);
  if (!gate.ok) return gate;
  searchSettings.endpoint = endpoint;
  const controller = new AbortController();
  activeSearchRequests.set(requestId, controller);

  let query = '';
  try {
    query = gate.query;
    const receipt = privacyReceipts.createReceipt({
      id: requestId,
      type: tab.kind === 'ask' ? 'ask' : 'search',
      label: tab.kind === 'ask' ? 'Ask AI web retrieval' : 'Search',
      chatId: input.chatId, sensitiveOverride: gate.sensitiveOverride,
      query
    });
    assignPrivacyReceiptToSender(event.sender, receipt.id);
    pushSearchActivity(requestActivityEntry({ endpoint, query, status: 'started' }));
    const result = await searchSearxng({
      query,
      endpoint,
      signal: controller.signal,
      fetchImpl: makeReceiptFetch(receipt.id, 'search', `${gate.sensitiveOverride ? 'Search query (sent after a sensitive-topic warning, chosen by you)' : 'Search query'}: ${query}`)
    });
    rememberAllowedSearch(event.sender, requestId, result.results);
    recordSearxngForwardingSafely(receipt.id, result);
    pushSearchActivity(requestActivityEntry({
      endpoint,
      query: result.query,
      status: 'complete',
      resultCount: result.results.length,
      durationMs: result.durationMs
    }));
    return {
      ...result,
      activity: searchActivityEvents.slice(-30)
    };
  } catch (error) {
    const status = error?.name === 'AbortError' ? 'canceled' : 'error';
    pushSearchActivity(requestActivityEntry({
      endpoint,
      query,
      status,
      error: error?.message || String(error)
    }));
    throw error;
  } finally {
    activeSearchRequests.delete(requestId);
  }
}
ipcMain.handle('search:query', handleSearchQuery);

async function handleMediaSearch(event, request) {
  const { tab } = findTabBySender(event.sender);
  if (!tab || !['search', 'ask'].includes(tab.kind)) {
    throw new Error('Media search is only available from Sovereign Search and Ask AI tabs.');
  }

  const input = request && typeof request === 'object' ? request : {};
  const crisis = sensitiveGate(event.sender, input.query, { ...input, crisisOnly: true });
  if (!crisis.ok) return crisis;
  refuseWebWhileOffline(event.sender, searchSettings.endpoint);
  const requestId = String(input.requestId || '').slice(0, 80);
  if (!requestId) {
    throw new Error('Media search request is missing an id.');
  }
  if (activeSearchRequests.has(requestId)) {
    throw new Error('That media search request is already running.');
  }

  allowedSearchRequests.delete(requestId);
  const gate = sensitiveGate(event.sender, input.query, input);
  if (!gate.ok) return gate;
  const controller = new AbortController();
  activeSearchRequests.set(requestId, controller);
  const category = input.type === 'videos' ? 'videos' : 'images';

  try {
    const query = gate.query;
    const receipt = privacyReceipts.createReceipt({
      id: requestId,
      type: tab.kind === 'ask' ? 'ask' : 'search',
      label: category === 'videos' ? 'Media video retrieval' : 'Media image retrieval',
      query, chatId: input.chatId, sensitiveOverride: gate.sensitiveOverride
    });
    assignPrivacyReceiptToSender(event.sender, receipt.id);
    const fixtureResult = mediaFixtureResults(query, category);
    if (fixtureResult) {
      rememberAllowedSearch(event.sender, requestId, fixtureResult.results, true);
      for (const item of fixtureResult.results) {
        if (item.thumbnailUrl) thumbnailReceipts.remember(urlKey(item.thumbnailUrl, String(event.sender.id)), receipt.id);
      }
      pushSearchActivity(requestActivityEntry({
        endpoint: fixtureResult.endpoint,
        query: fixtureResult.query,
        status: `${category}-media-complete`,
        resultCount: fixtureResult.results.length,
        durationMs: fixtureResult.durationMs
      }));
      return {
        ...fixtureResult,
        activity: searchActivityEvents.slice(-30)
      };
    }
    const result = await searchSearxngMedia({
      query,
      type: category,
      endpoint: input.endpoint || searchSettings.endpoint,
      signal: controller.signal,
      fetchImpl: makeReceiptFetch(receipt.id, 'search', `${gate.sensitiveOverride ? 'Search query (sent after a sensitive-topic warning, chosen by you)' : 'Media search query'}: ${query}`)
    });
    rememberAllowedSearch(event.sender, requestId, result.results, true);
    for (const item of result.results) {
      if (item.thumbnailUrl) thumbnailReceipts.remember(urlKey(item.thumbnailUrl, String(event.sender.id)), receipt.id);
    }
    recordSearxngForwardingSafely(receipt.id, result);
    pushSearchActivity(requestActivityEntry({
      endpoint: result.endpoint,
      query: result.query,
      status: `${category}-media-complete`,
      resultCount: result.results.length,
      durationMs: result.durationMs
    }));
    return {
      ...result,
      activity: searchActivityEvents.slice(-30)
    };
  } catch (error) {
    if (error?.name !== 'AbortError') {
      pushSearchActivity(requestActivityEntry({
        endpoint: input.endpoint || searchSettings.endpoint,
        query: gate.query,
        status: `${category}-media-error`,
        error: error?.message || String(error)
      }));
    }
    throw error;
  } finally {
    activeSearchRequests.delete(requestId);
  }
}
ipcMain.handle('search:media', handleMediaSearch);

ipcMain.handle('media:preflight', async (event, request) => {
  const { tab } = findTabBySender(event.sender);
  if (!tab || !['ask', 'search'].includes(tab.kind)) {
    throw new Error('Media validation is only available from Sovereign internal pages.');
  }
  const input = request && typeof request === 'object' ? request : {};
  refuseWebWhileOffline(event.sender, input.url);
  requireAllowedMedia(event.sender, input.url);
  const mediaType = input.type === 'videos' ? 'videos' : 'images';
  const receiptId = privacyReceiptIdForSender(event.sender);
  const checked = await preflightMediaUrlForRequest(input.url, mediaType, event.sender.session, receiptId
    ? {
        receiptId,
        category: 'image',
        whatWasSent: 'media validation request – no query, prompt, or AI output sent'
      }
    : null);
  if (checked.url) allowedMediaUrls.set(urlKey(checked.url, String(event.sender.id)), { expires: Date.now() + 5 * 60 * 1000, senderId: event.sender.id });
  return checked;
});

ipcMain.handle('media:download', async (event, request) => {
  const { tab } = findTabBySender(event.sender);
  if (!tab || !['ask', 'search'].includes(tab.kind)) {
    throw new Error('Media downloads are only available from Sovereign internal pages.');
  }
  const input = request && typeof request === 'object' ? request : {};
  refuseWebWhileOffline(event.sender, input.url);
  requireAllowedMedia(event.sender, input.url);
  const mediaType = input.type === 'videos' ? 'videos' : 'images';
  const receiptId = privacyReceiptIdForSender(event.sender);
  const checked = await preflightMediaUrlForRequest(input.url, mediaType, event.sender.session, receiptId
    ? {
        receiptId,
        category: 'image',
        whatWasSent: 'media download validation request – no query, prompt, or AI output sent'
      }
    : null);
  if (MEDIA_TEST_FIXTURES) {
    return {
      ok: true,
      url: checked.url,
      mediaType,
      items: downloadsSnapshot()
    };
  }
  setupDownloadHandlingForSession(event.sender.session);
  if (receiptId) {
    privacyReceipts.addEntry(receiptId, {
      category: 'image',
      method: 'GET',
      url: checked.url,
      whatWasSent: 'media file download request – no prompt or AI output sent'
    });
  }
  queueDownloadIntent(event.sender.id, checked.url, {
    forceAsk: false,
    suggestedFilename: filenameFromUrl(checked.url, mediaType === 'videos' ? 'video' : 'image', checked.contentType),
    ownerWindowId: null,
    ownerTabId: null,
    title: mediaType === 'videos' ? 'Save Video' : 'Save Image'
  });
  const guardKey = urlKey(checked.url, String(event.sender.id));
  const guard = { receiptId, created: Date.now() };
  guardedDownloadUrls.set(guardKey, guard);
  setTimeout(() => {
    if (guardedDownloadUrls.get(guardKey) === guard) guardedDownloadUrls.delete(guardKey);
  }, 60000).unref();
  event.sender.downloadURL(checked.url);
  return downloadsSnapshot();
});

async function handleReadSources(event, request) {
  const tab = datasetWindow && event.sender === datasetWindow.webContents
    ? { kind: 'ask' }
    : findTabBySender(event.sender).tab;
  if (!tab || !['search', 'ask'].includes(tab.kind)) {
    throw new Error('Source reading is only available from Sovereign Search and Ask AI tabs.');
  }

  const input = request && typeof request === 'object' ? request : {};
  const crisis = sensitiveGate(event.sender, input.question, { ...input, crisisOnly: true });
  if (!crisis.ok) return crisis;
  refuseWebWhileOffline(event.sender, '');
  const requestId = String(input.requestId || '').slice(0, 80);
  if (!requestId) {
    throw new Error('Source reading request is missing an id.');
  }
  if (activeSearchRequests.has(requestId)) {
    throw new Error('That source reading request is already running.');
  }

  const grant = allowedSearchRequests.get(requestId);
  if (!grant || grant.senderId !== event.sender.id || grant.expires <= Date.now()) throw new Error('Source reading requires an allowed search.');
  if (!Array.isArray(input.results) || input.results.some(item => !grant.urls.has(item.url))) throw new Error('Source URL was not returned by the allowed search.');
  allowedSearchRequests.delete(requestId);
  const controller = new AbortController();
  activeSearchRequests.set(requestId, controller);

  try {
    const question = String(input.question || '').replace(/\s+/g, ' ').trim();
    const existingReceiptId = privacyReceiptIdForSender(event.sender);
    const receipt = existingReceiptId === requestId
      ? { id: requestId }
      : privacyReceipts.createReceipt({
          id: requestId,
          type: tab.kind === 'ask' ? 'ask' : 'search',
          label: 'Read sources',
          query: '', chatId: input.chatId
        });
    assignPrivacyReceiptToSender(event.sender, receipt.id);
    return {
      ...(await readSourcePages({
        question: input.question,
        results: input.results,
        signal: controller.signal,
        onActivity: entry => pushSearchActivity(entry),
        fetchImpl: (url, options) => gatedSafeFetch(url, {
          ...options,
          onHop: hop => privacyReceipts.addEntry(receipt.id, {
            category: 'source-page', method: 'GET', url: hop.url,
            whatWasSent: `page fetch – no query or AI output sent${hop.index ? ` (redirect from ${hop.fromHost})` : ''}`
          })
        })
      })),
      activity: searchActivityEvents.slice(-30)
    };
  } catch (error) {
    if (error?.name !== 'AbortError') {
      pushSearchActivity({
        kind: 'source',
        at: new Date().toISOString(),
        endpoint: 'source pages',
        method: 'GET',
        status: 'source-error',
        error: error?.message || String(error)
      });
    }
    throw error;
  } finally {
    activeSearchRequests.delete(requestId);
  }
}
ipcMain.handle('search:read-sources', handleReadSources);

ipcMain.on('search:cancel', (event, requestId) => {
  const id = String(requestId || '').slice(0, 80);
  if (allowedSearchRequests.get(id)?.senderId === event.sender.id) allowedSearchRequests.delete(id);
  activeSearchRequests.get(id)?.abort();
});

ipcMain.handle('settings:get', () => ({
  search: searchSettingsSnapshot(),
  model: activeAiModel(),
  models: AI_MODELS,
  modelSetup: modelSetupSnapshot(),
  ai: aiSettingsSnapshot(),
  downloads: downloadSettingsSnapshot(),
  startup: startupSettingsSnapshot()
}));

ipcMain.handle('settings:update-downloads', (_event, patch) => updateDownloadSettings(patch));

ipcMain.handle('settings:update-startup', (_event, patch) => updateStartupSettings(patch));

ipcMain.handle('settings:update-ai', (_event, patch) => updateAiSettings(patch));

// Saved Ask AI chats: one file in the user-data folder, owned by the main process.
// Local file I/O only; no network request, so nothing to add to the Privacy Receipt.
let savedChatStore = null;
const pendingChatConsents = new Map();
const consentWatchers = new WeakSet();
function discardPendingChat(id) {
  chatStore().remove(id);
  privacyReceipts.deleteReceipts(receipt => receipt.chatId === id);
  pendingChatConsents.delete(id);
}

ipcMain.handle('chats:pending-consent', (event, id) => {
  chatSenderTab(event, ['ask']);
  if (typeof id !== 'string' || !id || id.length > 100) return { ok: false };
  pendingChatConsents.set(id, event.sender.id);
  if (!consentWatchers.has(event.sender)) {
    consentWatchers.add(event.sender);
    const senderId = event.sender.id;
    const cleanup = () => {
      for (const [chatId, owner] of pendingChatConsents) {
        if (owner === senderId) discardPendingChat(chatId);
      }
      broadcastSavedChats();
    };
    event.sender.once('destroyed', cleanup);
    event.sender.on('render-process-gone', cleanup);
    // A reload/navigation abandons the choice, but an in-page link does not.
    event.sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) cleanup();
    });
  }
  return { ok: true };
});
let legacyRemovalsInFlight = 0;

function chatStore() {
  if (!savedChatStore) {
    savedChatStore = createChatStore({ directory: app.getPath('userData') });
  }
  return savedChatStore;
}

function legacyDeleteNoticeVisible() {
  try {
    return chatStore().legacyDeletePending() && legacyRemovalsInFlight === 0;
  } catch (error) {
    console.log(`[Sovereign] could not check pending legacy chat deletion: ${error.message}`);
    return false;
  }
}

// What Ask AI pages get: valid chats, unreadable-file status, and pending legacy cleanup.
function savedChatSnapshot() {
  const status = chatStore().status();
  return { chats: chatStore().list(), unreadable: status.unreadable, legacyPending: legacyDeleteNoticeVisible() };
}

function chatSenderTab(event, kinds) {
  const { state, tab } = findTabBySender(event.sender);
  const url = String(event.sender.getURL() || '');
  if (!tab || !kinds.includes(tab.kind) || !kinds.some(kind => url.startsWith(`sovereign://${kind}/`))) {
    throw new Error('Saved chats can only be managed from Ask AI and Settings.');
  }
  return { state, tab };
}

function broadcastSavedChats() {
  const snapshot = savedChatSnapshot();
  for (const state of windows.values()) {
    for (const tab of state.tabs.values()) {
      if (tab.kind === 'ask' && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('chats:changed', snapshot);
      }
      if (tab.kind === 'settings' && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('chats:legacy-status', { legacyPending: snapshot.legacyPending });
      }
    }
  }
  return snapshot;
}

// Returns true only when the user picked Delete. Every other answer keeps the chats.
async function confirmChatDeletion(state, { message, keepLabel }) {
  // Test-only (ignored when packaged): skip the dialog. Read on every call so one test can
  // answer both ways.
  const testAnswer = testHook('SOVEREIGN_CHAT_DELETE_TEST_ANSWER', { isPackaged: app.isPackaged });
  if (['delete', 'keep'].includes(testAnswer)) {
    return testAnswer === 'delete';
  }
  const options = {
    type: 'question',
    title: 'Saved chats',
    message,
    // Honest scope: Sovereign removes its own copy. Chromium's own files and the disk are
    // outside its control, so there is no promise of secure erase.
    detail: "They will be deleted from Sovereign's storage. Chromium may keep fragments in its internal files until it cleans them up. Copies you exported, and system backups or snapshots, are not affected.",
    buttons: [keepLabel, 'Delete'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const parent = state?.window && !state.window.isDestroyed() ? state.window : null;
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

function savedChatsText(status) {
  const legacy = status.legacyUnknown ? ' and any chats saved by older versions' : '';
  if (status.count === 0) {
    return `${status.unreadable ? 'the unreadable saved chat history' : 'the saved chat history'}${legacy}`;
  }
  const chats = `${status.count} saved ${status.count === 1 ? 'chat' : 'chats'}`;
  return status.unreadable ? `${chats} and the unreadable saved chat history${legacy}` : `the ${chats}${legacy}`;
}

// ---- Chats saved by older versions in the Ask page's localStorage ----
// Older builds kept saved chats under one localStorage key on the sovereign://ask origin.
// Sovereign only reads and removes that key through Chromium's own localStorage API, from a
// hidden empty page on that origin; it never opens Chromium's files. Only this one key is
// touched: the same origin also holds the theme and the AI model cache (IndexedDB), so
// session.clearStorageData is not used. removeItem is a supported delete, but Chromium may keep
// fragments of the old value in its internal files until it cleans them up itself.
// Local only; no network request.
const LEGACY_CHAT_KEY = 'sovereign.ask.chats';
let legacyProbeQueue = Promise.resolve();

// Runs fn(webContents) with a hidden page on the sovereign://ask origin, one at a time.
function withLegacyProbe(fn) {
  const run = legacyProbeQueue.then(async () => {
    const probe = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    try {
      await probe.loadURL('sovereign://ask/legacy-chat-probe.html');
      return await fn(probe.webContents);
    } finally {
      probe.destroy();
    }
  });
  legacyProbeQueue = run.catch(() => {});
  return run;
}

function readLegacyChatKey(contents) {
  return contents.executeJavaScript(`window.localStorage.getItem(${JSON.stringify(LEGACY_CHAT_KEY)})`);
}

// Read only: { found, chats }. Never writes saved-chats.json, so it cannot restore anything.
function peekLegacyChats() {
  return withLegacyProbe(async contents => {
    const raw = await readLegacyChatKey(contents);
    return raw === null || raw === undefined
      ? { found: false, chats: [] }
      : { found: true, chats: parseLegacyChats(String(raw)) };
  });
}

// Test-only (ignored when packaged): make the removal fail, to prove a failed removal never
// restores deleted chats.
function legacyRemovalTestFailure() {
  if (testHook('SOVEREIGN_TEST_LEGACY_REMOVE', { isPackaged: app.isPackaged }) === 'fail') {
    throw new Error('legacy removal failed (test)');
  }
}

// Removes the key and checks it is gone; only then is the pending legacy delete cleared.
async function removeLegacyChatKey() {
  return withLegacyProbe(async contents => {
    legacyRemovalTestFailure();
    // Note which chats were still in the key: they are recorded as deleted when the pending
    // delete is cleared, so a late or repeated copy of them is never imported.
    const before = await readLegacyChatKey(contents);
    const ids = before === null || before === undefined ? [] : legacyChatIds(parseLegacyChats(String(before)));
    await contents.executeJavaScript(`window.localStorage.removeItem(${JSON.stringify(LEGACY_CHAT_KEY)}); true`);
    const after = await readLegacyChatKey(contents);
    if (after !== null && after !== undefined) {
      throw new Error('the old chat key is still present');
    }
    chatStore().legacyDeleteDone(ids);
    return true;
  });
}

// Returns false if the key could not be removed; the delete stays recorded as pending, and
// the next start (or the next time Ask AI opens) removes the key without importing it.
async function removeLegacyChatKeySafely() {
  legacyRemovalsInFlight += 1;
  try {
    return await removeLegacyChatKey();
  } catch (error) {
    console.log(`[Sovereign] could not remove chats saved by an older version: ${error.message}`);
    return false;
  } finally {
    legacyRemovalsInFlight -= 1;
  }
}

// After startup: finish a legacy delete that could not complete earlier.
function finishPendingLegacyChatDelete() {
  if (chatStore().legacyDeletePending()) {
    removeLegacyChatKeySafely().then(() => broadcastSavedChats());
  }
}

// Shared by Clear history and the Settings offer. The order makes deletion win:
//   1. read-only peek, so the dialog can count chats from older versions;
//   2. the user confirms;
//   3. the deletion (ids, and "delete legacy chats") is recorded before any data is touched;
//   4. saved-chats.json is removed;
//   5. the legacy key is removed. If that fails, nothing is restored: it stays pending.
async function deleteAllSavedChats(state, { message, keepLabel }) {
  let legacy = { found: false, chats: [] };
  let legacyUnknown = false;
  try {
    legacy = await peekLegacyChats();
  } catch (error) {
    console.log(`[Sovereign] could not check for chats saved by an older version: ${error.message}`);
    legacyUnknown = true;
  }
  const fileStatus = chatStore().status();
  const legacyIds = legacy.chats.map(chat => (chat && typeof chat.id === 'string' ? chat.id : '')).filter(Boolean);
  const savedIds = new Set(chatStore().list().map(chat => chat.id));
  const legacyCount = new Set(legacyIds.filter(id => !savedIds.has(id))).size;
  const status = {
    count: fileStatus.count + legacyCount,
    unreadable: fileStatus.unreadable,
    legacyUnknown,
    hasData: fileStatus.hasData || legacy.found || legacyUnknown || chatStore().legacyDeletePending()
  };
  if (!status.hasData) {
    return { status, confirmed: false };
  }
  if (!(await confirmChatDeletion(state, { message: message(status), keepLabel }))) {
    return { status, confirmed: false };
  }
  chatStore().clear({ legacy: true, extraIds: legacyIds });
  broadcastSavedChats();
  const legacyRemoved = await removeLegacyChatKeySafely();
  broadcastSavedChats();
  return { status, confirmed: true, legacyPending: !legacyRemoved };
}

ipcMain.handle('chats:legacy-status', event => {
  chatSenderTab(event, ['ask', 'settings']);
  return { legacyPending: legacyDeleteNoticeVisible() };
});

ipcMain.handle('chats:list', event => {
  chatSenderTab(event, ['ask']);
  return savedChatSnapshot();
});

ipcMain.handle('chats:save', (event, chat) => {
  chatSenderTab(event, ['ask']);
  if (!aiSettings.saveChatsOnDevice) {
    throw new Error('Saving chats is turned off.');
  }
  const needsConsent = (Array.isArray(chat?.messages) ? chat.messages : []).some(message => {
    if (message?.role === 'assistant') return [sensitiveGuard.CRISIS_REPLY, sensitiveGuard.HARM_REPLY].includes(message.content);
    if (message?.role !== 'user') return false;
    const result = sensitiveGuard.classifyQuestion(message.content, { strictness: 'strict' });
    return result.level === 'crisis' || result.categories.includes('harm-to-others') || result.categories.includes('abuse');
  });
  if ((needsConsent || pendingChatConsents.has(chat?.id)) && chat?.saveConsent !== true) return { ok: false, needsConsent: true };
  chatStore().save(chat);
  if (chat?.saveConsent === true) pendingChatConsents.delete(chat.id);
  return broadcastSavedChats();
});

ipcMain.handle('chats:delete', (event, id) => {
  chatSenderTab(event, ['ask']);
  discardPendingChat(id);
  return broadcastSavedChats();
});

// Clear history: always physical cleanup once confirmed, even if the file cannot be parsed.
ipcMain.handle('chats:clear', async event => {
  const { state } = chatSenderTab(event, ['ask']);
  const result = await deleteAllSavedChats(state, {
    message: status => `Delete ${savedChatsText(status)} from Sovereign's storage?`,
    keepLabel: 'Cancel'
  });
  if (!result.confirmed) {
    return { deleted: 0, canceled: result.status.hasData, ...savedChatSnapshot() };
  }
  privacyReceipts.deleteReceipts(receipt => receipt.chatId || receipt.sensitiveOverride);
  return { deleted: result.status.count, cleared: true, legacyPending: result.legacyPending, ...broadcastSavedChats() };
});

// The Ask page found the legacy key itself (it opened before any bulk delete). Imports nothing
// while a legacy delete is pending, and never a deleted id (see chat-store.js).
ipcMain.handle('chats:import-legacy', (event, chats) => {
  chatSenderTab(event, ['ask']);
  chatStore().importLegacy(Array.isArray(chats) ? chats : []);
  return broadcastSavedChats();
});

// The Ask page removed the legacy key with removeItem and checked it is gone.
ipcMain.handle('chats:legacy-removed', event => {
  chatSenderTab(event, ['ask']);
  if (chatStore().legacyDeletePending()) {
    chatStore().legacyDeleteDone();
    broadcastSavedChats();
  }
  return true;
});

// Called by Settings right after "Save chats on this device" is turned off.
ipcMain.handle('chats:offer-delete-on-disable', async event => {
  const { state } = chatSenderTab(event, ['settings']);
  if (aiSettings.saveChatsOnDevice) {
    return { count: 0, deleted: 0 };
  }
  const result = await deleteAllSavedChats(state, {
    message: status => `Also delete ${savedChatsText(status)} on this device?`,
    keepLabel: 'Keep'
  });
  const { count, unreadable, hasData } = result.status;
  if (!result.confirmed) {
    return { count, unreadable, kept: hasData, deleted: 0 };
  }
  privacyReceipts.deleteReceipts(receipt => receipt.chatId || receipt.sensitiveOverride);
  return { count, unreadable, deleted: count, cleared: true, legacyPending: result.legacyPending };
});

ipcMain.handle('settings:choose-download-directory', event => {
  const state = findWindowStateBySender(event.sender);
  const openDialogOptions = {
    title: 'Choose Download Folder',
    defaultPath: effectiveDownloadDirectory(),
    buttonLabel: 'Use Folder',
    properties: ['openDirectory', 'createDirectory']
  };
  const result = state?.window
    ? dialog.showOpenDialogSync(state.window, openDialogOptions)
    : dialog.showOpenDialogSync(openDialogOptions);
  if (!result || !result[0]) {
    return downloadSettingsSnapshot();
  }
  return updateDownloadSettings({ defaultDirectory: result[0] });
});

ipcMain.handle('ask-handoff:create', (_event, payload) => {
  pruneAskHandoffs();
  const handoff = sanitizeAskHandoff(payload);
  if (handoff.files.length === 0) {
    return { id: '', count: 0 };
  }
  const id = askHandoffId();
  askHandoffs.set(id, handoff);
  return { id, count: handoff.files.length };
});

ipcMain.handle('ask-handoff:consume', (_event, id) => {
  pruneAskHandoffs();
  const key = String(id || '').slice(0, 120);
  if (!key) {
    return { files: [] };
  }
  const handoff = askHandoffs.get(key);
  askHandoffs.delete(key);
  return handoff || { files: [] };
});

ipcMain.handle('bookmarks:get', () => bookmarksSnapshot());

ipcMain.handle('bookmarks:add', (_event, input) => {
  const payload = input && typeof input === 'object' ? input : {};
  return addOrUpdateBookmark({
    title: payload.title,
    url: payload.url
  });
});

ipcMain.handle('bookmarks:rename', (_event, id, title) => renameBookmark(id, title));

ipcMain.handle('bookmarks:remove', (_event, idOrUrl) => removeBookmark(idOrUrl));

ipcMain.on('bookmarks:open', (event, url) => {
  const state = findWindowStateBySender(event.sender);
  const checked = normalizeAddress(url);
  if (state && checked.ok) {
    createTab(state, checked.url, true);
  }
});

ipcMain.on('bookmarks:open-current-tab', (event, url) => {
  const state = findWindowStateBySender(event.sender);
  if (state) {
    navigateActive(state, url);
  }
});

ipcMain.handle('downloads:get-state', () => downloadsSnapshot());

ipcMain.handle('downloads:download-url', async (event, inputUrl) => {
  const url = validateDownloadUrlInput(inputUrl);
  if (networkMode.isOffline() && !networkDecision(url).allow) {
    recordOfflineBlocked({ url, method: 'GET', resourceType: 'download', webContentsId: event.sender.id });
    throw new Error(`${OFFLINE_MESSAGE} Switch to Online to download from this address.`);
  }
  setupDownloadHandlingForSession(event.sender.session);
  await preflightDownloadUrl(url, event.sender.session);
  event.sender.downloadURL(url);
  return downloadsSnapshot();
});

ipcMain.on('downloads:cancel', (_event, downloadId) => {
  const item = downloadItemForAction(downloadId);
  item?.cancel();
});

ipcMain.on('downloads:pause', (_event, downloadId) => {
  const item = downloadItemForAction(downloadId);
  item?.pause();
});

ipcMain.on('downloads:resume', (_event, downloadId) => {
  const item = downloadItemForAction(downloadId);
  if (item && networkMode.isOffline() && !networkDecision(item.getURL()).allow) {
    return;
  }
  if (item?.isPaused() || item?.canResume()) {
    offlinePausedDownloads.delete(Number(downloadId));
    item.resume();
  }
});

ipcMain.on('downloads:clear', (_event, downloadId) => {
  const id = Number(downloadId);
  if (!Number.isInteger(id) || activeDownloadItems.has(id)) {
    return;
  }
  downloads.delete(id);
  broadcastDownloadsState();
});

ipcMain.on('downloads:clear-finished', () => {
  for (const [id, record] of downloads.entries()) {
    if (!activeDownloadItems.has(id) && record.state !== 'progressing') {
      downloads.delete(id);
    }
  }
  broadcastDownloadsState();
});

ipcMain.on('downloads:show-in-folder', (_event, downloadId) => {
  const record = downloads.get(Number(downloadId));
  if (record?.savePath) {
    shell.showItemInFolder(record.savePath);
  }
});

ipcMain.handle('downloads:open-file', async (_event, downloadId) => {
  const record = downloads.get(Number(downloadId));
  if (!record?.savePath || record.state !== 'completed') {
    throw new Error('The file is not ready to open.');
  }
  const result = await shell.openPath(record.savePath);
  if (result) {
    throw new Error(result);
  }
  return true;
});

function openExternalOnline(url) {
  networkMode.assertOnline('open in another app');
  return shell.openExternal(url);
}

ipcMain.handle('browser:open-external', async (event, url) => {
  const checked = normalizeAddress(url);
  if (!checked.ok) {
    return { ok: false, error: checked.error };
  }
  if (networkMode.isOffline()) {
    const owner = findWindowStateBySender(event.sender) || focusedWindowState();
    sendError(owner, OPEN_EXTERNAL_OFFLINE_MESSAGE);
    return { ok: false, offline: true, error: OPEN_EXTERNAL_OFFLINE_MESSAGE };
  }
  await openExternalOnline(checked.url);
  return { ok: true };
});
