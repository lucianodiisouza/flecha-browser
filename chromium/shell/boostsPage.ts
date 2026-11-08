/**
 * The Boosts page (boosts.html): every boost, and a plain editor for one. `#github.com.ts`
 * opens that boost. Saving applies it at once (styles in place, scripts by reloading the site's
 * tabs), as saving the file did in Electron.
 */
import './noPageMenu';
import { invoke, on } from './client';
import type { BoostFile } from './features/boosts';
import { compileBoost } from './features/compileBoost';
import { showKeys } from './lib/shortcuts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>('list');
const main = document.querySelector('main')!;
const code = $<HTMLTextAreaElement>('code');
const status = $('status');

let current: BoostFile | undefined;
let savedCode = '';

showKeys();

const dirty = () => !!current && code.value !== savedCode;
const selected = () => decodeURIComponent(location.hash.slice(1));

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

async function renderList() {
  const boosts = await invoke<BoostFile[]>('boosts:list');
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

async function open(name: string) {
  if (dirty() && !confirm(`Discard your changes to ${current!.name}?`)) {
    history.replaceState(null, '', `#${encodeURIComponent(current!.name)}`);
    return;
  }
  current = name ? await invoke<BoostFile | undefined>('boosts:get', name) : undefined;
  main.classList.toggle('empty', !current);
  document.title = current ? `${current.name} · Boosts` : 'Boosts';
  if (current) {
    $('name').textContent = current.name;
    code.value = savedCode = current.code;
    if (current.error) setStatus(current.error, true);
    else setStatus(current.kind === 'styles' ? 'Applies as you save' : 'Open tabs of this site reload when you save');
    code.focus();
  }
  void renderList();
}

async function save() {
  if (!current) return;
  const build = current.kind === 'script' ? compileBoost(current.name, code.value) : undefined;
  const result = await invoke<BoostFile | undefined>('boosts:save', current.name, code.value, build);
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
window.addEventListener('hashchange', () => void open(selected()));
on('boosts:changed', () => void renderList());

void open(selected());
