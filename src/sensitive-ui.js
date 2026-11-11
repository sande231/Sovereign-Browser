// Local DOM only: the preview and main share the same identifier removal function.
(function attachSensitiveUI(global) {
  function render(container, { question, result, send, local, disabled = false }) {
    const guard = global.SovereignSensitiveGuard;
    const notice = document.createElement('section'); notice.className = 'sensitive-notice';
    const sentence = document.createElement('p');
    sentence.textContent = result.level === 'crisis' ? guard.CRISIS_REPLY : guard.notSentSentence(result.categories, result.modelFlag);
    notice.append(sentence);
    if (result.level === 'crisis') { container.append(notice); return; }
    if (result.categories.includes('self-harm')) {
      const line = document.createElement('p'); line.textContent = guard.CRISIS_SHORT_LINE; notice.append(line);
    }
    const button = (text, className, action) => {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'secondary-action ' + className;
      item.textContent = text; item.addEventListener('click', action); notice.append(item); return item;
    };
    if (local) button('Ask AI locally instead', 'sensitive-local', local);
    const anyway = button('Search anyway…', 'sensitive-anyway', () => {
      if (notice.querySelector('.sensitive-panel')) return;
      const panel = document.createElement('div'); panel.className = 'sensitive-panel';
      const input = document.createElement('textarea'); input.className = 'sensitive-query'; input.setAttribute('aria-label', 'Edit the search to send');
      const initial = guard.removeIdentifiers(question); input.value = initial.text; input.maxLength = 300;
      const removed = document.createElement('p'); removed.className = 'sensitive-removed';
      const describe = counts => {
        const labels = { email: 'email address', phone: 'phone number', address: 'street address', idNumber: 'ID number' };
        const parts = Object.entries(counts).filter(([,count]) => count).map(([kind,count]) => `${count} ${labels[kind]}${count > 1 ? (['email', 'address'].includes(kind) ? 'es' : 's') : ''}`);
        return parts.length ? 'Removed: ' + parts.join(', ') : 'No emails, phone numbers, addresses or ID numbers found.';
      };
      removed.textContent = describe(initial.removed);
      const label = document.createElement('p'); label.textContent = 'This exact text will be sent to your search service (SearXNG), which forwards it to public search engines:';
      const preview = document.createElement('pre'); preview.className = 'sensitive-preview';
      const sendButton = document.createElement('button'); sendButton.type = 'button'; sendButton.className = 'primary-action sensitive-send'; sendButton.textContent = 'Send this search';
      const update = () => {
        const clean = guard.removeIdentifiers(input.value); preview.textContent = clean.text;
        sendButton.disabled = disabled || !clean.text || clean.text.length > 300 || guard.classifyQuestion(input.value).level === 'crisis';
      };
      input.addEventListener('input', () => { removed.textContent = describe(guard.removeIdentifiers(input.value).removed); update(); });
      sendButton.addEventListener('click', () => { update(); if (!sendButton.disabled) { sendButton.disabled = true; send(input.value); } });
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-action'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', () => panel.remove());
      panel.append(input, removed, label, preview, sendButton, cancel); notice.append(panel); update(); input.focus();
    });
    anyway.disabled = disabled;
    container.append(notice);
  }
  global.SovereignSensitiveUI = { render };
})(window);
