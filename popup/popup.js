/* Popup settings. Everything persists to storage.sync the moment it changes,
   so there is no save button to forget about. */

const DEFAULTS = {
  enabled: true,
  apiKey: '',
  model: 'google/gemini-3.6-flash',
  fontSize: 26,
  showOriginal: false,
  textColor: '#ffffff',
};

// The colours subtitles conventionally use, for one-tap selection; the picker
// beside them takes anything.
const SWATCHES = [
  { value: '#ffffff', label: 'White' },
  { value: '#ffe14d', label: 'Yellow' },
  { value: '#7ee8fa', label: 'Cyan' },
  { value: '#9dff8a', label: 'Green' },
];

// Shortcuts only — the field accepts any of OpenRouter's models, and the
// datalist is filled from their live catalogue so it cannot go stale.
const PICKS = [
  { id: 'google/gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: '~deepseek/deepseek-v4-flash-latest', label: 'DeepSeek V4 Flash' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
];

const $ = (id) => document.getElementById(id);

const el = {
  enabled: $('enabled'),
  apiKey: $('apiKey'),
  reveal: $('reveal'),
  verify: $('verify'),
  keyStatus: $('keyStatus'),
  model: $('model'),
  modelList: $('modelList'),
  modelStatus: $('modelStatus'),
  refreshModels: $('refreshModels'),
  picks: $('picks'),
  fontSize: $('fontSize'),
  fontSizeOut: $('fontSizeOut'),
  showOriginal: $('showOriginal'),
  clearCache: $('clearCache'),
  cacheStatus: $('cacheStatus'),
  textColor: $('textColor'),
  swatches: $('swatches'),
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

/* --------------------------------------------------------------- colour */

function renderSwatches(selected) {
  el.swatches.replaceChildren(
    ...SWATCHES.map(({ value, label }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.background = value;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(value === selected.toLowerCase()));
      button.addEventListener('click', () => {
        el.textColor.value = value;
        save({ textColor: value });
        renderSwatches(value);
      });
      return button;
    })
  );
}

/* --------------------------------------------------------------- models */

let catalogue = []; // [{ id, name, prompt, completion }]

const price = (perMillion) =>
  perMillion >= 1 ? `$${perMillion.toFixed(2)}` : `${(perMillion * 100).toFixed(2)}¢`;

function renderPicks(selected) {
  el.picks.replaceChildren(
    ...PICKS.map(({ id, label }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick';
      button.textContent = label;
      button.title = id;
      button.setAttribute('aria-pressed', String(id === selected));
      button.addEventListener('click', () => {
        el.model.value = id;
        save({ model: id });
        renderPicks(id);
        describeModel(id);
      });
      return button;
    })
  );
}

/** Report whether the typed id exists, and what it costs. */
function describeModel(id) {
  if (!id) {
    setStatus(el.modelStatus, 'No model set — translation will fail.', 'error');
    return;
  }
  if (!catalogue.length) {
    setStatus(el.modelStatus, '');
    return;
  }

  const model = catalogue.find((entry) => entry.id === id);
  if (!model) {
    // The exact cause of the "model not found" failures this replaces.
    setStatus(
      el.modelStatus,
      'Not in OpenRouter’s catalogue — check the spelling.',
      'error'
    );
    return;
  }
  setStatus(
    el.modelStatus,
    `${model.name} — ${price(model.prompt)}/M in, ${price(model.completion)}/M out`,
    'ok'
  );
}

async function loadModels({ refresh } = {}) {
  if (refresh) setStatus(el.modelStatus, 'Fetching model list…');
  const result = await send({ type: 'LIST_MODELS', refresh: Boolean(refresh) });

  if (!result.ok) {
    setStatus(el.modelStatus, result.error || 'Could not load models.', 'error');
    return;
  }

  catalogue = result.models;
  el.modelList.replaceChildren(
    ...catalogue.map((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.label = `${model.name} — ${price(model.prompt)}/M`;
      return option;
    })
  );
  describeModel(el.model.value.trim());
}

/* ----------------------------------------------------------------- init */

chrome.storage.sync.get(DEFAULTS, (stored) => {
  const settings = { ...DEFAULTS, ...stored };
  el.enabled.checked = settings.enabled;
  el.apiKey.value = settings.apiKey;
  el.fontSize.value = settings.fontSize;
  el.fontSizeOut.value = `${settings.fontSize}px`;
  el.showOriginal.checked = settings.showOriginal;
  el.textColor.value = settings.textColor;
  renderSwatches(settings.textColor);
  el.model.value = settings.model;
  renderPicks(settings.model);
  loadModels();
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

// 'input' rather than 'change', so picking from the datalist saves immediately.
el.model.addEventListener('input', () => {
  const id = el.model.value.trim();
  renderPicks(id);
  describeModel(id);
  if (id) save({ model: id });
});

el.refreshModels.addEventListener('click', () => loadModels({ refresh: true }));

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

// 'input' rather than 'change', so dragging in the picker updates live.
el.textColor.addEventListener('input', () => {
  const value = el.textColor.value;
  save({ textColor: value });
  renderSwatches(value);
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
