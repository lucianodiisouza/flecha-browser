// Linux benchmark for a compiled Flecha Chromium and a built shell. See --help.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const extension = 'chrome-extension://abdiaepfgbbhdjaecjipmaailijaaide/';
const shellFrame = extension + 'window.html';
const spaces = 3;
const tabsPerSpace = 8;
const settleMs = 3000; // Same settling window as the reference performance harness.
const idleMs = 10_000;
const pollMs = 20; // Same document readiness poll as the reference performance harness.
// Same watchdog default as native-workflows.mjs. Applied to each run, including both launches.
const watchdogMs = Number(process.env.FLECHA_HARNESS_TIMEOUT_MS) || 10 * 60 * 1000;
const abort = new AbortController();

const { values: args } = parseArgs({
  options: {
    chrome: { type: 'string' },
    'shell-dir': { type: 'string', default: fileURLToPath(new URL('../shell/dist', import.meta.url)) },
    'compare-shell-dir': { type: 'string' },
    out: { type: 'string' },
    runs: { type: 'string', default: '3' },
    help: { type: 'boolean' },
  },
});
function temporaryEnvironment(profile, display) {
  const env = { ...process.env, HOME: path.join(profile, 'home'), DISPLAY: display };
  for (const key of ['WAYLAND_DISPLAY', 'CHROME_CONFIG_HOME', 'HELIUM_CONFIG_HOME', '__PYVENV_LAUNCHER__']) delete env[key];
  // Keep GTK, Chromium, and helpers away from the user's desktop/session bus.
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(profile, 'no-session-bus')}`;
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    env[key] = path.join(profile, key.toLowerCase());
  }
  return env;
}

function childProcess(file, argv, options) {
  const child = spawn(file, argv, options);
  // Listen immediately, including when spawn itself fails.
  const stopped = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, stopped };
}

function untilAborted(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function procFile(file) {
  try {
    return await fs.readFile(`/proc/${file}`, 'utf8');
  } catch (error) {
    // A process or thread can exit between enumeration and sampling.
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
}

async function processStat(pid) {
  const stat = await procFile(`${pid}/stat`);
  if (!stat) return;
  // Fields start at stat(5) field 3, after comm, which may contain spaces or ')'.
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).split(' ');
  return {
    pid,
    command: stat.slice(stat.indexOf('(') + 1, end),
    state: fields[0],
    group: Number(fields[2]),
    cpuTicks: Number(fields[11]) + Number(fields[12]),
    started: fields[19],
  };
}

async function liveProcesses() {
  const pids = (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
  return (await Promise.all(pids.map(processStat))).filter((entry) => entry && entry.state !== 'Z');
}

async function groupMembers(group) {
  return (await liveProcesses()).filter((entry) => entry.group === group);
}

class Browser {
  #nextId = 0;
  #pending = new Map();
  #events = new EventEmitter();
  #targets = new Map();
  #failure;

  constructor(binary, shellDir, profile, env, signal) {
    this.signal = signal;
    this.crashDatabasePrefix = `--database=${env.XDG_CONFIG_HOME}/`;
    this.started = performance.now();
    const { child, stopped } = childProcess(binary, [
      `--user-data-dir=${profile}`, `--flecha-shell-dir=${shellDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--ozone-platform=x11',
      '--password-store=basic', '--remote-debugging-pipe',
      '--disable-background-networking', '--no-proxy-server',
      '--host-resolver-rules=MAP *.test 127.0.0.1, MAP * ~NOTFOUND',
    ], { env, cwd: profile, detached: true, stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] });
    this.pid = child.pid;
    this.stopped = stopped;
    this.input = child.stdio[3];
    const output = child.stdio[4];
    this.input.on('error', (error) => this.#fail(error));
    output.on('error', (error) => this.#fail(error));
    output.setEncoding('utf8');
    let buffer = '';
    output.on('data', (chunk) => {
      const messages = (buffer + chunk).split('\0');
      buffer = messages.pop();
      for (const json of messages) this.#receive(JSON.parse(json));
    });
    void stopped.then(({ code, signal, error }) => {
      this.#fail(error ?? new Error(`Chromium exited (${signal ?? code})`));
    });
  }

  #fail(error) {
    this.#failure ??= error;
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    this.#events.emit('failed', error);
  }

  #receive(message) {
    if (message.id) {
      const call = this.#pending.get(message.id);
      if (!call) return;
      this.#pending.delete(message.id);
      if (message.error) call.reject(Object.assign(new Error(`${call.method}: ${message.error.message}`), { code: message.error.code }));
      else call.resolve(message.result);
      return;
    }
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
      this.#targets.set(message.params.targetInfo.targetId, message.params.targetInfo);
    }
    if (message.method === 'Target.targetDestroyed') this.#targets.delete(message.params.targetId);
    this.#events.emit(message.method, message.params);
  }

  send(method, params = {}, sessionId) {
    this.signal.throwIfAborted();
    if (this.#failure) return Promise.reject(this.#failure);
    const id = ++this.#nextId;
    const reply = new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.input.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
    return untilAborted(reply, this.signal).finally(() => this.#pending.delete(id));
  }

  async target(predicate) {
    const changed = () => [...this.#targets.values()].find(predicate);
    return this.#waitFor(['Target.targetCreated', 'Target.targetInfoChanged'], changed);
  }

  #waitFor(events, check) {
    this.signal.throwIfAborted();
    if (this.#failure) return Promise.reject(this.#failure);
    const found = check();
    if (found) return Promise.resolve(found);
    let onEvent;
    let onFailure;
    const result = new Promise((resolve, reject) => {
      onEvent = () => {
        const value = check();
        if (value) resolve(value);
      };
      onFailure = reject;
      for (const event of events) this.#events.on(event, onEvent);
      this.#events.on('failed', onFailure);
    });
    return untilAborted(result, this.signal).finally(() => {
      for (const event of events) this.#events.off(event, onEvent);
      this.#events.off('failed', onFailure);
    });
  }

  async attach(target) {
    return (await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  }

  async evaluate(session, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async loaded(session, url, extra = 'true') {
    const expression = `location.href.startsWith(${JSON.stringify(url)}) && document.readyState === 'complete' && (${extra})`;
    for (;;) {
      try {
        if (await this.evaluate(session, expression)) return;
      } catch (error) {
        if (error.code !== -32000 || !/context|navigat/i.test(error.message)) throw error;
      }
      await delay(pollMs, undefined, { signal: this.signal }).catch((error) => {
        throw new Error(`Waiting for ${url} (${extra}): ${error.message}`, { cause: error });
      });
    }
  }

  // Trace a mark inside the renderer to map a CDP session to a Linux PID. CDP's
  // SystemInfo.getProcessInfo lists renderer PIDs without their target IDs.
  async rendererPids(session, includeFrames = false) {
    const mark = 'flecha-perf-renderer-pid';
    const pids = new Set();
    let complete = false;
    const record = ({ value }) => {
      for (const event of value) if (event.name === mark) pids.add(event.pid);
    };
    const done = () => { complete = true; };
    this.#events.on('Tracing.dataCollected', record);
    this.#events.on('Tracing.tracingComplete', done);
    try {
      await this.send('Tracing.start', { categories: 'blink.user_timing' });
      await this.evaluate(session, `(() => {
        const mark = ${JSON.stringify(mark)};
        performance.mark(mark);
        performance.clearMarks(mark);
        if (${includeFrames}) {
          for (const frame of document.querySelectorAll('iframe')) {
            frame.contentWindow.performance.mark(mark);
            frame.contentWindow.performance.clearMarks(mark);
          }
        }
      })()`);
      await this.send('Tracing.end');
      await this.#waitFor(['Tracing.tracingComplete'], () => complete);
      assert.ok(pids.size, 'Trace did not identify the renderer PID');
      return pids;
    } finally {
      this.#events.off('Tracing.dataCollected', record);
      this.#events.off('Tracing.tracingComplete', done);
    }
  }

  async close() {
    // Chromium can close the CDP pipe before acknowledging Browser.close. Its
    // process exit status is the authority on whether shutdown was graceful.
    const close = this.send('Browser.close').catch(() => {});
    try {
      const { code, signal, error } = await untilAborted(this.stopped, this.signal);
      if (error) throw error;
      assert.equal(code, 0, `Chromium shutdown failed (${signal ?? code})`);
    } finally {
      await close;
    }
  }

  async dispose() {
    killGroup(this.pid);
    await this.stopped;
    if (!this.pid) return;
    // Crashpad daemonizes into a new process group. Its database path is
    // below this launch's private config directory, even on failure.
    for (;;) {
      const live = await liveProcesses();
      const crashpad = await Promise.all(live.filter(({ command }) => command === 'chrome_crashpad').map(async ({ pid }) => {
        const args = (await procFile(`${pid}/cmdline`))?.split('\0');
        return args?.some((arg) => arg.startsWith(this.crashDatabasePrefix)) ? pid : undefined;
      }));
      const owned = crashpad.filter(Boolean);
      for (const pid of owned) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      if (!owned.length && !live.some(({ group }) => group === this.pid)) return;
      await delay(pollMs);
    }
  }
}

// Same port protocol as the sidebar, with state waits kept in the frame so
// switch samples do not include a Node-side polling interval.
const instrument = `(() => {
  const port = chrome.runtime.connect({ name: 'flecha' });
  const calls = new Map();
  const waiters = new Set();
  let id = 0;
  let state;
  port.onMessage.addListener((message) => {
    if (message.type === 'result') {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) call?.reject(new Error(message.error));
      else call?.resolve(message.value);
    }
    if (message.type === 'event' && message.name === 'state') {
      state = message.args[0];
      for (const check of waiters) check();
    }
  });
  const rpc = (name, ...args) => new Promise((resolve, reject) => {
    calls.set(++id, { resolve, reject });
    port.postMessage({ type: 'invoke', id, name, args });
  });
  const wait = (predicate) => new Promise((resolve) => {
    const check = () => {
      if (!state || !predicate(state)) return;
      waiters.delete(check);
      resolve(state);
    };
    waiters.add(check);
    check();
  });
  globalThis.perfBench = { rpc, wait };
  port.postMessage({ type: 'cmd', name: 'ready', args: [] });
})()`;

async function startup(browser) {
  const version = await browser.send('Browser.getVersion');
  const cdpReadyMs = performance.now() - browser.started;
  await browser.send('Target.setDiscoverTargets', { discover: true });
  // Query the window through Chromium's active native frame target.
  const target = await browser.target(({ url }) => url.startsWith(shellFrame));
  const windowId = Number(new URL(target.url).searchParams.get('window'));
  assert.ok(windowId > 0, 'Native shell frame is missing its Chromium window ID');
  await browser.send('Browser.getWindowBounds', { windowId });
  const windowTargetMs = performance.now() - browser.started;
  const frame = await browser.attach(target);
  await browser.loaded(frame, shellFrame, "window.flecha && document.querySelector('.space-dot.active')");
  await browser.evaluate(frame, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const shellReadyMs = performance.now() - browser.started;
  return { version, frame, timings: { cdpReadyMs, windowTargetMs, shellReadyMs } };
}

function sleep(browser, ms) {
  return delay(ms, undefined, { signal: browser.signal });
}

async function workloadTabs(browser, frame, port) {
  const rpc = (name, ...args) => browser.evaluate(frame, `perfBench.rpc(...${JSON.stringify([name, ...args])})`);
  const waitState = (predicate) => browser.evaluate(frame, `perfBench.wait(${predicate})`);
  await browser.evaluate(frame, instrument);
  await rpc('finishOnboarding');
  await waitState('s => s.onboarded');
  const tabs = [];
  for (let space = 0; space < spaces; space++) {
    if (space > 0) {
      const { spaces: before } = await waitState('s => true');
      await rpc('newSpace');
      await waitState(`s => s.spaces.length > ${before.length}`);
      await browser.evaluate(frame, "document.querySelector('#space-done').click()");
    }
    const { activeSpaceId } = await waitState('s => true');
    tabs[space] = [];
    for (let tab = 0; tab < tabsPerSpace; tab++) {
      const url = `http://tabs-${space}.test:${port}/tab/${tab}?mode=tab`;
      await rpc('newTab', url);
      const state = await waitState(`s => Object.values(s.tabs).some(t => t.url === ${JSON.stringify(url)})`);
      const id = Object.values(state.tabs).find((entry) => entry.url === url).id;
      const target = await browser.target((entry) => entry.url === url && entry.type === 'page');
      const session = await browser.attach(target);
      await browser.loaded(session, url, "typeof nextVisibleFrame === 'function'");
      tabs[space].push({ id, spaceId: activeSpaceId, session });
    }
    console.error(`[perf] Loaded Space ${space + 1}/${spaces} with ${tabsPerSpace} tabs`);
  }
  assert.equal(new Set(tabs.flat().map((tab) => tab.spaceId)).size, spaces);
  // Pairs within each Space, rotated across Spaces, visit all 24 tabs.
  const order = [];
  for (let tab = 0; tab < tabsPerSpace; tab += 2) {
    for (const group of tabs) order.push(group[tab], group[tab + 1]);
  }
  const samples = [];
  let previous = tabs.at(-1).at(-1);
  for (const destination of order) {
    const { session, id, spaceId } = destination;
    // Arm the visibility observer before issuing the switch; exclude the arm's
    // CDP round trip from the measured interval.
    assert.equal(await browser.evaluate(session, 'document.hidden && !!(window.benchFrame = nextVisibleFrame())'), true);
    const request = browser.evaluate(frame, `(async () => {
      const now = () => performance.timeOrigin + performance.now();
      const id = ${JSON.stringify(id)};
      const space = ${JSON.stringify(spaceId)};
      const started = now();
      const ack = perfBench.rpc('activate', id).then(now);
      const state = perfBench.wait(s => s.activeSpaceId === space &&
        s.spaces.find(sp => sp.id === space).activeTabId === id).then(now);
      return { started, ackAt: await ack, stateAt: await state };
    })()`);
    const [ack, rendered] = await Promise.all([request, browser.evaluate(session, 'window.benchFrame')]);
    const sample = {
      crossSpace: previous.spaceId !== spaceId,
      rpcMs: ack.ackAt - ack.started,
      stateMs: ack.stateAt - ack.started,
      visibleMs: rendered.visibleAt - ack.started,
      frameMs: rendered.frameAt - ack.started,
    };
    assert.ok(sample.visibleMs >= 0 && sample.frameMs >= sample.visibleMs, 'Inconsistent tab visibility or frame timestamps');
    samples.push(sample);
    previous = destination;
  }
  console.error(`[perf] Measured ${samples.length} tab switches`);
  await Promise.all(order.map(({ session }) => browser.send('Target.detachFromTarget', { sessionId: session })));
  return { samples, rpc };
}

function procCounter(contents, name) {
  const value = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(contents)?.[1];
  assert.notEqual(value, undefined, `Missing /proc counter ${name}`);
  return Number(value);
}

async function processKinds(browser, shellPids) {
  const { processInfo } = await browser.send('SystemInfo.getProcessInfo');
  const kinds = new Map();
  for (const { id, type } of processInfo) {
    if (type === 'browser') kinds.set(id, 'browser');
    if (type === 'renderer') kinds.set(id, 'renderer');
    if (type.toLowerCase().startsWith('gpu')) kinds.set(id, 'gpu');
  }
  for (const pid of shellPids) {
    assert.equal(kinds.get(pid), 'renderer', 'CDP did not identify the shell frame as a renderer');
    kinds.set(pid, 'shellFrame');
  }
  return kinds;
}

async function idleSnapshot(browser, kinds) {
  const processes = new Map();
  for (const member of await groupMembers(browser.pid)) {
    const { pid, started, cpuTicks } = member;
    let threads;
    try {
      threads = await fs.readdir(`/proc/${pid}/task`);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      continue;
    }
    const wakeups = new Map();
    await Promise.all(threads.map(async (tid) => {
      const status = await procFile(`${pid}/task/${tid}/status`);
      if (status) wakeups.set(tid, procCounter(status, 'voluntary_ctxt_switches'));
    }));
    processes.set(pid, { started, cpuTicks, wakeups, kind: kinds.get(pid) ?? 'other' });
  }
  return processes;
}

function idleDeltas(before, after, elapsedMs, ticksPerSecond) {
  const byKind = {};
  const churn = { processesStarted: 0, processesExited: 0, threadsStarted: 0, threadsExited: 0 };
  for (const [pid, start] of before) {
    if (after.get(pid)?.started !== start.started) churn.processesExited++;
  }
  for (const [pid, end] of after) {
    const start = before.get(pid);
    if (start?.started !== end.started) {
      churn.processesStarted++;
      continue;
    }
    const group = byKind[end.kind] ??= { cpuMs: 0, wakeups: 0 };
    group.cpuMs += (end.cpuTicks - start.cpuTicks) * 1000 / ticksPerSecond;
    // Chromium uses voluntary context switches as its Linux idle wakeups proxy.
    // Sum the per-thread counters here to include renderer and browser workers.
    for (const tid of start.wakeups.keys()) {
      if (!end.wakeups.has(tid)) churn.threadsExited++;
    }
    for (const [tid, count] of end.wakeups) {
      const earlier = start.wakeups.get(tid);
      if (earlier === undefined || earlier > count) churn.threadsStarted++;
      else group.wakeups += count - earlier;
    }
  }
  assert.ok(byKind.browser && byKind.shellFrame && byKind.renderer, `Idle snapshot lost a required process role: ${JSON.stringify(byKind)}`);
  const groups = Object.values(byKind);
  return {
    elapsedMs, churn, byKind,
    cpuMs: groups.reduce((sum, group) => sum + group.cpuMs, 0),
    wakeups: groups.reduce((sum, group) => sum + group.wakeups, 0),
  };
}

async function memorySnapshot(browser, kinds = new Map()) {
  const members = await groupMembers(browser.pid);
  return (await Promise.all(members.map(async ({ pid }) => {
    const smaps = await procFile(`${pid}/smaps_rollup`);
    if (!smaps) return;
    return {
      pid,
      kind: kinds.get(pid) ?? 'other',
      rssKiB: procCounter(smaps, 'Rss'),
      pssKiB: procCounter(smaps, 'Pss'),
    };
  }))).filter(Boolean);
}

function sumMemory(processes) {
  return processes.reduce((total, process) => {
    total.processes++;
    total.rssKiB += process.rssKiB;
    total.pssKiB += process.pssKiB;
    return total;
  }, { processes: 0, rssKiB: 0, pssKiB: 0 });
}

async function adblockSample(browser, rpc, frame, port, site, enabled) {
  await rpc('settings:set', { adBlock: enabled });
  const isset = `chrome.scripting.getRegisteredContentScripts({ids: ['flecha-adblock-cosmetic']}).then(scripts => scripts.length === ${Number(enabled)})`;
  while (!await browser.evaluate(frame, isset)) await sleep(browser, pollMs);

  // Fresh site per condition keeps the previous stylesheet and page allocations
  // out of the next sample. Both sites serve identical bytes.
  const origin = `http://${site}.test:${port}`;
  const blank = origin + '/blank';
  await rpc('newTab', blank);
  const target = await browser.target(({ type, url }) => type === 'page' && url === blank);
  const session = await browser.attach(target);
  await browser.loaded(session, blank);
  const initialPids = await browser.rendererPids(session);
  assert.equal(initialPids.size, 1);
  await browser.send('Performance.enable', {}, session);
  const metrics = async () => {
    const response = await browser.send('Performance.getMetrics', {}, session);
    const value = response.metrics.find(({ name }) => name === 'RecalcStyleDuration')?.value;
    assert.ok(Number.isFinite(value), 'CDP RecalcStyleDuration is unavailable');
    return value * 1000;
  };
  const before = await metrics();
  const heavy = origin + '/heavy?mode=heavy';
  const navigation = await browser.send('Page.navigate', { url: heavy }, session);
  assert.equal(navigation.errorText, undefined);
  await browser.loaded(session, heavy, 'document.querySelectorAll("main > .row").length === 3000');
  const fixture = await browser.evaluate(session, `(() => {
    const frames = [...document.querySelectorAll('iframe')].map(frame => frame.contentDocument);
    const hidden = doc => doc.defaultView.getComputedStyle(doc.querySelector('#AD_300')).display === 'none';
    return {
      topRows: document.querySelectorAll('main > .row').length,
      frameRows: frames.map(doc => doc.querySelectorAll('main > .row').length),
      adsHidden: [document, ...frames].map(hidden),
    };
  })()`);
  const styleRecalcMs = await metrics() - before;
  assert.ok(styleRecalcMs > 0, 'Style recalculation time did not increase during fixture navigation');
  assert.equal(fixture.topRows, 3000);
  assert.deepEqual(fixture.frameRows, Array(8).fill(375));
  assert.deepEqual(fixture.adsHidden, Array(9).fill(enabled), 'Unexpected cosmetic CSS state in the document or an iframe');

  const memory = await memorySnapshot(browser);
  const rendererPids = await browser.rendererPids(session, true);
  assert.ok([...initialPids].every((pid) => rendererPids.has(pid)), 'Top renderer changed during same-site fixture navigation');
  const matching = memory.filter(({ pid }) => rendererPids.has(pid));
  assert.equal(matching.length, rendererPids.size, 'Could not read memory for all fixture renderers');
  await browser.send('Target.closeTarget', { targetId: target.targetId });
  return { styleRecalcMs, rendererPssKiB: sumMemory(matching).pssKiB, rendererPids: [...rendererPids], fixture };
}

async function run({ binary, shellDir, profile, display, port, ticksPerSecond, pair }) {
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(watchdogMs)]);
  const env = temporaryEnvironment(profile, display);
  await fs.mkdir(env.HOME);
  await fs.mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  let browser;
  let phase = 'cold startup';
  try {
    browser = new Browser(binary, shellDir, profile, env, signal);
    const cold = await startup(browser);
    await browser.close();
    await browser.dispose();

    phase = 'warm startup';
    browser = new Browser(binary, shellDir, profile, env, signal);
    const warm = await startup(browser);
    phase = 'tab workload and switching';
    const { samples, rpc } = await workloadTabs(browser, warm.frame, port);
    phase = 'multi-tab idle and memory';
    const shellPids = await browser.rendererPids(warm.frame);
    const kinds = await processKinds(browser, shellPids);
    await sleep(browser, settleMs);
    const before = await idleSnapshot(browser, kinds);
    const idleStart = performance.now();
    await sleep(browser, idleMs);
    const elapsedMs = performance.now() - idleStart;
    const after = await idleSnapshot(browser, kinds);
    const idle = idleDeltas(before, after, elapsedMs, ticksPerSecond);
    const processes = await memorySnapshot(browser, kinds);
    const memory = { ...sumMemory(processes), byKind: {}, perProcess: processes };
    for (const kind of new Set(processes.map((process) => process.kind))) {
      memory.byKind[kind] = sumMemory(processes.filter((process) => process.kind === kind));
    }
    for (const kind of ['browser', 'shellFrame', 'renderer', ...(new Set(kinds.values()).has('gpu') ? ['gpu'] : [])]) {
      assert.ok(memory.byKind[kind], `Could not read memory for ${kind}`);
    }

    phase = 'cosmetic ad blocking';
    const adblock = { order: [] };
    const enabledOrder = pair % 2 === 0 ? [true, false] : [false, true];
    for (const [index, enabled] of enabledOrder.entries()) {
      const key = enabled ? 'on' : 'off';
      adblock.order.push(key);
      adblock[key] = await adblockSample(browser, rpc, warm.frame, port, `cosmetic-${index}`, enabled);
    }
    assert.ok(adblock.on.rendererPids.every((pid) => !adblock.off.rendererPids.includes(pid)), 'Cosmetic conditions reused a renderer');
    phase = 'shutdown';
    await browser.close();
    return { version: cold.version, cold: cold.timings, warm: warm.timings, switches: samples, idle, memory, adblock };
  } catch (error) {
    throw new Error(`Benchmark failed during ${phase}: ${error.message}`, { cause: error });
  } finally {
    await browser?.dispose();
  }
}

async function bundle(shellDir) {
  const root = await fs.realpath(shellDir);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const files = (await fs.readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(js|css)$/.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
  const totals = { jsBytes: 0, cssBytes: 0 };
  const contents = {};
  for (const name of files) {
    const bytes = await fs.readFile(path.join(root, name));
    totals[name.endsWith('.js') ? 'jsBytes' : 'cssBytes'] += bytes.length;
    contents[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  assert.ok(totals.jsBytes > 0 && totals.cssBytes > 0, `Incomplete shell bundle: ${root}`);
  return { dir: root, manifestVersion: manifest.version, ...totals, files: contents };
}

function stats(samples) {
  assert.ok(samples.length && samples.every(Number.isFinite), 'Expected finite, non-empty metric samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return {
    n: sorted.length,
    median: (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function metricsOf(run) {
  const metrics = {};
  for (const launch of ['cold', 'warm']) {
    for (const [key, value] of Object.entries(run[launch])) metrics[`${launch}.${key}`] = [value];
  }
  for (const [kind, samples] of Object.entries({
    all: run.switches,
    sameSpace: run.switches.filter((sample) => !sample.crossSpace),
    crossSpace: run.switches.filter((sample) => sample.crossSpace),
  })) {
    for (const key of ['rpcMs', 'stateMs', 'visibleMs', 'frameMs']) {
      metrics[`switch.${kind}.${key}`] = samples.map((sample) => sample[key]);
    }
  }
  for (const [kind, memory] of Object.entries({ total: run.memory, ...run.memory.byKind })) {
    for (const key of ['rssKiB', 'pssKiB']) metrics[`memory.${kind}.${key}`] = [memory[key]];
  }
  for (const [kind, idle] of Object.entries({ total: run.idle, ...run.idle.byKind })) {
    for (const key of ['cpuMs', 'wakeups']) metrics[`idle.${kind}.${key}`] = [idle[key]];
  }
  for (const [kind, adblock] of Object.entries({
    on: run.adblock.on,
    off: run.adblock.off,
    onMinusOff: {
      styleRecalcMs: run.adblock.on.styleRecalcMs - run.adblock.off.styleRecalcMs,
      rendererPssKiB: run.adblock.on.rendererPssKiB - run.adblock.off.rendererPssKiB,
    },
  })) {
    for (const key of ['styleRecalcMs', 'rendererPssKiB']) metrics[`adblock.${kind}.${key}`] = [adblock[key]];
  }
  return metrics;
}

function summarize(metricSets) {
  const pooled = new Map();
  for (const metrics of metricSets) {
    for (const [key, samples] of Object.entries(metrics)) {
      if (!pooled.has(key)) pooled.set(key, []);
      pooled.get(key).push(...samples);
    }
  }
  return Object.fromEntries([...pooled].map(([key, samples]) => [key, stats(samples)]));
}

async function startDisplay(resources, signal) {
  resources.xvfb = childProcess('Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
  });
  const { child, stopped } = resources.xvfb;
  const reader = once(child.stdio[3], 'data', { signal }).then(([data]) => String(data).trim());
  const exited = stopped.then(({ code, signal, error }) => { throw error ?? new Error(`Xvfb exited (${signal ?? code})`); });
  const display = await Promise.race([reader, exited]);
  assert.match(display, /^\d+$/);
  return `:${display}`;
}

async function main() {
  assert.equal(process.platform, 'linux', 'Linux /proc is required for RSS, PSS and idle counters');
  assert.ok(args.chrome, 'Pass --chrome <Flecha Chromium binary> (see --help)');
  const count = Number(args.runs);
  assert.ok(/^\d+$/.test(args.runs) && Number.isSafeInteger(count) && count > 0, '--runs must be a positive integer');
  const [binary, shellA, shellB, clock, fixture] = await Promise.all([
    fs.realpath(args.chrome), bundle(args['shell-dir']),
    args['compare-shell-dir'] ? bundle(args['compare-shell-dir']) : undefined,
    exec('getconf', ['CLK_TCK']), fs.readFile(new URL('./fixtures/perf/workload.html', import.meta.url)),
  ]);
  const ticksPerSecond = Number(clock.stdout.trim());
  assert.ok(ticksPerSecond > 0, 'getconf CLK_TCK did not return a valid clock tick rate');
  const variants = shellB ? { A: shellA, B: shellB } : { A: shellA };
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    binary,
    host: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), kernel: os.release(), node: process.version, ticksPerSecond },
    workload: { spaces, tabsPerSpace, idleMs, settleMs, runsPerShell: count, display: 'private Xvfb 1280x800x24 with software graphics' },
    methodology: {
      cold: 'New Chromium profile; filesystem caches are left intact.',
      warm: 'New Chromium process with the just-closed cold profile.',
      windowTargetMs: 'First native shell CDP target observed and its Chromium window bounds returned.',
      shellReadyMs: 'Shell loaded with an active Space rendered, followed by two requestAnimationFrame callbacks.',
      switchFrameMs: 'Shell activate RPC to destination visibility and two requestAnimationFrame callbacks, a paint proxy.',
      idleWakeups: 'Sum of per-thread voluntary context switch deltas, a Linux idle wakeups proxy. Counts use threads and processes observed at both endpoints.',
      memory: 'RSS sums shared pages in each process; PSS apportions them. CDP identifies process types and a trace mark identifies the shell frame within the renderers.',
      styleRecalcMs: 'CDP RecalcStyleDuration delta after navigating from a same-site blank page to the cosmetic fixture. CSS hiding is asserted in the top document and all frames.',
      p95: 'Nearest rank, ceil(n * 0.95).',
    },
    variants,
    runs: [],
  };
  const stop = () => abort.abort(new Error('Interrupted'));
  const resources = {};
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    resources.root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-perf-bench-'));
    const display = await startDisplay(resources, AbortSignal.any([abort.signal, AbortSignal.timeout(watchdogMs)]));
    resources.server = createServer((request, response) => {
      if (request.url === '/favicon.ico') return response.writeHead(404).end();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(fixture);
    });
    resources.server.listen(0, '127.0.0.1');
    await once(resources.server, 'listening', { signal: abort.signal });
    const { port } = resources.server.address();
    for (let pair = 0; pair < count; pair++) {
      const order = shellB && pair % 2 !== 0 ? ['B', 'A'] : Object.keys(variants);
      for (const label of order) {
        abort.signal.throwIfAborted();
        const profile = await fs.mkdtemp(path.join(resources.root, 'profile-'));
        console.error(`[perf] Run ${pair + 1}/${count}, shell ${label}`);
        try {
          const result = await run({ binary, shellDir: variants[label].dir, profile, display, port, ticksPerSecond, pair });
          report.runs.push({ pair: pair + 1, variant: label, ...result });
        } finally {
          await fs.rm(profile, { recursive: true, force: true });
        }
      }
    }
    report.summary = Object.fromEntries(Object.entries(variants).map(([label, { jsBytes, cssBytes }]) => [
      label,
      {
        'bundle.jsBytes': stats([jsBytes]),
        'bundle.cssBytes': stats([cssBytes]),
        ...summarize(report.runs.filter((run) => run.variant === label).map(metricsOf)),
      },
    ]));
    if (shellB) {
      const paired = [];
      for (let pair = 0; pair < count; pair++) {
        const runs = report.runs.slice(pair * 2, pair * 2 + 2);
        const a = metricsOf(runs.find((run) => run.variant === 'A'));
        const b = metricsOf(runs.find((run) => run.variant === 'B'));
        paired.push(Object.fromEntries(Object.keys(a).filter((key) => b[key]).map((key) =>
          [key, [stats(b[key]).median - stats(a[key]).median]],
        )));
      }
      report.pairedBMinusA = {
        jsBytes: shellB.jsBytes - shellA.jsBytes,
        cssBytes: shellB.cssBytes - shellA.cssBytes,
        ...summarize(paired),
      };
    }
    abort.signal.throwIfAborted();
    const json = JSON.stringify(report, null, 2) + '\n';
    if (args.out) {
      await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
      await fs.writeFile(args.out, json);
    } else {
      process.stdout.write(json);
    }
  } finally {
    if (resources.server) {
      resources.server.closeAllConnections();
      await new Promise((resolve) => resources.server.close(resolve));
    }
    if (resources.xvfb) {
      resources.xvfb.child.kill('SIGTERM');
      await resources.xvfb.stopped;
    }
    if (resources.root) await fs.rm(resources.root, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (args.help) {
  console.log(`Usage: node chromium/tests/perf-bench.mjs --chrome <Flecha Chromium binary>
  [--shell-dir <built shell>] [--compare-shell-dir <built shell B>]
  [--runs <count per shell, default 3>] [--out <report.json>]

Runs on a private Xvfb display with a fresh profile per run. Each pair reverses
the preceding pair's shell order (A B, B A, ...). Reports JSON on stdout unless
--out is supplied. FLECHA_HARNESS_TIMEOUT_MS overrides the native test watchdog.`);
} else {
  await main();
}
