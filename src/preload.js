const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sovereign', {
  getState: () => ipcRenderer.invoke('browser:get-state'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
  onError: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('browser:error', listener);
    return () => ipcRenderer.removeListener('browser:error', listener);
  },
  onFocusAddress: callback => {
    const listener = () => callback();
    ipcRenderer.on('browser:focus-address', listener);
    return () => ipcRenderer.removeListener('browser:focus-address', listener);
  },
  newTab: url => ipcRenderer.send('browser:new-tab', url),
  openSearch: payload => ipcRenderer.send('browser:open-search', payload),
  openDownloads: () => ipcRenderer.send('browser:open-downloads'),
  toggleDownloadsPanel: () => ipcRenderer.send('browser:toggle-downloads-panel'),
  setDownloadsPanelVisible: visible => ipcRenderer.send('browser:set-downloads-panel-visible', visible),
  openSettings: () => ipcRenderer.send('browser:open-settings'),
  openBookmarks: () => ipcRenderer.send('browser:open-bookmarks'),
  toggleBookmark: () => ipcRenderer.invoke('browser:toggle-bookmark'),
  copyText: text => ipcRenderer.invoke('browser:copy-text', text),
  reopenClosedTab: () => ipcRenderer.send('browser:reopen-closed-tab'),
  switchTab: tabId => ipcRenderer.send('browser:switch-tab', tabId),
  closeTab: tabId => ipcRenderer.send('browser:close-tab', tabId),
  detachTab: (tabId, position) => ipcRenderer.send('browser:detach-tab', tabId, position),
  showTabMenu: tabId => ipcRenderer.send('browser:show-tab-menu', tabId),
  toggleSidebar: () => ipcRenderer.send('browser:toggle-sidebar'),
  navigate: url => ipcRenderer.send('browser:navigate', url),
  back: () => ipcRenderer.send('browser:back'),
  forward: () => ipcRenderer.send('browser:forward'),
  reload: () => ipcRenderer.send('browser:reload'),
  showFindBar: () => ipcRenderer.send('browser:set-find-bar-visible', true),
  hideFindBar: () => ipcRenderer.send('browser:set-find-bar-visible', false),
  findInPage: query => ipcRenderer.send('browser:find-in-page', query),
  findNext: query => ipcRenderer.send('browser:find-next', query),
  findPrevious: query => ipcRenderer.send('browser:find-previous', query),
  stopFind: () => ipcRenderer.send('browser:stop-find'),
  onShowFindBar: callback => {
    const listener = () => callback();
    ipcRenderer.on('browser:show-find-bar', listener);
    return () => ipcRenderer.removeListener('browser:show-find-bar', listener);
  },
  onFindResult: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('find:result', listener);
    return () => ipcRenderer.removeListener('find:result', listener);
  },
  ai: {
    getState: () => ipcRenderer.invoke('ai:get-state'),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('ai:state', listener);
      return () => ipcRenderer.removeListener('ai:state', listener);
    },
    extractActivePageText: () => ipcRenderer.invoke('ai:extract-active-page-text'),
    updateTabState: (tabId, patch) => ipcRenderer.send('ai:update-tab-state', tabId, patch),
    getNetworkLog: () => ipcRenderer.invoke('ai:get-network-log')
  },
  search: {
    getSettings: () => ipcRenderer.invoke('search:get-settings'),
    updateSettings: patch => ipcRenderer.invoke('search:update-settings', patch),
    query: request => ipcRenderer.invoke('search:query', request),
    media: request => ipcRenderer.invoke('search:media', request),
    readSources: request => ipcRenderer.invoke('search:read-sources', request),
    cancel: requestId => ipcRenderer.send('search:cancel', requestId),
    onActivity: callback => {
      const listener = (_event, activity) => callback(activity);
      ipcRenderer.on('search:activity', listener);
      return () => ipcRenderer.removeListener('search:activity', listener);
    }
  },
  media: {
    preflight: request => ipcRenderer.invoke('media:preflight', request),
    download: request => ipcRenderer.invoke('media:download', request)
  },
  privacy: {
    getLatestReceipt: () => ipcRenderer.invoke('privacy:get-latest-receipt'),
    getReceipts: () => ipcRenderer.invoke('privacy:get-receipts'),
    exportReceipts: () => ipcRenderer.invoke('privacy:export-receipts'),
    onReceiptUpdated: callback => {
      const listener = (_event, receipt) => callback(receipt);
      ipcRenderer.on('privacy:receipt-updated', listener);
      return () => ipcRenderer.removeListener('privacy:receipt-updated', listener);
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    updateDownloads: patch => ipcRenderer.invoke('settings:update-downloads', patch),
    updateStartup: patch => ipcRenderer.invoke('settings:update-startup', patch),
    updateAi: patch => ipcRenderer.invoke('settings:update-ai', patch),
    chooseDownloadDirectory: () => ipcRenderer.invoke('settings:choose-download-directory')
  },
  modelSetup: {
    getState: () => ipcRenderer.invoke('model-setup:get-state'),
    start: () => ipcRenderer.invoke('model-setup:start'),
    cancel: () => ipcRenderer.invoke('model-setup:cancel'),
    updateSettings: patch => ipcRenderer.invoke('model-setup:update-settings', patch),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('model-setup:state', listener);
      return () => ipcRenderer.removeListener('model-setup:state', listener);
    }
  },
  modelSetupWorker: {
    ready: () => ipcRenderer.send('model-setup:worker-ready'),
    report: patch => ipcRenderer.send('model-setup:worker-state', patch),
    onCommand: callback => {
      const listener = (_event, command) => callback(command);
      ipcRenderer.on('model-setup:command', listener);
      return () => ipcRenderer.removeListener('model-setup:command', listener);
    }
  },
  askHandoff: {
    create: payload => ipcRenderer.invoke('ask-handoff:create', payload),
    consume: id => ipcRenderer.invoke('ask-handoff:consume', id)
  },
  bookmarks: {
    get: () => ipcRenderer.invoke('bookmarks:get'),
    add: bookmark => ipcRenderer.invoke('bookmarks:add', bookmark),
    rename: (id, title) => ipcRenderer.invoke('bookmarks:rename', id, title),
    remove: idOrUrl => ipcRenderer.invoke('bookmarks:remove', idOrUrl),
    open: url => ipcRenderer.send('bookmarks:open', url),
    openCurrentTab: url => ipcRenderer.send('bookmarks:open-current-tab', url),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('bookmarks:state', listener);
      return () => ipcRenderer.removeListener('bookmarks:state', listener);
    }
  },
  downloads: {
    getState: () => ipcRenderer.invoke('downloads:get-state'),
    downloadUrl: url => ipcRenderer.invoke('downloads:download-url', url),
    cancel: downloadId => ipcRenderer.send('downloads:cancel', downloadId),
    pause: downloadId => ipcRenderer.send('downloads:pause', downloadId),
    resume: downloadId => ipcRenderer.send('downloads:resume', downloadId),
    clear: downloadId => ipcRenderer.send('downloads:clear', downloadId),
    clearFinished: () => ipcRenderer.send('downloads:clear-finished'),
    showInFolder: downloadId => ipcRenderer.send('downloads:show-in-folder', downloadId),
    openFile: downloadId => ipcRenderer.invoke('downloads:open-file', downloadId),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('downloads:state', listener);
      return () => ipcRenderer.removeListener('downloads:state', listener);
    }
  }
});
