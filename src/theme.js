(function attachSovereignTheme(global) {
  const STORAGE_KEY = 'sovereign.theme';
  const MODES = new Set(['system', 'light', 'dark']);

  function storedMode() {
    const value = global.localStorage?.getItem(STORAGE_KEY) || 'system';
    return MODES.has(value) ? value : 'system';
  }

  function apply(mode = storedMode()) {
    const clean = MODES.has(mode) ? mode : 'system';
    if (clean === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.dataset.theme = clean;
    }
    return clean;
  }

  function set(mode) {
    const clean = MODES.has(mode) ? mode : 'system';
    global.localStorage?.setItem(STORAGE_KEY, clean);
    apply(clean);
    return clean;
  }

  apply();
  global.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) {
      apply();
    }
  });

  global.SovereignTheme = {
    get: storedMode,
    set,
    apply
  };
})(window);
