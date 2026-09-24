const searchForm = document.querySelector('#search-form');
const questionInput = document.querySelector('#question');
const searchButton = document.querySelector('#search-button');
const cancelButton = document.querySelector('#cancel-search');
const searchStatus = document.querySelector('#search-status');
const resultsList = document.querySelector('#results-list');
const activityEndpoint = document.querySelector('#activity-endpoint');
const activityList = document.querySelector('#activity-list');
const privacyReceiptToggle = document.querySelector('#privacy-receipt-toggle');
const privacyReceiptPanel = document.querySelector('#privacy-receipt-panel');
const privacyReceiptSummary = document.querySelector('#privacy-receipt-summary');
const privacyCloudCheck = document.querySelector('#privacy-cloud-check');
const privacyReceiptRows = document.querySelector('#privacy-receipt-rows');
const privacyReceiptHistory = document.querySelector('#privacy-receipt-history');
const privacyExportJsonButton = document.querySelector('#privacy-export-json');

let running = false;
let currentRequestId = null;
let privacyReceiptList = [];
let selectedPrivacyReceiptId = '';
let userSelectedPrivacyReceipt = false;

function setSearchStatus(message, isError = false) {
  searchStatus.textContent = message || '';
  searchStatus.classList.toggle('error', Boolean(isError));
}

function receiptHostCount(receipt) {
  return new Set((receipt?.entries || []).map(entry => entry.host).filter(Boolean)).size;
}

function receiptTypeLabel(receipt) {
  if (receipt?.type === 'ask') return 'Ask AI';
  if (receipt?.type === 'background') return 'Background';
  if (receipt?.type === 'search') return 'Search';
  return receipt?.label || 'Activity';
}

function receiptOptionLabel(receipt) {
  const date = receipt?.startedAt ? new Date(receipt.startedAt) : null;
  const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown time';
  const query = String(receipt?.query || '').slice(0, 40);
  return `${time} ${receiptTypeLabel(receipt)}${query ? ` - ${query}` : ''}`;
}

function renderPrivacyHistory() {
  if (!privacyReceiptHistory) {
    return;
  }
  privacyReceiptHistory.replaceChildren();
  if (privacyReceiptList.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No receipts yet';
    privacyReceiptHistory.append(option);
    privacyReceiptHistory.disabled = true;
    return;
  }
  privacyReceiptHistory.disabled = false;
  for (const receipt of privacyReceiptList) {
    const option = document.createElement('option');
    option.value = receipt.id;
    option.textContent = receiptOptionLabel(receipt);
    privacyReceiptHistory.append(option);
  }
  privacyReceiptHistory.value = selectedPrivacyReceiptId || privacyReceiptList[0]?.id || '';
}

function renderPrivacyReceipt(receipt) {
  if (!privacyReceiptToggle || !privacyReceiptRows) {
    return;
  }
  const hostCount = receiptHostCount(receipt);
  privacyReceiptToggle.textContent = `Shield ${hostCount}`;
  privacyReceiptToggle.title = hostCount === 0
    ? 'No recorded outbound hosts for the latest Search activity.'
    : `${hostCount} outbound host${hostCount === 1 ? '' : 's'} recorded for the latest activity.`;
  privacyReceiptSummary.textContent = receipt?.summary || 'No Search network activity yet.';
  privacyCloudCheck.textContent = receipt?.cloudAi?.message || '✓ No data sent to cloud AI services';
  privacyCloudCheck.classList.toggle('warning', Boolean(receipt && receipt.cloudAi && !receipt.cloudAi.ok));
  privacyReceiptRows.replaceChildren();

  const entries = Array.isArray(receipt?.entries) ? receipt.entries : [];
  if (entries.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = 'No outbound requests recorded for this activity.';
    row.append(cell);
    privacyReceiptRows.append(row);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement('tr');
    const category = document.createElement('td');
    category.textContent = entry.category || 'other';
    const host = document.createElement('td');
    host.textContent = entry.host || 'unknown';
    const sent = document.createElement('td');
    sent.textContent = entry.whatWasSent || 'request metadata only';
    row.append(category, host, sent);
    privacyReceiptRows.append(row);
  }
}

function defaultPrivacyReceiptId() {
  return privacyReceiptList.find(receipt => receipt.type !== 'background')?.id || privacyReceiptList[0]?.id || '';
}

async function refreshPrivacyReceipts(preferredReceipt = null) {
  if (!window.sovereign?.privacy) {
    return;
  }
  privacyReceiptList = await window.sovereign.privacy.getReceipts();
  if (preferredReceipt?.id && preferredReceipt.type !== 'background' && !userSelectedPrivacyReceipt) {
    selectedPrivacyReceiptId = preferredReceipt.id;
  }
  if (!privacyReceiptList.some(receipt => receipt.id === selectedPrivacyReceiptId)) {
    selectedPrivacyReceiptId = defaultPrivacyReceiptId();
  }
  renderPrivacyHistory();
  renderPrivacyReceipt(privacyReceiptList.find(receipt => receipt.id === selectedPrivacyReceiptId) || null);
}

function selectPrivacyReceiptForActivity(receiptId) {
  selectedPrivacyReceiptId = String(receiptId || '');
  userSelectedPrivacyReceipt = false;
  refreshPrivacyReceipts().catch(() => {});
}

