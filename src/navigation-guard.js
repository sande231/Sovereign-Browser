// Preload-bearing views must never load other pages (PLAN Task 2d-a).
const lockedContents = new WeakSet();

function lockNavigation(contents) {
  if (lockedContents.has(contents)) return;
  lockedContents.add(contents);
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

module.exports = { lockNavigation };
