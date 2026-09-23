const searchInput = document.querySelector('#bookmarks-search');
const bookmarksList = document.querySelector('#bookmarks-list');
const statusLine = document.querySelector('#bookmarks-status');
const openCurrentButton = document.querySelector('#open-current');

let bookmarksState = { bookmarks: [] };
let selectedBookmarkId = '';

function setStatus(message, isError = false) {
  statusLine.textContent = message || '';
  statusLine.classList.toggle('error', Boolean(isError));
}

function filteredBookmarks() {
  const query = searchInput.value.replace(/\s+/g, ' ').trim().toLowerCase();
  const items = bookmarksState.bookmarks || [];
  if (!query) {
    return items;
  }
  return items.filter(bookmark => (
    String(bookmark.title || '').toLowerCase().includes(query) ||
    String(bookmark.url || '').toLowerCase().includes(query)
  ));
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

function renderBookmark(bookmark) {
  const card = document.createElement('article');
  card.className = 'bookmark-card';
  if (bookmark.id === selectedBookmarkId) {
    card.classList.add('selected');
  }

  const info = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'bookmark-title';
  title.textContent = bookmark.title || 'Untitled';
  const url = document.createElement('div');
  url.className = 'bookmark-url';
  url.textContent = bookmark.url || '';
  info.append(title, url);

  const actions = document.createElement('div');
  actions.className = 'bookmark-actions';
  actions.append(
    button('Open', () => {
      selectedBookmarkId = bookmark.id;
      window.sovereign.bookmarks.open(bookmark.url);
    }),
    button('Rename', async () => {
      const nextTitle = window.prompt('Bookmark name', bookmark.title || '');
      if (nextTitle === null) {
        return;
      }
      try {
        const state = await window.sovereign.bookmarks.rename(bookmark.id, nextTitle);
        render(state);
        setStatus('Bookmark renamed.');
      } catch (error) {
        setStatus(error.message, true);
      }
    }),
    button('Delete', async () => {
      try {
        const state = await window.sovereign.bookmarks.remove(bookmark.id);
        render(state);
        setStatus('Bookmark deleted.');
      } catch (error) {
        setStatus(error.message, true);
      }
    })
  );

  card.append(info, actions);
  card.addEventListener('click', () => {
    selectedBookmarkId = bookmark.id;
    render();
  });
  return card;
}

function render(state = bookmarksState) {
  bookmarksState = state || { bookmarks: [] };
  bookmarksList.replaceChildren();
  const items = filteredBookmarks();
  openCurrentButton.disabled = !selectedBookmarkId;

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = searchInput.value ? 'No bookmarks match that search.' : 'No bookmarks yet. Use the star in the address bar or Cmd+D to save a page.';
    bookmarksList.append(empty);
    return;
  }

  items.forEach(bookmark => bookmarksList.append(renderBookmark(bookmark)));
}

openCurrentButton.addEventListener('click', () => {
  const bookmark = (bookmarksState.bookmarks || []).find(item => item.id === selectedBookmarkId);
  if (!bookmark) {
    setStatus('Select a bookmark first.', true);
    return;
  }
  window.sovereign.bookmarks.openCurrentTab(bookmark.url);
});

searchInput.addEventListener('input', () => render());

window.sovereign.bookmarks.onState(render);
window.sovereign.bookmarks.get().then(render).catch(error => {
  setStatus(`Could not load bookmarks: ${error.message}`, true);
});
