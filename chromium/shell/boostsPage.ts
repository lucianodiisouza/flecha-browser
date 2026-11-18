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
const listError = $('list-error');

let current: BoostFile | undefined;
let savedCode = '';
let editorSession = Symbol();
let navigation: symbol | undefined;
let saves = Promise.resolve();
let deleting = false;

const dirty = () => !!current && code.value !== savedCode;
const selected = () => decodeURIComponent(location.hash.slice(1));

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

async function renderList() {
  const boosts = await invoke<BoostFile[]>('boosts:list').catch(() => {
    listError.hidden = false;
    $('empty').hidden = true;
    return undefined;
  });
  if (!boosts) return;
  listError.hidden = true;
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
  const request = navigation = Symbol();
  const stillSelected = () => navigation === request && selected() === name;
  const restoreHash = () => {
    if (current) history.replaceState(null, '', `#${encodeURIComponent(current.name)}`);
  };
  if (dirty() && !confirm(`Discard your changes to ${current!.name}?`)) {
    restoreHash();
    return;
  }
  const oldCode = code.value;
  let file: BoostFile | undefined;
  try {
    file = name ? await invoke<BoostFile | undefined>('boosts:get', name) : undefined;
  } catch {
    if (!stillSelected()) return;
    restoreHash();
    setStatus('Couldn’t load this Boost.', true);
    return;
  }
  if (!stillSelected()) return;
  if (code.value !== oldCode) return restoreHash();
  if (!reload || current?.name !== file?.name) editorSession = Symbol();
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

function save() {
  if (!current || deleting) return;
  const file = current;
  const session = editorSession;
  const draft = code.value;
  saves = saves.then(async () => {
    try {
      const build = file.kind === 'script' ? compileBoost(file.name, draft) : undefined;
      const result = await invoke<BoostFile | undefined>('boosts:save', file.name, draft, build);
      if (editorSession !== session) return;
      if (!result) throw new Error('Save returned no file');
      current = result;
      savedCode = result.code;
      if (result.error) setStatus(result.error, true);
      else setStatus(dirty() ? 'Not saved' : `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      void renderList();
    } catch {
      if (editorSession === session) setStatus('Couldn’t save. Your edits are still here.', true);
    }
  });
}

$('save').onclick = () => void save();
$('delete').onclick = async () => {
  if (!current || deleting || !confirm(`Delete ${current.name}?`)) return;
  const file = current;
  const session = editorSession;
  deleting = true;
  try {
    await saves;
    await invoke('boosts:delete', file.name);
    if (editorSession === session) {
      savedCode = code.value;
      location.hash = '';
    }
  } catch {
    if (editorSession === session) setStatus('Couldn’t delete this Boost.', true);
  } finally {
    deleting = false;
  }
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
