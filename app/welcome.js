'use strict';

// Run-mode picker logic. Pre-selects a sensible default from whether the QUAKE display is present
// (present -> Panel, absent -> Software), lets the user override, then persists via choose().
(function () {
  const api = window.openQuakeWelcome;
  const cards = Array.from(document.querySelectorAll('.card'));
  const go = document.getElementById('go');
  const hint = document.getElementById('hint');
  let selected = null;

  function select(mode) {
    selected = mode;
    cards.forEach(c => c.classList.toggle('sel', c.dataset.mode === mode));
    go.disabled = false;
    if (mode === 'monitor') hint.textContent = 'Monitor mode needs the QUAKE connected as a display.';
    else if (mode === 'panel') hint.textContent = 'Panel mode needs the QUAKE / open-bedrock hardware.';
    else hint.textContent = '';
  }

  cards.forEach(c => c.addEventListener('click', () => select(c.dataset.mode)));

  go.addEventListener('click', () => {
    if (!selected) return;
    go.disabled = true;
    Promise.resolve(api.choose(selected)).catch(() => { go.disabled = false; });
  });

  Promise.resolve(api.getInfo()).then(info => {
    info = info || {};
    // A prior choice (re-run from Settings) wins the pre-selection; otherwise guess from hardware.
    const pre = (info.currentMode === 'panel' || info.currentMode === 'software' || info.currentMode === 'monitor')
      ? info.currentMode
      : (info.deviceDisplayPresent ? 'panel' : 'software');
    select(pre);
    if (!info.deviceDisplayPresent) {
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = 'No QUAKE display detected';
      const sw = document.querySelector('.card[data-mode="software"]');
      if (sw) sw.appendChild(badge);
    }
  }).catch(() => select('panel'));
})();
