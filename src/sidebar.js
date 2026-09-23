const modelName = document.querySelector('#model-name');
const modelSize = document.querySelector('#model-size');
const modelProgress = document.querySelector('#model-progress');
const downloadModelButton = document.querySelector('#download-model');
const summarizeButton = document.querySelector('#summarize-page');
const stopButton = document.querySelector('#stop-summary');
const aiStatus = document.querySelector('#ai-status');
const sourceTitle = document.querySelector('#source-title');
const sourceUrl = document.querySelector('#source-url');
const summaryOutput = document.querySelector('#summary-output');

let sidebarState = null;
let engineLoaded = false;
let modelCached = false;
let summarizing = false;
let currentGenerationId = null;

function logAi(message, details = {}) {
  console.log('[Sovereign AI]', message, details);
}

function describeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
}

function getEngineApi() {
  const api = window.SovereignAIEngine;
  if (!api) {
    throw new Error('window.SovereignAIEngine is undefined. The local WebLLM bundle did not initialize.');
  }

  const requiredMethods = ['environment', 'isModelCached', 'loadModel', 'summarize', 'stop'];
  const missing = requiredMethods.filter(name => typeof api[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`window.SovereignAIEngine is missing: ${missing.join(', ')}`);
  }

  return api;
}

function getSummaryUtils() {
  const api = window.SovereignSummaryUtils;
  if (!api) {
    throw new Error('window.SovereignSummaryUtils is undefined. The summary rules did not initialize.');
  }
  return api;
}

function setStatus(message) {
  aiStatus.textContent = message || '';
}

function activeTab() {
  return sidebarState?.activeTab || null;
}

function activeTabState() {
  return sidebarState?.tabState || null;
}

function updateTabState(tabId, patch) {
  window.sovereign.ai.updateTabState(tabId, patch);
}

function renderModelInfo() {
  const model = sidebarState?.model;
  if (!model) {
    modelName.textContent = 'Local model unavailable';
    modelSize.textContent = '';
    downloadModelButton.disabled = true;
    return;
  }

  modelName.textContent = model.name;
  modelSize.textContent = model.approximateDownloadSize;

  if (engineLoaded) {
    downloadModelButton.textContent = 'Model ready';
    downloadModelButton.disabled = true;
  } else if (modelCached) {
    downloadModelButton.textContent = 'Load cached model';
    downloadModelButton.disabled = false;
  } else {
    downloadModelButton.textContent = 'Download model';
    downloadModelButton.disabled = false;
  }
}

function selectedModelId() {
  return String(sidebarState?.model?.id || '').trim() || undefined;
}

function renderSource() {
  const tab = activeTab();
  const state = activeTabState();
  const source = state?.source;

  sourceTitle.textContent = source?.title || tab?.title || 'No active page';
  sourceUrl.textContent = source?.url || tab?.url || '';
}

function appendSummaryParagraph(text) {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  summaryOutput.append(paragraph);
}

function renderSummaryOutput(text) {
  summaryOutput.replaceChildren();

  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return;
  }

  let list = null;
  for (const line of lines) {
    const bulletMatch = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bulletMatch) {
      if (!list) {
        list = document.createElement('ul');
        list.className = 'summary-list';
        summaryOutput.append(list);
      }

      const item = document.createElement('li');
      item.textContent = bulletMatch[1].trim();
      list.append(item);
    } else {
      list = null;
      appendSummaryParagraph(line);
    }
  }
}

function renderSummary() {
  const state = activeTabState();
  renderSummaryOutput(state?.summary || '');

  if (state?.status === 'summarizing') {
    setStatus('Summarizing locally...');
  } else if (state?.status === 'loading-model') {
    setStatus('Loading the local model...');
  } else if (state?.status === 'extracting') {
    setStatus('Extracting readable page text...');
  } else if (state?.status === 'complete') {
    setStatus('Summary complete.');
  } else if (state?.status === 'stopped') {
    setStatus('Summary stopped.');
  } else if (state?.status === 'error') {
    setStatus(state.error || 'Local AI failed.');
  } else if (!engineLoaded) {
    setStatus('Download or load the model before summarizing.');
  } else {
    setStatus('');
  }
}

function renderControls() {
  const tab = activeTab();
  const activeState = activeTabState();
  const busy = summarizing || activeState?.status === 'extracting' || activeState?.status === 'summarizing';

  summarizeButton.disabled = !tab || !engineLoaded || busy;
  stopButton.disabled = !busy;
}

function render() {
  renderModelInfo();
  renderSource();
  renderSummary();
  renderControls();
}

async function refreshModelCacheState() {
  try {
    const engineApi = getEngineApi();
    const environment = await engineApi.environment();
    if (!environment.webgpu) {
      modelProgress.textContent = 'WebGPU is not available in this Electron window. Local inference cannot run here.';
      downloadModelButton.disabled = true;
      return;
    }

    modelCached = await engineApi.isModelCached(selectedModelId());
    modelProgress.textContent = modelCached ? 'Model files found in local cache.' : 'Not downloaded.';
  } catch (error) {
    logAi('cache inspection failed', describeError(error));
    modelCached = false;
    modelProgress.textContent = `Could not inspect local model cache: ${error.message}`;
  }
  render();
}

