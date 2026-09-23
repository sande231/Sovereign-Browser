const tabsElement = document.querySelector('#tabs');
const addressForm = document.querySelector('#address-form');
const addressInput = document.querySelector('#address');
const statusElement = document.querySelector('#status');
const auditModeLabel = document.querySelector('#audit-mode-label');
const newTabButton = document.querySelector('#new-tab');
const backButton = document.querySelector('#back');
const forwardButton = document.querySelector('#forward');
const reloadButton = document.querySelector('#reload');
const bookmarkToggleButton = document.querySelector('#bookmark-toggle');
const aiToggleButton = document.querySelector('#ai-toggle');
const aiSetupChip = document.querySelector('#ai-setup-chip');
const aiSetupMain = document.querySelector('#ai-setup-main');
const aiSetupText = document.querySelector('#ai-setup-text');
const aiSetupAction = document.querySelector('#ai-setup-action');
const searchOpenButton = document.querySelector('#search-open');
const downloadsOpenButton = document.querySelector('#downloads-open');
const downloadsPopover = document.querySelector('#downloads-popover');
const downloadsPopoverStatus = document.querySelector('#downloads-popover-status');
const compactDownloadsList = document.querySelector('#compact-downloads-list');
const downloadsPageOpenButton = document.querySelector('#downloads-page-open');
const downloadsClearFinishedButton = document.querySelector('#downloads-clear-finished');
const downloadIndicator = document.querySelector('#download-indicator');
const settingsOpenButton = document.querySelector('#settings-open');
const findBar = document.querySelector('#find-bar');
const findInput = document.querySelector('#find-input');
const findCount = document.querySelector('#find-count');
const findPreviousButton = document.querySelector('#find-previous');
const findNextButton = document.querySelector('#find-next');
const findCloseButton = document.querySelector('#find-close');

const DRAG_START_DISTANCE = 8;
const DETACH_MARGIN = 16;
const DETACH_LOG_PREFIX = '[Sovereign detach]';

let currentState = {
  activeTabId: null,
  tabs: [],
  downloadsPanelVisible: false
};
let downloadsState = { downloads: [] };
let modelSetupState = null;
let modelSetupNoticeSent = false;
let tabDrag = null;
let nativeDrag = null;
let suppressNextClick = false;
let findTimer = null;
const detachRequests = new Set();

function logDetach(message, details = {}) {
  console.log(DETACH_LOG_PREFIX, message, details);
}

function activeTab() {
  return currentState.tabs.find(tab => tab.id === currentState.activeTabId);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function searchQuestionFromUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const localSearxng = (host === '127.0.0.1' || host === 'localhost' || host === '::1') &&
      parsed.port === '8080' &&
      parsed.pathname.replace(/\/+$/, '') === '/search';
    return localSearxng ? parsed.searchParams.get('q') || '' : '';
  } catch {
    return '';
  }
}

function naturalSearchQuestion(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith('?')) {
    return raw.slice(1).trim();
  }
  if (isHttpUrl(raw) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    return '';
  }
  if (raw.includes(' ') || raw.endsWith('?')) {
    return raw;
  }
  return '';
}

function searchSeedQuestion() {
  return naturalSearchQuestion(addressInput.value) || searchQuestionFromUrl(activeTab()?.url || '');
}

