import {
  MLCEngine,
  hasModelInCache,
  prebuiltAppConfig
} from '@mlc-ai/web-llm';

const DEFAULT_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
const appConfig = {
  ...prebuiltAppConfig,
  cacheBackend: 'indexeddb'
};

let engine = null;
let loaded = false;
let loadedModelId = '';

function modelId(value) {
  return String(value || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
}

function ensureWebGPU() {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not available. Local WebLLM inference requires Electron/Chromium WebGPU support.');
  }
}

async function environment() {
  return {
    webgpu: Boolean(navigator.gpu),
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent
  };
}

async function isModelCached(targetModelId) {
  return hasModelInCache(modelId(targetModelId), appConfig);
}

async function loadModel(onProgress, targetModelId) {
  ensureWebGPU();
  const target = modelId(targetModelId);
  if (!engine) {
    engine = new MLCEngine({
      appConfig,
      initProgressCallback: progress => onProgress?.(progress)
    });
  } else {
    engine.setInitProgressCallback(progress => onProgress?.(progress));
  }

  if (loaded && loadedModelId && loadedModelId !== target) {
    await engine.unload();
    loaded = false;
    loadedModelId = '';
  }

  if (!loaded) {
    await engine.reload(target, {
      temperature: 0.1,
      top_p: 0.9,
      context_window_size: 4096
    });
    loaded = true;
    loadedModelId = target;
  }
}

async function summarize(messages, onChunk) {
  if (!engine || !loaded) {
    throw new Error('The local model is not loaded yet.');
  }

  await engine.resetChat();
  const chunks = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 420
  });

  for await (const chunk of chunks) {
    const content = chunk.choices?.[0]?.delta?.content || '';
    if (content) {
      onChunk(content);
    }
  }
}

async function stop() {
  if (engine) {
    await engine.interruptGenerate();
  }
}

async function unload() {
  if (engine) {
    await engine.unload();
  }
  loaded = false;
  loadedModelId = '';
}

window.SovereignAIEngine = {
  environment,
  isModelCached,
  loadModel,
  summarize,
  stop,
  unload
};
