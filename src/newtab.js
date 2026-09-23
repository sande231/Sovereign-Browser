const queryInput = document.querySelector('#home-query');
const searchForm = document.querySelector('#home-search');
const searchBox = document.querySelector('.home-search-box');
const attachButton = document.querySelector('#home-attach');
const attachmentInput = document.querySelector('#home-attachment-input');
const attachmentList = document.querySelector('#home-attachment-list');
const attachmentStatus = document.querySelector('#home-attachment-status');
const shortcutsRow = document.querySelector('#shortcuts-row');
const shortcutEditor = document.querySelector('#shortcut-editor');
const shortcutEditorTitle = document.querySelector('#shortcut-editor-title');
const shortcutTitleInput = document.querySelector('#shortcut-title');
const shortcutUrlInput = document.querySelector('#shortcut-url');
const shortcutHelp = document.querySelector('#shortcut-help');
const shortcutCancelButton = document.querySelector('#shortcut-cancel');

const SHORTCUTS_KEY = 'sovereign.shortcuts';
const DEFAULT_SHORTCUTS = [
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'Python', url: 'https://www.python.org/' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' }
];
const MAX_ATTACHMENTS = 3;
const MAX_NON_PDF_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'pdf']);
const SUPPORTED_ATTACHMENT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/pdf']);

let editingIndex = -1;
const homeAttachments = [];

function normalizeShortcutTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function normalizeShortcutUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return { ok: false, error: 'Enter a shortcut URL.' };
  }

  let candidate = raw;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'Enter a valid HTTP or HTTPS URL.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'Shortcuts support HTTP and HTTPS websites only.' };
  }

  if (!parsed.hostname) {
    return { ok: false, error: 'Shortcut URLs need a website host.' };
  }

  return { ok: true, url: parsed.toString() };
}

function cleanShortcut(item) {
  const title = normalizeShortcutTitle(item?.title);
  const checked = normalizeShortcutUrl(item?.url);
  return title && checked.ok ? { title, url: checked.url } : null;
}

function shortcutList() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || 'null');
    if (Array.isArray(parsed)) {
      const items = parsed.slice(0, 6).map(cleanShortcut).filter(Boolean);
      if (items.length > 0) {
        return items;
      }
    }
  } catch {
    // Use defaults if local data is malformed.
  }
  return DEFAULT_SHORTCUTS;
}

function saveShortcuts(items) {
  const clean = items.slice(0, 6).map(cleanShortcut).filter(Boolean);
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(clean));
  return clean;
}

function selectedMode() {
  return document.querySelector('input[name="home-mode"]:checked')?.value === 'ask' ? 'ask' : 'search';
}

function setSelectedMode(mode) {
  const input = document.querySelector(`input[name="home-mode"][value="${mode === 'ask' ? 'ask' : 'search'}"]`);
  if (input) {
    input.checked = true;
  }
}

function attachmentId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function attachmentExtension(name) {
  return String(name || '').toLowerCase().split('.').pop() || '';
}

function validateAttachmentFile(file) {
  if (!file) {
    return 'Could not read that file.';
  }
  const extension = attachmentExtension(file.name);
  const type = file.type || '';
  const pdf = extension === 'pdf' || type === 'application/pdf';
  const limit = pdf ? MAX_PDF_ATTACHMENT_BYTES : MAX_NON_PDF_ATTACHMENT_BYTES;
  if (file.size > limit) {
    return pdf ? 'PDF files must be 25 MB or smaller.' : 'Files must be 5 MB or smaller.';
  }
  if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension) && !SUPPORTED_ATTACHMENT_TYPES.has(type)) {
    return 'Attach PDF, TXT, Markdown, or CSV files.';
  }
  return '';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

function setAttachmentStatus(message, isError = false) {
  attachmentStatus.textContent = message || '';
  attachmentStatus.classList.toggle('error', Boolean(isError));
}

function readyAttachments() {
  return homeAttachments.filter(item => item.status === 'ready' && item.dataUrl);
}

function removeAttachment(id) {
  const index = homeAttachments.findIndex(item => item.id === id);
  if (index !== -1) {
    homeAttachments.splice(index, 1);
    renderAttachments();
  }
}