function setStatus(message) {
  statusElement.textContent = message || '';
  if (message) {
    window.clearTimeout(setStatus.timeout);
    setStatus.timeout = window.setTimeout(() => {
      statusElement.textContent = '';
    }, 3600);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function downloadStatusText(download) {
  if (download.paused) {
    return 'Paused';
  }
  if (download.state === 'progressing' || download.status === 'progressing') {
    return 'Downloading';
  }
  if (download.state === 'completed' || download.status === 'completed') {
    return 'Completed';
  }
  if (download.state === 'cancelled' || download.status === 'cancelled') {
    return 'Canceled';
  }
  if (download.state === 'interrupted' || download.status === 'interrupted') {
    return 'Failed';
  }
  if (download.status === 'Choose a save location') {
    return 'Waiting for save location';
  }
  return download.status || download.state || 'Starting';
}

function downloadProgressText(download) {
  const total = Number(download.totalBytes || 0);
  const received = Number(download.receivedBytes || 0);
  const bytes = total > 0 ? `${formatBytes(received)} of ${formatBytes(total)}` : formatBytes(received);
  const percent = Number(download.percent);
  return Number.isFinite(percent) && percent >= 0 ? `${bytes} · ${Math.round(percent)}%` : bytes;
}

function isDownloadActive(download) {
  return download.state === 'progressing' || download.status === 'progressing' || download.paused;
}

function compactButton(label, handler, disabled = false, title = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-action compact-action';
  button.textContent = label;
  button.disabled = disabled;
  button.title = title || label;
  button.addEventListener('click', handler);
  return button;
}

function renderCompactDownload(download) {
  const item = document.createElement('article');
  item.className = `compact-download ${download.state || download.status || ''}`;

  const top = document.createElement('div');
  top.className = 'compact-download-top';
  const name = document.createElement('div');
  name.className = 'compact-download-name';
  name.textContent = download.filename || 'Download';
  const state = document.createElement('div');
  state.className = 'compact-download-state';
  state.textContent = downloadStatusText(download);
  top.append(name, state);

  const meta = document.createElement('div');
  meta.className = 'compact-download-meta';
  meta.textContent = downloadProgressText(download);

  const progress = document.createElement('progress');
  progress.className = 'download-progress compact-progress';
  progress.max = 100;
  progress.value = Number.isFinite(download.percent) && download.percent >= 0 ? Math.min(100, download.percent) : 0;

  const actions = document.createElement('div');
  actions.className = 'compact-download-actions';
  const active = isDownloadActive(download);
  if (active) {
    actions.append(
      compactButton(download.paused ? 'Resume' : 'Pause', () => {
        if (download.paused) {
          window.sovereign.downloads.resume(download.id);
        } else {
          window.sovereign.downloads.pause(download.id);
        }
      }, download.paused ? !download.canResume : false),
      compactButton('Cancel', () => window.sovereign.downloads.cancel(download.id))
    );
  } else if (download.state === 'completed') {
    actions.append(
      compactButton('Show in Finder', () => window.sovereign.downloads.showInFolder(download.id), !download.savePath),
      compactButton('Open', async () => {
        try {
          await window.sovereign.downloads.openFile(download.id);
        } catch (error) {
          setStatus(error.message);
        }
      }),
      compactButton('Clear', () => window.sovereign.downloads.clear(download.id))
    );
  } else {
    actions.append(compactButton('Clear', () => window.sovereign.downloads.clear(download.id)));
  }

  item.append(top, meta);
  if (download.error) {
    const error = document.createElement('div');
    error.className = 'compact-download-error';
    error.textContent = download.error;
    item.append(error);
  }
  item.append(progress, actions);
  return item;
}

function renderDownloadsPanel() {
  const items = downloadsState.downloads || [];
  const activeCount = items.filter(isDownloadActive).length;
  const failedCount = items.filter(item => item.state === 'interrupted').length;

  downloadIndicator.hidden = activeCount === 0;
  downloadsOpenButton.classList.toggle('active', currentState.downloadsPanelVisible);
  downloadsOpenButton.setAttribute('aria-expanded', String(Boolean(currentState.downloadsPanelVisible)));
  downloadsPopover.hidden = !currentState.downloadsPanelVisible;
  document.querySelector('.chrome')?.classList.toggle('downloads-panel-visible', Boolean(currentState.downloadsPanelVisible));

  if (activeCount > 0) {
    downloadsPopoverStatus.textContent = `${activeCount} active`;
  } else if (failedCount > 0) {
    downloadsPopoverStatus.textContent = `${failedCount} failed`;
  } else if (items.length > 0) {
    downloadsPopoverStatus.textContent = `${items.length} recent`;
  } else {
    downloadsPopoverStatus.textContent = 'No downloads yet';
  }

  compactDownloadsList.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    empty.textContent = 'Downloaded files will appear here.';
    compactDownloadsList.append(empty);
    downloadsClearFinishedButton.disabled = true;
    return;
  }

  downloadsClearFinishedButton.disabled = !items.some(item => !isDownloadActive(item));
  items.slice(0, 3).forEach(download => compactDownloadsList.append(renderCompactDownload(download)));
}

function modelSetupStatusText(state = {}) {
  if (state.status === 'downloading') {
    const percent = Number(state.progress?.progress);
    return Number.isFinite(percent)
      ? `AI setup ${Math.round(percent * 100)}%`
      : 'AI setup';
  }
  if (state.status === 'checking') {
    return 'AI setup...';
  }
  if (state.status === 'error') {
    return 'AI setup failed';
  }
  if (state.status === 'canceled') {
    return 'AI setup canceled';
  }
  return 'AI setup';
}

function renderModelSetupIndicator() {
  const state = modelSetupState || {};
  const visible = ['checking', 'downloading', 'error', 'canceled'].includes(state.status);
  aiSetupChip.hidden = !visible;
  if (!visible) {
    return;
  }

  if (
    !modelSetupNoticeSent &&
    (state.status === 'checking' || state.status === 'downloading') &&
    state.settings?.setupNoticeSeen === false
  ) {
    modelSetupNoticeSent = true;
    setStatus('AI setup is downloading local model files and uses disk space. Answers run locally after setup.');
    window.sovereign.modelSetup.updateSettings({ setupNoticeSeen: true }).catch(() => {});
  }

  aiSetupChip.dataset.status = state.status;
  aiSetupText.textContent = modelSetupStatusText(state);
  aiSetupMain.title = state.text || 'AI setup downloads model files and uses local disk space. Answers run locally after setup.';
  const retry = state.status === 'error' || state.status === 'canceled';
  aiSetupAction.textContent = retry ? 'Retry' : 'Cancel';
  aiSetupAction.title = retry ? 'Retry AI model setup' : 'Cancel AI model setup';
  aiSetupAction.disabled = !retry && !state.canCancel;
}

function renderTabs() {
  tabsElement.replaceChildren();

  for (const tab of currentState.tabs) {
    const item = document.createElement('button');
    item.type = 'button';
    item.draggable = true;
    item.className = `tab${tab.id === currentState.activeTabId ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
    item.title = tab.title;
    item.dataset.tabId = String(tab.id);

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.loading ? `${tab.title}...` : tab.title;

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.setAttribute('aria-label', 'Close tab');

    item.append(title, close);
    tabsElement.append(item);
  }
}

function renderControls() {
  const tab = activeTab();
  const inputIsFocused = document.activeElement === addressInput;

  backButton.disabled = !tab || !tab.canGoBack;
  forwardButton.disabled = !tab || !tab.canGoForward;
  aiToggleButton.classList.toggle('active', Boolean(currentState.sidebarVisible));
  bookmarkToggleButton.disabled = !tab || !tab.bookmarkable;
  bookmarkToggleButton.classList.toggle('active', Boolean(tab?.bookmarked));
  bookmarkToggleButton.textContent = tab?.bookmarked ? '★' : '☆';
  bookmarkToggleButton.title = tab?.bookmarked ? 'Remove bookmark (Cmd+D)' : 'Bookmark this page (Cmd+D)';
  findBar.hidden = !currentState.findBarVisible;
  auditModeLabel.hidden = !currentState.auditMode?.active;
  auditModeLabel.title = currentState.auditMode?.active
    ? `Audit mode active: ${currentState.auditMode.proxy || 'proxy configured'}`
    : 'Audit mode inactive';
  document.querySelector('.chrome')?.classList.toggle('find-bar-visible', Boolean(currentState.findBarVisible));

  if (tab && !inputIsFocused) {
    addressInput.value = tab.url || '';
  }
}

function render(state) {
  currentState = state;
  renderTabs();
  renderControls();
  renderDownloadsPanel();
  renderModelSetupIndicator();
}

function isOutsideTabBar(clientX, clientY, margin = DETACH_MARGIN) {
  const strip = tabsElement.getBoundingClientRect();
  return (
    clientX < strip.left - margin ||
    clientX > strip.right + margin ||
    clientY < strip.top - margin ||
    clientY > strip.bottom + margin
  );
}

function eventPosition(event, reason) {
  return {
    reason,
    screenX: Number.isFinite(event.screenX) ? event.screenX : undefined,
    screenY: Number.isFinite(event.screenY) ? event.screenY : undefined,
    clientX: Number.isFinite(event.clientX) ? event.clientX : undefined,
    clientY: Number.isFinite(event.clientY) ? event.clientY : undefined
  };
}

function requestDetach(tabId, event, reason) {
  if (!tabId || detachRequests.has(tabId)) {
    return;
  }

  detachRequests.add(tabId);
  window.setTimeout(() => detachRequests.delete(tabId), 2500);
  const position = eventPosition(event, reason);
  logDetach('renderer requesting detach', { tabId, position });
  window.sovereign.detachTab(tabId, position);
}

tabsElement.addEventListener('click', event => {
  if (suppressNextClick) {
    suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const tabButton = event.target.closest('.tab');
  if (!tabButton) {
    return;
  }

  const tabId = Number(tabButton.dataset.tabId);
  if (event.target.classList.contains('tab-close')) {
    window.sovereign.closeTab(tabId);
  } else {
    window.sovereign.switchTab(tabId);
  }
});

tabsElement.addEventListener('contextmenu', event => {
  const tabButton = event.target.closest('.tab');
  if (!tabButton) {
    return;
  }

  event.preventDefault();
  const tabId = Number(tabButton.dataset.tabId);
  logDetach('renderer requesting tab context menu', { tabId });
  window.sovereign.showTabMenu(tabId);
});

tabsElement.addEventListener('pointerdown', event => {
  const tabButton = event.target.closest('.tab');
  if (!tabButton || event.button !== 0 || event.target.classList.contains('tab-close')) {
    return;
  }

  tabDrag = {
    tabId: Number(tabButton.dataset.tabId),
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false
  };

  tabButton.classList.add('dragging');
  logDetach('pointerdown on tab', {
    tabId: tabDrag.tabId,
    pointerId: tabDrag.pointerId,
    clientX: event.clientX,
    clientY: event.clientY
  });
  try {
    tabButton.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; normal pointer events still cover short drags.
  }
});

tabsElement.addEventListener('pointermove', event => {
  if (!tabDrag || tabDrag.pointerId !== event.pointerId) {
    return;
  }

  const distance = Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY);
  if (distance < DRAG_START_DISTANCE) {
    return;
  }

  tabDrag.moved = true;
  const outsideTabBar = isOutsideTabBar(event.clientX, event.clientY);

  if (outsideTabBar) {
    suppressNextClick = true;
    logDetach('pointermove left tab bar', {
      tabId: tabDrag.tabId,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY
    });
    requestDetach(tabDrag.tabId, event, 'pointermove-outside-tab-bar');
    tabDrag = null;
  }
});

function endTabDrag(event) {
  if (tabDrag?.pointerId === event.pointerId) {
    const tabButton = tabsElement.querySelector(`[data-tab-id="${tabDrag.tabId}"]`);
    tabButton?.classList.remove('dragging');
    suppressNextClick = tabDrag.moved;
    tabDrag = null;
  }
}

tabsElement.addEventListener('pointerup', endTabDrag);
tabsElement.addEventListener('pointercancel', endTabDrag);

tabsElement.addEventListener('dragstart', event => {
  const tabButton = event.target.closest('.tab');
  if (!tabButton || event.target.classList.contains('tab-close')) {
    event.preventDefault();
    return;
  }

  nativeDrag = {
    tabId: Number(tabButton.dataset.tabId)
  };
  tabButton.classList.add('dragging');

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabButton.title || 'Sovereign tab');
    event.dataTransfer.setDragImage(tabButton, 20, 14);
  }

  logDetach('native dragstart on tab', {
    tabId: nativeDrag.tabId,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY
  });
});

tabsElement.addEventListener('dragend', event => {
  if (!nativeDrag) {
    return;
  }

  const tabId = nativeDrag.tabId;
  const tabButton = tabsElement.querySelector(`[data-tab-id="${tabId}"]`);
  tabButton?.classList.remove('dragging');

  const hasClientPoint = event.clientX !== 0 || event.clientY !== 0;
  const outsideTabBar = hasClientPoint ? isOutsideTabBar(event.clientX, event.clientY, 0) : true;
  logDetach('native dragend on tab', {
    tabId,
    hasClientPoint,
    outsideTabBar,
    dropEffect: event.dataTransfer?.dropEffect,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY
  });

  if (outsideTabBar) {
    suppressNextClick = true;
    requestDetach(tabId, event, 'native-dragend-outside-tab-bar');
  }

  nativeDrag = null;
  tabDrag = null;
});

addressForm.addEventListener('submit', event => {
  event.preventDefault();
  window.sovereign.navigate(addressInput.value);
});

newTabButton.addEventListener('click', () => {
  window.sovereign.newTab();
});

backButton.addEventListener('click', () => {
  window.sovereign.back();
});

forwardButton.addEventListener('click', () => {
  window.sovereign.forward();
});

reloadButton.addEventListener('click', () => {
  window.sovereign.reload();
});

searchOpenButton.addEventListener('click', () => {
  window.sovereign.openSearch({
    question: searchSeedQuestion(),
    mode: 'search',
    autoRun: Boolean(searchSeedQuestion())
  });
});

aiToggleButton.addEventListener('click', () => {
  window.sovereign.toggleSidebar();
});

aiSetupMain.addEventListener('click', () => {
  window.sovereign.openSettings();
});

aiSetupAction.addEventListener('click', async () => {
  const state = modelSetupState || {};
  aiSetupAction.disabled = true;
  try {
    if (state.status === 'error' || state.status === 'canceled') {
      modelSetupState = await window.sovereign.modelSetup.start();
    } else {
      modelSetupState = await window.sovereign.modelSetup.cancel();
    }
    renderModelSetupIndicator();
  } catch (error) {
    setStatus(error.message);
  } finally {
    aiSetupAction.disabled = false;
  }
});

downloadsOpenButton.addEventListener('click', () => {
  window.sovereign.toggleDownloadsPanel();
});

downloadsPageOpenButton.addEventListener('click', () => {
  window.sovereign.setDownloadsPanelVisible(false);
  window.sovereign.openDownloads();
});

downloadsClearFinishedButton.addEventListener('click', () => {
  window.sovereign.downloads.clearFinished();
});

bookmarkToggleButton.addEventListener('click', async () => {
  bookmarkToggleButton.disabled = true;
  try {
    await window.sovereign.toggleBookmark();
  } catch (error) {
    setStatus(error.message);
  } finally {
    bookmarkToggleButton.disabled = false;
  }
});

settingsOpenButton.addEventListener('click', () => {
  window.sovereign.openSettings();
});

addressInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    renderControls();
    addressInput.blur();
  }
});

function updateFindCount(result = {}) {
  const matches = Number(result.matches || 0);
  const active = Number(result.activeMatchOrdinal || 0);
  findCount.textContent = matches > 0 ? `${active}/${matches}` : '0/0';
  findPreviousButton.disabled = matches < 1;
  findNextButton.disabled = matches < 1;
}

function runFindFromInput(immediate = false) {
  window.clearTimeout(findTimer);
  const query = findInput.value;
  if (immediate) {
    window.sovereign.findInPage(query);
    return;
  }
  findTimer = window.setTimeout(() => {
    window.sovereign.findInPage(query);
  }, 120);
}

function focusFindBar() {
  findBar.hidden = false;
  document.querySelector('.chrome')?.classList.add('find-bar-visible');
  findInput.focus();
  findInput.select();
  if (findInput.value) {
    runFindFromInput(true);
  }
}

function showFindBar() {
  window.sovereign.showFindBar();
  focusFindBar();
}

function hideFindBar() {
  window.clearTimeout(findTimer);
  window.sovereign.hideFindBar();
  window.sovereign.stopFind();
  findInput.blur();
}

findInput.addEventListener('input', () => runFindFromInput(false));
findInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideFindBar();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) {
      window.sovereign.findPrevious(findInput.value);
    } else {
      window.sovereign.findNext(findInput.value);
    }
  }
});

findPreviousButton.addEventListener('click', () => {
  window.sovereign.findPrevious(findInput.value);
});

findNextButton.addEventListener('click', () => {
  window.sovereign.findNext(findInput.value);
});

findCloseButton.addEventListener('click', hideFindBar);

window.sovereign.onState(render);
window.sovereign.onError(setStatus);
window.sovereign.onShowFindBar(focusFindBar);
window.sovereign.onFindResult(updateFindCount);
window.sovereign.downloads.onState(state => {
  downloadsState = state || { downloads: [] };
  renderDownloadsPanel();
});
window.sovereign.modelSetup.onState(state => {
  modelSetupState = state;
  renderModelSetupIndicator();
});
window.sovereign.onFocusAddress(() => {
  addressInput.focus();
  addressInput.select();
});

window.sovereign.getState().then(render).catch(() => {
  setStatus('Sovereign could not read the browser state.');
});

window.sovereign.downloads.getState().then(state => {
  downloadsState = state || { downloads: [] };
  renderDownloadsPanel();
}).catch(() => {});

window.sovereign.modelSetup.getState().then(state => {
  modelSetupState = state;
  renderModelSetupIndicator();
}).catch(() => {});
