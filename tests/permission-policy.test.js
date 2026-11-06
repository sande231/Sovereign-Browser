const assert = require('node:assert/strict');
const {
  DECISIONS,
  PROMPT_PERMISSIONS,
  checkPermission,
  classifyPermissionRequest,
  createPermissionController,
  describePermission,
  isInternalUrl,
  promptText
} = require('../src/permission-policy');

const WEB = 'https://maps.example/page';
const INTERNAL_URLS = ['sovereign://ask/', 'sovereign://ask/sidebar.html', 'file:///Applications/Sovereign/src/index.html'];

// --- Classification -------------------------------------------------------

for (const permission of [...PROMPT_PERMISSIONS.keys(), 'media']) {
  const result = classifyPermissionRequest({ permission, requestingUrl: WEB, topUrl: WEB, details: { mediaTypes: ['video'] } });
  assert.equal(result.action, 'prompt', permission);
  assert.equal(result.origin, 'https://maps.example', permission);
  assert.ok(result.promptAction.length > 0, permission);
}

const media = types => describePermission('media', { mediaTypes: types });
assert.equal(media(['video']).action, 'use your camera');
assert.equal(media(['audio']).action, 'use your microphone');
assert.equal(media(['video', 'audio']).action, 'use your camera and microphone');
assert.equal(media([]).name, 'screen capture');
for (const mediaTypes of [[], undefined]) {
  const capture = classifyPermissionRequest({ permission: 'media', requestingUrl: WEB, topUrl: WEB, details: { mediaTypes } });
  assert.equal(capture.action, 'deny', 'getDisplayMedia (media with no camera or microphone) is never prompted');
  assert.equal(capture.decision, DECISIONS.deniedUnsupported);
  assert.equal(capture.name, 'screen capture');
}
assert.equal(describePermission('geolocation').action, 'use your location');
assert.equal(describePermission('notifications').action, 'show notifications');
assert.equal(describePermission('clipboard-read').action, 'read your clipboard');
assert.equal(describePermission('midiSysex').action, 'use MIDI devices with full control (SysEx)');

for (const permission of ['fullscreen', 'clipboard-sanitized-write']) {
  const web = classifyPermissionRequest({ permission, requestingUrl: WEB, topUrl: WEB });
  assert.equal(web.action, 'allow', permission);
  assert.equal(web.decision, DECISIONS.allowedAuto);
}

for (const permission of ['openExternal', 'mediaKeySystem', 'display-capture', 'fileSystem', 'hid', 'usb', 'serial', 'unknown', 'deprecated-sync-clipboard-read', 'invented-new-permission']) {
  const result = classifyPermissionRequest({ permission, requestingUrl: WEB, topUrl: WEB });
  assert.equal(result.action, 'deny', permission);
  assert.equal(result.decision, DECISIONS.deniedUnsupported, permission);
}

for (const url of INTERNAL_URLS) {
  assert.equal(isInternalUrl(url), true, url);
  for (const permission of [...PROMPT_PERMISSIONS.keys(), 'media', 'fullscreen', 'clipboard-sanitized-write', 'openExternal']) {
    const result = classifyPermissionRequest({ permission, requestingUrl: url, topUrl: url });
    assert.equal(result.action, 'deny', `${url} ${permission}`);
    assert.equal(result.decision, DECISIONS.deniedInternal);
  }
}
assert.equal(isInternalUrl(WEB), false);

for (const requestingUrl of ['', 'not a url', 'data:text/html,hi', 'blob:null/123']) {
  const result = classifyPermissionRequest({ permission: 'geolocation', requestingUrl, topUrl: '' });
  assert.equal(result.action, 'deny', requestingUrl);
  assert.equal(result.decision, DECISIONS.deniedUnknownSite, requestingUrl);
}

const framed = classifyPermissionRequest({ permission: 'geolocation', requestingUrl: 'https://widget.example/frame', topUrl: 'https://news.example/story' });
assert.equal(framed.origin, 'https://widget.example');
assert.equal(framed.embeddedIn, 'https://news.example');
assert.match(promptText(framed).detail, /frame inside https:\/\/news\.example/);
assert.equal(promptText(framed).message, 'https://widget.example wants to use your location.');
assert.match(promptText(framed).detail, /Allow once grants this request only/);

const idn = classifyPermissionRequest({ permission: 'notifications', requestingUrl: 'https://аpple.example/', topUrl: 'https://аpple.example/' });
assert.match(idn.origin, /^https:\/\/xn--/, 'look-alike domains are shown in punycode');

// --- Check handler --------------------------------------------------------

assert.equal(checkPermission({ permission: 'fullscreen', requestingOrigin: 'https://maps.example' }), true);
assert.equal(checkPermission({ permission: 'clipboard-sanitized-write', requestingOrigin: 'https://maps.example' }), true);
for (const permission of [...PROMPT_PERMISSIONS.keys(), 'media', 'openExternal', 'unknown']) {
  assert.equal(checkPermission({ permission, requestingOrigin: 'https://maps.example' }), false, permission);
}
for (const permission of ['fullscreen', 'clipboard-sanitized-write', 'notifications']) {
  assert.equal(checkPermission({ permission, requestingOrigin: 'sovereign://ask' }), false, permission);
}
assert.equal(checkPermission({ permission: 'fullscreen', requestingOrigin: '' }), false);