async function loadModel() {
  downloadModelButton.disabled = true;
  modelProgress.textContent = 'Preparing local model...';
  const tab = activeTab();
  if (tab) {
    updateTabState(tab.id, { status: 'loading-model', progress: { text: 'Preparing local model...', progress: null } });
  }

  try {
    const engineApi = getEngineApi();
    await engineApi.loadModel(progress => {
      const text = progress?.text || 'Downloading/loading model files...';
      const percent = Number.isFinite(progress?.progress) ? ` ${Math.round(progress.progress * 100)}%` : '';
      modelProgress.textContent = `${text}${percent}`;
      if (tab) {
        updateTabState(tab.id, { status: 'loading-model', progress: { text, progress: progress?.progress ?? null } });
      }
    }, selectedModelId());
    engineLoaded = true;
    modelCached = true;
    modelProgress.textContent = 'Local model ready.';
    if (tab) {
      updateTabState(tab.id, { status: 'idle', progress: null, error: '' });
    }
  } catch (error) {
    logAi('model setup failed', describeError(error));
    modelProgress.textContent = `Local model setup failed: ${error.message}`;
    if (tab) {
      updateTabState(tab.id, { status: 'error', error: error.message, progress: null });
    }
  }
  render();
}

async function summarizePage() {
  const tab = activeTab();
  if (!tab || !engineLoaded || summarizing) {
    return;
  }

  summarizing = true;
  currentGenerationId = `${tab.id}-${Date.now()}`;
  renderControls();

  updateTabState(tab.id, {
    status: 'extracting',
    summary: '',
    error: '',
    generationId: currentGenerationId,
    summaryVersion: getSummaryUtils().SUMMARY_BEHAVIOR_VERSION,
    progress: { text: 'Extracting readable page text...', progress: null }
  });

  try {
    const source = await window.sovereign.ai.extractActivePageText();
    const summaryUtils = getSummaryUtils();
    const userPrompt = summaryUtils.buildUserPrompt(source);
    const promptDiagnostics = {
      promptLength: userPrompt.length,
      sourceTextLength: source.text.length,
      sourceContainsCompactStandardLibrary: /compact[\s\S]{0,80}standard library/i.test(source.text),
      promptContainsCompactStandardLibrary: /compact[\s\S]{0,80}standard library/i.test(userPrompt),
      sourceContainsExtensiveStandardLibrary: /extensive[\s\S]{0,80}standard library/i.test(source.text),
      promptContainsExtensiveStandardLibrary: /extensive[\s\S]{0,80}standard library/i.test(userPrompt)
    };

    updateTabState(source.tabId, {
      status: 'summarizing',
      summary: '',
      error: '',
      generationId: currentGenerationId,
      summaryVersion: summaryUtils.SUMMARY_BEHAVIOR_VERSION,
      promptDiagnostics,
      source: {
        title: source.title,
        url: source.url,
        extractedAt: source.extractedAt,
        charCount: source.charCount,
        truncated: source.truncated
      },
      progress: { text: 'Generating locally...', progress: null }
    });

    let output = '';
    const engineApi = getEngineApi();
    await engineApi.summarize(
      [
        { role: 'system', content: summaryUtils.SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      chunk => {
        output += chunk;
        updateTabState(source.tabId, {
          status: 'summarizing',
          summary: summaryUtils.finalizeSummaryText(output, source),
          generationId: currentGenerationId
        });
      }
    );

    const finalSummary = summaryUtils.finalizeSummaryText(output, source);
    updateTabState(source.tabId, {
      status: 'complete',
      summary: finalSummary,
      generationId: currentGenerationId,
      summaryVersion: summaryUtils.SUMMARY_BEHAVIOR_VERSION,
      generatedAt: new Date().toISOString(),
      progress: null
    });
  } catch (error) {
    logAi('summarize failed', describeError(error));
    const status = error?.name === 'AbortError' ? 'stopped' : 'error';
    updateTabState(tab.id, {
      status,
      error: status === 'stopped' ? '' : error.message,
      generationId: currentGenerationId,
      progress: null
    });
  } finally {
    summarizing = false;
    currentGenerationId = null;
    renderControls();
  }
}

async function stopSummary() {
  if (!summarizing) {
    return;
  }

  try {
    await getEngineApi().stop();
  } catch (error) {
    logAi('stop failed', describeError(error));
  }

  const tab = activeTab();
  if (tab) {
    updateTabState(tab.id, { status: 'stopped', progress: null });
  }
}

downloadModelButton.addEventListener('click', loadModel);
summarizeButton.addEventListener('click', summarizePage);
stopButton.addEventListener('click', stopSummary);

window.sovereign.ai.onState(state => {
  sidebarState = state;
  render();
});

window.sovereign.ai.getState().then(state => {
  sidebarState = state;
  render();
  return refreshModelCacheState();
}).catch(error => {
  setStatus(`Could not initialize Sovereign AI: ${error.message}`);
});