function renderAttachments() {
  attachmentList.replaceChildren();
  if (homeAttachments.length === 0) {
    setAttachmentStatus('');
    return;
  }

  homeAttachments.forEach(item => {
    const chip = document.createElement('div');
    chip.className = `home-attachment-chip ${item.status}`;

    const label = document.createElement('span');
    label.textContent = item.status === 'error'
      ? `${item.name}: ${item.error}`
      : `${item.name} (${item.status})`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'home-attachment-remove';
    remove.textContent = 'Remove';
    remove.title = `Remove ${item.name}`;
    remove.addEventListener('click', () => removeAttachment(item.id));

    chip.append(label, remove);
    attachmentList.append(chip);
  });

  const ready = readyAttachments().length;
  const errors = homeAttachments.filter(item => item.status === 'error').length;
  if (ready > 0) {
    setAttachmentStatus(`${ready} file${ready === 1 ? '' : 's'} will open in Ask AI. Attachments stay local to the Ask chat.`);
  } else if (errors > 0) {
    setAttachmentStatus('No supported files are ready to send to Ask AI.', true);
  }
}

async function addAttachmentFiles(files) {
  const incoming = Array.from(files || []);
  if (incoming.length === 0) {
    return;
  }
  setSelectedMode('ask');
  for (const file of incoming) {
    if (homeAttachments.filter(item => item.status !== 'error').length >= MAX_ATTACHMENTS) {
      setAttachmentStatus(`You can attach up to ${MAX_ATTACHMENTS} files.`, true);
      break;
    }
    const item = {
      id: attachmentId(),
      name: file.name || 'attachment',
      type: file.type || '',
      size: file.size || 0,
      status: 'reading',
      dataUrl: '',
      error: ''
    };
    homeAttachments.push(item);
    renderAttachments();
    const validationError = validateAttachmentFile(file);
    if (validationError) {
      item.status = 'error';
      item.error = validationError;
      renderAttachments();
      continue;
    }
    try {
      item.dataUrl = await fileToDataUrl(file);
      item.status = 'ready';
    } catch (error) {
      item.status = 'error';
      item.error = error.message || String(error);
    }
    renderAttachments();
  }
  attachmentInput.value = '';
}

function openShortcut(url) {
  const checked = normalizeShortcutUrl(url);
  if (!checked.ok) {
    shortcutHelp.textContent = checked.error;
    return;
  }
  window.sovereign.navigate(checked.url);
}

function setShortcutMessage(message) {
  shortcutHelp.textContent = message || 'Home-page shortcuts use HTTP or HTTPS addresses and are stored locally.';
}

function closeShortcutEditor(options = {}) {
  shortcutEditor.hidden = true;
  editingIndex = -1;
  shortcutEditor.reset();
  setShortcutMessage('');
  if (options.focusAdd) {
    document.querySelector('.shortcut-add')?.focus();
  }
}

function showShortcutEditor(index = -1) {
  const items = shortcutList();
  const current = index >= 0 ? items[index] : { title: '', url: '' };
  editingIndex = index;
  shortcutEditorTitle.textContent = index >= 0 ? 'Edit shortcut' : 'Add shortcut';
  shortcutTitleInput.value = current?.title || '';
  shortcutUrlInput.value = current?.url || '';
  setShortcutMessage('');
  shortcutEditor.hidden = false;
  shortcutTitleInput.focus();
  shortcutTitleInput.select();
}

function saveShortcutFromEditor() {
  const title = normalizeShortcutTitle(shortcutTitleInput.value);
  const checked = normalizeShortcutUrl(shortcutUrlInput.value);
  if (!title) {
    setShortcutMessage('Enter a shortcut title.');
    shortcutTitleInput.focus();
    return;
  }
  if (!checked.ok) {
    setShortcutMessage(checked.error);
    shortcutUrlInput.focus();
    return;
  }

  const items = shortcutList();
  const next = { title, url: checked.url };
  if (editingIndex >= 0 && editingIndex < items.length) {
    items[editingIndex] = next;
  } else if (items.length < 6) {
    items.push(next);
  } else {
    setShortcutMessage('You can keep up to 6 shortcuts.');
    return;
  }

  saveShortcuts(items);
  renderShortcuts();
  closeShortcutEditor();
}