// --- Controller -----------------------------------------------------------

function fakeContents(url) {
  return {
    url,
    destroyed: false,
    getURL() { return this.url; },
    isDestroyed() { return this.destroyed; }
  };
}

function harness(answer) {
  const prompts = [];
  const records = [];
  let active = 0;
  let maxActive = 0;
  const controller = createPermissionController({
    prompt: async request => {
      prompts.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      if (typeof answer === 'function') return answer(request);
      return answer;
    },
    record: entry => records.push(entry)
  });
  const ask = (contents, permission, details = {}) => new Promise(resolve => {
    controller.request(contents, permission, granted => resolve(granted), { requestingUrl: contents.getURL(), ...details });
  });
  return { controller, prompts, records, ask, maxActive: () => maxActive };
}

async function testController() {
  {
    const h = harness('allow');
    const granted = await h.ask(fakeContents(WEB), 'media', { mediaTypes: ['video'] });
    assert.equal(granted, true);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].message, 'https://maps.example wants to use your camera.');
    assert.deepEqual(h.records, [{ origin: 'https://maps.example', name: 'camera', decision: DECISIONS.allowedOnce, embeddedIn: '' }]);
  }
  {
    const h = harness('deny');
    assert.equal(await h.ask(fakeContents(WEB), 'geolocation'), false);
    assert.equal(h.records[0].decision, DECISIONS.deniedByUser);
  }
  {
    const h = harness(() => { throw new Error('dialog failed'); });
    assert.equal(await h.ask(fakeContents(WEB), 'notifications'), false);
    assert.equal(h.records[0].decision, DECISIONS.deniedByUser);
  }
  {
    const h = harness('something-else');
    assert.equal(await h.ask(fakeContents(WEB), 'notifications'), false, 'only an explicit allow grants');
  }
  {
    const contents = fakeContents(WEB);
    const h = harness(() => { contents.destroyed = true; return 'allow'; });
    assert.equal(await h.ask(contents, 'media', { mediaTypes: ['audio'] }), false, 'tab closed while prompting');
    assert.equal(h.records[0].decision, DECISIONS.deniedStale);
  }
  {
    const contents = fakeContents(WEB);
    const h = harness(() => { contents.url = 'https://other.example/'; return 'allow'; });
    assert.equal(await h.ask(contents, 'geolocation'), false, 'page moved to another origin while prompting');
    assert.equal(h.records[0].decision, DECISIONS.deniedStale);
  }
  {
    const h = harness('allow');
    for (const url of INTERNAL_URLS) {
      assert.equal(await h.ask(fakeContents(url), 'notifications'), false, url);
    }
    for (const permission of ['openExternal', 'display-capture', 'hid', 'unknown']) {
      assert.equal(await h.ask(fakeContents(WEB), permission), false, permission);
    }
    assert.equal(await h.ask(fakeContents(WEB), 'media', { mediaTypes: [] }), false, 'screen capture');
    assert.equal(await h.ask(fakeContents(WEB), 'fullscreen'), true);
    assert.equal(h.prompts.length, 0, 'never prompts for denied or allowed-without-prompt permissions');
    assert.equal(h.records.length, INTERNAL_URLS.length + 6, 'every request is recorded once');
    assert.equal(h.records.at(-1).decision, DECISIONS.allowedAuto);
  }
  {
    const h = harness('allow');
    const results = await Promise.all([
      h.ask(fakeContents(WEB), 'geolocation'),
      h.ask(fakeContents('https://second.example/'), 'notifications')
    ]);
    assert.deepEqual(results, [true, true]);
    assert.equal(h.maxActive(), 1, 'prompts are shown one at a time');
    assert.deepEqual(h.records.map(record => record.origin), ['https://maps.example', 'https://second.example']);
  }
  {
    const records = [];
    const controller = createPermissionController({ prompt: async () => 'allow', record: entry => records.push(entry) });
    controller.recordAutoDenied(fakeContents(WEB), 'bluetooth');
    controller.recordAutoDenied(fakeContents('sovereign://ask/'), 'usb');
    controller.recordAutoDenied(null, 'screen capture');
    assert.deepEqual(records.map(record => record.decision), [DECISIONS.deniedUnsupported, DECISIONS.deniedInternal, DECISIONS.deniedUnknownSite]);
    assert.equal(controller.check(null, 'notifications', 'https://maps.example'), false);
    assert.equal(controller.check(null, 'fullscreen', 'https://maps.example'), true);
  }
  {
    const h = harness('allow');
    const controller = createPermissionController({
      prompt: async () => 'allow',
      record: () => { throw new Error('receipt failed'); }
    });
    const granted = await new Promise(resolve => controller.request(fakeContents(WEB), 'notifications', resolve, { requestingUrl: WEB }));
    assert.equal(granted, true, 'a failing receipt does not block the user decision');
    assert.equal(h.prompts.length, 0);
  }
  console.log('permission-policy tests passed');
}

testController().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
