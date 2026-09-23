const themeMode = document.querySelector('#theme-mode');
const endpointInput = document.querySelector('#settings-endpoint');
const saveEndpointButton = document.querySelector('#save-settings-endpoint');
const modelName = document.querySelector('#settings-model-name');
const modelSize = document.querySelector('#settings-model-size');
const modelStatus = document.querySelector('#settings-model-status');
const modelSelect = document.querySelector('#settings-model-select');
const modelDetails = document.querySelector('#settings-model-details');
const autoModel = document.querySelector('#settings-auto-model');
const saveChats = document.querySelector('#settings-save-chats');
const startModelButton = document.querySelector('#settings-start-model');
const cancelModelButton = document.querySelector('#settings-cancel-model');
const restoreSession = document.querySelector('#settings-restore-session');
const downloadsDir = document.querySelector('#settings-downloads-dir');
const askDownloads = document.querySelector('#settings-ask-downloads');
const chooseDownloadFolderButton = document.querySelector('#choose-download-folder');
const resetDownloadFolderButton = document.querySelector('#reset-download-folder');
const settingsStatus = document.querySelector('#settings-status');

function setStatus(message, isError = false) {
  settingsStatus.textContent = message || '';
  settingsStatus.classList.toggle('error', Boolean(isError));
}

async function loadSettings() {
  const state = await window.sovereign.settings.get();
  endpointInput.value = state.search.endpoint;
  themeMode.value = window.SovereignTheme.get();
  renderModelOptions(state);
  modelName.textContent = state.model.name;
  modelSize.textContent = state.model.approximateDownloadSize;
  renderAiSettings(state.ai, state.modelSetup);
  restoreSession.checked = Boolean(state.startup?.continueWhereLeftOff);
  renderDownloadSettings(state.downloads);
}

function renderModelOptions(state = {}) {
  const models = Array.isArray(state.models) ? state.models : [state.model].filter(Boolean);
  modelSelect.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    modelSelect.append(option);
  }
  modelSelect.value = state.model?.id || state.ai?.selectedModelId || '';
  renderSelectedModelDetails(models.find(model => model.id === modelSelect.value) || state.model);
}

function renderSelectedModelDetails(model = {}) {
  const parts = [
    model.status,
    model.approximateDownloadSize,
    Number.isFinite(model.vramRequiredMB) ? `WebLLM listed VRAM: ${Math.round(model.vramRequiredMB)} MB` : '',
    model.license ? `License: ${model.license}` : ''
  ].filter(Boolean);
  modelDetails.textContent = parts.join(' · ') || 'Selecting a larger model does not download it until setup starts.';
}

function setupText(state = {}) {
  if (state.status === 'downloading') {
    const percent = Number(state.progress?.progress);
    const suffix = Number.isFinite(percent) ? ` (${Math.round(percent * 100)}%)` : '';
    return `${state.text || 'Downloading model'}${suffix}`;
  }
  if (state.status === 'ready') {
    return state.loaded ? 'Loaded in memory.' : 'Downloaded, not loaded in memory.';
  }
  if (state.status === 'checking') {
    return 'Checking local cache...';
  }
  if (state.status === 'error') {
    return `Setup failed: ${state.error || state.text || 'Unknown error'}`;
  }
  if (state.status === 'canceled') {
    return 'Setup canceled.';
  }
  return state.cached ? 'Downloaded, not loaded in memory.' : 'Not downloaded.';
}

function renderAiSettings(ai = {}, setup = {}) {
  autoModel.checked = ai.autoDownloadModel !== false;
  saveChats.checked = Boolean(ai.saveChatsOnDevice);
  modelStatus.textContent = setupText(setup);
  startModelButton.disabled = setup.status === 'checking' || setup.status === 'downloading' || setup.status === 'ready';
  cancelModelButton.disabled = setup.status !== 'downloading';
}

function renderDownloadSettings(downloads) {
  askDownloads.checked = Boolean(downloads.askWhereToSave);
  downloadsDir.textContent = downloads.defaultDirectory;
}

