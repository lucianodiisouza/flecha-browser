// Flecha landing: scales the app drawing, runs the command bar demo and the copy button.

/* ---- scale the window drawing to the column ---------------------------- */

const frame = document.querySelector('.mock-frame');
const canvas = document.querySelector('.mock-canvas');
const CANVAS_W = 1200;
const CANVAS_H = 712;

function fitDrawing() {
  const s = Math.min(1, frame.clientWidth / CANVAS_W);
  canvas.style.setProperty('--s', s);
  frame.style.height = `${Math.ceil(CANVAS_H * s)}px`;
}
if (frame && canvas) {
  new ResizeObserver(fitDrawing).observe(frame);
  fitDrawing();
}

/* ---- command bar demo -------------------------------------------------- */
// Same rules as src/renderer/devCommands.ts in the app.

const SEARCHES = {
  npm: { name: 'npm', url: (q) => (/^\S+$/.test(q) ? `https://www.npmjs.com/package/${q}` : `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`) },
  mdn: { name: 'MDN', url: (q) => `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}` },
  caniuse: { name: 'Can I use', url: (q) => `https://caniuse.com/?search=${encodeURIComponent(q)}` },
  so: { name: 'Stack Overflow', url: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}` },
};

function devSuggestions(query) {
  const q = query.trim();
  const [keyword, ...rest] = q.split(/\s+/);
  const arg = rest.join(' ');

  if (keyword === 'gh' && arg) return [github(arg)];
  const search = SEARCHES[keyword?.toLowerCase()];
  if (search && arg) return [{ label: arg, sub: `Open in ${search.name}`, url: search.url(arg) }];

  const jwt = decodeJwt(q);
  if (jwt) return [jwt];
  const time = decodeTimestamp(q);
  if (time) return [time];
  return [];
}

function github(arg) {
  if (/^[\w.-]+\/[\w.-]+$/.test(arg)) return { label: arg, sub: 'Open on GitHub', url: `https://github.com/${arg}` };
  if (/^#?\d+$/.test(arg)) {
    return { label: `#${arg.replace('#', '')}`, sub: 'Opens in the repo of your current tab', url: 'https://github.com/lucianodiisouza/flecha-browser/pulls' };
  }
  return { label: arg, sub: 'Search GitHub', url: `https://github.com/search?q=${encodeURIComponent(arg)}` };
}

function decodeJwt(text) {
  const parts = text.split('.');
  if (parts.length !== 3 || !/^eyJ/.test(parts[0])) return undefined;
  try {
    const decode = (part) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    const facts = [header.alg && `alg ${header.alg}`, payload.sub && `sub ${payload.sub}`, expiry(payload.exp)].filter(Boolean);
    return { label: `JWT · ${facts.join(' · ') || 'decoded'}`, sub: 'Copy decoded JSON', copy: JSON.stringify({ header, payload }, null, 2) };
  } catch {
    return undefined;
  }
}

function expiry(exp) {
  if (typeof exp !== 'number') return undefined;
  const ms = exp * 1000 - Date.now();
  return ms < 0 ? `expired ${relative(-ms)} ago` : `expires in ${relative(ms)}`;
}

function decodeTimestamp(text) {
  if (!/^\d{10}(\d{3})?$/.test(text)) return undefined;
  const date = new Date(text.length === 10 ? Number(text) * 1000 : Number(text));
  const ms = date.getTime() - Date.now();
  return {
    label: `${date.toLocaleString()} · ${ms < 0 ? `${relative(-ms)} ago` : `in ${relative(ms)}`}`,
    sub: 'Copy ISO date',
    copy: date.toISOString(),
  };
}

function relative(ms) {
  const units = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm']];
  for (const [size, unit] of units) if (ms >= size) return `${Math.floor(ms / size)}${unit}`;
  return `${Math.floor(ms / 1000)}s`;
}

function sampleJwt() {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const exp = Math.floor(Date.now() / 1000) + 2 * 3600;
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user_42', role: 'admin', exp })}.c2lnbmF0dXJl`;
}

const PT = document.documentElement.lang === 'pt-BR';
const HINT = PT ? 'Tente gh, npm, mdn, caniuse ou so, ou cole um JWT' : 'Try gh, npm, mdn, caniuse or so, or paste a JWT';
const input = document.getElementById('try-input');
const results = document.getElementById('try-results');
const detail = document.getElementById('try-detail');
const chips = document.getElementById('try-chips');

