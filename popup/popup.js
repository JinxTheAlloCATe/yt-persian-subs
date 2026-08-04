/* Popup settings. Everything persists to storage.sync the moment it changes,
   so there is no save button to forget about. */

const DEFAULTS = {
  enabled: true,
  apiKey: '',
  model: 'google/gemini-2.0-flash-001',
  fontSize: 26,
  showOriginal: false,
};

const $ = (id) => document.getElementById(id);

const el = {
  enabled: $('enabled'),
  apiKey: $('apiKey'),
  reveal: $('reveal'),
  verify: $('verify'),
  keyStatus: $('keyStatus'),
  model: $('model'),
  customModel: $('customModel'),
  fontSize: $('fontSize'),
  fontSizeOut: $('fontSizeOut'),
  showOriginal: $('showOriginal'),
  clearCache: $('clearCache'),
  cacheStatus: $('cacheStatus'),
};

const save = (patch) => chrome.storage.sync.set(patch);

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'no response' });
    });
  });

function setStatus(node, text, tone) {
  node.textContent = text;
  node.hidden = !text;
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

/** Point the select at `id`, falling back to the custom field for unknown ids. */
function showModel(id) {
  const known = [...el.model.options].some(
    (option) => option.value === id && option.value !== '__custom__'
  );
  if (known) {
    el.model.value = id;
    el.customModel.hidden = true;
    el.customModel.value = '';
  } else {
    el.model.value = '__custom__';
    el.customModel.hidden = false;
    el.customModel.value = id;
  }
}

/* ----------------------------------------------------------------- init */

chrome.storage.sync.get(DEFAULTS, (stored) => {
  const settings = { ...DEFAULTS, ...stored };
  el.enabled.checked = settings.enabled;
  el.apiKey.value = settings.apiKey;
  el.fontSize.value = settings.fontSize;
  el.fontSizeOut.value = `${settings.fontSize}px`;
  el.showOriginal.checked = settings.showOriginal;
  showModel(settings.model);
});

/* -------------------------------------------------------------- wiring */

el.enabled.addEventListener('change', () => save({ enabled: el.enabled.checked }));

el.showOriginal.addEventListener('change', () =>
  save({ showOriginal: el.showOriginal.checked })
);

el.fontSize.addEventListener('input', () => {
  const size = Number(el.fontSize.value);
  el.fontSizeOut.value = `${size}px`;
  save({ fontSize: size });
});

el.apiKey.addEventListener('change', () => {
  save({ apiKey: el.apiKey.value.trim() });
  setStatus(el.keyStatus, '');
});

el.reveal.addEventListener('click', () => {
  const hidden = el.apiKey.type === 'password';
  el.apiKey.type = hidden ? 'text' : 'password';
  el.reveal.textContent = hidden ? 'Hide' : 'Show';
});

el.model.addEventListener('change', () => {
  if (el.model.value === '__custom__') {
    el.customModel.hidden = false;
    el.customModel.focus();
    return;
  }
  el.customModel.hidden = true;
  save({ model: el.model.value });
});

el.customModel.addEventListener('change', () => {
  const id = el.customModel.value.trim();
  if (id) save({ model: id });
});

el.verify.addEventListener('click', async () => {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) {
    setStatus(el.keyStatus, 'Enter a key first.', 'error');
    return;
  }

  save({ apiKey });
  el.verify.disabled = true;
  setStatus(el.keyStatus, 'Checking…');

  const result = await send({ type: 'VERIFY_KEY', apiKey });
  el.verify.disabled = false;

  if (!result.ok) {
    setStatus(el.keyStatus, result.error || 'Key rejected.', 'error');
    return;
  }

  const detail = [];
  if (result.label) detail.push(result.label);
  if (typeof result.usage === 'number') {
    detail.push(`$${result.usage.toFixed(3)} used`);
  }
  if (typeof result.limit === 'number') {
    detail.push(`$${result.limit.toFixed(2)} limit`);
  }
  const suffix = detail.length ? ` — ${detail.join(' · ')}` : '';
  setStatus(el.keyStatus, `Key works${suffix}`, 'ok');
});

el.clearCache.addEventListener('click', async () => {
  const result = await send({ type: 'CLEAR_CACHE' });
  el.cacheStatus.textContent = result.ok
    ? `Cleared ${result.cleared} batches`
    : 'Failed';
  setTimeout(() => {
    el.cacheStatus.textContent = '';
  }, 2500);
});
