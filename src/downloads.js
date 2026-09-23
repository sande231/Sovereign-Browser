const statusLine = document.querySelector('#downloads-status');
const downloadsList = document.querySelector('#downloads-list');
const clearFinishedButton = document.querySelector('#downloads-clear-finished');

let downloadsState = { downloads: [] };

function setStatus(message, isError = false) {
  statusLine.textContent = message || '';
  statusLine.classList.toggle('error', Boolean(isError));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function statusText(download) {
  if (download.paused) {
    return 'Paused';
  }
  if (download.status === 'progressing' || download.state === 'progressing') {
    return 'Downloading';
  }
  if (download.status === 'completed' || download.state === 'completed') {
    return 'Completed';
  }
  if (download.status === 'cancelled' || download.state === 'cancelled') {
    return 'Canceled';
  }
  if (download.status === 'interrupted' || download.state === 'interrupted') {
    return 'Failed';
  }
  if (download.status === 'Choose a save location') {
    return 'Waiting for save location';
  }
  return download.status || download.state || 'Starting';
}

function progressText(download) {
  const total = Number(download.totalBytes || 0);
  const received = Number(download.receivedBytes || 0);
  const bytes = total > 0 ? `${formatBytes(received)} of ${formatBytes(total)}` : formatBytes(received);
  const percent = Number(download.percent);
  return Number.isFinite(percent) && percent >= 0 ? `${bytes} (${Math.round(percent)}%)` : bytes;
}

function isActive(download) {
  return download.state === 'progressing' || download.status === 'progressing' || download.paused;
}

function button(label, handler, disabled = false) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'secondary-action compact-action';
  item.textContent = label;
  item.disabled = disabled;
  item.addEventListener('click', handler);
  return item;
}

function renderDownload(download) {
  const card = document.createElement('article');
  card.className = `download-card ${download.status || download.state || ''}`;

  const title = document.createElement('div');
  title.className = 'download-title';
  title.textContent = download.filename || 'Download';

  const source = document.createElement('div');
  source.className = 'download-source';
  source.textContent = download.url || '';

  const meta = document.createElement('div');
  meta.className = 'download-meta';
  meta.textContent = `${statusText(download)} · ${progressText(download)}`;

  const progress = document.createElement('progress');
  progress.className = 'download-progress';
  progress.max = 100;
  progress.value = Number.isFinite(download.percent) && download.percent >= 0 ? Math.min(100, download.percent) : 0;

  const actions = document.createElement('div');
  actions.className = 'download-actions';
  if (isActive(download)) {
    actions.append(
      button(download.paused ? 'Resume' : 'Pause', () => {
        if (download.paused) {
          window.sovereign.downloads.resume(download.id);
        } else {
          window.sovereign.downloads.pause(download.id);
        }
      }, download.paused ? !download.canResume : false),
      button('Cancel', () => window.sovereign.downloads.cancel(download.id))
    );
  } else {
    actions.append(
      button('Show in Finder', () => window.sovereign.downloads.showInFolder(download.id), !download.savePath),
      button('Open', async () => {
        try {
          await window.sovereign.downloads.openFile(download.id);
        } catch (error) {
          setStatus(error.message, true);
        }
      }, download.state !== 'completed'),
      button('Clear', () => window.sovereign.downloads.clear(download.id))
    );
  }

  card.append(title, source, meta, progress, actions);
  if (download.error) {
    const error = document.createElement('div');
    error.className = 'activity-error';
    error.textContent = download.error;
    card.append(error);
  }
  return card;
}

function render(state = downloadsState) {
  downloadsState = state || { downloads: [] };
  downloadsList.replaceChildren();
  const items = downloadsState.downloads || [];
  clearFinishedButton.disabled = !items.some(item => !isActive(item));

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No downloads yet. Files you download from websites will appear here.';
    downloadsList.append(empty);
    return;
  }
  items.forEach(download => downloadsList.append(renderDownload(download)));
}

clearFinishedButton.addEventListener('click', () => {
  window.sovereign.downloads.clearFinished();
});

window.sovereign.downloads.onState(render);
window.sovereign.downloads.getState().then(render).catch(error => {
  setStatus(`Could not load downloads: ${error.message}`, true);
});
