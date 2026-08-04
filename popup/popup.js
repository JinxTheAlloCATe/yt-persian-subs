/* Popup settings. Everything persists to storage.sync the moment it changes,
   so there is no save button to forget about. */

// Shortcuts only — the field accepts any OpenRouter model, and this list is
// editable, so it is just a starting point.
const STARTER_PICKS = [
  { id: '~deepseek/deepseek-v4-flash-latest', label: 'DeepSeek V4 Flash' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'google/gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
];

const DEFAULTS = {
  enabled: true,
  apiKey: '',
  // Output tokens dominate translation cost and this model's are far cheaper.
  model: '~deepseek/deepseek-v4-flash-latest',
  fontSize: 26,
  showOriginal: false,
  textColor: '#ffffff',
  picks: STARTER_PICKS,
};

// The colours subtitles conventionally use, for one-tap selection; the picker
// beside them takes anything.
const SWATCHES = [
  { value: '#ffffff', label: 'White' },
  { value: '#ffe14d', label: 'Yellow' },
  { value: '#7ee8fa', label: 'Cyan' },
  { value: '#9dff8a', label: 'Green' },
];

let picks = STARTER_PICKS;

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
  usage: $('usage'),
  resetUsage: $('resetUsage'),
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

/* ---------------------------------------------------------------- usage */

async function refreshUsage() {
  const result = await send({ type: 'USAGE_STATS' });
  if (!result.ok || !result.calls) {
    el.usage.textContent = 'Nothing translated yet.';
    return;
  }

  const cost = result.cost >= 0.01 ? `$${result.cost.toFixed(2)}` : `$${result.cost.toFixed(4)}`;
  const thousands = Math.round(result.tokens / 1000);
  const since = result.since
    ? ` since ${new Date(result.since).toLocaleDateString()}`
    : '';
  el.usage.textContent = `${cost} · ${thousands}k tokens · ${result.calls} requests${since}`;
}

el.resetUsage.addEventListener('click', async () => {
  await send({ type: 'RESET_USAGE' });
  refreshUsage();
});

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
  const chips = picks.map(({ id, label }) => {
    const chip = document.createElement('span');
    chip.className = 'pick';
    chip.setAttribute('aria-pressed', String(id === selected));

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'pick__name';
    choose.textContent = label || id;
    choose.title = id;
    choose.addEventListener('click', () => selectModel(id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pick__remove';
    remove.textContent = '×';
    remove.title = `Remove ${label || id}`;
    remove.setAttribute('aria-label', `Remove ${label || id}`);
    remove.addEventListener('click', () => {
      picks = picks.filter((pick) => pick.id !== id);
      save({ picks });
      renderPicks(el.model.value.trim());
    });

    chip.append(choose, remove);
    return chip;
  });

  // Offer to keep whatever is in the field, when it is not already saved.
  const current = el.model.value.trim();
  if (current && !picks.some((pick) => pick.id === current)) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pick pick--add';
    add.textContent = '+ Save this model';
    add.addEventListener('click', () => {
      const name = catalogue.find((entry) => entry.id === current)?.name;
      picks = [...picks, { id: current, label: name || current }];
      save({ picks });
      renderPicks(current);
    });
    chips.push(add);
  }

  el.picks.replaceChildren(...chips);
}

function selectModel(id) {
  el.model.value = id;
  save({ model: id });
  renderPicks(id);
  describeModel(id);
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
  picks = Array.isArray(settings.picks) ? settings.picks : STARTER_PICKS;
  el.model.value = settings.model;
  renderPicks(settings.model);
  loadModels();
  refreshUsage();
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
