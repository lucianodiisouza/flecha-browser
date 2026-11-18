/**
 * The Boosts page (boosts.html): every boost, and a plain editor for one. `#github.com.ts`
 * opens that boost. Saving applies it at once (styles in place, scripts by reloading the site's
 * tabs), as saving the file did in Electron.
 */
import './noPageMenu';
import { invoke, on, onReconnect } from './client';
import type { BoostFile } from './features/boosts';
import { compileBoost } from './features/compileBoost';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>('list');
const main = document.querySelector('main')!;
const code = $<HTMLTextAreaElement>('code');
const status = $('status');

let current: BoostFile | undefined;
let savedCode = '';

const dirty = () => !!current && code.value !== savedCode;
const selected = () => decodeURIComponent(location.hash.slice(1));

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

async function renderList() {
  const boosts = await invoke<BoostFile[]>('boosts:list').catch(() => {
    setStatus('Couldn’t load Boosts.', true);
    return undefined;
  });
  if (!boosts) return;
  list.replaceChildren(
    ...boosts.map((b) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.className = `${b.name === current?.name ? 'current' : ''} ${b.error ? 'broken' : ''}`;
      button.title = b.error ?? '';
      const host = Object.assign(document.createElement('span'), { textContent: b.host });
      const kind = Object.assign(document.createElement('span'), { className: 'kind', textContent: b.kind === 'script' ? '.ts' : '.css' });
      button.append(host, kind);
      button.onclick = () => (location.hash = encodeURIComponent(b.name));
      li.append(button);
      return li;
    }),
  );
  $('empty').hidden = boosts.length > 0;
}

async function open(name: string, reload = false) {
  if (dirty() && !confirm(`Discard your changes to ${current!.name}?`)) {
    history.replaceState(null, '', `#${encodeURIComponent(current!.name)}`);
    return;
  }
  const oldCode = code.value;
  let file: BoostFile | undefined;
  try {
    file = name ? await invoke<BoostFile | undefined>('boosts:get', name) : undefined;
  } catch {
    setStatus('Couldn’t load this Boost.', true);
    return;
  }
  if (selected() !== name || code.value !== oldCode) return;
  current = file;
  main.classList.toggle('empty', !current);
  document.title = current ? `${current.name} · Boosts` : 'Boosts';
  if (current) {
    $('name').textContent = current.name;
    code.value = savedCode = current.code;
    if (current.error) setStatus(current.error, true);
    else setStatus(current.kind === 'styles' ? 'Applies as you save' : 'Open tabs of this site reload when you save');
    if (!reload) code.focus();
  }
}

async function save() {
  if (!current) return;
  const file = current;
  let result: BoostFile | undefined;
  try {
    const build = file.kind === 'script' ? compileBoost(file.name, code.value) : undefined;
    result = await invoke<BoostFile | undefined>('boosts:save', file.name, code.value, build);
  } catch {
    if (current === file) setStatus('Couldn’t save. Your edits are still here.', true);
    return;
  }
  if (current !== file) return;
  if (!result) return setStatus('Couldn’t save', true);
  current = result;
  savedCode = result.code;
  if (result.error) setStatus(result.error, true);
  else setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  void renderList();
}

$('save').onclick = () => void save();
$('delete').onclick = async () => {
  if (!current || !confirm(`Delete ${current.name}?`)) return;
  await invoke('boosts:delete', current.name);
  savedCode = code.value;
  location.hash = '';
};

$<HTMLFormElement>('new').onsubmit = async (e) => {
  e.preventDefault();
  const host = $<HTMLInputElement>('new-host').value.trim().toLowerCase();
  const kind = $<HTMLSelectElement>('new-kind').value;
  const name = await invoke<string | undefined>('boosts:create', host, kind);
  if (!name) return alert('That isn’t a site name, like github.com (or “all” for every site).');
  $<HTMLInputElement>('new-host').value = '';
  location.hash = encodeURIComponent(name);
};

code.addEventListener('keydown', (e) => {
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void save();
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});
code.addEventListener('input', () => dirty() && setStatus('Not saved'));
window.addEventListener('beforeunload', (e) => {
  if (dirty()) e.preventDefault();
});
async function refresh(reload = false) {
  if (!reload || !dirty()) await open(selected(), reload);
  await renderList();
}
window.addEventListener('hashchange', () => void refresh());
on('boosts:changed', () => void renderList());
onReconnect(() => void refresh(true));

void refresh();
