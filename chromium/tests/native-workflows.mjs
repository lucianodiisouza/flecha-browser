// Runs the compiled browser on a private X display and profile. Never attaches to a user browser.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const binary = process.argv[2];
const artifacts = process.argv[3];
if (!binary) throw new Error('Usage: node chromium/tests/native-workflows.mjs /absolute/path/to/chrome');
// The shell built by `FLECHA_SHELL_OUT=<dir> npm run shell:build`; chromium/shell/dist otherwise.
const shellDir = process.env.FLECHA_SHELL_OUT || path.resolve('chromium/shell/dist');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-workflows-'));
const inputTool = path.join(profile, 'x11-input');
execFileSync('c++', ['chromium/tests/x11-input.cc', '-o', inputTool, '-lX11', '-lXtst'], { stdio: 'inherit' });
const display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24'], { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
const displayNumber = String((await once(display.stdio[3], 'data'))[0]).trim();
const env = { ...process.env, DISPLAY: `:${displayNumber}` };
delete env.__PYVENV_LAUNCHER__;
delete env.CHROME_CONFIG_HOME;
delete env.HELIUM_CONFIG_HOME;
// Off the desktop's session bus: no keyring, notification or file-chooser portal of the
// user's session is reached; dialogs open on this display instead.
delete env.DBUS_SESSION_BUS_ADDRESS;
// Only the private X display: GTK dialogs would otherwise open on the desktop's Wayland session.
delete env.WAYLAND_DISPLAY;
env.HOME = path.join(profile, 'home');
env.XDG_CONFIG_HOME = path.join(profile, 'import-config');
// Dialogs (GTK's file chooser) read and write these; keep them in the temporary profile too.
for (const name of ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) env[name] = path.join(profile, name.toLowerCase());
const fixture = path.join(env.XDG_CONFIG_HOME, 'google-chrome', 'Default');
await fs.mkdir(fixture, { recursive: true });
await fs.writeFile(path.join(fixture, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'Import fixture', url: 'https://example.com/' }] } } }));
const heliumFixture = path.join(env.XDG_CONFIG_HOME, 'net.imput.helium', 'Default');
await fs.mkdir(heliumFixture, { recursive: true });
const heliumHistory = path.join(heliumFixture, 'History');
const heliumDb = new DatabaseSync(heliumHistory);
heliumDb.exec("CREATE TABLE urls (url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER); INSERT INTO urls VALUES ('https://example.org/helium-history', 'Helium history fixture', 2, 13300000000000000, 0)");
heliumDb.close();
const originalHeliumHistory = await fs.readFile(heliumHistory);
// An extension with a toolbar action: its button, badge and popup live in the sidebar.
const testExtension = path.join(profile, 'probe-extension');
await fs.mkdir(testExtension);
await fs.writeFile(path.join(testExtension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Probe Action', version: '1.0', action: { default_popup: 'popup.html', default_title: 'Probe action' }, background: { service_worker: 'bg.js' }, commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+U' } } } }));
await fs.writeFile(path.join(testExtension, 'popup.html'), '<!doctype html><body style="width:240px;height:120px">Probe popup</body>');
await fs.writeFile(path.join(testExtension, 'bg.js'), "chrome.action.setBadgeText({ text: '7' });");
// An extension without an action: Chromium gives it a disabled one with its default puzzle icon.
const quietExtension = path.join(profile, 'quiet-extension');
await fs.mkdir(quietExtension);
await fs.writeFile(path.join(quietExtension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Quiet Extension', version: '1.0', background: { service_worker: 'bg.js' } }));
await fs.writeFile(path.join(quietExtension, 'bg.js'), '');
// Downloads: a file sent over plain HTTP (held for a decision), and one whose connection drops
// and whose resumptions fail until the test lets them through.
const resumable = Buffer.alloc(200000, 7);
let resumeAllowed = false;
// A stand-in for the search engine's suggest endpoint, answering `["query", ["query one", "query two"]]`.
// It never answers a query the test holds: the test checks that the browser gives that request up.
const held = {};
const heldSuggest = (query) => new Promise((resolve) => (held[query] = resolve));
const slowSuggestAsked = heldSuggest('flecha slow');
const server = createServer((request, response) => {
  if (request.url.startsWith('/suggest?')) {
    const query = new URL(request.url, base).searchParams.get('q');
    // Wrapped, so that awaiting the request doesn't also wait for its connection to close.
    if (held[query]) return held[query]({ closed: once(response, 'close') });
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify([query, [`${query} one`, `${query} two`]]));
  }
  if (request.url.startsWith('/held')) {
    response.setHeader('Content-Disposition', `attachment; filename="${request.url.slice(1)}.bin"`);
    return response.end('held');
  }
  if (request.url === '/resumable') {
    const range = /bytes=(\d+)-/.exec(request.headers.range ?? '');
    if (range && !resumeAllowed) return request.socket.destroy();
    response.setHeader('Content-Disposition', 'attachment; filename="resumable.bin"');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', '"v1"');
    if (range) {
      const from = Number(range[1]);
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${from}-${resumable.length - 1}/${resumable.length}`);
      response.setHeader('Content-Length', resumable.length - from);
      return response.end(resumable.subarray(from));
    }
    response.setHeader('Content-Length', resumable.length);
    // The connection closes after the first part, short of its length: the download stops there.
    return void response.write(resumable.subarray(0, 50000), () => request.socket.end());
  }
  response.setHeader('Content-Type', 'text/html');
  // A page that runs every 100 ms, and on resuming says how long it ran nothing.
  if (request.url === '/ticking') return response.end('<title>Ticking</title><script>window.lastTick = Date.now(); setInterval(() => (lastTick = Date.now()), 100); window.freezes = 0; document.addEventListener("freeze", () => freezes++); document.addEventListener("resume", () => (window.silent = Date.now() - lastTick)); window.documentToken = crypto.randomUUID();</script>');
  if (request.url === '/geo') return response.end('<title>Geo</title><script>navigator.geolocation.getCurrentPosition(() => {}, () => {})</script>');
  if (request.url === '/login') return response.end('<title>Login</title><form action="/done" method="post"><input id="user" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button id="go">Go</button></form>');
  response.end(`<title>Workflow ${request.url}</title><input id="draft"><button id="count" onclick="window.counter++">Count</button><a href="/peek" style="position: absolute; top: 700px">Peek link</a><div style="height: 3000px"></div><script>window.counter = 0; window.documentToken = crypto.randomUUID();</script>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
let browserConnectionError;
let debugSession;
let id = 0;
const pending = new Map();
const listeners = new Set();
// A step that waits for something that never happens fails the run instead of hanging it. The
// default is about three times the longest full run measured (3.5 minutes, 2026-10-26).
const deadline = Number(process.env.FLECHA_HARNESS_TIMEOUT_MS) || 10 * 60 * 1000;
let finished = false;
/** What the current step waits for, when it says; the deadline's failure names it. */
let waitingFor;
const STEP_TIMEOUT = 10_000;
/** Keep individual browser waits on the same budget as the native host's wait_for command. */
async function withinStep(operation, expected) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), STEP_TIMEOUT);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function stopChild(child, name) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  try {
    await withinStep(exited, `${name} to exit`);
  } catch {
    child.kill('SIGKILL');
    await withinStep(exited, `${name} to exit after SIGKILL`);
  }
}
let cleaning;
function cleanUp() {
  return cleaning ??= (async () => {
    const stopped = await Promise.allSettled([stopChild(browser, 'Chromium'), stopChild(display, 'Xvfb')]);
    server.close();
    server.closeAllConnections();
    await withinStep(fs.rm(profile, { recursive: true, force: true }), 'the temporary profile to be removed');
    for (const result of stopped) if (result.status === 'rejected') throw result.reason;
  })();
}
const watchdog = setTimeout(async () => {
  if (finished) return;
  const capture = path.join(os.tmpdir(), 'flecha-harness-timeout.png');
  console.error(`FAIL the run took longer than ${deadline} ms (FLECHA_HARNESS_TIMEOUT_MS); last step is the last PASS above${waitingFor ? `, waiting for ${waitingFor}` : ''}`);
  try {
    execFileSync('import', ['-display', env.DISPLAY, '-window', 'root', capture], { timeout: STEP_TIMEOUT, killSignal: 'SIGKILL' });
    console.error(`Harness screenshot: ${capture}`);
  } catch (error) {
    console.error(`Could not capture harness screenshot: ${error.code ?? error.signal ?? error.message}`);
  }
  if (debugSession) {
    const diagnostic = evaluate(debugSession, "Promise.all([chrome.downloads.search({}), typeof chrome.flechaPrivate.getDownloadWarnings === 'function' ? chrome.flechaPrivate.getDownloadWarnings() : []]).then(([d, w]) => JSON.stringify({ downloads: d.map(x => [x.id, x.filename.split('/').pop(), x.state, x.error, x.canResume, x.bytesReceived]), warnings: w, rows: [...document.querySelectorAll('#downloads-list .download')].map(li => li.textContent), active: testState?.spaces.find(sp => sp.id === testState.activeSpaceId)?.activeTabId && testState.tabs[testState.spaces.find(sp => sp.id === testState.activeSpaceId).activeTabId]?.url }))");
    await withinStep(diagnostic, 'the browser diagnostic').then((data) => console.error('DIAGNOSTIC', data), (error) => console.error(error.message));
  }
  await cleanUp().catch((error) => console.error(error.message));
  process.exit(1);
}, deadline);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await cleanUp().catch((error) => console.error(error.message));
  process.exit(1);
});
process.on('SIGUSR2', () => {
  if (debugSession) void evaluate(debugSession, "({paletteHidden:document.querySelector('#palette').hidden,active:document.activeElement.id,shortcuts:globalThis.testShortcuts,state:globalThis.testState?.activeSpaceId})").then(value => console.log('DIAGNOSTIC', value));
});
function send(method, params = {}, sessionId) {
  if (browserConnectionError) return Promise.reject(browserConnectionError);
  return new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    browser.stdio[3].write(JSON.stringify({ id: callId, method, params, sessionId }) + '\0');
  });
}
async function evaluate(session, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function attach(targetId) {
  return (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
}
async function findTarget(predicate, expected = `a browser target matching ${predicate}`) {
  let listener;
  try {
    return await withinStep(new Promise((resolve, reject) => {
      const accept = (target) => { if (predicate(target)) resolve(target); };
      listener = (message) => { if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') accept(message.params.targetInfo); };
      listeners.add(listener);
      void send('Target.getTargets').then(({ targetInfos }) => targetInfos.forEach(accept), reject);
    }), expected);
  } finally {
    listeners.delete(listener);
  }
}
async function loaded(session, urlPrefix) {
  await send('Page.enable', {}, session);
  await send('Runtime.enable', {}, session);
  await new Promise((resolve, reject) => {
    const check = async () => {
      try {
        if (await evaluate(session, `location.href.startsWith(${JSON.stringify(urlPrefix)}) && document.readyState === 'complete' && !!document.body`)) { listeners.delete(listener); resolve(); }
      } catch (error) { if (!/context|navigat/i.test(error.message)) reject(error); }
    };
    const listener = (message) => { if (message.sessionId === session && ['Page.loadEventFired', 'Runtime.executionContextCreated'].includes(message.method)) void check(); };
    listeners.add(listener);
    void check();
  });
}
function startBrowser(...addresses) {
  browserConnectionError = undefined;
  const child = browser = spawn(binary, [`--user-data-dir=${profile}`, `--flecha-shell-dir=${shellDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--ozone-platform=x11', '--password-store=basic', '--remote-debugging-pipe', // Google, the default search engine, is out of reach: its suggestions come from this test's server.
    '--host-resolver-rules=MAP *.flecha.test 127.0.0.1, MAP www.google.com ~NOTFOUND',`--load-extension=${testExtension},${quietExtension}`, '--disable-features=DisableLoadExtensionCommandLineSwitch',
    // Chromium doesn't freeze a page for 5 minutes after it was on screen; 3 s for this run.
    '--enable-features=CPUMeasurementInFreezingPolicy:freezing_visible_protection_time/3s', ...addresses], { env, stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] });
  const failConnection = (error) => {
    if (browser !== child) return;
    browserConnectionError ??= error;
    for (const call of pending.values()) call.reject(browserConnectionError);
    pending.clear();
  };
  child.once('error', failConnection);
  child.once('exit', (code, signal) => failConnection(new Error(`Browser exited ${code ?? signal}`)));
  for (const pipe of [child.stdio[3], child.stdio[4]]) {
    pipe.on('error', (error) => failConnection(new Error(`Browser debugging pipe failed: ${error.message}`, { cause: error })));
  }
  let buffer = '';
  child.stdio[4].on('data', (data) => {
    if (browser !== child) return;
    buffer += data.toString();
    const messages = buffer.split('\0');
    buffer = messages.pop();
    for (const json of messages) {
      const message = JSON.parse(json);
      if (message.id) {
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) call?.reject(new Error(JSON.stringify(message.error)));
        else call?.resolve(message.result);
      } else for (const listener of listeners) listener(message);
    }
  });
}
async function closeBrowser() {
  const exited = once(browser, 'exit');
  await send('Browser.close');
  await exited;
}

try {
  startBrowser();
  console.log('Browser', (await send('Browser.getVersion')).product);
  await send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await send('Target.getTargets');
  console.log('Targets', JSON.stringify(targetInfos.map(({ type, url }) => ({ type, url }))));
  const extension = 'chrome-extension://abdiaepfgbbhdjaecjipmaailijaaide/';
  const frame = targetInfos.find(({ url }) => url.startsWith(extension + 'window.html'));
  assert.ok(frame, 'Native frame target exists');
  const session = await attach(frame.targetId);
  debugSession = session;
  await loaded(session, extension);
  assert.equal(await evaluate(session, '!!window.flecha'), true);
  // Shell RPC and state events for this test, through the port the sidebar uses.
  const instrument = (target) => evaluate(target, `
    globalThis.testShortcuts = [];
    chrome.flechaPrivate.onShortcut.addListener(command => testShortcuts.push(command));
    chrome.commands.onCommand.addListener(command => testShortcuts.push(command));
    globalThis.testPort = chrome.runtime.connect({name: 'flecha'});
    globalThis.testCalls = new Map(); globalThis.testWaiters = new Set(); globalThis.testId = 0;
    testPort.onMessage.addListener(m => {
      if (m.type === 'result') { const call = testCalls.get(m.id); testCalls.delete(m.id); m.error ? call?.reject(new Error(m.error)) : call?.resolve(m.value); }
      if (m.type === 'event' && m.name === 'state') { globalThis.testState = m.args[0]; for (const check of testWaiters) check(); }
    });
    globalThis.testInvoke = (name, ...args) => new Promise((resolve,reject) => { const id = ++testId; testCalls.set(id,{resolve,reject}); testPort.postMessage({type:'invoke',id,name,args}); });
    globalThis.testWait = predicate => new Promise(resolve => { const check = () => { if (globalThis.testState && predicate(testState)) { testWaiters.delete(check); resolve(testState); } }; testWaiters.add(check); check(); });
    testPort.postMessage({type:'cmd',name:'ready',args:[]});
  `);
  await instrument(session);
  const rpc = (name, ...args) => evaluate(session, `testInvoke(${JSON.stringify(name)}, ...${JSON.stringify(args)})`);
  const stateWhere = (predicate, expected = `shell state matching ${predicate}`) => withinStep(evaluate(session, `testWait(${predicate})`), expected);
  const until = async (ready, expected = 'the browser condition to be met') => {
    let stop = false;
    const poll = async () => {
      while (!stop) {
        const result = await ready();
        if (result || stop) return result;
        if (browser.exitCode !== null) throw new Error('The browser exited');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    try {
      return await withinStep(poll(), expected);
    } finally {
      stop = true;
    }
  };
  const domWhere = (predicate, expected = `the frame DOM to match ${predicate}`) => withinStep(evaluate(session, `new Promise(resolve => { const check = () => { if ((${predicate})()) { observer.disconnect(); document.removeEventListener('focusin',check); resolve(true); } }; const observer = new MutationObserver(check); observer.observe(document.body, {subtree:true,childList:true,attributes:true}); document.addEventListener('focusin',check); check(); })`), expected);
  const textWhere = (predicate) => withinStep(evaluate(session, `new Promise(resolve => { const check = () => { if ((${predicate})(document.body.innerText)) { observer.disconnect(); resolve(document.body.innerText); } }; const observer = new MutationObserver(check); observer.observe(document.body, {subtree:true,childList:true,characterData:true}); check(); })`), `the frame text to match ${predicate}`);
  await stateWhere('s => s.spaces.length > 0');
  await evaluate(session, "document.querySelector('.tour-primary').click(); document.querySelector('.tour-primary').click()");
  await textWhere("text => text.includes('could not connect to its import helper')");
  console.log('PASS onboarding distinguishes a missing helper from an empty browser list');
  execFileSync(process.execPath, ['chromium/scripts/install-native-host.mjs', '--profile', profile], { env, stdio: 'inherit' });
  await evaluate(session, "[...document.querySelectorAll('.tour-ghost')].find(b => b.textContent === 'Try again').click()");
  await textWhere("text => text.includes('Chrome') && text.includes('Import')");
  const heliumRow = "[...document.querySelectorAll('.tour-browser')].find(row => row.querySelector('strong')?.textContent === 'Helium')";
  assert.equal(await evaluate(session, `(${heliumRow}).querySelector('small').textContent`), 'history');
  const bookmarkFile = path.join(fixture, 'Bookmarks');
  const bookmarkData = await fs.readFile(bookmarkFile);
  await fs.writeFile(bookmarkFile, '{invalid json');
  await evaluate(session, "[...document.querySelectorAll('.tour-ghost')].find(b => b.textContent === 'Import').click()");
  await textWhere("text => text.includes('Couldn’t read bookmarks')");
  assert.equal(await evaluate(session, "document.querySelector('.tour-browser').classList.contains('done')"), false);
  await fs.writeFile(bookmarkFile, bookmarkData);
  await evaluate(session, "document.querySelector('.tour-browser button').click()");
  // Nothing is added until the preview is confirmed.
  await domWhere("() => document.querySelector('.tour-preview .tour-confirm')");
  assert.deepEqual(await evaluate(session, "[...document.querySelectorAll('.tour-preview-spaces strong')].map(s => s.textContent)"), ['Chrome']);
  assert.equal(await evaluate(session, "[...document.querySelectorAll('.tour-preview .tour-segmented button')].map(b => b.textContent).join()"), 'Merge,Add as new');
  assert.equal((await rpc('previewImport', 'chrome')).spaces[0].pinned, 1);
  assert.equal((await stateWhere('s => s.spaces.length > 0')).spaces.some((sp) => sp.name.includes('Chrome')), false);
  console.log('PASS onboarding previews an import before adding anything');
  if (artifacts) {
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, 'onboarding-import-preview.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, session)).data, 'base64'));
  }
  await evaluate(session, "document.querySelector('.tour-preview .tour-confirm').click()");
  await textWhere("text => text.includes('1 bookmark')");
  console.log('PASS failed imports remain retryable and do not show a success check');
  assert.ok((await stateWhere("s => s.spaces.some(sp => sp.name.includes('Chrome'))")).spaces.length);
  console.log('PASS onboarding discovers and imports a synthetic Chrome bookmark through the native helper');
  await evaluate(session, `(${heliumRow}).querySelector('button').click()`);
  await domWhere("() => document.querySelector('.tour-preview .tour-confirm')");
  assert.equal(await evaluate(session, "document.querySelector('.tour-preview-extras').textContent"), '1 page of history');
  await evaluate(session, "document.querySelector('.tour-preview .tour-confirm').click()");
  await domWhere(`() => (${heliumRow}).classList.contains('done')`);
  assert.equal(await evaluate(session, `(${heliumRow}).querySelector('small').textContent`), '1 page');
  assert.equal(await evaluate(session, "chrome.history.search({ text: 'example.org/helium-history', startTime: 0 }).then(items => items.some(item => item.url === 'https://example.org/helium-history'))"), true);
  assert.deepEqual(await fs.readFile(heliumHistory), originalHeliumHistory);
  console.log('PASS onboarding discovers and imports Helium history without bookmarks or source changes');
  await rpc('finishOnboarding');
  const retryUrl = extension + 'settings.html#environments';
  const { targetId: retryTarget } = await send('Target.createTarget', { url: retryUrl });
  const retryPage = await attach(retryTarget);
  const environmentPane = 'document.querySelector("[data-pane=environments].pane")';
  const environmentCard = 'document.querySelector(".env-card:last-child")';
  const editEnvironment = (field, value) => `(() => {
    const input = ${environmentCard}.querySelector(${JSON.stringify(field)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`;
  let environmentRetryFailed = false;
  try {
    await withinStep(loaded(retryPage, retryUrl), 'the Environment settings page');
    await until(() => evaluate(retryPage, `!${environmentPane}.inert`), 'Environment preferences to load');
    await evaluate(retryPage, `(() => {
      const prefs = window.settings;
      const get = prefs.get;
      const set = prefs.set;
      const reply = Promise.withResolvers();
      const probe = globalThis.retryProbe = { reply, writes: [], committed: false, lostReply: false, readFailed: false };
      prefs.set = async (patch) => {
        probe.writes.push(patch.environment);
        const view = await set(patch);
        if (patch.environment?.op === 'create') {
          probe.committed = true;
          await reply.promise;
          probe.lostReply = true;
          throw new Error('Fixture lost create reply');
        }
        return view;
      };
      prefs.get = async () => {
        if (probe.lostReply && !probe.readFailed) {
          probe.readFailed = true;
          throw new Error('Fixture reconciliation read failed');
        }
        return get();
      };
      document.querySelector('#addEnvironment').click();
    })()`);
    await evaluate(retryPage, editEnvironment('.env-targets', 'https://retry-environment.test'));
    await until(() => evaluate(retryPage, 'retryProbe.committed'), 'the Environment create to commit');
    assert.equal(await evaluate(retryPage, 'window.settings.get().then(() => retryProbe.readFailed)'), false);
    await evaluate(retryPage, editEnvironment('.env-name', 'Retried project'));
    await evaluate(retryPage, 'retryProbe.reply.resolve()');
    await until(() => evaluate(retryPage, 'retryProbe.readFailed && !document.querySelector("#settings-load-error").hidden'), 'the reconciliation read to fail');
    await evaluate(retryPage, 'document.querySelector("#settings-load-error button").click()');
    await until(() => evaluate(retryPage, `!${environmentPane}.inert`), 'Environment preferences to recover');
    assert.equal(await evaluate(retryPage, `${environmentCard}.querySelector('.env-name').value`), 'Retried project');
    assert.equal(await evaluate(retryPage, `${environmentCard}.querySelector('.env-retry').hidden`), false);
    const projectId = await evaluate(retryPage, 'retryProbe.writes[0].id');
    assert.deepEqual(await evaluate(retryPage, 'retryProbe.writes.map(edit => edit.op)'), ['create']);
    assert.equal((await rpc('settings:get')).environments.find((project) => project.id === projectId)?.name, 'Project');
    await evaluate(retryPage, `${environmentCard}.querySelector('.env-retry').click()`);
    await until(async () => (await rpc('settings:get')).environments.some((project) => project.id === projectId && project.name === 'Retried project'), 'the retried Environment name to save');
    assert.deepEqual(await evaluate(retryPage, 'retryProbe.writes.map(edit => edit.op)'), ['create', 'edit']);
    await rpc('settings:set', { environment: { op: 'remove', id: projectId } });
    console.log('PASS Environment retry saves a newer name after a lost create reply and failed reconciliation read');
  } catch (error) {
    environmentRetryFailed = true;
    throw error;
  } finally {
    await withinStep(send('Target.closeTarget', { targetId: retryTarget }), 'the Environment test tab to close').catch((error) => {
      if (!environmentRetryFailed) throw error;
      console.warn('Could not close the Environment test tab', error);
    });
  }
  // Shortcut recording cancels on disconnect, even while the native pause is pending.
  const shortcutUrl = extension + 'settings.html?shortcuts-reconnect=1#shortcuts';
  const shortcutWorker = await attach((await findTarget(t => t.type === 'service_worker' && t.url.startsWith(extension))).targetId);
  await evaluate(shortcutWorker, `(() => {
    const original = chrome.flechaPrivate.setShortcuts;
    const probe = globalThis.shortcutReconnect = { original, connections: 0, starts: 0, restoredMaps: 0, pause: Promise.withResolvers() };
    probe.observe = port => {
      if (port.name !== 'flecha-settings' || !port.sender?.url?.includes('?shortcuts-reconnect=1')) return;
      probe.port = port;
      probe.connections++;
      port.onMessage.addListener(message => {
        if (message.name === 'settings:recording' && message.args[0] === true) probe.starts++;
      });
    };
    chrome.runtime.onConnect.addListener(probe.observe);
    chrome.flechaPrivate.setShortcuts = async map => {
      const normal = Object.keys(map).length !== 0;
      if (!normal && probe.pause) await probe.pause.promise;
      const rejected = await original.call(chrome.flechaPrivate, map);
      if (normal) probe.restoredMaps++;
      return rejected;
    };
  })()`);
  const { targetId: shortcutTarget } = await send('Target.createTarget', { url: shortcutUrl });
  const shortcutPage = await attach(shortcutTarget);
  try {
    await withinStep(loaded(shortcutPage, shortcutUrl), 'the shortcut test page to load');
    const keycap = 'document.querySelector("#shortcut-groups .keycap")';
    await until(() => evaluate(shortcutPage, `!!${keycap}`), 'the shortcut keycaps to render');
    for (const label of ['Preparing…', 'Press keys…']) {
      const starts = (await evaluate(shortcutWorker, 'shortcutReconnect.starts')) + 1;
      const connections = await evaluate(shortcutWorker, 'shortcutReconnect.connections');
      await evaluate(shortcutPage, `${keycap}.click()`);
      await until(() => evaluate(shortcutWorker, `shortcutReconnect.starts === ${starts}`), 'the recording request to reach the worker');
      await until(() => evaluate(shortcutPage, `${keycap}.textContent === ${JSON.stringify(label)}`), 'the keycap to show the recording state');
      await evaluate(shortcutWorker, 'shortcutReconnect.port.disconnect()');
      await until(() => evaluate(shortcutPage, `!document.querySelector('.keycap.recording') &&
        document.querySelector('#shortcut-notice').textContent.includes('Recording ended')`), 'the disconnected page to clear recording');
      await until(() => evaluate(shortcutWorker, `shortcutReconnect.connections > ${connections}`), 'the shortcut page to reconnect');
      await withinStep(evaluate(shortcutPage, 'window.settings.get()'), 'the replacement Settings port to answer');
      assert.equal(await evaluate(shortcutWorker, 'shortcutReconnect.starts'), starts);
      assert.equal(await evaluate(shortcutPage, `window.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Escape', code: 'Escape', cancelable: true }))`), true);
      await evaluate(shortcutWorker, 'shortcutReconnect.pause?.resolve(); shortcutReconnect.pause = undefined');
      // A disconnect injected from the worker only notifies the page. Reset the worker fixture
      // between cases and wait until Chromium actually has the normal shortcut map again.
      const restoredMaps = await evaluate(shortcutWorker, 'shortcutReconnect.restoredMaps');
      await withinStep(evaluate(shortcutPage, 'window.settings.recordShortcut(true).then(() => window.settings.recordShortcut(false))'),
        'the fixture to restore the shortcut map');
      await until(() => evaluate(shortcutWorker, `shortcutReconnect.restoredMaps > ${restoredMaps}`),
        'Chromium to apply the normal shortcut map');
    }
    console.log('PASS Settings cancels preparing and ready recordings on disconnect without resuming capture');
  } finally {
    await withinStep(evaluate(shortcutWorker, `shortcutReconnect.pause?.resolve();
      chrome.flechaPrivate.setShortcuts = shortcutReconnect.original;
      chrome.runtime.onConnect.removeListener(shortcutReconnect.observe)`), 'the shortcut fixture to release the native API')
      .catch(error => console.warn('Could not restore the shortcut fixture', error));
    await withinStep(send('Target.closeTarget', { targetId: shortcutTarget }), 'the shortcut test page to close')
      .catch(error => console.warn('Could not close the shortcut test tab', error));
  }
  await rpc('openSettings', 'import');
  const settingsImport = await attach((await findTarget(t => t.url.includes('/settings.html#import'))).targetId);
  await loaded(settingsImport, 'chrome-extension://');
  assert.equal(await evaluate(settingsImport, "document.querySelector('[data-pane=import].pane').hidden"), false);
  await evaluate(settingsImport, "const importButton = document.querySelector('#import-browser'); importButton.focus(); importButton.click()");
  waitingFor = 'the Settings import chooser to open';
  const importChoices = await until(async () => {
    const labels = await evaluate(settingsImport, `[...document.querySelectorAll('.shell-dialog[open] button')].map(button => button.textContent)`);
    return labels.length && labels;
  }, waitingFor);
  assert.deepEqual(importChoices, ['Chrome', 'Helium', 'Bookmarks File…', 'Cancel']);
  if (artifacts) await fs.writeFile(path.join(artifacts, 'settings-import.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, settingsImport)).data, 'base64'));
  await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button:last-child').click()");
  waitingFor = 'focus to return to the Settings import button after cancel';
  await until(() => evaluate(settingsImport, "document.activeElement === importButton && !importButton.hasAttribute('aria-disabled')"), waitingFor);
  await evaluate(settingsImport, 'importButton.click()');
  await until(() => evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button')?.textContent === 'Chrome'"), 'the Settings import chooser to reopen');
  await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button').click()");
  await until(() => evaluate(settingsImport, "document.querySelector('.shell-dialog[open] strong')?.textContent === 'Import from Chrome?'"), 'the Chrome import preview');
  try {
    await fs.writeFile(bookmarkFile, JSON.stringify({ roots: {} }));
    await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button').click()");
    await until(() => evaluate(settingsImport, "document.querySelector('.shell-dialog[open] strong')?.textContent === 'Nothing imported from Chrome'"), 'the changed-source import result');
    assert.match(await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] p').textContent"), /Spaces changed since the preview/);
  } finally {
    await fs.writeFile(bookmarkFile, bookmarkData);
  }
  await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button').click()");
  await until(() => evaluate(settingsImport, "!importButton.hasAttribute('aria-disabled')"), 'the import dialog to dismiss');
  await evaluate(settingsImport, 'importButton.click()');
  await until(() => evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button')?.textContent === 'Chrome'"), 'the duplicate import chooser');
  await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button').click()");
  await until(() => evaluate(settingsImport, "document.querySelector('.shell-dialog[open] strong')?.textContent === 'Import from Chrome?'"), 'the duplicate import preview');
  await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] button').click()");
  await until(() => evaluate(settingsImport, "document.querySelector('.shell-dialog[open] strong')?.textContent === 'Nothing imported from Chrome'"), 'the duplicate-only result');
  assert.equal(await evaluate(settingsImport, "document.querySelector('.shell-dialog[open] p').textContent"), 'Nothing to import');
  waitingFor = undefined;
  const importWindowId = await evaluate(settingsImport, 'chrome.windows.getCurrent().then(window => window.id)');
  await evaluate(session, `chrome.windows.remove(${importWindowId})`);
  console.log('PASS Settings Import opens the browser and bookmarks-file chooser');
  console.log('PASS Settings reports when the import source has changed and nothing was imported');
  console.log('PASS Settings reports a duplicate-only merge as unchanged');
  await rpc('newSpace');
  await stateWhere('s => s.spaces.length > 1');
  await evaluate(session, "document.querySelector('#space-done').click()");
  const first = (await stateWhere('s => s.onboarded')).activeSpaceId;
  await rpc('newTab', base + '/a');
  let state = await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/a')})`);
  const a = Object.values(state.tabs).find(t => t.url === base + '/a').id;
  const page = await attach((await findTarget(t => t.type === 'page' && t.url === base + '/a')).targetId);
  await loaded(page, base + '/a');
  await evaluate(page, "document.querySelector('#draft').focus()");
  await send('Input.insertText', { text: 'Unsaved document' }, page);
  // Scrolled down, with nothing focused: what a page is like after reading for a while.
  const documentState = await evaluate(page, "document.querySelector('#count').click(); document.activeElement.blur(); scrollTo(0, 500); ({ draft: document.querySelector('#draft').value, counter, documentToken, scrollY })");
  const preserved = async (label) => { assert.deepEqual(await evaluate(page, "({ draft: document.querySelector('#draft').value, counter, documentToken, scrollY })"), documentState); console.log(`PASS document preserved through ${label}`); };
  await rpc('togglePin', a);
  await stateWhere(`s => s.spaces.some(sp => sp.pinned.some(n => n.kind === 'tab' && n.tabId === ${JSON.stringify(a)}))`);
  await evaluate(session, "document.querySelector('#btn-toggle-pinned').click()");
  await domWhere("() => document.querySelector('#pinned').hidden && document.querySelector('#pinned-count').textContent === '1'");
  await evaluate(session, "document.querySelector('#btn-toggle-pinned').click()");
  await domWhere("() => !document.querySelector('#pinned').hidden");
  console.log('PASS the sidebar folds and unfolds the current Space’s Pinned section');
  await rpc('newTab', base + '/b');
  state = await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/b')})`);
  const b = Object.values(state.tabs).find(t => t.url === base + '/b').id;
  const key = async (name, modifiers) => {
    execFileSync(inputTool, [env.DISPLAY, String(browser.pid), ...modifiers, name], { env });
  };
  // The command bar closed by `how` is gone, and a real click on the sidebar reaches it: a bar left
  // open covers the sidebar, and a click's press then lands on the bar.
  const barClosed = async (how) => {
    waitingFor = `the command bar to hide after ${how}`;
    await domWhere("() => document.querySelector('#palette').hidden");
    const today = await evaluate(session, "document.querySelector('.today-header > span').getBoundingClientRect().toJSON()");
    // Where the press and the release land. `void`, so this evaluate doesn't wait for the click.
    await evaluate(session, "void (globalThis.sidebarPress = new Promise((resolve) => { let down; const name = (t) => (t?.closest?.('.today-header') ? 'Today' : t ? `${t.tagName}#${t.id}` : 'nothing'); addEventListener('mousedown', (e) => (down = e.target), { once: true, capture: true }); addEventListener('mouseup', (e) => resolve([name(down), name(e.target)]), { once: true, capture: true }); }))");
    waitingFor = `a real click on the sidebar's Today label after ${how} to reach the frame page`;
    execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'click', String(Math.round(today.x + today.width / 2)), String(Math.round(today.y + today.height / 2))], { env });
    assert.deepEqual(await evaluate(session, 'sidebarPress'), ['Today', 'Today'], `after ${how}, a click on the sidebar's Today label landed elsewhere (press, release)`);
    waitingFor = undefined;
  };
  await key('1', ['Control_L']);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(a)}`);
  await key('2', ['Control_L']);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(b)}`);
  await key('Tab', ['Control_L']);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(a)}`);
  await key('Tab', ['Control_L', 'Shift_L']);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(b)}`);
  console.log('PASS native Control-digit and Control-Tab dispatch');
  // Control-Tab goes by recency while Control is held, and the release commits the tab it stopped on.
  await rpc('newTab', base + '/c');
  state = await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/c')})`);
  const c = Object.values(state.tabs).find(t => t.url === base + '/c').id;
  const active = (id) => stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(id)}`);
  await active(c);
  const hold = (...args) => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), ...args], { env });
  hold('down', 'Control_L');
  hold('down', 'Tab'); hold('up', 'Tab');
  await active(b);
  hold('down', 'Tab'); hold('up', 'Tab');
  await active(a);
  hold('down', 'Shift_L', 'Tab'); hold('up', 'Tab', 'Shift_L');
  await active(b);
  hold('down', 'Tab'); hold('up', 'Tab');
  await active(a);
  hold('up', 'Control_L');
  // a is now the most recent and c the one before it: b was only passed through.
  await key('Tab', ['Control_L']);
  await active(c);
  await key('Tab', ['Control_L']);
  await active(a);
  console.log('PASS Control-Tab switches by recency while Control is held and commits on release');
  // A link opened in the background (Control-click) isn't a tab you used yet: Control-Tab still
  // goes back to the tab before, and reaches the new one last.
  await evaluate(session, `chrome.tabs.query({ active: true, windowType: 'normal' }).then(([tab]) => chrome.tabs.create({ url: ${JSON.stringify(base + '/background')}, active: false, openerTabId: tab.id }))`);
  state = await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/background')})`);
  const background = Object.values(state.tabs).find(t => t.url === base + '/background').id;
  await key('Tab', ['Control_L']);
  await active(c);
  await key('Tab', ['Control_L']);
  await active(a);
  hold('down', 'Control_L');
  hold('down', 'Shift_L', 'Tab'); hold('up', 'Tab', 'Shift_L');
  await active(background);
  hold('down', 'Shift_L', 'Tab'); hold('up', 'Tab', 'Shift_L');
  await active(b);
  hold('down', 'Tab'); hold('up', 'Tab');
  await active(background);
  hold('down', 'Tab'); hold('up', 'Tab');
  await active(a);
  hold('up', 'Control_L');
  await rpc('close', background);
  await stateWhere(`s => !s.tabs[${JSON.stringify(background)}]`);
  console.log('PASS a tab opened in the background comes after the tabs you used, for Control-Tab and Control-Shift-Tab');
  // A hold that began with another shortcut (Control-L, then Tab) ends on release too.
  hold('down', 'Control_L');
  hold('down', 'l'); hold('up', 'l');
  await domWhere("() => !document.querySelector('#palette').hidden");
  hold('down', 'Tab'); hold('up', 'Tab');
  await active(c);
  hold('up', 'Control_L');
  // The tab switch took keyboard focus to the page, which closes the command bar.
  await barClosed('a tab switch');
  await key('Tab', ['Control_L']);
  await active(a);
  console.log('PASS a Control-Tab run that began with another shortcut ends when Control is released');
  await rpc('close', c);
  await rpc('activate', b);
  await active(b);
  await rpc('activate', a);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(a)}`);
  await preserved('tab switching and pinning');
  const second = state.spaces.find(sp => sp.id !== first).id;
  await key('1', ['Control_L', 'Alt_L']);
  await stateWhere(`s => s.activeSpaceId === ${JSON.stringify(second)}`);
  await key('2', ['Control_L', 'Alt_L']);
  await stateWhere(`s => s.activeSpaceId === ${JSON.stringify(first)}`);
  await preserved('Space switching');
  await key('l', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.tagName === 'INPUT'");
  await key('Escape', []);
  await barClosed('Escape');
  console.log('PASS native Control-L opens and focuses the command bar');
  // A tab switch closes the bar, with no Escape.
  await key('l', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await key('Tab', ['Control_L']);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId !== ${JSON.stringify(a)}`);
  await barClosed('a Control-Tab switch');
  await rpc('activate', a);
  await active(a);
  console.log('PASS Control-Tab from the open command bar closes it and leaves the sidebar clickable');
  // Search suggestions: the frame page's requests to Google's suggest endpoint go to this test's server.
  const suggestRequests = [];
  // A query in `failing` fails at the network instead; its promise settles once it has.
  const failing = {};
  const toFakeSuggest = (message) => {
    if (message.sessionId !== session || message.method !== 'Fetch.requestPaused') return;
    const asked = new URL(message.params.request.url);
    const query = asked.searchParams.get('q');
    suggestRequests.push(query);
    if (failing[query]) return void send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'ConnectionFailed' }, session).then(failing[query]);
    void send('Fetch.continueRequest', { requestId: message.params.requestId, url: `${base}/suggest${asked.search}` }, session);
  };
  listeners.add(toFakeSuggest);
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.google.com/complete/search?*' }] }, session);
  // The command bar is one ranked list, as Arc's: each row says its kind, and the selected one
  // is the combobox's active option. Every suggestion it ever shows is kept, to check none was for an older query.
  const paletteRows = "[...document.querySelectorAll('#palette-results [role=option]')].map((li) => li.dataset.kind + ': ' + li.querySelector('.title').textContent + (li.getAttribute('aria-selected') === 'true' && document.querySelector('#palette-input').getAttribute('aria-activedescendant') === li.id ? ' (selected)' : ''))";
  const suggestionLabels = "[...document.querySelectorAll('#palette-results [data-kind=suggestion] .title')].map((title) => title.textContent)";
  await evaluate(session, `globalThis.shownSuggestions = new Set(); new MutationObserver(() => (${suggestionLabels}).forEach((label) => shownSuggestions.add(label))).observe(document.querySelector('#palette-results'), { childList: true })`);
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await send('Input.insertText', { text: 'flecha slow' }, session);
  const { closed: slowClosed } = await slowSuggestAsked;
  await send('Input.insertText', { text: ' more' }, session);
  await domWhere(`() => (${suggestionLabels}).join('|') === 'flecha slow more one|flecha slow more two'`);
  // The older query's request was given up, unanswered.
  await slowClosed;
  assert.deepEqual(await evaluate(session, paletteRows), ['search: flecha slow more (selected)', 'suggestion: flecha slow more one', 'suggestion: flecha slow more two']);
  await key('Down', []);
  assert.deepEqual(await evaluate(session, paletteRows), ['search: flecha slow more', 'suggestion: flecha slow more one (selected)', 'suggestion: flecha slow more two']);
  await key('Return', []);
  await stateWhere("s => Object.values(s.tabs).some((t) => t.url === 'https://www.google.com/search?q=flecha%20slow%20more%20one')");
  await barClosed('picking a suggestion');
  assert.deepEqual([...(await evaluate(session, '[...shownSuggestions]'))].sort(), ['flecha slow more one', 'flecha slow more two']);
  console.log('PASS typing in the command bar shows the engine\'s suggestions under the typed search, never an older query\'s, and picking one searches for it');
  // Nothing is asked for an address, an internal page or a file path, or while Chromium's
  // "Autocomplete searches and URLs" is off; requests that went out would reach the list above.
  const suggestNow = (query) => evaluate(session, `window.flecha.searchSuggestions(${JSON.stringify(query)}, new AbortController().signal)`);
  for (const query of ['example.com/private', 'chrome://settings', '/home/user/notes.txt', '%65xample%2ecom', 'notes 127.0.0.1:8080', 'notes 127.0.0.1', 'notes 127.0.0.1.', 'notes chrome:']) assert.deepEqual(await suggestNow(query), []);
  await evaluate(session, 'chrome.privacy.services.searchSuggestEnabled.set({ value: false })');
  assert.deepEqual(await suggestNow('flecha off'), []);
  await evaluate(session, 'chrome.privacy.services.searchSuggestEnabled.clear({})');
  assert.deepEqual(await suggestNow('flecha on'), ['flecha on one', 'flecha on two']);
  assert.deepEqual(suggestRequests.filter((query) => !query.startsWith('flecha slow')), ['flecha on']);
  console.log('PASS no suggestions are asked for addresses, internal pages or file paths, or with Chromium\'s search suggestions off');
  // An empty bar, as Arc's: the three most recent other tabs to switch to, then two actions.
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  state = await stateWhere('s => true');
  const current = state.spaces.find((sp) => sp.id === state.activeSpaceId).activeTabId;
  const recentOthers = Object.values(state.tabs).filter((t) => t.id !== current).length;
  const emptyKinds = [...Array(Math.min(3, recentOthers)).fill('tab'), 'action', 'action'];
  const kinds = "[...document.querySelectorAll('#palette-results [role=option]')].map((li) => li.dataset.kind)";
  assert.deepEqual(await evaluate(session, kinds), emptyKinds);
  assert.deepEqual((await evaluate(session, paletteRows)).slice(-2), ['action: New Space', 'action: New Flechinha Window']);
  assert.ok((await evaluate(session, "[...document.querySelectorAll('#palette-results [data-kind=tab] .go')].map((go) => go.textContent)")).every((go) => go === 'Switch to Tab'));
  assert.match((await evaluate(session, paletteRows))[0], /^tab: .* \(selected\)$/);
  // Tab there searches actions only; Backspace in the empty field goes back.
  await key('Tab', []);
  await domWhere("() => document.querySelector('#palette-mode').textContent === 'Actions' && document.activeElement.id === 'palette-input'");
  assert.ok((await evaluate(session, kinds)).every((kind) => kind === 'action'));
  await send('Input.insertText', { text: 's' }, session);
  await domWhere(`() => (${paletteRows})[0] === 'action: Settings (selected)'`);
  await key('BackSpace', []);
  await key('BackSpace', []);
  await domWhere(`() => document.querySelector('#palette-mode').textContent === '' && (${kinds}).join() === ${JSON.stringify(emptyKinds.join())}`);
  // The same shortcut again closes the bar.
  await key('t', ['Control_L']);
  await barClosed('Control-T again');
  console.log('PASS an empty command bar shows recent tabs to switch to and two actions, Tab searches actions, and Control-T again closes it');
  // An open tab whose title starts with what's typed is the top hit, before the typed search; Enter switches to it.
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await send('Input.insertText', { text: 'Workflow /b' }, session);
  await domWhere(`() => (${paletteRows}).slice(0, 2).join('|') === 'tab: Workflow /b (selected)|search: Workflow /b'`);
  await key('Return', []);
  await active(b);
  await barClosed('switching to a tab');
  console.log('PASS a tab whose title starts with the query is the top hit and Enter switches to it');
  // A tab renamed in the background reorders the list; the result you moved to stays selected.
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await send('Input.insertText', { text: 'Workflow /' }, session);
  await domWhere(`() => (${paletteRows}).includes('tab: Workflow /a (selected)') && (${paletteRows}).includes('search: Workflow /')`);
  const searchRow = (await evaluate(session, paletteRows)).indexOf('search: Workflow /');
  for (let i = 0; i < searchRow; i++) await key('Down', []);
  await domWhere(`() => (${paletteRows})[${searchRow}] === 'search: Workflow / (selected)'`);
  await rpc('renameTab', a, 'Renamed elsewhere');
  await domWhere(`() => !(${paletteRows}).some((row) => row.startsWith('tab: Workflow /a'))`);
  assert.ok((await evaluate(session, paletteRows)).includes('search: Workflow / (selected)'));
  await rpc('renameTab', a, '');
  await key('Escape', []);
  await domWhere("() => document.querySelector('#palette').hidden");
  console.log('PASS a background change to the tabs keeps the selected result selected');
  // An address you've visited completes inline, the added part selected; moving off it puts back what was typed.
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  // The imported Helium history page; the Chrome bookmark import left an example.com tab open, which "exam" would complete to.
  await send('Input.insertText', { text: 'example.o' }, session);
  const field = "(() => { const input = document.querySelector('#palette-input'); return [input.value, input.selectionStart, input.selectionEnd].join() })()";
  await domWhere(`() => ${field} === 'example.org,9,11' && (${paletteRows})[0] === 'completion: example.org (selected)'`);
  // Down from the completion goes to the typed search, the next row, which Enter would search for.
  // The completion's row stays where it was; Up selects it and shows it in the field again.
  await key('Down', []);
  await domWhere(`() => ${field} === 'example.o,9,9' && (${paletteRows}).slice(0, 2).join('|') === 'completion: example.org|search: example.o (selected)'`);
  await key('Up', []);
  await domWhere(`() => ${field} === 'example.org,9,11' && (${paletteRows})[0] === 'completion: example.org (selected)'`);
  // Typing on completes again; pointing at the typed address ("example.or" reads as one) puts back
  // what was typed, as the arrows do, and leaves that row under the pointer for a click.
  await send('Input.insertText', { text: 'r' }, session);
  await domWhere(`() => ${field} === 'example.org,10,11' && (${paletteRows})[0] === 'completion: example.org (selected)'`);
  const centre = (selector) => evaluate(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  // The bar opens in the sidebar-wide frame and moves to the window's centre when the frame grows
  // (x 130, then 525; 2026-10-26). It stays transparent until then, so point at it once it shows:
  // the row can't move after that, and the assertion below uses the same point.
  waitingFor = 'the command bar to show once its frame has grown';
  await domWhere("() => !document.querySelector('#palette').classList.contains('opening')");
  // From the field to the row, again until it takes: a move to where the pointer already is fires
  // no mousemove. Both are measured each time.
  let typedAt;
  waitingFor = 'pointing at the typed address in the command bar to select its row';
  do {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await centre('#palette-input')) }, session);
    typedAt = await centre('#palette-results [data-kind=address]');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...typedAt }, session);
  } while (!(await evaluate(session, `(${paletteRows}).includes('address: example.or (selected)')`)));
  waitingFor = undefined;
  await domWhere(`() => ${field} === 'example.or,10,10' && (${paletteRows}).includes('address: example.or (selected)')`);
  assert.equal(await evaluate(session, `document.elementFromPoint(${typedAt.x}, ${typedAt.y}).closest('[role=option]').dataset.kind`), 'address');
  await key('Escape', []);
  await domWhere("() => document.querySelector('#palette').hidden");
  console.log('PASS a visited address completes inline as the top hit, and moving off it restores the typed text');
  // Closing gives up the suggestions still on their way, and a change to the tabs after it
  // doesn't show the bar again.
  const lateAsked = heldSuggest('flecha late');
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await send('Input.insertText', { text: 'flecha late' }, session);
  const { closed: lateClosed } = await lateAsked;
  await key('Escape', []);
  await lateClosed;
  await rpc('renameTab', b, 'Renamed after the bar closed');
  await textWhere("(text) => text.includes('Renamed after the bar closed')");
  await barClosed('Escape, with suggestions still on their way');
  await rpc('renameTab', b, '');
  console.log('PASS each way of closing the command bar leaves the sidebar clickable, and nothing arriving later shows the bar again');
  // Suggestions from one opening don't show in the next while the request for them fails (Sol check SUGGEST4).
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await send('Input.insertText', { text: 'flecha fail' }, session);
  await domWhere(`() => (${suggestionLabels}).join('|') === 'flecha fail one|flecha fail two'`);
  await key('Escape', []);
  await domWhere("() => document.querySelector('#palette').hidden");
  const failed = new Promise((resolve) => (failing['flecha fail'] = resolve));
  await key('t', ['Control_L']);
  await domWhere("() => !document.querySelector('#palette').hidden && document.activeElement.id === 'palette-input'");
  await send('Input.insertText', { text: 'flecha fail' }, session);
  await failed;
  await domWhere(`() => (${paletteRows})[0] === 'search: flecha fail (selected)'`);
  assert.deepEqual(await evaluate(session, suggestionLabels), []);
  await key('Escape', []);
  await barClosed('Escape after a failed suggestion request');
  console.log('PASS a failed suggestion request shows no suggestions, not those of an earlier opening');
  await send('Fetch.disable', {}, session);
  listeners.delete(toFakeSuggest);
  await rpc('close', Object.values((await stateWhere('s => true')).tabs).find((t) => t.url.startsWith('https://www.google.com/search')).id);
  const unrelatedUrl = base + '/unrelated-split';
  await rpc('newTab', unrelatedUrl);
  const unrelated = Object.values((await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(unrelatedUrl)})`)).tabs).find(t => t.url === unrelatedUrl).id;
  const dragSpace = await stateWhere('s => true');
  const otherDragSpace = dragSpace.spaces.find(sp => sp.id !== dragSpace.activeSpaceId).id;
  await rpc('updateSpace', dragSpace.activeSpaceId, { pinnedCollapsed: true });
  await until(() => evaluate(session, "document.querySelector('#pinned').hidden"), 'Pinned to fold before the drag');
  assert.equal(await evaluate(session, `(() => {
    const row = id => document.querySelector('.row[data-tab-id="' + CSS.escape(id) + '"]');
    const source = row(${JSON.stringify(b)});
    const target = row(${JSON.stringify(a)});
    const event = { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true };
    source.dispatchEvent(new DragEvent('dragstart', event));
    globalThis.staleTabDrag = { source, target, event };
    return !document.querySelector('#pinned').hidden && document.querySelector('#pinned-count').hidden
      && document.querySelector('#btn-toggle-pinned').getAttribute('aria-expanded') === 'true';
  })()`), true, 'temporary expansion updates Pinned and its accessibility state');
  await rpc('switchSpace', otherDragSpace);
  await until(() => evaluate(session, `document.querySelector('#space-title').dataset.spaceId === ${JSON.stringify(otherDragSpace)}`), 'the new Space to render during the drag');
  assert.equal(await evaluate(session, `(() => {
    const { source, target, event } = staleTabDrag;
    if (getComputedStyle(target).visibility !== 'hidden') throw new Error('The previous Space’s rows are still visible');
    const moveTab = flecha.moveTab;
    let submitted = false;
    flecha.moveTab = () => { submitted = true; };
    try {
      target.dispatchEvent(new DragEvent('drop', event));
      source.dispatchEvent(new DragEvent('dragend', event));
      return submitted;
    } finally {
      flecha.moveTab = moveTab;
      delete globalThis.staleTabDrag;
    }
  })()`), false, 'a row from the previous Space rejects the drop');
  await rpc('switchSpace', dragSpace.activeSpaceId);
  await rpc('updateSpace', dragSpace.activeSpaceId, { pinnedCollapsed: false });
  console.log('PASS drag expansion and stale destinations follow the current Space');
  await rpc('activate', a);
  await active(a);
  await domWhere(`() => document.querySelector('.row.active[data-tab-id="' + CSS.escape(${JSON.stringify(a)}) + '"]')`);
  const splitHighlight = await evaluate(session, `(() => {
    const rowFor = id => document.querySelector('.row[data-tab-id="' + CSS.escape(id) + '"]');
    const source = rowFor(${JSON.stringify(b)});
    const target = rowFor(${JSON.stringify(a)});
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
    const rect = target.getBoundingClientRect();
    const event = { dataTransfer, bubbles: true, cancelable: true, clientX: rect.right - 1, clientY: rect.top + rect.height / 2 };
    target.dispatchEvent(new DragEvent('dragover', event));
    globalThis.testTabDrag = { source, target, event };
    return getComputedStyle(target).backgroundImage;
  })()`);
  assert.match(splitHighlight, /linear-gradient\(to left/);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] }, session);
  assert.equal(await evaluate(session, `(() => {
    const style = getComputedStyle(testTabDrag.target, '::after');
    return style.borderStyle === 'solid' && Math.abs(parseFloat(style.left) - testTabDrag.target.offsetWidth * 0.4) <= 1;
  })()`), true, 'forced colors outline the right drop zone');
  if (artifacts) await fs.writeFile(path.join(artifacts, 'split-drop-forced-colors.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, session)).data, 'base64'));
  await send('Emulation.setEmulatedMedia', { features: [] }, session);
  if (artifacts) {
    for (const theme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, session);
      await fs.writeFile(path.join(artifacts, `split-drop-${theme}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, session)).data, 'base64'));
    }
    await send('Emulation.setEmulatedMedia', { features: [] }, session);
  }
  await rpc('activate', unrelated);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(unrelated)}`);
  assert.equal(await evaluate(session, `(() => {
    const { source, target, event } = testTabDrag;
    if (!source.isConnected || !target.isConnected) return false;
    target.dispatchEvent(new DragEvent('drop', event));
    source.dispatchEvent(new DragEvent('dragend', event));
    delete globalThis.testTabDrag;
    return true;
  })()`), true, 'the drag source and target survive a state update');
  const sidebarSplit = await stateWhere('s => !!s.spaces.find(sp => sp.id === s.activeSpaceId).split');
  assert.deepEqual(sidebarSplit.spaces.find(sp => sp.id === sidebarSplit.activeSpaceId).split, [a, b]);
  waitingFor = 'the two dropped tabs to share a native split';
  const splitWindowId = await evaluate(session, 'chrome.flechaPrivate.getWindowId()');
  const waitForNativeSplit = (leftUrl, rightUrl, removed, expected) => until(() => evaluate(session, `chrome.tabs.query({ windowId: ${splitWindowId} }).then(tabs => {
    const left = tabs.find(t => t.url === ${JSON.stringify(leftUrl)});
    const right = tabs.find(t => t.url === ${JSON.stringify(rightUrl)});
    return left && right && left.id !== right.id && left.splitViewId >= 0 && left.splitViewId === right.splitViewId
      && !tabs.some(t => t.id === ${JSON.stringify(removed)});
  })`), expected);
  await waitForNativeSplit(sidebarSplit.tabs[a].url, sidebarSplit.tabs[b].url, undefined, waitingFor);
  waitingFor = undefined;
  await preserved('entering split view');
  await rpc('exitSplit');
  await stateWhere('s => !s.spaces.find(sp => sp.id === s.activeSpaceId).split');
  await preserved('leaving split view');
  await rpc('activate', a);
  await active(a);
  await rpc('toggleResponsive');
  const responsive = await stateWhere("s => s.spaces.find(sp => sp.id === s.activeSpaceId).splitMode === 'responsive'");
  const responsiveSpace = responsive.spaces.find(sp => sp.id === responsive.activeSpaceId);
  assert.equal(responsiveSpace.activeTabId, a);
  const mirror = responsiveSpace.split[1];
  const responsivePanes = () => evaluate(session, `chrome.tabs.query({ windowId: ${splitWindowId} }).then(tabs => {
    const desktop = tabs.find(t => t.active && t.url === ${JSON.stringify(responsive.tabs[a].url)});
    const phone = desktop && tabs.find(t => t.id !== desktop.id && desktop.splitViewId >= 0 && t.splitViewId === desktop.splitViewId);
    return phone ? { desktop: desktop.width, phone: phone.width, phoneId: phone.id } : null;
  })`);
  const panes = await until(async () => {
    const now = await responsivePanes();
    // The phone viewport uses the 393px width in responsiveViewport.ts.
    return now && Math.abs(now.phone - 393) <= 1 && now;
  }, 'the active desktop tab to share a native split with a phone-width pane');
  const dockedFrame = await evaluate(session, 'innerWidth');
  await rpc('setOverlay', 'responsive-test', true);
  const fullFrame = await until(() => evaluate(session, `innerWidth > ${dockedFrame} && innerWidth`), 'the frame to open a full-width overlay');
  await rpc('toggleSidebar');
  await until(async () => {
    const now = await responsivePanes();
    return now && now.desktop > panes.desktop && Math.abs(now.phone - panes.phone) <= 1;
  }, 'the desktop pane to grow while the phone stays the same width');
  assert.equal(await evaluate(session, 'innerWidth'), fullFrame);
  await rpc('toggleSidebar');
  await until(async () => {
    const now = await responsivePanes();
    return now && Math.abs(now.desktop - panes.desktop) <= 1 && Math.abs(now.phone - panes.phone) <= 1;
  }, 'the responsive panes to return to their docked widths');
  await rpc('setOverlay', 'responsive-test', false);
  await rpc('activate', mirror);
  await active(mirror);
  await domWhere(`() => !!document.querySelector('.row.active[data-tab-id="' + CSS.escape(${JSON.stringify(mirror)}) + '"]')`);
  await evaluate(session, `(() => {
    const source = document.querySelector('.row[data-tab-id="' + CSS.escape(${JSON.stringify(unrelated)}) + '"]');
    const half = document.querySelector('#split-drop .drop-half[data-side=right]');
    const event = { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true };
    source.dispatchEvent(new DragEvent('dragstart', event));
    half.dispatchEvent(new DragEvent('dragover', event));
    globalThis.stalePageDrop = { source, half, event };
  })()`);
  const originalInset = await evaluate(session, "parseFloat(getComputedStyle(document.querySelector('#split-drop')).left)");
  await rpc('setSidebarWidth', originalInset + 1);
  await until(() => evaluate(session, `parseFloat(getComputedStyle(document.querySelector('#split-drop')).left) === ${originalInset + 1}`), 'the drop zone to follow the resized sidebar');
  await rpc('setSidebarWidth', originalInset);
  await rpc('activate', b);
  await active(b);
  const hoveredTarget = await evaluate(session, `(async () => {
    const { source, half, event } = stalePageDrop;
    const dropToSplit = flecha.dropToSplit;
    let args;
    flecha.dropToSplit = (...values) => { args = values; };
    try {
      half.dispatchEvent(new DragEvent('drop', event));
      source.dispatchEvent(new DragEvent('dragend', event));
      if (args) await testInvoke('dropToSplit', ...args);
      return args?.[2]?.tabId;
    } finally {
      flecha.dropToSplit = dropToSplit;
      delete globalThis.stalePageDrop;
    }
  })()`);
  assert.equal(hoveredTarget, a, 'the command names the page that was under the pointer');
  await rpc('ready');
  assert.equal(await evaluate(session, `testState.spaces.find(sp => sp.id === testState.activeSpaceId).splitMode`), 'responsive');
  await rpc('activate', mirror);
  await active(mirror);
  await domWhere(`() => !!document.querySelector('.row.active[data-tab-id="' + CSS.escape(${JSON.stringify(mirror)}) + '"]')`);
  const overlay = await evaluate(session, `(() => {
    const drag = id => {
      const row = document.querySelector('.row[data-tab-id="' + CSS.escape(id) + '"]');
      const dataTransfer = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true, cancelable: true }));
      return { row, dataTransfer };
    };
    const splitDrop = document.querySelector('#split-drop');
    const phone = drag(${JSON.stringify(mirror)});
    const phoneCanSplit = !splitDrop.hidden;
    phone.row.dispatchEvent(new DragEvent('dragend', { dataTransfer: phone.dataTransfer, bubbles: true }));
    const source = drag(${JSON.stringify(unrelated)});
    const desktopCanSplit = !splitDrop.hidden;
    const half = splitDrop.querySelector('.drop-half[data-side=right]');
    half.dispatchEvent(new DragEvent('dragover', { dataTransfer: source.dataTransfer, bubbles: true, cancelable: true }));
    half.dispatchEvent(new DragEvent('drop', { dataTransfer: source.dataTransfer, bubbles: true }));
    source.row.dispatchEvent(new DragEvent('dragend', { dataTransfer: source.dataTransfer, bubbles: true }));
    return { phoneCanSplit, desktopCanSplit };
  })()`);
  assert.deepEqual(overlay, { phoneCanSplit: false, desktopCanSplit: true });
  const replaced = await stateWhere(`s => !s.tabs[${JSON.stringify(mirror)}] && !!s.spaces.find(sp => sp.id === s.activeSpaceId).split`, 'the page drop to replace the phone mirror');
  assert.deepEqual(replaced.spaces.find(sp => sp.id === replaced.activeSpaceId).split, [a, unrelated]);
  await waitForNativeSplit(responsive.tabs[a].url, unrelatedUrl, panes.phoneId, 'the replacement native split to appear without the old phone tab');
  await rpc('exitSplit');
  await preserved('replacing the responsive split with a desktop tab');
  await rpc('activate', a);
  await active(a);
  await rpc('toggleResponsive');
  const hiddenPair = await stateWhere("s => s.spaces.find(sp => sp.id === s.activeSpaceId).splitMode === 'responsive'");
  const hiddenMirror = hiddenPair.spaces.find(sp => sp.id === hiddenPair.activeSpaceId).split[1];
  await rpc('activate', unrelated);
  await active(unrelated);
  await rpc('toggleSidebar');
  await until(() => evaluate(session, "document.body.dataset.sidebar === 'hidden'"), 'the sidebar to hide while the split is in the background');
  await rpc('activate', a);
  await active(a);
  await until(async () => {
    const now = await responsivePanes();
    return now && now.desktop > panes.desktop && Math.abs(now.phone - 393) <= 1;
  }, 'the returning phone pane to have its correct width after the layout changed');
  await rpc('toggleSidebar');
  await until(() => evaluate(session, "document.body.dataset.sidebar === 'docked'"), 'the sidebar to dock again');
  await rpc('activate', unrelated);
  await active(unrelated);
  await domWhere(`() => !!document.querySelector('.row.active[data-tab-id="' + CSS.escape(${JSON.stringify(unrelated)}) + '"]')`);
  assert.equal(await evaluate(session, `(() => {
    const row = document.querySelector('.row[data-tab-id="' + CSS.escape(${JSON.stringify(a)}) + '"]');
    const splitDrop = document.querySelector('#split-drop');
    const event = { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true };
    row.dispatchEvent(new DragEvent('dragstart', event));
    const offered = !splitDrop.hidden;
    if (offered) {
      const half = splitDrop.querySelector('.drop-half[data-side=right]');
      half.dispatchEvent(new DragEvent('dragover', event));
      half.dispatchEvent(new DragEvent('drop', event));
    }
    row.dispatchEvent(new DragEvent('dragend', event));
    return offered;
  })()`), true, 'a tab from a hidden split can be dropped on the visible page');
  const visiblePair = await stateWhere(`s => !s.tabs[${JSON.stringify(hiddenMirror)}] && !!s.spaces.find(sp => sp.id === s.activeSpaceId).split`, 'the visible tab and former desktop pane to replace the hidden phone split');
  assert.deepEqual(visiblePair.spaces.find(sp => sp.id === visiblePair.activeSpaceId).split, [unrelated, a]);
  await rpc('exitSplit');
  console.log('PASS responsive layout follows the sidebar and drops target the page on screen');
  await rpc('close', unrelated);
  await stateWhere(`s => !s.tabs[${JSON.stringify(unrelated)}]`);
  await rpc('openPeek', base + '/peek');
  const peek = await findTarget(t => t.type === 'page' && t.url === base + '/peek');
  assert.ok(peek.targetId);
  // Control-W closes the Peek, not the tab behind it.
  await domWhere("() => !document.querySelector('#peek').hidden");
  const tabsUnderPeek = Object.keys((await stateWhere('s => true')).tabs).sort();
  await key('w', ['Control_L']);
  await domWhere("() => document.querySelector('#peek').hidden");
  assert.deepEqual(Object.keys((await stateWhere('s => true')).tabs).sort(), tabsUnderPeek);
  await preserved('Peek');
  // "Open in Peek" on a link's own context menu: the item above Inspect, picked by keyboard.
  await rpc('activate', a);
  await evaluate(page, "new Promise(resolve => document.visibilityState === 'visible' ? resolve() : document.addEventListener('visibilitychange', resolve, { once: true }))");
  const linkAt = await evaluate(page, "(() => { const r = document.querySelector('a').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  const windowsBefore = execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'windows'], { env, encoding: 'utf8' }).trim().split('\n').length;
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...linkAt, button: 'right', clickCount: 1 }, page);
  // The menu is a window of its own; there is no page event for it.
  while (execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'windows'], { env, encoding: 'utf8' }).trim().split('\n').length === windowsBefore) {
    if (browser.exitCode !== null) throw new Error('The browser exited');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const keyName of ['Up', 'Up', 'Return']) {
    execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'down', keyName], { env });
    execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'up', keyName], { env });
  }
  assert.ok((await findTarget(t => t.type === 'page' && t.url === base + '/peek')).targetId);
  await rpc('closePeek');
  await preserved('Open in Peek from the link context menu');
  // A Peek that replaces another (a link inside a Peek) leaves the page as it was too.
  await rpc('openPeek', base + '/peek');
  await findTarget(t => t.type === 'page' && t.url === base + '/peek');
  await rpc('openPeek', base + '/peek-replacing');
  await findTarget(t => t.type === 'page' && t.url === base + '/peek-replacing');
  await rpc('closePeek');
  await preserved('a Peek replacing another');
  const folder = await rpc('newFolder');
  assert.ok(folder);
  await rpc('renameFolder', folder, 'Workflow folder');
  await rpc('moveTab', a, { zone: 'pinned', folderId: folder });
  await stateWhere(`s => s.spaces.some(sp => sp.pinned.some(n => n.kind === 'folder' && n.id === ${JSON.stringify(folder)} && n.children.some(t => t.tabId === ${JSON.stringify(a)})))`);
  await rpc('toggleFolder', folder);
  await preserved('folder moves and collapse');
  await rpc('activate', a);
  await rpc('openFlechinha', undefined, a);
  await preserved('moving into Flechinha');
  const windows = await evaluate(session, 'chrome.flechaPrivate.getFlechinhas()');
  assert.equal(windows.length, 1);
  await rpc('flechinha:openInFlecha', windows[0]);
  await preserved('moving back from Flechinha');
  // A link's Peek opens in the Space partition of the tab the link is on.
  const spaceCount = (await stateWhere('s => true')).spaces.length;
  await rpc('newSpace');
  const isolated = (await stateWhere(`s => s.spaces.length > ${spaceCount}`)).activeSpaceId;
  await evaluate(session, "document.querySelector('#space-done').click()");
  await rpc('setSpaceIsolated', isolated, true);
  await rpc('newTab', base + '/isolated');
  const isolatedPage = await attach((await findTarget(t => t.type === 'page' && t.url === base + '/isolated')).targetId);
  await loaded(isolatedPage, base + '/isolated');
  await evaluate(isolatedPage, "document.cookie = 'space=isolated; path=/'");
  const isolatedTab = await evaluate(session, `chrome.tabs.query({ url: ${JSON.stringify(base + '/isolated')} }).then(tabs => tabs[0].id)`);
  const peekCookie = async (url) => {
    const peekPage = await attach((await findTarget(t => t.type === 'page' && t.url === url)).targetId);
    await loaded(peekPage, url);
    const cookie = await evaluate(peekPage, 'document.cookie');
    await rpc('closePeek');
    return cookie;
  };
  await rpc('openLinkInPeek', base + '/peek-isolated', isolatedTab);
  await loaded(await attach((await findTarget(t => t.type === 'page' && t.url === base + '/peek-isolated')).targetId), base + '/peek-isolated');
  // A link inside that Peek has no tab; its Peek keeps the Peek's cookies.
  await rpc('openLinkInPeek', base + '/peek-nested');
  assert.equal(await peekCookie(base + '/peek-nested'), 'space=isolated');
  await rpc('openLinkInPeek', base + '/peek-isolated', isolatedTab);
  assert.equal(await peekCookie(base + '/peek-isolated'), 'space=isolated');
  await rpc('openPeek', base + '/peek-shared');
  assert.equal(await peekCookie(base + '/peek-shared'), '');
  console.log('PASS a link\'s Peek keeps its tab\'s separate cookies');
  await rpc('deleteSpace', isolated);
  // Back from the Flechinha, the page is a new Today tab (the pinned /a it came from stays, unloaded).
  const afterDelete = await stateWhere(`s => s.spaces.length === ${spaceCount}`);
  const pageTab = afterDelete.spaces.flatMap(sp => sp.today).find(id => afterDelete.tabs[id].url === base + '/a');
  await rpc('activate', pageTab);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);

  // Extension actions: a sidebar button with its badge, whose popup drops from it and closes on a second click.
  const actionButton = "document.querySelector('#extensions .ext-action[aria-label=\"Probe Action\"]')";
  await domWhere("() => !document.querySelector('#extensions').hidden && !document.querySelector('#btn-extensions').hidden");
  assert.equal(await evaluate(session, `Boolean(${actionButton})`), false, 'an unpinned extension stays in Chromium’s Extensions menu');
  await rpc('newTab', 'chrome://extensions/');
  const extensionsPage = await attach((await findTarget(t => t.type === 'page' && t.url.startsWith('chrome://extensions'))).targetId);
  await loaded(extensionsPage, 'chrome://extensions');
  const quietId = await evaluate(extensionsPage, `chrome.developerPrivate.getExtensionsInfo().then(async list => {
    for (const name of ['Probe Action', 'Quiet Extension']) {
      const extensionId = list.find(extension => extension.name === name).id;
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, pinnedToToolbar: true });
    }
    return list.find(extension => extension.name === 'Quiet Extension').id;
  })`);
  await rpc('activate', pageTab);
  await domWhere(`() => ${actionButton}?.querySelector('img')?.src.startsWith('data:image/png')`);
  await evaluate(session, "document.querySelector('#btn-toggle-extension-pins').click()");
  assert.equal(await evaluate(session, "document.querySelector('#extension-pins').hidden && !document.querySelector('#btn-extensions').hidden"), true);
  await evaluate(session, "document.querySelector('#btn-toggle-extension-pins').click()");
  console.log('PASS only pinned extensions have sidebar buttons, and collapsing keeps the Extensions menu available');
  const toolbarRows = await evaluate(session, `(() => {
    const toolbar = document.querySelector('#extensions').cloneNode(true);
    const pins = toolbar.querySelector('#extension-pins');
    const action = pins.firstElementChild;
    pins.replaceChildren(...Array.from({ length: 8 }, () => action.cloneNode(true)));
    toolbar.style.width = '240px';
    document.body.append(toolbar);
    try {
      const menu = toolbar.querySelector('#btn-extensions').getBoundingClientRect();
      const edge = toolbar.getBoundingClientRect();
      return { rows: new Set([...toolbar.querySelectorAll('button')].map(button => button.getBoundingClientRect().top)).size,
        menuAtStart: menu.left === edge.left && menu.top === edge.top };
    } finally {
      toolbar.remove();
    }
  })()`);
  assert.deepEqual(toolbarRows, { rows: 2, menuAtStart: true }, 'pins wrap alongside a fixed Extensions menu button');
  const button = await evaluate(session, `${actionButton}.getBoundingClientRect().toJSON()`);
  const frameWindow = await evaluate(session, '({ x: screenX, y: screenY, width: outerWidth })');
  const clickButton = () => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'click', String(Math.round(button.x + button.width / 2)), String(Math.round(button.y + button.height / 2))], { env });
  const popupAt = async () => {
    const popup = await attach((await findTarget(t => t.url.endsWith('/popup.html'))).targetId);
    await loaded(popup, 'chrome-extension://');
    // Popups open small and grow to their page (the fixture's body is 240px wide).
    return evaluate(popup, "new Promise(resolve => { const check = () => innerWidth >= 240 && resolve({ x: screenX, y: screenY, width: outerWidth }); addEventListener('resize', check); check(); })");
  };
  const popupGone = () => new Promise(resolve => { const check = async () => { if (!(await send('Target.getTargets')).targetInfos.some(t => t.url.endsWith('/popup.html'))) { listeners.delete(listener); resolve(); } }; const listener = (message) => { if (message.method === 'Target.targetDestroyed') void check(); }; listeners.add(listener); void check(); });
  clickButton();
  const fromButton = await popupAt();
  assert.equal(fromButton.x, frameWindow.x + button.x);
  assert.equal(fromButton.y, frameWindow.y + button.bottom);
  clickButton();
  await popupGone();
  console.log('PASS an extension action shows in the sidebar and its popup drops from its button, closing on a second click');
  // Its keyboard shortcut has no button to drop from: the popup goes to the page area's top right.
  await key('u', ['Control_L', 'Shift_L']);
  const fromShortcut = await popupAt();
  assert.equal(fromShortcut.x + fromShortcut.width, frameWindow.x + frameWindow.width - 8 - 8);
  assert.equal(fromShortcut.y, frameWindow.y + 8);
  // The extension's worker, woken from its popup, for chrome.action calls below.
  // The Quiet fixture's worker is a bg.js too, so it is found by the popup's extension.
  const probePopup = await findTarget(t => t.url.endsWith('/popup.html'));
  await evaluate(await attach(probePopup.targetId), "chrome.runtime.sendMessage('wake').catch(() => undefined)");
  const probeWorkerUrl = new URL('/bg.js', probePopup.url).href;
  const probeWorker = await attach((await findTarget(t => t.type === 'service_worker' && t.url === probeWorkerUrl)).targetId);
  await key('Escape', []);
  await popupGone();
  console.log('PASS an extension popup opened by its shortcut drops into the page area');
  // A disabled action's button shows the extension's menu, not its popup, and leaves no anchor
  // behind: once enabled again, its shortcut's popup still goes to the page area.
  await evaluate(probeWorker, 'chrome.action.disable()');
  await domWhere(`() => ${actionButton}.classList.contains('disabled')`);
  const topWindowCount = () => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'windows'], { env, encoding: 'utf8' }).trim().split('\n').length;
  const withoutMenu = topWindowCount();
  clickButton();
  while (topWindowCount() === withoutMenu) await new Promise(resolve => setTimeout(resolve, 50));
  execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'down', 'Escape'], { env });
  execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'up', 'Escape'], { env });
  while (topWindowCount() !== withoutMenu) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.endsWith('/popup.html')), false);
  await evaluate(probeWorker, 'chrome.action.enable()');
  await domWhere(`() => !${actionButton}.classList.contains('disabled')`);
  await key('u', ['Control_L', 'Shift_L']);
  const afterDisabled = await popupAt();
  assert.equal(afterDisabled.x + afterDisabled.width, fromShortcut.x + fromShortcut.width);
  assert.equal(afterDisabled.y, fromShortcut.y);
  await key('Escape', []);
  await popupGone();
  console.log('PASS a disabled action leaves no anchor for its next popup');
  // Chromium's own bubbles drop into the page area instead of covering the sidebar.
  const shot = path.join(profile, 'bubble.png');
  const pixel = (x, y) => { execFileSync('import', ['-display', env.DISPLAY, '-window', 'root', shot]); return execFileSync('magick', [shot, '-format', `%[pixel:p{${x},${y}}]`, 'info:'], { encoding: 'utf8' }); };
  const pageWhite = (x, y) => /^(srgb\(255,255,255\)|white)$/.test(pixel(frameWindow.x + x, frameWindow.y + y));
  // An extension without an action shows Chromium's puzzle icon, disabled: its button shows the
  // extension's menu, dropping from the button (patch 0071; it went to the hidden toolbar's spot).
  const quietButton = "document.querySelector('#extensions .ext-action[aria-label=\"Quiet Extension\"]')";
  await domWhere(`() => ${quietButton}?.classList.contains('disabled')`);
  const quiet = await evaluate(session, `${quietButton}.getBoundingClientRect().toJSON()`);
  const xclick = (x, y) => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'click', String(Math.round(x)), String(Math.round(y))], { env });
  const menuWindows = () => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'windows'], { env, encoding: 'utf8' }).trim().split('\n').map(line => { const [x, y, , , id] = line.split(' '); return { x: Number(x), y: Number(y), id }; });
  const beforeMenu = menuWindows().map(w => w.id);
  xclick(quiet.x + quiet.width / 2, quiet.y + quiet.height / 2);
  let quietMenu;
  await until(() => (quietMenu = menuWindows().find(w => !beforeMenu.includes(w.id))));
  assert.deepEqual({ x: quietMenu.x, y: quietMenu.y }, { x: frameWindow.x + quiet.x, y: frameWindow.y + quiet.bottom }, JSON.stringify({ quietMenu, quiet, frameWindow }));
  execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'down', 'Escape'], { env });
  execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'up', 'Escape'], { env });
  await until(() => menuWindows().length === beforeMenu.length);
  console.log('PASS an extension without an action shows its menu from its sidebar button');
  // The puzzle button opens Chromium's extensions menu under it, and a second click closes it.
  const puzzle = await evaluate(session, "document.querySelector('#btn-extensions').getBoundingClientRect().toJSON()");
  const clickPuzzle = () => xclick(puzzle.x + puzzle.width / 2, puzzle.y + puzzle.height / 2);
  // A spot right of the puzzle, in the page area, that the menu covers when open.
  const underMenu = () => pixel(frameWindow.x + puzzle.x + 400, frameWindow.y + puzzle.bottom + 30);
  const menuClosed = underMenu();
  clickPuzzle();
  await until(() => underMenu() !== menuClosed);
  clickPuzzle();
  await until(() => underMenu() === menuClosed);
  console.log('PASS the sidebar\'s puzzle button opens the extensions menu, and a second click closes it');
  // An action picked in that menu opens its popup from the puzzle button. The menu's rows start
  // 130 px below its top, 54 px apart: Flecha, then Probe Action.
  clickPuzzle();
  await until(() => underMenu() !== menuClosed);
  xclick(puzzle.x + 120, puzzle.bottom + 130 + 54);
  const fromMenu = await popupAt();
  assert.deepEqual({ x: fromMenu.x, y: fromMenu.y }, { x: frameWindow.x + puzzle.x, y: frameWindow.y + puzzle.bottom });
  await key('Escape', []);
  await popupGone();
  console.log('PASS an action picked in the extensions menu opens its popup from the puzzle button');
  // An extension reloaded (as an update does) while its sidebar menu is open: the menu closes with
  // the extension's action, whose menu model it showed, and the browser keeps running. Without
  // developer mode, Chromium keeps a reloaded unpacked extension off: Quiet is gone from here on.
  const extensionTab = Object.values((await stateWhere('s => true')).tabs).find(t => t.url.startsWith('chrome://extensions'));
  await rpc('activate', extensionTab.id);
  await active(extensionTab.id);
  const beforeReload = menuWindows().map(w => w.id);
  xclick(quiet.x + quiet.width / 2, quiet.y + quiet.height / 2);
  await until(() => menuWindows().some(w => !beforeReload.includes(w.id)));
  await evaluate(extensionsPage, `chrome.developerPrivate.reload(${JSON.stringify(quietId)}, { failQuietly: true })`);
  await until(() => menuWindows().length === beforeReload.length);
  await domWhere(`() => !${quietButton}`);
  assert.equal((await send('Browser.getVersion')).product.startsWith('Chrome/'), true);
  await rpc('close', Object.values((await stateWhere('s => true')).tabs).find((t) => t.url.startsWith('chrome://extensions')).id);
  console.log('PASS an extension reloaded while its sidebar menu is open closes the menu, and the browser keeps running');
  await rpc('newTab', base + '/plain-page');
  await findTarget(t => t.type === 'page' && t.url === base + '/plain-page');
  const sidebarBefore = pixel(frameWindow.x + 140, frameWindow.y + 64);
  await rpc('newTab', base + '/geo');
  await loaded(await attach((await findTarget(t => t.type === 'page' && t.url === base + '/geo')).targetId), base + '/geo');
  // Covered at the page area's top left, while the page further in is painted white.
  while (pageWhite(260 + 8 + 40, 8 + 40) || !pageWhite(700, 500)) {
    if (browser.exitCode !== null) throw new Error('The browser exited');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(pixel(frameWindow.x + 140, frameWindow.y + 64), sidebarBefore);
  console.log('PASS the permission prompt drops from the page area\'s top left and leaves the sidebar uncovered');
  await key('Escape', []);
  await rpc('newTab', base + '/login');
  const login = await attach((await findTarget(t => t.type === 'page' && t.url === base + '/login')).targetId);
  await loaded(login, base + '/login');
  await evaluate(login, "document.querySelector('#user').focus()");
  await send('Input.insertText', { text: 'flecha-test' }, login);
  await evaluate(login, "document.querySelector('#password').focus()");
  await send('Input.insertText', { text: 'not-a-real-password' }, login);
  await evaluate(login, "document.querySelector('#go').click()");
  while (pageWhite(frameWindow.width - 8 - 8 - 40, 8 + 60) || !pageWhite(260 + 8 + 40, 500)) {
    if (browser.exitCode !== null) throw new Error('The browser exited');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('PASS the save-password bubble drops into the page area\'s top right');
  await key('Escape', []);
  await rpc('activate', pageTab);

  // Downloads Chromium holds back are kept or discarded from the sidebar; stopped ones resume.
  let downloads = 0;
  const downloadFrom = async (address) => {
    const pageAddress = `${base}/download-page-${++downloads}`;
    await rpc('newTab', pageAddress);
    const downloadPage = await attach((await findTarget(t => t.type === 'page' && t.url === pageAddress)).targetId);
    await loaded(downloadPage, pageAddress);
    // A page gets one automatic download; each of these has a page of its own.
    await evaluate(downloadPage, `location.href = ${JSON.stringify(address)}`);
  };
  const downloadRow = (name, predicate) => domWhere(`() => [...document.querySelectorAll('#downloads-list .download')].some(li => li.querySelector('.name').textContent === ${JSON.stringify(name)} && (${predicate})(li))`);
  const clickDownloadButton = (name, label) => evaluate(session, `[...document.querySelectorAll('#downloads-list .download')].find(li => li.querySelector('.name').textContent === ${JSON.stringify(name)}).querySelector('.actions').querySelectorAll('button').forEach(b => b.textContent === ${JSON.stringify(label)} && b.click())`);
  const downloadState = (name, predicate) => evaluate(session, `new Promise(resolve => { const check = async () => { const [item] = await chrome.downloads.search({ filenameRegex: ${JSON.stringify(name.replace('.', '\\.'))} }); if ((${predicate})(item)) { chrome.downloads.onChanged.removeListener(check); chrome.downloads.onErased.removeListener(check); resolve(item ?? null); } }; chrome.downloads.onChanged.addListener(check); chrome.downloads.onErased.addListener(check); void check(); })`);
  const insecure = `http://downloads.flecha.test:${server.address().port}`;
  await downloadFrom(insecure + '/held-kept');
  await downloadRow('held-kept.bin', "li => li.querySelector('.status').textContent.includes('HTTP')");
  await clickDownloadButton('held-kept.bin', 'Keep');
  assert.equal((await downloadState('held-kept.bin', 'd => d?.state === "complete"')).exists, true);
  await downloadFrom(insecure + '/held-discarded');
  await downloadRow('held-discarded.bin', "li => !!li.querySelector('.actions')");
  await clickDownloadButton('held-discarded.bin', 'Discard');
  assert.equal(await downloadState('held-discarded.bin', 'd => !d'), null);
  console.log('PASS a download held for being sent over HTTP can be kept or discarded from the sidebar');
  await downloadFrom(base + '/resumable');
  await downloadRow('resumable.bin', "li => li.querySelector('.status').textContent === 'Stopped'");
  resumeAllowed = true;
  await clickDownloadButton('resumable.bin', 'Resume');
  assert.equal((await downloadState('resumable.bin', 'd => d?.state === "complete"')).bytesReceived, resumable.length);
  console.log('PASS a stopped download resumes from the sidebar');
  // Settings' download folder and "ask where to save" are Chromium's own prefs.
  const chosenFolder = path.join(profile, 'chosen-downloads');
  await fs.mkdir(chosenFolder);
  const typeInDialog = (...steps) => { for (const step of steps) execFileSync(inputTool, [env.DISPLAY, String(browser.pid), ...step], { env }); };
  const topWindows = () => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'windows'], { env, encoding: 'utf8' }).trim().split('\n');
  const windowCount = () => topWindows().length;
  const focused = () => execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'focus'], { env, encoding: 'utf8' }).trim();
  // The chooser is a window of its own; there is no page event for it. Keys reach it only once
  // it has keyboard focus, which GTK gives it a moment after it shows (no window manager here).
  const dialogOpen = async (before) => {
    while (windowCount() <= before || focused() !== topWindows().at(-1).split(' ')[4]) {
      if (browser.exitCode !== null) throw new Error('The browser exited');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  let before = windowCount();
  let chosen = rpc('settings:choose-downloads-folder');
  await dialogOpen(before);
  typeInDialog(['down', 'Escape'], ['up', 'Escape']);
  assert.notEqual((await chosen).downloadsFolder, chosenFolder);
  before = windowCount();
  chosen = rpc('settings:choose-downloads-folder');
  await dialogOpen(before);
  typeInDialog(['down', 'Control_L'], ['down', 'l'], ['up', 'l'], ['up', 'Control_L'], ['type', chosenFolder + '/']);
  // GTK's location field ignores Return while it is still completing the path, and says
  // nothing when it's done: Return again every 500 ms (what worked in a probe, 2026-10-26).
  let answer;
  void chosen.then(view => (answer = view));
  while (!answer) {
    typeInDialog(['down', 'Return'], ['up', 'Return']);
    await Promise.race([chosen, new Promise(resolve => setTimeout(resolve, 500))]);
  }
  assert.equal(answer.downloadsFolder, chosenFolder);
  assert.equal((await evaluate(session, 'chrome.flechaPrivate.getDownloadSettings()')).folder, chosenFolder);
  await rpc('settings:set', { askWhereToSave: true });
  assert.equal((await evaluate(session, 'chrome.flechaPrivate.getDownloadSettings()')).askWhereToSave, true);
  await rpc('settings:set', { askWhereToSave: false });
  console.log('PASS Settings choose the download folder with the system chooser and set Chromium\'s ask-where-to-save');
  await rpc('activate', pageTab);

  // A link from another app (Flecha as the default browser) comes as a second launch with the
  // address; it opens in a Flechinha, or as a tab with that setting off.
  const launchLink = (address) => execFileSync(binary, [`--user-data-dir=${profile}`, '--ozone-platform=x11', '--password-store=basic', address], { env, stdio: 'ignore' });
  launchLink(base + '/from-another-app');
  await findTarget(t => t.type === 'page' && t.url === base + '/from-another-app');
  const flechinhaWindows = await evaluate(session, 'chrome.flechaPrivate.getFlechinhas()');
  assert.equal(flechinhaWindows.length, 1);
  assert.equal(await evaluate(session, `chrome.tabs.query({ windowId: ${flechinhaWindows[0]} }).then(tabs => tabs[0]?.url)`), base + '/from-another-app');
  // Linux gives it no title bar: its toolbar draws close, minimize and maximize.
  const flechinhaToolbar = await attach((await findTarget(t => t.url.startsWith(extension + 'flechinha.html') && t.url.includes(`window=${flechinhaWindows[0]}`))).targetId);
  await loaded(flechinhaToolbar, extension + 'flechinha.html');
  assert.equal(await evaluate(flechinhaToolbar, "getComputedStyle(document.querySelector('.window-controls')).display"), 'flex');
  // The browser opened this Flechinha, not the shell: Control-W still closes it, not a Flecha tab.
  const tabsBeforeClose = Object.keys((await stateWhere('s => true')).tabs).sort();
  await until(async () => (await evaluate(session, 'chrome.windows.getLastFocused()')).id === flechinhaWindows[0]);
  // Pressed where focus is: key() would focus Flecha's main window first.
  hold('down', 'Control_L', 'w'); hold('up', 'w', 'Control_L');
  await until(async () => (await evaluate(session, 'chrome.flechaPrivate.getFlechinhas()')).length === 0);
  assert.deepEqual(Object.keys((await stateWhere('s => true')).tabs).sort(), tabsBeforeClose);
  await rpc('settings:set', { openLinksInFlechinha: false });
  launchLink(base + '/as-a-tab');
  await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/as-a-tab')})`);
  assert.deepEqual(await evaluate(session, 'chrome.flechaPrivate.getFlechinhas()'), []);
  await rpc('settings:set', { openLinksInFlechinha: true });
  await rpc('activate', pageTab);
  console.log('PASS a link from another app opens in a Flechinha on Linux, or as a tab with that off');

  // History: Control-H opens it as a tab; it searches, removes a page, opens one, and clears by time.
  const historyUrl = extension + 'history.html';
  const activeUrl = (url) => `s => s.tabs[s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId]?.url === ${JSON.stringify(url)}`;
  await key('h', ['Control_L']);
  const historyTab = await stateWhere(activeUrl(historyUrl)).then(s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId);
  const historyPage = await attach((await findTarget(t => t.type === 'page' && t.url === historyUrl)).targetId);
  await loaded(historyPage, historyUrl);
  const listed = (predicate) => evaluate(historyPage, `new Promise(resolve => { const links = () => [...document.querySelectorAll('#days a')].map(a => a.href); const check = () => { if ((${predicate})(links(), !document.querySelector('#empty').hidden)) { observer.disconnect(); resolve(links()); } }; const observer = new MutationObserver(check); observer.observe(document.body, {subtree:true,childList:true,attributes:true}); check(); })`);
  await listed(`links => links.includes(${JSON.stringify(base + '/a')}) && links.includes('https://example.org/helium-history')`);
  await evaluate(historyPage, "{ const field = document.querySelector('#search'); field.value = 'helium-history'; field.dispatchEvent(new Event('input')) }");
  await listed("links => links.length === 1 && links[0] === 'https://example.org/helium-history'");
  await evaluate(historyPage, "document.querySelector('#days .remove').click()");
  await listed('(links, empty) => links.length === 0 && empty');
  assert.deepEqual(await evaluate(session, "chrome.history.search({ text: 'helium-history', startTime: 0 })"), []);
  await evaluate(historyPage, "{ const field = document.querySelector('#search'); field.value = ''; field.dispatchEvent(new Event('input')) }");
  await listed(`links => links.includes(${JSON.stringify(base + '/from-another-app')})`);
  if (artifacts) {
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, 'history.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, historyPage)).data, 'base64'));
  }
  assert.equal(await evaluate(historyPage, "getComputedStyle(document.querySelector('#more')).display"), 'none');
  await evaluate(historyPage, `[...document.querySelectorAll('#days a')].find(a => a.href === ${JSON.stringify(base + '/from-another-app')}).click()`);
  await stateWhere(activeUrl(base + '/from-another-app'));
  console.log('PASS Control-H opens History as a tab, which searches, removes a page and opens one as a tab');
  // From another Space, Control-H goes back to the History tab this window has, not a second one.
  const historySpace = (await stateWhere('s => true')).activeSpaceId;
  const elsewhere = (await stateWhere('s => true')).spaces.find(sp => sp.id !== historySpace).id;
  await rpc('switchSpace', elsewhere);
  await stateWhere(`s => s.activeSpaceId === ${JSON.stringify(elsewhere)}`);
  await key('h', ['Control_L']);
  const backInHistory = await stateWhere(`s => s.activeSpaceId === ${JSON.stringify(historySpace)} && s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(historyTab)}`);
  assert.equal(Object.values(backInHistory.tabs).filter(t => t.url === historyUrl).length, 1);
  // Pinned, or a Favorite, it is still the one History tab.
  for (const [place, toggle] of [['pinned', 'togglePin'], ['favorite', 'toggleFavorite']]) {
    await rpc(toggle, historyTab);
    await stateWhere(place === 'pinned' ? `s => s.spaces.some(sp => sp.pinned.some(n => n.kind === 'tab' && n.tabId === ${JSON.stringify(historyTab)}))` : `s => s.favorites.includes(${JSON.stringify(historyTab)})`);
    await rpc('switchSpace', elsewhere);
    await stateWhere(`s => s.activeSpaceId === ${JSON.stringify(elsewhere)}`);
    await key('h', ['Control_L']);
    const found = await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(historyTab)}`);
    assert.equal(Object.values(found.tabs).filter(t => t.url === historyUrl).length, 1, place);
    await rpc(toggle, historyTab);
    await stateWhere(place === 'pinned' ? `s => !s.spaces.some(sp => sp.pinned.some(n => n.kind === 'tab' && n.tabId === ${JSON.stringify(historyTab)}))` : `s => !s.favorites.includes(${JSON.stringify(historyTab)})`);
  }
  console.log('PASS History is one tab per window, found from another Space, pinned or a Favorite');
  // More pages than one read (chrome.history.search's default of 100): older ones come with "Show older pages".
  await evaluate(session, '(async () => { for (let i = 0; i < 120; i++) await chrome.history.addUrl({ url: `https://example.net/page-${i}` }); })()');
  await listed(`links => links.length === 100 && links[0] === 'https://example.net/page-119' && !document.querySelector('#more').hidden`);
  await evaluate(historyPage, "document.querySelector('#more').click()");
  const allListed = await listed(`links => links.includes(${JSON.stringify(base + '/a')}) && document.querySelector('#more').hidden`);
  assert.equal(new Set(allListed).size, allListed.length);
  assert.equal(allListed.filter(url => url.startsWith('https://example.net/page-')).length, 120);
  console.log('PASS History reads older pages on request, without repeats or gaps');
  // More pages visited in the same instant than one read holds (imported history can be): none is
  // skipped. Chromium can't be given visit times here, so its search is stood in for on the page.
  await evaluate(historyPage, `{
    globalThis.realSearch = chrome.history.search;
    const tied = Array.from({ length: 150 }, (_, i) => ({ id: 'tie-' + i, url: 'https://ties.flecha.test/' + i, title: 'Tie ' + i, lastVisitTime: i < 120 ? 1700000000000 : 1690000000000 - i }));
    chrome.history.search = async ({ maxResults = 100, endTime = Infinity }) => tied.filter(e => e.lastVisitTime < endTime).slice(0, maxResults);
    const field = document.querySelector('#search'); field.value = 'ties'; field.dispatchEvent(new Event('input'));
  }`);
  await listed(`links => links.length === 100 && links.every(url => url.startsWith('https://ties.flecha.test/')) && !document.querySelector('#more').hidden`);
  await evaluate(historyPage, "document.querySelector('#more').click()");
  const ties = await listed(`links => links.length === 150 && document.querySelector('#more').hidden`);
  assert.equal(new Set(ties).size, 150);
  await evaluate(historyPage, "{ chrome.history.search = realSearch; const field = document.querySelector('#search'); field.value = ''; field.dispatchEvent(new Event('input')); }");
  await listed("links => links[0] === 'https://example.net/page-119'");
  console.log('PASS History reads on past pages visited in the same instant');
  // The page asks for the last hour up to now; every page this run visited is in it.
  await evaluate(historyPage, "window.confirm = () => true; { const deleteRange = chrome.history.deleteRange; chrome.history.deleteRange = range => { globalThis.cleared = { ...range, at: Date.now() }; return deleteRange(range); }; } document.querySelector('#range').value = '3600000'; document.querySelector('#clear').requestSubmit()");
  await listed('(links, empty) => links.length === 0 && empty');
  const cleared = await evaluate(historyPage, 'cleared');
  assert.equal(cleared.endTime - cleared.startTime, 3600000);
  assert.ok(cleared.at - cleared.endTime < 1000);
  assert.deepEqual(await evaluate(session, "chrome.history.search({ text: '', startTime: 0 })"), []);
  await rpc('close', historyTab);
  await rpc('activate', pageTab);
  console.log('PASS History clears the last hour of pages');

  // The sidebar's right edge drags between Chromium's vertical tab strip limits, 126 and 400px
  // (shared/sidebarWidth.ts); the page area follows, and the width is kept.
  const favorites = [];
  for (const name of ['/favorite-one', '/favorite-two']) {
    await rpc('newTab', base + name);
    const added = await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + name)})`);
    favorites.push(Object.values(added.tabs).find(t => t.url === base + name).id);
    await rpc('toggleFavorite', favorites.at(-1));
  }
  await stateWhere(`s => ${JSON.stringify(favorites)}.every(id => s.favorites.includes(id))`);
  await rpc('activate', pageTab);
  const dragEdge = async (dx) => {
    const edge = await evaluate(session, "(() => { const r = document.querySelector('#sidebar-resize').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'drag', String(edge.x), String(edge.y), String(edge.x + dx), String(edge.y)], { env });
  };
  // Nothing in the sidebar reaches past its edges, however narrow.
  const spilled = () => evaluate(session, "(() => { const bar = document.querySelector('#sidebar').getBoundingClientRect(); return [...document.querySelectorAll('#sidebar *')].filter(el => el.offsetParent && el.id !== 'sidebar-resize').filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.left < bar.left - 0.5 || r.right > bar.right + 0.5); }).map(el => el.id || el.className || el.tagName); })()");
  const laidOut = async (width) => {
    await stateWhere(`s => s.sidebarWidth === ${width}`);
    await evaluate(session, `new Promise(resolve => { const check = () => innerWidth === ${width} && document.querySelector('#sidebar').offsetWidth === ${width} ? resolve() : requestAnimationFrame(check); check(); })`);
    if (artifacts) await fs.writeFile(path.join(artifacts, `sidebar-${width}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, session)).data, 'base64'));
    assert.deepEqual(await spilled(), []);
  };
  // A held download's Keep and Discard are in the open downloads panel while it narrows.
  await downloadFrom(insecure + '/held-narrow');
  await downloadRow('held-narrow.bin', "li => !!li.querySelector('.actions')");
  await evaluate(session, "document.querySelector('#downloads-panel').hidden = false");
  await rpc('activate', pageTab);
  await dragEdge(260);
  await laidOut(400);
  await dragEdge(-400);
  await laidOut(126);
  await clickDownloadButton('held-narrow.bin', 'Discard');
  assert.equal(await downloadState('held-narrow.bin', 'd => !d'), null);
  console.log('PASS dragging the sidebar edge stops at 126 and 400px, the page area follows, and nothing spills out at 126px');
  await dragEdge(174);
  await laidOut(300);
  for (const id of favorites) await rpc('toggleFavorite', id);
  await stateWhere(`s => !${JSON.stringify(favorites)}.some(id => s.favorites.includes(id))`);
  for (const id of favorites) await rpc('close', id);
  await rpc('activate', pageTab);

  // A page in full screen (a video's button) has the screen to itself, unless Settings keep the
  // sidebar beside it (patch 0072). Leaving, by Escape or by the page, puts the sidebar back as it
  // was, hidden or not. The window's own full screen (F11) keeps the sidebar.
  // Its own tab: two /a pages are open by now, one of them unloaded.
  await rpc('newTab', base + '/fullscreen');
  const fsState = await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/fullscreen')})`);
  const fsTab = Object.values(fsState.tabs).find(t => t.url === base + '/fullscreen').id;
  await rpc('activate', fsTab);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(fsTab)}`);
  const fsPage = await attach((await findTarget(t => t.type === 'page' && t.url === base + '/fullscreen')).targetId);
  await loaded(fsPage, base + '/fullscreen');
  const polled = (target, expression) => evaluate(target, `new Promise(resolve => { const check = () => (${expression}) ? resolve(true) : setTimeout(check, 16); check(); })`);
  // Waits for the layout; a step that never gets it ends at the run's deadline, after its label.
  // `page` is the page's width, a number or an expression of the window's (outerWidth): without
  // a window manager, as on Xvfb, a window in full screen keeps its size instead of the screen's.
  // `frame` is the frame view's width, or 'hidden': a frame view 0 wide hides its page, which
  // keeps its last size.
  const layoutIs = async (want, label) => {
    console.log(`waiting for ${label}: ${JSON.stringify(want)}`);
    await polled(fsPage, `innerWidth === ${want.page} && !!document.fullscreenElement === ${want.full}`);
    const frame = want.frame === 'hidden' ? "document.visibilityState === 'hidden'" : `document.visibilityState === 'visible' && innerWidth === ${want.frame}`;
    await polled(session, `${frame} && matchMedia('(display-mode: fullscreen)').matches === ${want.windowFull}`);
  };
  const pageFullscreen = () => send('Runtime.evaluate', { expression: 'document.documentElement.requestFullscreen().then(() => true)', userGesture: true, awaitPromise: true }, fsPage);
  // Docked, the frame view is as wide as the sidebar (a new profile keeps no width of its own).
  const sidebarWidth = await evaluate(session, 'innerWidth');
  const docked = { page: await evaluate(fsPage, 'innerWidth'), frame: sidebarWidth, full: false, windowFull: false };
  const alone = { page: 'outerWidth', frame: 'hidden', full: true, windowFull: true };
  const besideSidebar = `outerWidth - ${sidebarWidth + 8}`;
  assert.equal(await evaluate(fsPage, `innerWidth === ${besideSidebar}`), true);
  // Pressed where the keyboard already is, the page: key() first focuses the window again, and
  // around a full screen change that sometimes lost the key here.
  const tap = (name) => { hold('down', name); hold('up', name); };
  // Off by default: the page fills the screen, and Escape brings the docked sidebar back.
  await pageFullscreen();
  await layoutIs(alone, 'page full screen, sidebar docked');
  assert.equal(await evaluate(fsPage, 'innerHeight === outerHeight'), true);
  tap('Escape');
  await layoutIs(docked, 'Escape from page full screen');
  // A hidden sidebar stays hidden after the page leaves full screen itself.
  // Hidden, the page area starts 8px in (the hover edge) instead of at the sidebar's edge.
  const hidden = { page: docked.page + sidebarWidth - 8, frame: 8, full: false, windowFull: false };
  await rpc('toggleSidebar');
  await layoutIs(hidden, 'sidebar hidden');
  await pageFullscreen();
  await layoutIs(alone, 'page full screen, sidebar hidden');
  await evaluate(fsPage, 'document.exitFullscreen()');
  await layoutIs(hidden, 'the page leaving full screen, sidebar hidden');
  assert.equal((await stateWhere('s => true')).sidebarVisible, false);
  await rpc('toggleSidebar');
  await layoutIs(docked, 'sidebar shown again');
  console.log('PASS a page in full screen fills the screen, and leaving puts the sidebar back as it was');
  // On: the docked sidebar stays beside the page, as before patch 0072. Where the window keeps its
  // size, the page's doesn't change either, and Escape must still tell it that it left.
  await rpc('settings:set', { sidebarInPageFullscreen: true });
  await pageFullscreen();
  await layoutIs({ page: besideSidebar, frame: sidebarWidth, full: true, windowFull: true }, 'page full screen with the sidebar kept');
  tap('Escape');
  await layoutIs(docked, 'Escape with the sidebar kept');
  await rpc('settings:set', { sidebarInPageFullscreen: false });
  console.log('PASS Show sidebar in full screen keeps the sidebar beside a page in full screen');
  // F11 keeps the sidebar; a page going full screen inside it has the screen alone, and leaves
  // back to F11's layout.
  const windowFull = { page: besideSidebar, frame: sidebarWidth, full: false, windowFull: true };
  tap('F11');
  await layoutIs(windowFull, 'F11');
  await pageFullscreen();
  await layoutIs(alone, 'page full screen inside F11');
  tap('Escape');
  await layoutIs(windowFull, 'Escape from page full screen inside F11');
  tap('F11');
  await layoutIs(docked, 'F11 again');
  console.log('PASS F11 keeps the sidebar, and a page in full screen inside it fills the screen until Escape');
  // Back first: closing the active tab would show a neighbour, possibly after this activation.
  await rpc('activate', pageTab);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);
  await rpc('close', fsTab);
  await stateWhere(`s => !s.tabs[${JSON.stringify(fsTab)}] && s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);

  // The inline header on Linux: Flecha's own close, minimize and maximize circles where macOS
  // draws the traffic lights, then the sidebar toggle, the menu button, and back/forward/reload.
  const header = await evaluate(session, `(() => {
    const box = (sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, shown: getComputedStyle(e).display !== 'none', label: e.getAttribute('aria-label') }; };
    return { traffic: box('.traffic-lights'), close: box('#wc-close'), minimize: box('#wc-minimize'), maximize: box('#wc-maximize'), toggle: box('#btn-sidebar'), menu: box('#btn-menu'), back: box('#btn-back'), reload: box('#btn-reload'), popup: document.querySelector('#btn-menu').getAttribute('aria-haspopup') };
  })()`);
  assert.equal(header.traffic.shown, false);
  assert.deepEqual([header.close, header.minimize, header.maximize].map(c => [c.shown, c.label, c.w]), [[true, 'Close window', 20], [true, 'Minimize', 20], [true, 'Maximize', 20]]);
  assert.ok(header.close.x < header.minimize.x && header.minimize.x < header.maximize.x && header.maximize.x < header.toggle.x && header.toggle.x < header.menu.x && header.menu.x < header.back.x, JSON.stringify(header));
  assert.ok([header.close, header.toggle, header.menu, header.back, header.reload].every(c => Math.abs(c.y + c.h / 2 - (header.toggle.y + header.toggle.h / 2)) < 1), 'one row');
  assert.equal(header.popup, 'menu');
  console.log('PASS the inline header has window controls where the traffic lights go, then the sidebar toggle, the menu and back/forward/reload');
  // The row between the menu and back moves the window (a caption, which Chromium handles: drag
  // to move, double-click to maximize): a real click there never reaches the frame page, one on
  // the menu button does.
  await evaluate(session, "window.headerPresses = []; addEventListener('pointerdown', (e) => headerPresses.push(e.target.closest('button')?.id ?? e.target.className), true)");
  xclick((header.menu.x + header.menu.w + header.back.x) / 2, header.menu.y + header.menu.h / 2);
  xclick(header.menu.x + header.menu.w / 2, header.menu.y + header.menu.h / 2);
  await domWhere("() => document.querySelector('#btn-menu').getAttribute('aria-expanded') === 'true' && document.querySelector('.shell-menu')");
  assert.deepEqual(await evaluate(session, 'headerPresses'), ['btn-menu']);
  console.log('PASS the header row between its buttons is a window-move area; its buttons take clicks');
  // The menu holds what the macOS menu bar does, with Linux shortcut labels; arrow keys, Home and
  // End move a focused item, Esc closes it and gives focus back to the button.
  const menuItems = await evaluate(session, "[...document.querySelectorAll('.shell-menu > .shell-menu-item')].map(r => r.textContent)");
  for (const expected of ['New windowCtrl+N', 'New incognito windowCtrl+Shift+N', 'HistoryCtrl+H', 'Downloads', 'Boosts', 'Extensions', 'Find in page…Ctrl+F', 'Zoom', 'Print…Ctrl+P', 'Developer toolsCtrl+Alt+I', 'SettingsCtrl+,', 'Help', 'About Flecha']) {
    assert.ok(menuItems.includes(expected), `${expected} in ${JSON.stringify(menuItems)}`);
  }
  await key('Down', []);
  await domWhere("() => document.activeElement?.textContent === 'New windowCtrl+N'");
  await key('End', []);
  const last = menuItems.at(-1);
  await domWhere(`() => document.activeElement?.textContent === ${JSON.stringify(last)}`);
  // Zoom says it has a submenu, without the drawn arrow in its name; → opens the submenu on its
  // first item, and ← or Esc gives focus back to Zoom.
  const { nodes } = await send('Accessibility.getFullAXTree', {}, session);
  const zoomNode = nodes.find(n => n.role?.value === 'menuitem' && n.name?.value?.startsWith('Zoom'));
  const axProperty = (name) => zoomNode?.properties?.find(p => p.name === name)?.value.value;
  assert.deepEqual({ name: zoomNode?.name.value, hasPopup: axProperty('hasPopup'), expanded: axProperty('expanded') }, { name: 'Zoom', hasPopup: 'menu', expanded: false });
  const zoomIndex = await evaluate(session, "[...document.querySelectorAll('.shell-menu > .shell-menu-item:not(:disabled)')].findIndex(r => r.textContent === 'Zoom')");
  await key('Home', []);
  for (let i = 0; i < zoomIndex; i++) await key('Down', []);
  const onZoom = "() => document.activeElement?.textContent === 'Zoom' && document.activeElement.getAttribute('aria-expanded') === 'false' && document.querySelectorAll('.shell-menu').length === 1";
  await domWhere(onZoom);
  for (const back of ['Left', 'Escape']) {
    await key('Right', []);
    await domWhere("() => document.activeElement?.textContent.startsWith('Zoom in') && document.querySelector('.shell-menu-item.open')?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('.shell-menu')[1]?.getAttribute('aria-label') === 'Zoom'");
    await key(back, []);
    await domWhere(onZoom);
  }
  console.log('PASS the menu marks its submenus for screen readers, and leaving one gives focus back to its item');
  await key('Escape', []);
  await domWhere("() => !document.querySelector('.shell-menu') && document.querySelector('#btn-menu').getAttribute('aria-expanded') === 'false' && document.activeElement?.id === 'btn-menu'");
  console.log('PASS the menu lists Settings, windows, History, Downloads, Boosts, Extensions, Find, Zoom, Print, Developer tools, Help and About, and works from the keyboard');
  // From the keyboard: Enter opens it with its first item focused; Settings opens Settings.
  await key('Return', []);
  await domWhere("() => document.activeElement?.textContent === 'New windowCtrl+N'");
  await evaluate(session, "[...document.querySelectorAll('.shell-menu-item')].find(r => r.textContent === 'SettingsCtrl+,').click()");
  // Settings is its own small window (settingsHandlers.ts openSettings), closed here as you would.
  const settingsUrl = extension + 'settings.html';
  const closeSettings = async () => {
    const target = await findTarget(t => t.type === 'page' && t.url.startsWith(settingsUrl));
    await send('Target.closeTarget', { targetId: target.targetId });
    await new Promise(resolve => { const check = async () => ((await send('Target.getTargets')).targetInfos.some(t => t.url.startsWith(settingsUrl)) ? setTimeout(check, 100) : resolve()); void check(); });
  };
  await closeSettings();
  await rpc('activate', pageTab);
  // Ctrl+, opens Settings too, as ⌘, does on macOS.
  await key('comma', ['Control_L']);
  await closeSettings();
  await rpc('activate', pageTab);
  console.log('PASS the menu\'s Settings and Ctrl+, open Settings');
  // Import from another browser offers the browsers the import helper finds, as the onboarding
  // tour does: here the Chrome and Helium fixtures, then a bookmarks file. Cancel leaves it.
  const openImport = async () => {
    await evaluate(session, "document.querySelector('#btn-menu').click()");
    await domWhere("() => document.querySelector('.shell-menu')");
    await evaluate(session, "[...document.querySelectorAll('.shell-menu-item')].find(r => r.textContent === 'Import from another browser…').click()");
    await domWhere("() => document.querySelector('.shell-dialog[open] strong')?.textContent === 'Import from which browser?' && [...document.querySelectorAll('.shell-dialog[open] button')].map(b => b.textContent).join() === 'Chrome,Helium,Bookmarks File…,Cancel'");
  };
  const dialogButton = (label) => evaluate(session, `[...document.querySelectorAll('.shell-dialog[open] button')].find(b => b.textContent === ${JSON.stringify(label)}).getBoundingClientRect().toJSON()`);
  await openImport();
  await evaluate(session, "[...document.querySelectorAll('.shell-dialog[open] button')].at(-1).click()");
  await domWhere("() => !document.querySelector('.shell-dialog[open]')");
  await rpc('activate', pageTab);
  console.log('PASS the menu\'s Import from another browser looks for browsers to import');
  // Bookmarks File… takes the file any browser exports: a real click opens the file chooser, which
  // DevTools answers with the sample export, then the same preview and import as a browser.
  const bookmarksFile = path.join(profile, 'bookmarks.html');
  await fs.copyFile('chromium/native-host/fixtures/bookmarks.html', bookmarksFile);
  await send('Page.setInterceptFileChooserDialog', { enabled: true }, session);
  const chooser = new Promise(resolve => {
    const listener = (message) => { if (message.sessionId === session && message.method === 'Page.fileChooserOpened') { listeners.delete(listener); resolve(message.params); } };
    listeners.add(listener);
  });
  await openImport();
  const fileButton = await dialogButton('Bookmarks File…');
  xclick(fileButton.x + fileButton.width / 2, fileButton.y + fileButton.height / 2);
  await send('DOM.setFileInputFiles', { files: [bookmarksFile], backendNodeId: (await chooser).backendNodeId }, session);
  await send('Page.setInterceptFileChooserDialog', { enabled: false }, session);
  await domWhere("() => document.querySelector('.shell-dialog[open] strong')?.textContent === 'Import from “bookmarks.html”?'");
  await evaluate(session, "document.querySelector('.shell-dialog[open] button').click()");
  await domWhere("() => document.querySelector('.shell-dialog[open] strong')?.textContent === 'Imported from “bookmarks.html”'");
  const fromFile = (await stateWhere("s => s.spaces.some(sp => sp.name === 'Imported Bookmarks')")).spaces.find(sp => sp.name === 'Imported Bookmarks');
  assert.ok(fromFile.pinned.some(n => n.kind === 'folder' && n.name === 'Work'), JSON.stringify(fromFile.pinned));
  await evaluate(session, "document.querySelector('.shell-dialog[open] button').click()");
  await domWhere("() => !document.querySelector('.shell-dialog[open]')");
  // Later checks count on the Spaces they made, so the imported one goes again.
  await rpc('deleteSpace', fromFile.id);
  await stateWhere(`s => !s.spaces.some(sp => sp.id === ${JSON.stringify(fromFile.id)})`);
  await rpc('activate', pageTab);
  console.log('PASS Import from another browser takes an exported bookmarks file into a Space of its own');
  // The close circle closes its window.
  const windowsBeforeClose = await evaluate(session, 'chrome.windows.getAll().then(ws => ws.length)');
  await rpc('newWindow');
  const closingFrame = await new Promise(resolve => { const check = async () => { const frames = (await send('Target.getTargets')).targetInfos.filter(t => t.url.startsWith(extension + 'window.html')); if (frames.length === 2) resolve(frames.find(t => t.targetId !== frame.targetId)); else setTimeout(check, 100); }; void check(); });
  const closing = await attach(closingFrame.targetId);
  await loaded(closing, extension);
  await evaluate(closing, "new Promise(resolve => { const check = () => document.documentElement.dataset.windowFocused !== undefined ? resolve() : setTimeout(check, 50); check(); })");
  await evaluate(closing, "document.querySelector('#wc-close').click()");
  await new Promise(resolve => { const check = async () => { const frames = (await send('Target.getTargets')).targetInfos.filter(t => t.url.startsWith(extension + 'window.html')); if (frames.length === 1) resolve(); else setTimeout(check, 100); }; void check(); });
  assert.equal(await evaluate(session, 'chrome.windows.getAll().then(ws => ws.length)'), windowsBeforeClose);
  console.log('PASS the close circle closes its window');

  // Tab sleep (patches 0065-0067, shell/tabSleep.ts, Dia's rules in shared/tabSleep.ts).
  // Memory Saver is on by default, at medium (Chromium's 4 hours).
  const settingsTarget = await send('Target.createTarget', { url: 'chrome://settings/performance' });
  const settingsPage = await attach(settingsTarget.targetId);
  // The new tab can still be committing its navigation while this reads it, which destroys the
  // context the read ran in; it reads again then (the harness deadline bounds the whole run).
  const evaluateSettled = async (session, expression) => {
    for (;;) {
      try { return await evaluate(session, expression); } catch (error) { if (!/Execution context was destroyed/.test(error.message)) throw error; }
    }
  };
  const memorySaver = await evaluateSettled(settingsPage, `new Promise(resolve => { const look = () => { const found = {}; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.getAttribute?.('label') === 'Memory Saver') found.on = el.checked; if (el.pref?.key === 'performance_tuning.high_efficiency_mode.aggressiveness') found.aggressiveness = el.pref.value; } }; walk(document); found.on === undefined || found.aggressiveness === undefined ? setTimeout(look, 100) : resolve(found); }; look(); })`);
  await send('Target.closeTarget', { targetId: settingsTarget.targetId });
  // MemorySaverModeAggressiveness: 0 conservative, 1 medium, 2 aggressive.
  assert.deepEqual(memorySaver, { on: true, aggressiveness: 1 });
  console.log('PASS Memory Saver is on by default, at medium');
  // Tab sleep's rules run on their 300 s alarm only; this fires it now.
  const runTabSleep = () => evaluate(session, `chrome.alarms.create('tab-sleep', { when: Date.now(), periodInMinutes: 5 })`);
  // Each of Flecha's tabs is marked as its tab sleep's to discard (patch 0069, so Memory Saver
  // leaves it to the active-use rules); none is made not auto-discardable, which stays other
  // extensions' to choose. The ten most recent are kept by the rules alone (unit tests), so
  // Chromium's own discard takes a recent background tab too.
  const sleepUrl = (n) => `${base}/sleep-${n}`;
  for (let n = 0; n <= 10; n++) {
    await rpc('newTab', sleepUrl(n));
    await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(sleepUrl(n))})`);
  }
  const sleepTabs = () => evaluate(session, `chrome.tabs.query({}).then(ts => Object.fromEntries(ts.filter(t => t.url.startsWith(${JSON.stringify(base + '/sleep-')})).map(t => [t.url, { id: t.id, auto: t.autoDiscardable, discarded: t.discarded }])))`);
  await runTabSleep();
  await evaluate(session, `new Promise(resolve => { const check = async () => { const { 'tabSleep:managed': ids = [] } = await chrome.storage.session.get('tabSleep:managed'); const ts = (await chrome.tabs.query({})).filter(t => t.url.startsWith(${JSON.stringify(base + '/sleep-')})); ts.length === 11 && ts.every(t => ids.includes(t.id)) ? resolve() : setTimeout(check, 200); }; check(); })`);
  const slept = await sleepTabs();
  assert.ok(Object.values(slept).every(t => t.auto), JSON.stringify(slept));
  assert.equal(await evaluate(session, `chrome.flechaPrivate.discardTab(${slept[sleepUrl(5)].id})`), true);
  assert.equal((await sleepTabs())[sleepUrl(5)].discarded, true);
  console.log('PASS Flecha marks its tabs as its own to discard and leaves autoDiscardable to other extensions');
  // A tab in a Space no window shows is frozen at the next evaluation (after Chromium's protection
  // for recently visible pages, shortened for this run), stops running, and comes back as it was.
  const tickingUrl = base + '/ticking';
  const sleepSpace = (await stateWhere('s => true')).activeSpaceId;
  const awaySpace = (await stateWhere('s => true')).spaces.find(sp => sp.id !== sleepSpace).id;
  await rpc('newTab', tickingUrl);
  const ticking = await attach((await findTarget(t => t.type === 'page' && t.url === tickingUrl)).targetId);
  await loaded(ticking, tickingUrl);
  const tickingChromeId = await evaluate(session, `chrome.tabs.query({ url: ${JSON.stringify(tickingUrl)} }).then(ts => ts[0].id)`);
  const beforeFreeze = await evaluate(ticking, '({ documentToken })');
  await rpc('switchSpace', awaySpace);
  await runTabSleep();
  await evaluate(session, `new Promise(resolve => { const check = async () => { if ((await chrome.tabs.get(${tickingChromeId})).frozen) { chrome.tabs.onUpdated.removeListener(check); resolve(); } }; chrome.tabs.onUpdated.addListener(check); void check(); })`);
  const frozenFor = Date.now();
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.ok(Date.now() - frozenFor >= 2000);
  await rpc('switchSpace', sleepSpace);
  await evaluate(session, `new Promise(resolve => { const check = async () => { if (!(await chrome.tabs.get(${tickingChromeId})).frozen) { chrome.tabs.onUpdated.removeListener(check); resolve(); } }; chrome.tabs.onUpdated.addListener(check); void check(); })`);
  const afterFreeze = await evaluate(ticking, '({ documentToken, freezes, silent })');
  assert.equal(afterFreeze.documentToken, beforeFreeze.documentToken);
  assert.equal(afterFreeze.freezes, 1);
  // Its timer (every 100 ms; once a second while merely hidden) ran nothing while frozen.
  assert.ok(afterFreeze.silent >= 2000, JSON.stringify(afterFreeze));
  console.log('PASS a tab in a Space no window shows is frozen, and comes back as it was');
  for (const url of Array.from({ length: 11 }, (_, n) => sleepUrl(n))) {
    const state = await stateWhere('s => true');
    const id = Object.values(state.tabs).find(t => t.url === url)?.id;
    if (id) await rpc('close', id);
  }
  // Closing the active tab and picking another at once shows the one picked. Chromium activates a
  // neighbour of a closing active tab (here /download-page-4), and the shell took that as you
  // picking it, after your pick. Settled: the closed tab is gone and the window shows the
  // Store's active tab.
  const tickingTab = Object.values((await stateWhere('s => true')).tabs).find(t => t.url === tickingUrl).id;
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(tickingTab)}`);
  waitingFor = 'the window to settle after closing the active tab and activating another at once';
  const settledOn = await evaluate(session, `chrome.flechaPrivate.getWindowId().then(windowId => new Promise(resolve => {
    const check = async () => {
      const space = testState.spaces.find(sp => sp.id === testState.activeSpaceId);
      const [shown] = await chrome.tabs.query({ active: true, windowId });
      const closed = !(await chrome.tabs.query({})).some(t => t.id === ${tickingChromeId});
      if (!closed || !space.activeTabId || shown?.url !== testState.tabs[space.activeTabId]?.url) return;
      testWaiters.delete(check); chrome.tabs.onActivated.removeListener(check); chrome.tabs.onRemoved.removeListener(check);
      resolve(testState.tabs[space.activeTabId].url);
    };
    testWaiters.add(check); chrome.tabs.onActivated.addListener(check); chrome.tabs.onRemoved.addListener(check);
    void testInvoke('close', ${JSON.stringify(tickingTab)}); void testInvoke('activate', ${JSON.stringify(pageTab)});
  }))`);
  waitingFor = undefined;
  assert.equal(settledOn, base + '/a', 'closing the active tab and activating another at once showed the closed tab\'s neighbour');
  console.log('PASS closing the active tab and picking another at once shows the one picked');

  // Several windows: each has its own active Space and Today tabs; pinned tabs are shared.
  waitingFor = 'the first window to show the /a tab again';
  const firstState = await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);
  waitingFor = undefined;
  const frameWindows = async () => (await send('Target.getTargets')).targetInfos.filter(t => t.url.startsWith(extension + 'window.html'));
  const openWindowFrame = async (known) => {
    const target = await findTarget(t => t.url.startsWith(extension + 'window.html') && !known.includes(t.targetId));
    const other = await attach(target.targetId);
    await loaded(other, extension);
    await instrument(other);
    return { target, session: other, state: (predicate) => withinStep(evaluate(other, `testWait(${predicate})`), `the other window state to match ${predicate}`), rpc: (name, ...args) => evaluate(other, `testInvoke(${JSON.stringify(name)}, ...${JSON.stringify(args)})`) };
  };
  const known = (await frameWindows()).map(t => t.targetId);
  await key('n', ['Control_L']);
  waitingFor = 'the frame page of the window Ctrl+N opens';
  const otherWindow = await openWindowFrame(known);
  let secondState = await otherWindow.state('s => true');
  waitingFor = undefined;
  assert.notEqual(secondState.windowId, firstState.windowId);
  // Saved once the window is up, not after the Store's debounce: a quit right after keeps it.
  assert.equal(await evaluate(session, `chrome.storage.local.get('state').then(({ state }) => JSON.parse(state).windows.some(w => w.id === ${JSON.stringify(secondState.windowId)}))`), true);
  assert.equal(secondState.activeSpaceId, firstState.activeSpaceId);
  const todayOf = (st) => st.spaces.find(sp => sp.id === st.activeSpaceId).today;
  assert.deepEqual(todayOf(secondState), []);
  await otherWindow.rpc('newTab', base + '/second-window');
  secondState = await otherWindow.state(`s => s.spaces.some(sp => sp.today.some(id => s.tabs[id]?.url === ${JSON.stringify(base + '/second-window')}))`);
  const secondTab = todayOf(secondState).find(id => secondState.tabs[id].url === base + '/second-window');
  assert.equal(todayOf(await stateWhere('s => true')).includes(secondTab), false);
  console.log('PASS a new window shows the same Space with Today tabs of its own');
  await rpc('updateSpace', firstState.activeSpaceId, { pinnedCollapsed: true });
  await domWhere("() => document.querySelector('#pinned').hidden");
  const otherSpace = secondState.spaces.find(sp => sp.id !== secondState.activeSpaceId).id;
  await evaluate(session, `(() => {
    const header = document.querySelector('#pinned-header');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-flecha-tab', ${JSON.stringify(secondTab)});
    const event = { dataTransfer, bubbles: true, cancelable: true };
    header.dispatchEvent(new DragEvent('dragenter', event));
    if (header.dispatchEvent(new DragEvent('dragover', event))) throw new Error('The first Space did not accept the drag');
    globalThis.staleHeaderDrop = event;
  })()`);
  await rpc('switchSpace', otherSpace);
  await until(() => evaluate(session, `document.querySelector('#space-title').dataset.spaceId === ${JSON.stringify(otherSpace)}`), 'the destination window to switch Spaces');
  assert.equal(await evaluate(session, `(() => {
    const moveTab = flecha.moveTab;
    let moved = false;
    flecha.moveTab = () => { moved = true; };
    try {
      document.querySelector('#pinned-header').dispatchEvent(new DragEvent('drop', staleHeaderDrop));
      return moved;
    } finally {
      flecha.moveTab = moveTab;
      delete globalThis.staleHeaderDrop;
    }
  })()`), false);
  assert.ok(todayOf(await otherWindow.state('s => true')).includes(secondTab));
  assert.equal(await evaluate(session, `testState.spaces.find(sp => sp.id === ${JSON.stringify(otherSpace)}).pinned.some(item => item.tabId === ${JSON.stringify(secondTab)})`), false);
  await rpc('switchSpace', firstState.activeSpaceId);
  await until(() => evaluate(session, `document.querySelector('#space-title').dataset.spaceId === ${JSON.stringify(firstState.activeSpaceId)}`), 'the original destination Space to return');
  console.log('PASS a reused drop zone rejects a stale cross-window hover after a Space switch');
  const droppedOnHeader = await evaluate(session, `(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-flecha-tab', ${JSON.stringify(secondTab)});
    const header = document.querySelector('#pinned-header');
    const event = { dataTransfer, bubbles: true, cancelable: true };
    header.dispatchEvent(new DragEvent('dragenter', event));
    if (document.querySelector('#pinned').hidden) return false;
    header.dispatchEvent(new DragEvent('dragleave', event));
    if (!document.querySelector('#pinned').hidden) return false;
    header.dispatchEvent(new DragEvent('dragenter', event));
    if (header.dispatchEvent(new DragEvent('dragover', event))) return false;
    header.dispatchEvent(new DragEvent('drop', event));
    return true;
  })()`);
  assert.equal(droppedOnHeader, true);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).pinned.some(item => item.tabId === ${JSON.stringify(secondTab)})`);
  assert.equal(await evaluate(session, "document.querySelector('#pinned').hidden"), true);
  await otherWindow.rpc('moveTab', secondTab, { zone: 'today' });
  await otherWindow.rpc('activate', secondTab);
  await rpc('updateSpace', firstState.activeSpaceId, { pinnedCollapsed: false });
  await domWhere("() => !document.querySelector('#pinned').hidden");
  console.log('PASS a tab from another window drops on the folded Pinned header');
  await otherWindow.rpc('switchSpace', otherSpace);
  await otherWindow.state(`s => s.activeSpaceId === ${JSON.stringify(otherSpace)} && !s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId`);
  assert.equal((await stateWhere('s => true')).activeSpaceId, firstState.activeSpaceId);
  // That Space has nothing open there: the window shows Flecha's empty state, not the page before.
  const otherChromeWindow = await evaluate(otherWindow.session, 'chrome.flechaPrivate.getWindowId()');
  await evaluate(session, `new Promise(resolve => { const check = async () => { const [tab] = await chrome.tabs.query({ active: true, windowId: ${otherChromeWindow} }); if (/^chrome:\\/\\/(newtab|new-tab-page)/.test(tab?.pendingUrl || tab?.url || '')) { chrome.tabs.onActivated.removeListener(check); chrome.tabs.onUpdated.removeListener(check); resolve(); } }; chrome.tabs.onActivated.addListener(check); chrome.tabs.onUpdated.addListener(check); void check(); })`);
  await otherWindow.rpc('switchSpace', firstState.activeSpaceId);
  await otherWindow.state(`s => s.activeSpaceId === ${JSON.stringify(firstState.activeSpaceId)}`);
  console.log('PASS switching Space in one window leaves the other window alone, which shows its empty Space empty');
  // The sidebar hides in one window only, and a Peek belongs to its window.
  await rpc('toggleSidebar');
  await stateWhere("s => s.sidebarMode === 'hidden'");
  assert.equal((await otherWindow.state('s => true')).sidebarMode, 'docked');
  await rpc('toggleSidebar');
  await stateWhere("s => s.sidebarMode === 'docked'");
  await otherWindow.rpc('openPeek', base + '/peek-other-window');
  await evaluate(otherWindow.session, "new Promise(resolve => { const check = () => !document.querySelector('#peek').hidden && (observer.disconnect(), resolve()); const observer = new MutationObserver(check); observer.observe(document.querySelector('#peek'), { attributes: true }); check(); })");
  assert.equal(await evaluate(session, "document.querySelector('#peek').hidden"), true);
  await otherWindow.rpc('closePeek');
  console.log('PASS the sidebar and Peek act in their own window');
  // A pinned tab opened in the other window moves there with its page as it was.
  await rpc('togglePin', pageTab);
  await stateWhere(`s => s.spaces.some(sp => sp.pinned.some(n => n.kind === 'tab' && n.tabId === ${JSON.stringify(pageTab)}))`);
  const secondChromeWindow = await evaluate(otherWindow.session, 'chrome.flechaPrivate.getWindowId()');
  await otherWindow.rpc('activate', pageTab);
  await otherWindow.state(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId !== ${JSON.stringify(pageTab)}`);
  const pageChromeTab = await evaluate(session, `chrome.tabs.query({ url: ${JSON.stringify(base + '/a')} }).then(tabs => tabs[0])`);
  assert.equal(pageChromeTab.windowId, secondChromeWindow);
  await preserved('moving a pinned tab to another window');
  await rpc('activate', pageTab);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);
  await preserved('moving it back');
  // A closed window comes back, Today tabs and all, with Control-Shift-T.
  const withSecond = (await frameWindows()).map(t => t.targetId);
  await evaluate(session, `chrome.windows.remove(${secondChromeWindow})`);
  await new Promise(resolve => { const check = async () => { if (!(await frameWindows()).some(t => t.targetId === otherWindow.target.targetId)) { listeners.delete(listener); resolve(); } }; const listener = (message) => { if (message.method === 'Target.targetDestroyed') void check(); }; listeners.add(listener); void check(); });
  // At once: Control-Shift-T waits for the shell to take the close in.
  await key('t', ['Control_L', 'Shift_L']);
  const reopened = await openWindowFrame(withSecond);
  const reopenedState = await reopened.state(`s => s.spaces.some(sp => sp.activeTabId === ${JSON.stringify(secondTab)})`);
  assert.equal(reopenedState.windowId, secondState.windowId);
  assert.ok(todayOf(reopenedState).includes(secondTab));
  console.log('PASS a closed window reopens with its Today tabs');
  // Already saved once the window is up, not after the Store's debounce: a quit right after a
  // reopen keeps the window.
  assert.equal(await evaluate(session, `chrome.storage.local.get('state').then(({ state }) => JSON.parse(state).windows.some(w => w.id === ${JSON.stringify(secondState.windowId)}))`), true);
  console.log('PASS a reopened window is saved at once');
  // Edit Pinned URL, from the tab menu: typed like the address bar and kept through the restart
  // below. A pinned tab browsed away stays where it is and goes back to the new URL.
  const pickInTabMenu = async (tabId, label) => {
    await evaluate(session, `flecha.tabMenu(${JSON.stringify(tabId)})`);
    const item = `[...document.querySelectorAll('.shell-menu-item')].find(r => r.textContent === ${JSON.stringify(label)})`;
    await domWhere(`() => !!${item}`);
    await evaluate(session, `${item}.click()`);
  };
  const tabMenuLabels = async (tabId) => {
    await evaluate(session, `flecha.tabMenu(${JSON.stringify(tabId)})`);
    await domWhere("() => !!document.querySelector('.shell-menu')");
    const labels = await evaluate(session, "[...document.querySelectorAll('.shell-menu-item')].map(r => r.textContent)");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, session);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, session);
    await domWhere("() => !document.querySelector('.shell-menu')");
    return labels;
  };
  const typeUrl = async (field, current, typed) => {
    await domWhere(`() => document.activeElement?.matches(${JSON.stringify(field)}) && document.activeElement.isContentEditable && document.activeElement.textContent === ${JSON.stringify(current)} && document.getSelection().toString() === ${JSON.stringify(current)}`);
    await send('Input.insertText', { text: typed }, session);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
  };
  const tabWhere = (tabId, predicate) => stateWhere(`s => (${predicate})(s.tabs[${JSON.stringify(tabId)}] ?? {})`);
  await rpc('newTab', base + '/pinned-home');
  const homeTab = Object.values((await stateWhere(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(base + '/pinned-home')})`)).tabs).find(t => t.url === base + '/pinned-home').id;
  await rpc('togglePin', homeTab);
  await tabWhere(homeTab, `t => t.homeUrl === ${JSON.stringify(base + '/pinned-home')}`);
  assert.equal((await tabMenuLabels(homeTab)).filter(l => l.includes('Pinned URL')).join(), 'Edit Pinned URL…');
  await rpc('navigate', base + '/pinned-away');
  await tabWhere(homeTab, `t => t.url === ${JSON.stringify(base + '/pinned-away')}`);
  assert.equal((await tabMenuLabels(homeTab)).filter(l => l.includes('Pinned URL')).join(), 'Edit Pinned URL…,Go Back to Pinned URL,Set Pinned URL to Current Page');
  await pickInTabMenu(homeTab, 'Set Pinned URL to Current Page');
  await tabWhere(homeTab, `t => t.homeUrl === ${JSON.stringify(base + '/pinned-away')}`);
  console.log('PASS Set Pinned URL to Current Page keeps the page a pinned tab was browsed to');
  await rpc('navigate', base + '/pinned-later');
  await tabWhere(homeTab, `t => t.url === ${JSON.stringify(base + '/pinned-later')}`);
  const pinnedTitle = `#pinned .row[data-tab-id="${homeTab}"] .title`;
  await pickInTabMenu(homeTab, 'Edit Pinned URL…');
  await typeUrl(pinnedTitle, base + '/pinned-away', base.replace('http://', '') + '/pinned-new');
  await tabWhere(homeTab, `t => t.homeUrl === ${JSON.stringify(base + '/pinned-new')} && t.url === ${JSON.stringify(base + '/pinned-later')}`);
  await domWhere(`() => !document.querySelector(${JSON.stringify(pinnedTitle)}).isContentEditable && document.querySelector(${JSON.stringify(pinnedTitle)}).textContent === 'Workflow /pinned-later'`);
  // An address the shell doesn't keep (a script, here) is refused with a message.
  await pickInTabMenu(homeTab, 'Edit Pinned URL…');
  await typeUrl(pinnedTitle, base + '/pinned-new', 'javascript:alert(1)');
  await domWhere("() => document.querySelector('#urlbar-wrap').classList.contains('flashing') && document.querySelector('#urlbar-wrap').dataset.flash === 'Enter a web address, like example.com.'");
  await domWhere(`() => document.querySelector(${JSON.stringify(pinnedTitle)}).textContent === 'Workflow /pinned-later'`);
  assert.equal((await stateWhere('s => true')).tabs[homeTab].homeUrl, base + '/pinned-new');
  // So is a blank one.
  await evaluate(session, "document.querySelector('#urlbar-wrap').classList.remove('flashing'); document.querySelector('#urlbar-wrap').dataset.flash = ''");
  await pickInTabMenu(homeTab, 'Edit Pinned URL…');
  await typeUrl(pinnedTitle, base + '/pinned-new', '   ');
  await domWhere("() => document.querySelector('#urlbar-wrap').classList.contains('flashing') && document.querySelector('#urlbar-wrap').dataset.flash === 'Enter a web address, like example.com.'");
  assert.equal((await stateWhere('s => true')).tabs[homeTab].homeUrl, base + '/pinned-new');
  await pickInTabMenu(homeTab, 'Go Back to Pinned URL');
  await tabWhere(homeTab, `t => t.url === ${JSON.stringify(base + '/pinned-new')}`);
  console.log('PASS Edit Pinned URL takes a typed address, refuses a script or a blank, and Go Back uses the new URL');
  // A favorite is an icon: its URL is edited in a field under the favorites. Shown at its pinned
  // page, the tab follows the new URL. Typed without the trailing slash the page reports, it is
  // still the page the tab shows: no Go Back or Set Pinned URL.
  await rpc('toggleFavorite', homeTab);
  await stateWhere(`s => s.favorites.includes(${JSON.stringify(homeTab)})`);
  await pickInTabMenu(homeTab, 'Edit Pinned URL…');
  await typeUrl('.url-edit', base + '/pinned-new', base);
  await tabWhere(homeTab, `t => t.homeUrl === ${JSON.stringify(base + '/')} && t.url === t.homeUrl && t.title === 'Workflow /'`);
  assert.equal(await evaluate(session, "document.querySelector('.url-edit')"), null);
  assert.equal((await tabMenuLabels(homeTab)).filter(l => l.includes('Pinned URL')).join(), 'Edit Pinned URL…');
  console.log('PASS Edit Pinned URL works on a favorite, and a tab at its pinned page follows the new URL');
  await rpc('activate', pageTab);
  await stateWhere(`s => s.spaces.find(sp => sp.id === s.activeSpaceId).activeTabId === ${JSON.stringify(pageTab)}`);
  // The tab menu's edits focused this window, raising it; the reopened window goes back on top,
  // as it was (the window title check below reads the one underneath).
  await evaluate(reopened.session, 'chrome.flechaPrivate.getWindowId().then(id => chrome.windows.update(id, { focused: true }))');
  // The second window stays open through the restart below.

  const storage = await evaluate(session, `new Promise(resolve => { const check = async () => { const { state } = await chrome.storage.local.get('state'); if (state && JSON.parse(state).onboarded && Object.values(JSON.parse(state).tabs).some(t => t.url === ${JSON.stringify(base + '/a')}) && JSON.parse(state).tabs[${JSON.stringify(homeTab)}]?.homeUrl === ${JSON.stringify(base + '/')}) { chrome.storage.onChanged.removeListener(check); resolve(JSON.parse(state)); } }; chrome.storage.onChanged.addListener(check); void check(); })`);
  assert.ok(storage.spaces.length > 1);
  console.log('PASS state persisted to native extension storage before shutdown');
  const title = execFileSync(inputTool, [env.DISPLAY, String(browser.pid), 'title'], { env, encoding: 'utf8' });
  assert.match(title, /Workflow \/a - Flecha/);
  console.log('PASS native Linux window title uses Flecha');
  if (artifacts) {
    await fs.mkdir(artifacts, { recursive: true });
    await rpc('settings:show-tour');
    await domWhere("() => !document.querySelector('#onboarding').hidden");
    await evaluate(session, "document.querySelector('.tour-primary').click(); document.querySelector('.tour-primary').click()");
    for (const theme of ['light', 'dark']) {
      await rpc('setPreferences', { theme });
      await stateWhere(`s => s.theme === ${JSON.stringify(theme)}`);
      await evaluate(session, `new Promise(resolve => { const media = matchMedia('(prefers-color-scheme: dark)'); if (media.matches === ${theme === 'dark'}) resolve(); else media.addEventListener('change', () => resolve(), {once:true}); })`);
      await evaluate(session, "document.fonts.ready.then(async () => { getComputedStyle(document.querySelector('#onboarding')).opacity; await Promise.all(document.getAnimations().filter(a => a.effect && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {}))); })");
      const capture = await send('Page.captureScreenshot', { format: 'png' }, session);
      await fs.writeFile(path.join(artifacts, `onboarding-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
    await rpc('finishOnboarding');
  }
  // Quit with Ctrl+Shift+Q, the window menu's Quit on Linux (patch 0070): every window comes back.
  const quit = once(browser, 'exit');
  await key('q', ['Control_L', 'Shift_L']);
  await quit;
  console.log('PASS Ctrl+Shift+Q quits');
  startBrowser();
  await send('Target.setDiscoverTargets', { discover: true });
  const restoredFrameTarget = (await findTarget(t => t.url.startsWith(extension + 'window.html'))).targetId;
  const restoredFrame = await attach(restoredFrameTarget);
  await loaded(restoredFrame, extension);
  const restored = await evaluate(restoredFrame, "chrome.storage.local.get('state').then(({state}) => JSON.parse(state))");
  assert.equal(restored.onboarded, true);
  assert.deepEqual(restored.spaces.map(({id,name,pinned}) => ({id,name,pinned})), storage.spaces.map(({id,name,pinned}) => ({id,name,pinned})));
  assert.ok(Object.values(restored.tabs).some(t => t.url === base + '/a'));
  assert.ok(Object.values(restored.tabs).some(t => t.url === base + '/b'));
  console.log('PASS Spaces and tab URLs survive graceful native restart');
  assert.equal(restored.tabs[homeTab]?.homeUrl, base + '/');
  assert.ok(restored.favorites.includes(homeTab));
  console.log('PASS an edited pinned URL survives the restart');
  assert.equal(restored.sidebarWidth, 300);
  await evaluate(restoredFrame, "new Promise(resolve => { const check = () => innerWidth === 300 && document.querySelector('#sidebar').offsetWidth === 300 ? resolve() : requestAnimationFrame(check); check(); })");
  console.log('PASS the dragged sidebar width comes back after a restart');
  // Both windows come back, each with its own Today tabs.
  const restoredWindows = await new Promise(resolve => { const check = async () => { const frames = await frameWindows(); if (frames.length === 2) { listeners.delete(listener); resolve(frames); } }; const listener = (message) => { if (message.method === 'Target.targetCreated') void check(); }; listeners.add(listener); void check(); });
  const windowStates = [];
  for (const target of restoredWindows) {
    // By the frame attached above, not whichever frame Chromium lists first now.
    const restoredSession = target.targetId === restoredFrameTarget ? restoredFrame : await attach(target.targetId);
    await loaded(restoredSession, extension);
    await instrument(restoredSession);
    windowStates.push(await evaluate(restoredSession, 'testWait(s => true)'));
  }
  const restoredSecond = windowStates.find(st => st.windowId === secondState.windowId);
  assert.ok(restoredSecond, 'the second window is restored');
  assert.ok(todayOf(restoredSecond).some(id => restoredSecond.tabs[id].url === base + '/second-window'));
  const restoredFirst = windowStates.find(st => st !== restoredSecond);
  const todayUrls = (st) => todayOf(st).map(id => `${id.slice(0, 8)} ${st.tabs[id]?.url}`);
  assert.equal(todayOf(restoredFirst).some(id => restoredSecond.tabs[id]?.url === base + '/second-window'), false, JSON.stringify({ first: todayUrls(restoredFirst), second: todayUrls(restoredSecond) }));
  console.log('PASS both windows come back after a restart with their own Today tabs');
  const damaged = '{"spaces": [';
  await evaluate(restoredFrame, `chrome.storage.local.set({ state: ${JSON.stringify(damaged)} })`);
  await closeBrowser();
  startBrowser();
  await send('Target.setDiscoverTargets', { discover: true });
  const recoveredFrame = await attach((await findTarget(t => t.url.startsWith(extension + 'window.html'))).targetId);
  await loaded(recoveredFrame, extension);
  await instrument(recoveredFrame);
  const recoveredState = await evaluate(recoveredFrame, `testWait(s => s.spaces.length === ${storage.spaces.length})`);
  assert.deepEqual(recoveredState.spaces.map(({ id, name }) => ({ id, name })), storage.spaces.map(({ id, name }) => ({ id, name })));
  const kept = await evaluate(recoveredFrame, "chrome.storage.local.get(['state', 'state:damaged'])");
  assert.equal(kept['state:damaged'], damaged);
  assert.deepEqual(JSON.parse(kept.state).spaces.map(({ id }) => id), storage.spaces.map(({ id }) => id));
  console.log('PASS an unreadable saved state recovers from the last good copy and is kept aside');
  // A state that parses but holds a setting of the wrong type starts without that setting.
  await evaluate(recoveredFrame, "chrome.storage.local.get('state').then(({ state }) => chrome.storage.local.set({ state: JSON.stringify({ ...JSON.parse(state), keybindings: { newTab: 42 } }) }))");
  await closeBrowser();
  // Launched with an address (a link from another app while Flecha isn't running): it loads.
  const coldLink = base + '/cold-link';
  startBrowser(coldLink);
  await send('Target.setDiscoverTargets', { discover: true });
  const repairedFrame = await attach((await findTarget(t => t.url.startsWith(extension + 'window.html'))).targetId);
  await loaded(repairedFrame, extension);
  await instrument(repairedFrame);
  const repaired = await evaluate(repairedFrame, `testWait(s => s.spaces.length === ${storage.spaces.length})`);
  assert.equal(repaired.keybindings, undefined);
  assert.equal(await evaluate(repairedFrame, "chrome.storage.local.get('state:last-good').then(r => JSON.parse(r['state:last-good']).keybindings)"), undefined);
  console.log('PASS a setting of the wrong type is dropped and never reaches the last good copy');
  await evaluate(repairedFrame, `new Promise(resolve => { const check = async () => { if ((await chrome.tabs.query({})).some(t => t.url === ${JSON.stringify(coldLink)} && t.status === 'complete')) { chrome.tabs.onUpdated.removeListener(check); resolve(); } }; chrome.tabs.onUpdated.addListener(check); void check(); })`);
  await evaluate(repairedFrame, `testWait(s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(coldLink)}))`);
  console.log('PASS a cold launch with an address loads it');
  // An incognito window's command bar asks for no search suggestions, as Chromium's omnibox in
  // incognito. Last, because this display has no window manager to give the keyboard back to
  // the main window once the incognito one closes.
  const regularFrames = new Set((await send('Target.getTargets')).targetInfos.filter((t) => t.url.startsWith(extension + 'window.html')).map((t) => t.targetId));
  await evaluate(repairedFrame, "testInvoke('newIncognitoWindow')");
  const incognitoFrame = await findTarget((t) => t.url.startsWith(extension + 'window.html') && !regularFrames.has(t.targetId));
  const incognitoSession = await attach(incognitoFrame.targetId);
  await loaded(incognitoSession, extension);
  // Google doesn't resolve on this run: a request sent would fail, rejecting instead of giving [].
  assert.deepEqual(await evaluate(incognitoSession, "chrome.extension.inIncognitoContext && window.flecha.searchSuggestions('flecha incognito', new AbortController().signal)"), []);
  console.log('PASS an incognito window asks for no search suggestions');
  await closeBrowser();
} finally {
  finished = true;
  clearTimeout(watchdog);
  // After a failed step the killed browser's helpers can still be writing to the profile; a
  // failing cleanup must not hide the step that failed.
  await cleanUp().catch((err) => console.error(`Cleanup failed (${err.message}); remove ${profile} by hand`));
}
