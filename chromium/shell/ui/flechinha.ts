import { ICONS, type IconName } from './icons.js';
import type { FlechinhaApi, FlechinhaState } from '../../shared/types';
import { displayKeys, showKeys } from '../lib/shortcuts';

declare global {
  interface Window {
    flechinha: FlechinhaApi;
  }
}

const api = window.flechinha;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const address = $('address');
const show = $<HTMLButtonElement>('address-show');
const form = $<HTMLFormElement>('address-edit');
const input = $<HTMLInputElement>('address-input');
const back = $<HTMLButtonElement>('back');
const forward = $<HTMLButtonElement>('forward');
const reload = $<HTMLButtonElement>('reload');
const copy = $<HTMLButtonElement>('copy');
const openInFlecha = $<HTMLButtonElement>('open-in-flecha');

back.title = `Back  ${displayKeys('CmdOrCtrl+[')}`;
forward.title = `Forward  ${displayKeys('CmdOrCtrl+]')}`;
copy.title = `Copy link  ${displayKeys('CmdOrCtrl+Shift+C')}`;
showKeys();

let state: FlechinhaState | undefined;
let editing = false;

function icon(name: IconName) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

for (const el of document.querySelectorAll<HTMLElement>('i[data-icon]')) el.replaceWith(icon(el.dataset.icon as IconName));

/** What the address shows: the site, quieter for the URL schemes people don't type. */
function siteOf(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host.replace(/^www\./, '');
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || 'File');
    return u.protocol.replace(/:$/, '');
  } catch {
    return url;
  }
}

function siteIcon(s: FlechinhaState) {
  const wrap = $('site-icon');
  const insecure = s.url.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(s.url);
  wrap.classList.toggle('insecure', insecure);
  if (insecure || !s.favicon) return wrap.replaceChildren(icon(insecure ? 'unlocked' : 'globe'));
  const img = document.createElement('img');
  img.src = s.favicon;
  img.draggable = false;
  img.onerror = () => wrap.replaceChildren(icon('globe'));
  wrap.replaceChildren(img);
}

function render(s: FlechinhaState) {
  state = s;
  document.documentElement.style.setProperty('--tint', s.tint);
  const empty = !s.url;
  document.body.classList.toggle('is-empty', empty);
  $('empty').hidden = !empty;
  $('empty-hint').textContent = `Type an address, or anything to search ${s.searchEngineName}.`;

  back.disabled = !s.canGoBack;
  forward.disabled = !s.canGoForward;
  reload.disabled = empty;
  reload.replaceChildren(icon(s.loading ? 'close' : 'reload'));
  reload.title = s.loading ? 'Stop' : `Reload  ${displayKeys('CmdOrCtrl+R')}`;
  copy.disabled = empty;
  openInFlecha.disabled = empty;
  const space = `${s.space.emoji ? s.space.emoji + ' ' : ''}${s.space.name}`;
  openInFlecha.title = `Move this page to ${space} as a tab  ${displayKeys('CmdOrCtrl+O')}`;

  address.classList.toggle('loading', s.loading);
  $('host').textContent = siteOf(s.url);
  const title = s.title && s.title !== s.url ? s.title : '';
  $('page-title').textContent = title;
  show.title = `${s.url}\nEdit address  ${displayKeys('CmdOrCtrl+L')}`;
  siteIcon(s);

  if (empty && !editing) startEditing();
  document.title = title || siteOf(s.url) || 'Flechinha';
}

function startEditing() {
  editing = true;
  address.classList.remove('flashing');
  address.classList.add('editing');
  show.hidden = true;
  form.hidden = false;
  input.value = state?.url ?? '';
  input.focus();
  input.select();
}

function stopEditing() {
  // An empty Flechinha has nothing to show instead of the field.
  if (!state?.url) return;
  editing = false;
  address.classList.remove('editing');
  show.hidden = false;
  form.hidden = true;
}

show.addEventListener('click', startEditing);
input.addEventListener('blur', stopEditing);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  api.navigate(text);
  editing = false;
  address.classList.remove('editing');
  show.hidden = false;
  form.hidden = true;
});

back.onclick = () => api.back();
forward.onclick = () => api.forward();
reload.onclick = () => (state?.loading ? api.stop() : api.reload());
copy.onclick = () => api.copyLink();
openInFlecha.onclick = () => api.openInFlecha();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (editing && state?.url) return input.blur();
    api.close();
  } else if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    if (state?.url) api.openInFlecha();
  }
});

let flashTimer: number | undefined;
api.onFlash((message) => {
  address.dataset.flash = message;
  address.classList.add('flashing');
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => address.classList.remove('flashing'), 1400);
});

api.onEditAddress(startEditing);
api.onState(render);
api.ready();
