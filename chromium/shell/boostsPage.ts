/**
 * The Boosts page (boosts.html): every boost, and a plain editor for one. `#github.com.ts`
 * opens that boost. Saving applies it at once (styles in place, scripts by reloading the site's
 * tabs), as saving the file did in Electron.
 */
import './noPageMenu';
import { invoke, on, onReconnect } from './client';
import { ConnectionError } from './protocol';
import type { BoostFile } from './features/boosts';
import { compileBoost } from './features/compileBoost';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>('list');
const main = document.querySelector('main')!;
const code = $<HTMLTextAreaElement>('code');
const status = $('status');
const listError = $('list-error');
const retryList = $<HTMLButtonElement>('retry-list');
const openError = $('open-error');
const retryOpen = $('retry-open');
const deleteCheckStatus = $('delete-check-status');
const retryDeleteCheck = $<HTMLButtonElement>('retry-delete-check');
const saveButton = $<HTMLButtonElement>('save');
const deleteButton = $<HTMLButtonElement>('delete');

let current: BoostFile | undefined;
let savedCode = '';
let editorSession = Symbol();
let navigation: symbol | undefined;
let listRead: symbol | undefined;
let discard: { name: string; draft: string } | undefined;
let failedOpen: { name: string; fallback: string; reconnect: boolean } | undefined;
const writes = new Map<string, Promise<void>>();
const writeRevisions = new Map<string, symbol>();
const deleting = new Set<string>();
const unconfirmedDeletes = new Set<string>();
let checkingDeletes: Promise<void> | undefined;
let deletedDraft: symbol | undefined;

const dirty = () => !!current && code.value !== savedCode;
function selected() {
  try { return decodeURIComponent(location.hash.slice(1)); }
  catch { return ''; }
}

function updateEditorActions() {
  const unavailable = !!current && (deleting.has(current.name) || deletedDraft === editorSession);
  saveButton.disabled = deleteButton.disabled = code.readOnly = unavailable;
}

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function clearEditor() {
  current = undefined;
  editorSession = Symbol();
  savedCode = code.value = '';
  main.classList.add('empty');
  document.title = 'Boosts';
  highlightListSelection();
}

function highlightListSelection() {
  for (const button of list.querySelectorAll<HTMLButtonElement>('button[data-boost-name]')) {
    button.classList.toggle('current', button.dataset.boostName === current?.name);
  }
}

async function renderList() {
  const request = listRead = Symbol();
  retryList.disabled = true;
  const boosts = await invoke<BoostFile[]>('boosts:list').catch(() => undefined);
  if (listRead !== request) return;
  retryList.disabled = false;
  retryList.hidden = !!boosts;
  listError.textContent = boosts ? '' : 'Couldn’t load Boosts.';
  $('empty').hidden = !boosts || boosts.length > 0;
  if (!boosts) return;
  const shown = list.querySelectorAll<HTMLButtonElement>('button[data-boost-name]');
  if (shown.length === boosts.length &&
    boosts.every((boost, index) => shown[index].dataset.boostName === boost.name && shown[index].title === (boost.error ?? ''))) return;
  list.replaceChildren(
    ...boosts.map((b) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.dataset.boostName = b.name;
      button.className = `${b.name === current?.name ? 'current' : ''} ${b.error ? 'broken' : ''}`;
      button.title = b.error ?? '';
      const host = Object.assign(document.createElement('span'), { textContent: b.host });
      const kind = Object.assign(document.createElement('span'), { className: 'kind', textContent: b.kind === 'script' ? '.ts' : '.css' });
      button.append(host, kind);
      button.onclick = () => {
        if (selected() === b.name && current?.name !== b.name) void refresh();
        else location.hash = encodeURIComponent(b.name);
      };
      li.append(button);
      return li;
    }),
  );
}

