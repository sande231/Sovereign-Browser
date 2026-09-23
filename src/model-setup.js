const AI_LOG_PREFIX = '[Sovereign AI]';

let running = false;
let lastCommandKey = '';

function describeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
}

function logSetup(message, details = {}) {
  console.log(AI_LOG_PREFIX, message, details);
}

function report(patch) {
  window.sovereign.modelSetupWorker.report(patch);
}

function engineApi() {
  const api = window.SovereignAIEngine;
  if (!api) {
    throw new Error('Local AI runtime did not initialize.');
  }
  const required = ['environment', 'isModelCached', 'loadModel', 'unload'];
  const missing = required.filter(name => typeof api[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Local AI runtime is missing: ${missing.join(', ')}`);
  }
  return api;
}

function selectedModelId(command = {}) {
  return String(command?.model?.id || '').trim() || undefined;
}

async function inspectCache(command = {}) {
  const api = engineApi();
  const environment = await api.environment();
  if (!environment.webgpu) {
    report({
      status: 'error',
      cached: false,
      loaded: false,
      text: 'WebGPU is not available in this Electron window.',
      error: 'Local WebLLM inference requires Chromium WebGPU support.',
      canRetry: true,
      canCancel: false
    });
    return false;
  }

  const cached = await api.isModelCached(selectedModelId(command));
  report({
    status: cached ? 'ready' : 'idle',
    cached,
    loaded: false,
    progress: null,
    text: cached ? 'Local model files are already downloaded.' : 'Local model files are not downloaded yet.',
    canRetry: !cached,
    canCancel: false
  });
  return cached;
}

async function downloadModel(command = {}) {
  if (running) {
    return;
  }
  running = true;
  try {
    const api = engineApi();
    report({
      status: 'downloading',
      cached: false,
      loaded: false,
      progress: { progress: 0, text: 'Starting model download...' },
      text: 'Downloading the configured local model...',
      canCancel: true,
      canRetry: false
    });

    await api.loadModel(progress => {
      const text = progress?.text || 'Downloading/loading model files...';
      report({
        status: 'downloading',
        cached: false,
        loaded: true,
        progress: {
          progress: Number.isFinite(progress?.progress) ? progress.progress : null,
          text
        },
        text,
        canCancel: true,
        canRetry: false
      });
    }, selectedModelId(command));

    const cached = await api.isModelCached(selectedModelId(command));
    if (!cached) {
      throw new Error('WebLLM finished loading, but the model cache check still reports missing files.');
    }

    try {
      await api.unload();
    } catch (error) {
      logSetup('model unload after setup failed', describeError(error));
    }

    report({
      status: 'ready',
      cached: true,
      loaded: false,
      progress: null,
      text: 'Local model files are downloaded and ready.',
      canCancel: false,
      canRetry: false
    });
  } catch (error) {
    logSetup('background model setup failed', describeError(error));
    report({
      status: 'error',
      cached: false,
      loaded: false,
      progress: null,
      text: 'Local model setup failed.',
      error: error?.message || String(error),
      canCancel: false,
      canRetry: true
    });
  } finally {
    running = false;
  }
}

async function handleCommand(command = {}) {
  const type = command.type === 'check-and-download' ? 'check-and-download' : 'check';
  const commandKey = `${type}:${Date.now()}`;
  lastCommandKey = commandKey;

  report({
    status: 'checking',
    cached: false,
    loaded: false,
    progress: null,
    text: 'Checking local model cache...',
    canCancel: false,
    canRetry: false
  });

  try {
    const cached = await inspectCache(command);
    if (lastCommandKey !== commandKey || cached || type !== 'check-and-download') {
      return;
    }
    await downloadModel(command);
  } catch (error) {
    logSetup('model cache inspection failed', describeError(error));
    report({
      status: 'error',
      cached: false,
      loaded: false,
      progress: null,
      text: 'Could not inspect or prepare the local model cache.',
      error: error?.message || String(error),
      canCancel: false,
      canRetry: true
    });
  }
}

window.sovereign.modelSetupWorker.onCommand(command => {
  handleCommand(command).catch(error => {
    logSetup('model setup command failed', describeError(error));
    report({
      status: 'error',
      cached: false,
      loaded: false,
      text: 'Local model setup failed.',
      error: error?.message || String(error),
      canRetry: true,
      canCancel: false
    });
  });
});

window.sovereign.modelSetupWorker.ready();