function setupPrivacyReceiptPanel() {
  if (!privacyReceiptToggle || !window.sovereign?.privacy) {
    return;
  }
  privacyReceiptToggle.addEventListener('click', () => {
    const nextHidden = !privacyReceiptPanel.hidden;
    privacyReceiptPanel.hidden = nextHidden;
    privacyReceiptToggle.setAttribute('aria-expanded', String(!nextHidden));
  });
  privacyReceiptHistory?.addEventListener('change', () => {
    selectedPrivacyReceiptId = privacyReceiptHistory.value;
    userSelectedPrivacyReceipt = true;
    renderPrivacyReceipt(privacyReceiptList.find(receipt => receipt.id === selectedPrivacyReceiptId) || null);
  });
  privacyExportJsonButton?.addEventListener('click', async () => {
    try {
      const result = await window.sovereign.privacy.exportReceipts();
      if (result?.ok) {
        setSearchStatus(`Exported ${result.receiptCount} privacy receipt${result.receiptCount === 1 ? '' : 's'}.`);
      } else {
        setSearchStatus('Privacy receipt export canceled.');
      }
    } catch (error) {
      setSearchStatus(`Could not export privacy receipts: ${error.message}`, true);
    }
  });
  refreshPrivacyReceipts()
    .catch(() => renderPrivacyReceipt(null));
  window.sovereign.privacy.onReceiptUpdated(receipt => {
    refreshPrivacyReceipts(receipt).catch(() => renderPrivacyReceipt(receipt));
  });
}

function setRunning(nextRunning) {
  running = nextRunning;
  searchButton.disabled = running;
  cancelButton.disabled = !running;
  questionInput.disabled = running;
}

function openUrl(url) {
  window.sovereign.newTab(url);
}

function renderResults(results) {
  const safeResults = Array.isArray(results) ? results : [];
  resultsList.replaceChildren();

  if (safeResults.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No results found.';
    resultsList.append(empty);
    return;
  }

  for (const result of safeResults) {
    const card = document.createElement('article');
    card.className = 'result-card ordinary-result-card';

    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'result-title ordinary-result-title';
    titleButton.textContent = result.title || result.url || 'Untitled result';
    titleButton.addEventListener('click', () => openUrl(result.url));

    const url = document.createElement('div');
    url.className = 'result-url ordinary-result-url';
    url.textContent = result.url || '';

    const snippet = document.createElement('p');
    snippet.className = 'result-snippet ordinary-result-snippet';
    snippet.textContent = result.snippet || 'No description provided.';

    card.append(titleButton, url, snippet);
    resultsList.append(card);
  }
}

function renderActivity(events) {
  activityList.replaceChildren();
  if (!events || events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    empty.textContent = 'No retrieval requests observed yet.';
    activityList.append(empty);
    return;
  }

  for (const event of events.slice().reverse()) {
    const item = document.createElement('div');
    item.className = `activity-item ${event.status || ''}`;

    const line = document.createElement('div');
    line.className = 'activity-line';
    const resultCount = Number.isFinite(event.resultCount) ? `, ${event.resultCount} result${event.resultCount === 1 ? '' : 's'}` : '';
    const duration = Number.isFinite(event.durationMs) ? `, ${event.durationMs} ms` : '';
    line.textContent = `${event.status || 'request'} ${event.method || 'GET'}${resultCount}${duration}`;

    const endpoint = document.createElement('div');
    endpoint.className = 'activity-url';
    endpoint.textContent = event.endpoint || '';

    item.append(line, endpoint);
    if (event.error) {
      const error = document.createElement('div');
      error.className = 'activity-error';
      error.textContent = event.error;
      item.append(error);
    }
    activityList.append(item);
  }
}

async function refreshSettings() {
  const state = await window.sovereign.search.getSettings();
  activityEndpoint.textContent = `Configured endpoint: ${state.settings.endpoint}`;
  renderActivity(state.activity || []);
  return state.settings;
}

function applySeedQuestion() {
  const params = new URLSearchParams(window.location.search);
  const question = String(params.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (question && !questionInput.value.trim()) {
    questionInput.value = question;
  }
  questionInput.focus();
  if (question && params.get('run') === '1') {
    window.setTimeout(() => {
      if (!running) {
        searchForm.requestSubmit();
      }
    }, 0);
  }
}

async function runSearch() {
  if (running) {
    return;
  }

  const query = questionInput.value.replace(/\s+/g, ' ').trim();
  if (!query) {
    questionInput.focus();
    return;
  }

  currentRequestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  selectPrivacyReceiptForActivity(currentRequestId);
  setRunning(true);
  setSearchStatus('Searching...');
  renderResults([]);

  try {
    const settingsState = await window.sovereign.search.getSettings();
    const settings = settingsState.settings;
    activityEndpoint.textContent = `Configured endpoint: ${settings.endpoint}`;

    const response = await window.sovereign.search.query({
      requestId: currentRequestId,
      query,
      endpoint: settings.endpoint
    });

    renderResults(response.results);
    renderActivity(response.activity || []);
    setSearchStatus(response.results.length === 0 ? 'Search completed with no results.' : `Search returned ${response.results.length} result${response.results.length === 1 ? '' : 's'}.`);
  } catch (error) {
    const canceled = error?.name === 'AbortError' || /canceled|cancelled|aborted/i.test(error?.message || '');
    setSearchStatus(canceled ? 'Search canceled.' : error.message, !canceled);
  } finally {
    currentRequestId = null;
    setRunning(false);
  }
}

function cancelSearch() {
  if (!running || !currentRequestId) {
    return;
  }
  window.sovereign.search.cancel(currentRequestId);
  setSearchStatus('Canceling...');
}

searchForm.addEventListener('submit', event => {
  event.preventDefault();
  runSearch();
});

cancelButton.addEventListener('click', cancelSearch);
window.sovereign.search.onActivity(renderActivity);
setupPrivacyReceiptPanel();

refreshSettings()
  .then(applySeedQuestion)
  .catch(error => {
    setSearchStatus(`Could not initialize search: ${error.message}`, true);
  });
