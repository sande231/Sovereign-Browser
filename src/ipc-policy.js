'use strict';

// Pure sender policy; view identities are established by the main process.
function checkSender({ role, tabKind, url, isMainFrame } = {}, policy = {}, { indexUrl } = {}) {
  const reject = reason => ({ ok: false, reason });
  if (isMainFrame !== true) return reject('not the main frame');
  if (!['chrome', 'sidebar', 'tab', 'setup'].includes(role)) return reject('unknown view');
  if (role === 'tab' && (!tabKind || tabKind === 'web')) return reject('not an internal tab');
  let internal = false;
  try { internal = new URL(url).protocol === 'sovereign:'; } catch { /* Invalid URL is untrusted. */ }
  if (!internal && !(typeof indexUrl === 'string' && url === indexUrl)) return reject('untrusted URL');
  if (policy.roles && !policy.roles.includes(role)) return reject('role not allowed');
  if (policy.tabKinds && (role !== 'tab' || !policy.tabKinds.includes(tabKind))) return reject('tab kind not allowed');
  return { ok: true, reason: '' };
}

module.exports = { checkSender };