themeMode.addEventListener('change', () => {
  window.SovereignTheme.set(themeMode.value);
});

saveEndpointButton.addEventListener('click', async () => {
  saveEndpointButton.disabled = true;
  try {
    const settings = await window.sovereign.search.updateSettings({ endpoint: endpointInput.value });
    endpointInput.value = settings.endpoint;
    setStatus('SearXNG endpoint saved.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveEndpointButton.disabled = false;
  }
});

restoreSession.addEventListener('change', async () => {
  restoreSession.disabled = true;
  try {
    await window.sovereign.settings.updateStartup({
      continueWhereLeftOff: restoreSession.checked
    });
    setStatus('Startup setting saved.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    restoreSession.disabled = false;
  }
});

autoModel.addEventListener('change', async () => {
  autoModel.disabled = true;
  try {
    const ai = await window.sovereign.settings.updateAi({
      autoDownloadModel: autoModel.checked
    });
    const setup = await window.sovereign.modelSetup.getState();
    renderAiSettings(ai, setup);
    setStatus('AI setup setting saved.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    autoModel.disabled = false;
  }
});

saveChats.addEventListener('change', async () => {
  saveChats.disabled = true;
  try {
    const ai = await window.sovereign.settings.updateAi({
      saveChatsOnDevice: saveChats.checked
    });
    const setup = await window.sovereign.modelSetup.getState();
    renderAiSettings(ai, setup);
    setStatus('Chat history setting saved.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveChats.disabled = false;
  }
});

modelSelect.addEventListener('change', async () => {
  modelSelect.disabled = true;
  try {
    const ai = await window.sovereign.settings.updateAi({
      selectedModelId: modelSelect.value
    });
    const state = await window.sovereign.settings.get();
    renderModelOptions(state);
    modelName.textContent = state.model.name;
    modelSize.textContent = state.model.approximateDownloadSize;
    renderAiSettings(ai, state.modelSetup);
    setStatus('AI model selection saved. Run setup to check or download this model.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    modelSelect.disabled = false;
  }
});

startModelButton.addEventListener('click', async () => {
  startModelButton.disabled = true;
  try {
    const setup = await window.sovereign.modelSetup.start();
    renderAiSettings(setup.settings, setup);
    setStatus('AI model setup started.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    const setup = await window.sovereign.modelSetup.getState().catch(() => null);
    if (setup) {
      renderAiSettings(setup.settings, setup);
    }
  }
});

cancelModelButton.addEventListener('click', async () => {
  cancelModelButton.disabled = true;
  try {
    const setup = await window.sovereign.modelSetup.cancel();
    renderAiSettings(setup.settings, setup);
    setStatus('AI model setup canceled.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    const setup = await window.sovereign.modelSetup.getState().catch(() => null);
    if (setup) {
      renderAiSettings(setup.settings, setup);
    }
  }
});

askDownloads.addEventListener('change', async () => {
  askDownloads.disabled = true;
  try {
    const downloads = await window.sovereign.settings.updateDownloads({
      askWhereToSave: askDownloads.checked
    });
    renderDownloadSettings(downloads);
    setStatus('Download setting saved.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    askDownloads.disabled = false;
  }
});

chooseDownloadFolderButton.addEventListener('click', async () => {
  chooseDownloadFolderButton.disabled = true;
  try {
    const downloads = await window.sovereign.settings.chooseDownloadDirectory();
    renderDownloadSettings(downloads);
    setStatus('Download folder saved.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    chooseDownloadFolderButton.disabled = false;
  }
});

resetDownloadFolderButton.addEventListener('click', async () => {
  resetDownloadFolderButton.disabled = true;
  try {
    const downloads = await window.sovereign.settings.updateDownloads({ defaultDirectory: '' });
    renderDownloadSettings(downloads);
    setStatus('Download folder reset to the Mac Downloads folder.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    resetDownloadFolderButton.disabled = false;
  }
});

loadSettings().catch(error => {
  setStatus(`Could not load settings: ${error.message}`, true);
});

window.sovereign.modelSetup.onState(state => {
  renderAiSettings(state.settings, state);
});