function deleteShortcut(index) {
  const items = shortcutList();
  if (index < 0 || index >= items.length) {
    return;
  }
  items.splice(index, 1);
  saveShortcuts(items);
  renderShortcuts();
  closeShortcutEditor({ focusAdd: true });
}

function moveShortcut(index, direction) {
  const items = shortcutList();
  const target = index + direction;
  if (index < 0 || target < 0 || index >= items.length || target >= items.length) {
    return;
  }
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
  saveShortcuts(items);
  renderShortcuts();
  const movedTile = shortcutsRow.querySelector(`[data-shortcut-index="${target}"] .shortcut-open`);
  movedTile?.focus();
}

function shortcutActionButton(label, title, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'shortcut-action';
  button.textContent = label;
  button.title = title;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function renderShortcuts() {
  const items = shortcutList();
  shortcutsRow.replaceChildren();

  items.forEach((item, index) => {
    const tile = document.createElement('div');
    tile.className = 'shortcut-tile';
    tile.dataset.shortcutIndex = String(index);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'shortcut-open';
    open.textContent = item.title;
    open.title = item.url;
    open.addEventListener('click', () => openShortcut(item.url));

    const actions = document.createElement('div');
    actions.className = 'shortcut-actions';
    actions.append(
      shortcutActionButton('Edit', `Edit ${item.title}`, () => showShortcutEditor(index)),
      shortcutActionButton('←', `Move ${item.title} left`, () => moveShortcut(index, -1), index === 0),
      shortcutActionButton('→', `Move ${item.title} right`, () => moveShortcut(index, 1), index === items.length - 1),
      shortcutActionButton('Delete', `Delete ${item.title}`, () => deleteShortcut(index))
    );

    tile.append(open, actions);
    shortcutsRow.append(tile);
  });

  if (items.length < 6) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'shortcut-add';
    add.textContent = '+ Add';
    add.title = 'Add a home-page shortcut';
    add.addEventListener('click', () => showShortcutEditor(-1));
    shortcutsRow.append(add);
  }
}

searchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const attachments = readyAttachments();
  const question = queryInput.value.replace(/\s+/g, ' ').trim() ||
    (attachments.length > 0 ? 'Summarize the attached files.' : '');
  if (!question) {
    queryInput.focus();
    return;
  }
  const mode = attachments.length > 0 ? 'ask' : selectedMode();
  let handoffId = '';
  if (attachments.length > 0) {
    try {
      const result = await window.sovereign.askHandoff.create({ files: attachments });
      handoffId = result?.id || '';
      if (!handoffId) {
        setAttachmentStatus('Could not prepare the attached files for Ask AI.', true);
        return;
      }
    } catch (error) {
      setAttachmentStatus(`Could not prepare attachments: ${error.message}`, true);
      return;
    }
  }
  window.sovereign.openSearch({
    question,
    mode,
    autoRun: true,
    handoffId
  });
});

attachButton.addEventListener('click', () => {
  attachmentInput.click();
});

attachmentInput.addEventListener('change', () => {
  addAttachmentFiles(attachmentInput.files).catch(error => setAttachmentStatus(error.message, true));
});

searchBox.addEventListener('dragover', event => {
  event.preventDefault();
  searchBox.classList.add('drag-over');
});

searchBox.addEventListener('dragleave', () => {
  searchBox.classList.remove('drag-over');
});

searchBox.addEventListener('drop', event => {
  event.preventDefault();
  searchBox.classList.remove('drag-over');
  addAttachmentFiles(event.dataTransfer?.files).catch(error => setAttachmentStatus(error.message, true));
});

shortcutEditor.addEventListener('submit', event => {
  event.preventDefault();
  saveShortcutFromEditor();
});

shortcutCancelButton.addEventListener('click', () => closeShortcutEditor({ focusAdd: true }));

shortcutEditor.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeShortcutEditor({ focusAdd: true });
  }
});

window.SovereignNewTab = {
  focusSearch() {
    queryInput.focus();
  },
  getShortcuts() {
    return shortcutList();
  },
  setShortcuts(items) {
    saveShortcuts(Array.isArray(items) ? items : []);
    renderShortcuts();
  },
  attachments() {
    return homeAttachments.map(item => ({
      name: item.name,
      status: item.status,
      error: item.error
    }));
  }
};

renderShortcuts();
queryInput.focus();
