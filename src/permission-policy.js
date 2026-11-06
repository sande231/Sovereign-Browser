// Website permission policy. Pure logic with no Electron imports, so it can be unit-tested.
// main.js wires createPermissionController() to the session permission handlers.

// Ask the user ("Allow once" / "Deny"). Value: [short name for the receipt, prompt action text].
const PROMPT_PERMISSIONS = new Map([
  ['geolocation', ['location', 'use your location']],
  ['notifications', ['notifications', 'show notifications']],
  ['midi', ['MIDI', 'use MIDI devices']],
  ['midiSysex', ['MIDI SysEx', 'use MIDI devices with full control (SysEx)']],
  ['clipboard-read', ['clipboard read', 'read your clipboard']],
  ['pointerLock', ['pointer lock', 'hide and lock your mouse pointer']],
  ['keyboardLock', ['keyboard lock', 'capture all keyboard keys']],
  ['idle-detection', ['idle detection', 'know when you are idle']],
  ['window-management', ['window management', 'see your screens and place windows on them']],
  ['storage-access', ['storage access', 'use its cookies while embedded in another site']],
  ['top-level-storage-access', ['storage access', 'use its cookies while embedded in another site']],
  ['speaker-selection', ['speaker selection', 'choose your audio output device']]
]);

// Allowed for web pages without a prompt: Chromium only allows these straight after a
// click or key press, and they read no user data.
const AUTO_ALLOW_WEB_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

const DECISIONS = {
  allowedOnce: 'allowed once by you',
  deniedByUser: 'denied by you',
  allowedAuto: 'allowed automatically (needs a click or key press; reads no user data)',
  deniedUnsupported: 'denied automatically: not supported in Sovereign',
  deniedInternal: "denied automatically: Sovereign's own pages need no website permissions",
  deniedStale: 'denied: tab closed or page changed before you answered',
  deniedUnknownSite: 'denied: unknown site'
};

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

function isInternalUrl(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && (parsed.protocol === 'sovereign:' || parsed.protocol === 'file:'));
}

function webOrigin(value) {
  const parsed = parseUrl(value);
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.origin : '';
}

function describePermission(permission, details = {}) {
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const video = types.includes('video');
    const audio = types.includes('audio');
    if (video && audio) return { name: 'camera and microphone', action: 'use your camera and microphone' };
    if (video) return { name: 'camera', action: 'use your camera' };
    if (audio) return { name: 'microphone', action: 'use your microphone' };
    // getDisplayMedia() arrives as 'media' with no camera or microphone types.
    return { name: 'screen capture', action: '' };
  }
  const known = PROMPT_PERMISSIONS.get(permission);
  if (known) return { name: known[0], action: known[1] };
  return { name: String(permission || 'unknown').slice(0, 60), action: '' };
}

// Returns { action: 'prompt' | 'allow' | 'deny', name, promptAction, decision, origin, embeddedIn }.
function classifyPermissionRequest({ permission, requestingUrl = '', topUrl = '', details = {} } = {}) {
  const { name, action } = describePermission(permission, details);
  const base = { name, promptAction: action, origin: '', embeddedIn: '' };
  if (isInternalUrl(requestingUrl) || (!requestingUrl && isInternalUrl(topUrl))) {
    return { ...base, origin: 'Sovereign', action: 'deny', decision: DECISIONS.deniedInternal };
  }
  const origin = webOrigin(requestingUrl || topUrl);
  if (!origin) {
    return { ...base, action: 'deny', decision: DECISIONS.deniedUnknownSite };
  }
  const top = webOrigin(topUrl);
  const withOrigin = { ...base, origin, embeddedIn: top && top !== origin ? top : '' };
  if (AUTO_ALLOW_WEB_PERMISSIONS.has(permission)) {
    return { ...withOrigin, action: 'allow', decision: DECISIONS.allowedAuto };
  }
  if ((permission === 'media' && action) || PROMPT_PERMISSIONS.has(permission)) {
    return { ...withOrigin, action: 'prompt', decision: '' };
  }
  return { ...withOrigin, action: 'deny', decision: DECISIONS.deniedUnsupported };
}