async function open(name: string, reload = false) {
  const request = navigation = Symbol();
  const stillSelected = () => navigation === request && selected() === name;
  const restoreHash = () => {
    discard = undefined;
    if (current) history.replaceState(null, '', `#${encodeURIComponent(current.name)}`);
  };
  const oldCode = code.value;
  const previousEditor = editorSession;
  if (dirty() && (discard?.name !== name || discard.draft !== oldCode)) {
    if (!confirm(`Discard your changes to ${current!.name}?`)) {
      discard = undefined;
      restoreHash();
      return false;
    }
    discard = { name, draft: oldCode };
  }
  let file: BoostFile | undefined;
  let revision: symbol | undefined;
  try {
    for (let pending = writes.get(name); pending; pending = writes.get(name)) {
      await pending;
      if (!stillSelected()) return;
    }
    if (!stillSelected()) return;
    revision = writeRevisions.get(name);
    file = name ? await invoke<BoostFile | undefined>('boosts:get', name) : undefined;
  } catch (error) {
    if (!stillSelected()) return;
    restoreHash();
    failedOpen = { name, fallback: selected(), reconnect: error instanceof ConnectionError };
    retryOpen.hidden = false;
    openError.textContent = 'Couldn’t load this Boost.';
    return;
  }
  if (!stillSelected()) return;
  if (editorSession === previousEditor && code.value !== oldCode) return restoreHash();
  if (writeRevisions.get(name) !== revision) return open(name, reload);
  discard = undefined;
  clearOpenFailure();
  if (!reload || current?.name !== file?.name) editorSession = Symbol();
  current = file;
  highlightListSelection();
  updateEditorActions();
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
  if (!current || saveButton.disabled) return;
  const file = current;
  const session = editorSession;
  const draft = code.value;
  queueWrite(file.name, async () => {
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

function queueWrite(name: string, write: () => Promise<void>) {
  writeRevisions.set(name, Symbol());
  const pending = (writes.get(name) ?? Promise.resolve()).then(write).finally(() => {
    if (writes.get(name) === pending) writes.delete(name);
  });
  writes.set(name, pending);
}

saveButton.onclick = () => void save();
deleteButton.onclick = () => {
  if (!current || deleteButton.disabled || !confirm(`Delete ${current.name}?`)) return;
  const file = current;
  const session = editorSession;
  deleting.add(file.name);
  updateEditorActions();
  queueWrite(file.name, async () => {
    try {
      await invoke('boosts:delete', file.name);
      if (editorSession === session) clearEditor();
      if (selected() === file.name) location.hash = '';
    } catch (error) {
      if (error instanceof ConnectionError && error.sent) {
        unconfirmedDeletes.add(file.name);
        showUnconfirmedDelete('Couldn’t confirm deletion. Check again or copy your draft and reopen Boosts.');
      } else if (editorSession === session) setStatus('Couldn’t delete this Boost.', true);
    } finally {
      if (!unconfirmedDeletes.has(file.name)) deleting.delete(file.name);
      updateEditorActions();
    }
  });
};

function showUnconfirmedDelete(message: string) {
  deleteCheckStatus.textContent = message;
  retryDeleteCheck.hidden = !message;
}

function verifyDeletes() {
  if (checkingDeletes) return checkingDeletes;
  if (!unconfirmedDeletes.size) return Promise.resolve();
  retryDeleteCheck.disabled = true;
  checkingDeletes = Promise.all([...unconfirmedDeletes].map((name) =>
    invoke<BoostFile | undefined>('boosts:get', name).then((file) => {
      if (!file) writeRevisions.set(name, Symbol());
      unconfirmedDeletes.delete(name);
      deleting.delete(name);
      if (current?.name === name) {
        if (file) setStatus('This Boost is still here.');
        else if (dirty()) {
          deletedDraft = editorSession;
          setStatus('This Boost was deleted. You can still copy your draft.', true);
        } else {
          clearEditor();
          if (selected() === name) history.replaceState(null, '', '#');
        }
      }
      updateEditorActions();
      return true;
    }, () => false),
  )).then((results) => {
    const failed = results.includes(false);
    showUnconfirmedDelete(failed ? 'Couldn’t check deletion. Try again or copy your draft and reopen Boosts.' : '');
  }).finally(() => {
    checkingDeletes = undefined;
    retryDeleteCheck.disabled = false;
  });
  return checkingDeletes;
}

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
  if (code.readOnly) return;
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
  const name = selected();
  const listing = renderList();
  const keepEditor = reload && name === current?.name && (dirty() || unconfirmedDeletes.has(name));
  if (!keepEditor) await open(name, reload);
  await listing;
}
function clearOpenFailure() {
  failedOpen = undefined;
  openError.textContent = '';
  retryOpen.hidden = true;
}

function retryFailedOpen() {
  if (!failedOpen || failedOpen.fallback !== selected()) return false;
  failedOpen.reconnect = false;
  history.replaceState(null, '', `#${encodeURIComponent(failedOpen.name)}`);
  return true;
}

retryOpen.onclick = () => { if (retryFailedOpen()) void refresh(); };
retryList.onclick = () => void renderList();
retryDeleteCheck.onclick = () => void verifyDeletes().then(() => refresh(true));
window.addEventListener('hashchange', () => {
  clearOpenFailure();
  void refresh();
});
on('boosts:changed', () => void renderList());
onReconnect(() => {
  if (failedOpen?.reconnect) retryFailedOpen();
  void verifyDeletes().then(() => refresh(true));
});

void refresh();