function render() {
  const q = input.value;
  const items = devSuggestions(q);
  results.replaceChildren();
  detail.hidden = true;

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = q.trim() ? `Search the web for “${q.trim()}”` : HINT;
    results.append(li);
    return;
  }
  if (q.trim()) items.push({ label: `Search the web for “${q.trim()}”`, sub: 'Your search engine', web: true });
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.web ? 'web' : 'selected';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = item.sub;
    if (item.url) {
      const a = document.createElement('a');
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(label, sub);
      li.append(a);
    } else {
      li.append(label, sub);
    }
    results.append(li);
    if (item.copy) {
      detail.textContent = item.copy;
      detail.hidden = false;
    }
  }
}

if (input) {
  input.addEventListener('input', () => {
    for (const b of chips.querySelectorAll('button')) b.removeAttribute('aria-pressed');
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const link = results.querySelector('a');
    if (link) link.click();
  });
  chips.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    input.value = button.dataset.q === 'jwt' ? sampleJwt() : button.dataset.q;
    for (const b of chips.querySelectorAll('button')) b.toggleAttribute('aria-pressed', b === button);
    button.setAttribute('aria-pressed', 'true');
    render();
  });
  render();
}

/* ---- copy the build commands ------------------------------------------ */

const copyButton = document.getElementById('copy-build');
copyButton?.addEventListener('click', async () => {
  const label = copyButton.dataset.label || (copyButton.dataset.label = copyButton.textContent);
  const text = document.getElementById('build-cmds').textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyButton.textContent = copyButton.dataset.done || 'Copied';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('build-cmds'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    copyButton.textContent = copyButton.dataset.selected || 'Selected';
  }
  setTimeout(() => (copyButton.textContent = label), 1600);
});

/* ---- motion: hero command bar, environments --------------------------- */

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

const ARROW = '<svg viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
const favicon = (letter, color) => `<i class="fi" style="--c:${color}">${letter}</i>`;
const HERO_QUERIES = [
  { q: 'gh 483', rows: [[ARROW, 'oprimo/api#483', 'Open pull request or issue'], [favicon('G', '#1d1d1f'), 'Fix checkout redirect #482', 'Switch to tab'], [favicon('G', '#1d1d1f'), 'oprimo/api · Pull requests', 'History']] },
  { q: 'npm zod', rows: [[ARROW, 'zod', 'Open in npm'], [favicon('n', '#cb3837'), 'zod · npm', 'Switch to tab'], [favicon('n', '#cb3837'), 'zod-to-json-schema · npm', 'History']] },
  { q: 'caniuse :has()', rows: [[ARROW, ':has()', 'Open in Can I use'], [favicon('M', '#83d0f2'), ':has() · CSS · MDN', 'History']] },
  { q: '1761140000', rows: () => [[ARROW, decodeTimestamp('1761140000').label, 'Copy ISO date']] },
];

const heroInput = document.querySelector('.m-input');
const heroResults = document.querySelector('.m-results');

function heroRows(rows) {
  heroResults.innerHTML = rows
    .map(([icon, label, sub], i) => `<li class="${i ? '' : 'selected'}">${icon}<span class="label">${label}</span><span class="sub">${sub}</span></li>`)
    .join('');
}

async function typeHero(text) {
  const caret = heroInput.querySelector('.caret');
  for (let i = 0; i <= text.length; i++) {
    heroInput.firstChild.textContent = text.slice(0, i);
    await new Promise((r) => setTimeout(r, 55 + Math.random() * 45));
  }
  heroInput.append(caret);
}

async function cycleHero() {
  let index = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, 3600));
    index = (index + 1) % HERO_QUERIES.length;
    const { q, rows } = HERO_QUERIES[index];
    heroResults.classList.add('swapping');
    await typeHero(q);
    heroRows(typeof rows === 'function' ? rows() : rows);
    heroResults.classList.remove('swapping');
  }
}
if (!calm && heroInput && heroResults) cycleHero();

const envRows = [...document.querySelectorAll('.env-row')];
if (!calm && envRows.length) {
  let current = envRows.findIndex((row) => row.classList.contains('on'));
  setInterval(() => {
    envRows[current].classList.remove('on');
    current = (current + 1) % envRows.length;
    envRows[current].classList.add('on');
  }, 2400);
}
