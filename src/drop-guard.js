// Block page-navigation drops while preserving drops into editable text fields.
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, event => {
    if (!event.target?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
      event.preventDefault();
    }
  });
}