// Synchronous status check (navigator.permissions.query and similar). Never reports a grant
// for anything that needs a prompt, so "Allow once" is never remembered.
function checkPermission({ permission, requestingOrigin = '' } = {}) {
  if (isInternalUrl(requestingOrigin)) return false;
  return Boolean(webOrigin(requestingOrigin)) && AUTO_ALLOW_WEB_PERMISSIONS.has(permission);
}

function promptText({ origin, promptAction, embeddedIn }) {
  return {
    message: `${origin} wants to ${promptAction}.`,
    detail: `${embeddedIn ? `This request comes from a frame inside ${embeddedIn}.\n\n` : ''}Allow once grants this request only. Sovereign will ask again next time.`
  };
}

function safeCurrentUrl(webContents) {
  try {
    if (!webContents || (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed())) return null;
    return typeof webContents.getURL === 'function' ? webContents.getURL() : '';
  } catch {
    return null;
  }
}

// prompt({ webContents, origin, name, message, detail }) -> Promise<'allow' | 'deny'>
// record({ origin, name, decision, embeddedIn }) -> void
function createPermissionController({ prompt, record }) {
  let queue = Promise.resolve();

  function request(webContents, permission, callback, details = {}) {
    const topUrl = safeCurrentUrl(webContents) || '';
    const requestingUrl = details?.requestingUrl || details?.securityOrigin || '';
    const result = classifyPermissionRequest({ permission, requestingUrl, topUrl, details });
    let answered = false;
    const finish = (granted, decision) => {
      if (answered) return;
      answered = true;
      try {
        record({ origin: result.origin, name: result.name, decision, embeddedIn: result.embeddedIn });
      } catch {
        // Recording must never block the decision.
      }
      callback(Boolean(granted));
    };

    if (result.action === 'allow') return finish(true, result.decision);
    if (result.action === 'deny') return finish(false, result.decision);

    const originAtRequest = webOrigin(topUrl);
    const stale = () => {
      const current = safeCurrentUrl(webContents);
      return current === null || webOrigin(current) !== originAtRequest;
    };
    queue = queue.then(async () => {
      if (stale()) return finish(false, DECISIONS.deniedStale);
      let answer = 'deny';
      try {
        answer = await prompt({ webContents, origin: result.origin, name: result.name, ...promptText(result) });
      } catch {
        answer = 'deny';
      }
      if (stale()) return finish(false, DECISIONS.deniedStale);
      return answer === 'allow'
        ? finish(true, DECISIONS.allowedOnce)
        : finish(false, DECISIONS.deniedByUser);
    }).catch(() => finish(false, DECISIONS.deniedByUser));
    return undefined;
  }

  function check(_webContents, permission, requestingOrigin) {
    return checkPermission({ permission, requestingOrigin });
  }

  // For device pickers and screen capture, which are always denied.
  function recordAutoDenied(webContents, name) {
    const topUrl = safeCurrentUrl(webContents) || '';
    const internal = isInternalUrl(topUrl);
    const origin = internal ? 'Sovereign' : webOrigin(topUrl);
    try {
      record({
        origin,
        name,
        decision: internal ? DECISIONS.deniedInternal : origin ? DECISIONS.deniedUnsupported : DECISIONS.deniedUnknownSite,
        embeddedIn: ''
      });
    } catch {
      // Recording must never block the denial.
    }
  }

  return { request, check, recordAutoDenied, pending: () => queue };
}

module.exports = {
  AUTO_ALLOW_WEB_PERMISSIONS,
  DECISIONS,
  PROMPT_PERMISSIONS,
  checkPermission,
  classifyPermissionRequest,
  createPermissionController,
  describePermission,
  isInternalUrl,
  promptText,
  webOrigin
};
