import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';

function preservesOwnedTree(error, signal) {
  return signal?.aborted || error?.code === 'REUSE_TERMINATION_FAILED' || error?.code === 'ABORT_ERR' ||
    (error?.code !== 'ETIMEDOUT' && ['SIGINT', 'SIGTERM'].includes(error?.signal));
}

function preserveCancellation(error) {
  if (preservesOwnedTree(error)) throw error;
}

const execFileAsync = promisify(execFile);

async function windowsProcessTree(pid, env) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0} {1}' -f $_.ProcessId,$_.ParentProcessId }"], { env });
  const children = new Map();
  for (const line of stdout.trim().split(/\r?\n/)) {
    const [child, parent] = line.split(' ').map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const tree = new Set([pid]);
  for (const parent of tree) for (const child of children.get(parent) ?? []) tree.add(child);
  return [...tree];
}

// taskkill can report a vanished member after terminating others. Snapshot
// descendants first: a compiler can redirect its output and outlive Ninja's pipes.
export async function stopWindowsTree(pid, env, {
  exec = execFileAsync, probe = process.kill, snapshot = windowsProcessTree, rootRunning = () => true,
} = {}) {
  const tree = await snapshot(pid, env);
  const alive = id => {
    try { probe(id, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  if (!rootRunning()) {
    if (tree.some(alive)) throw new Error('Windows build parent exited before its descendants.');
    return false;
  }
  let killed = true;
  try {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { env });
  } catch (error) {
    if (!Number.isInteger(error.code) || tree.some(alive)) throw error;
    // taskkill writes successful terminations to stdout and errors to stderr.
    // If none were stopped, preserve the compiler's own exit status.
    killed = Boolean(error.stdout?.trim());
  }
  const exiting = tree.filter(alive);
  if (exiting.length) {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Wait-Process -Id ${exiting.join(',')} -ErrorAction SilentlyContinue; exit 0`], { env });
    if (exiting.some(alive)) throw new Error('Windows build descendants are still running.');
  }
  return killed;
}

// Hosted native trees are disposable. Force-stop their process group at the owner deadline,
// then wait for inherited pipes to close before allowing cleanup or another attempt.
export async function runNativeCommand(command, args, { cwd, env, deadline, signal, capture = false, interruptGraceMs, stdoutFile } = {}) {
  signal?.throwIfAborted();
  const timeoutError = () => Object.assign(new Error('Native reuse reached its deadline.'), { code: 'ETIMEDOUT' });
  if (deadline !== undefined && deadline <= Date.now()) throw timeoutError();
  const windows = process.platform === 'win32';
  // Pipes and a new session keep sudo away from terminal/PTY process groups.
  const output = stdoutFile === undefined ? 'pipe' : openSync(stdoutFile, 'wx');
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: !windows, stdio: ['ignore', output, 'pipe'] });
  } finally {
    if (typeof output === 'number') closeSync(output);
  }
  let stdout = '';
  if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  else child.stdout?.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  let expired = false;
  let stopping;
  let finishGrace;
  let terminationFailure;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const killTree = async () => {
    if (!child.pid) return false;
    const killEnv = withoutGitHubTokens(env || process.env);
    if (windows) {
      return stopWindowsTree(child.pid, killEnv, { rootRunning: () => child.exitCode === null && child.signalCode === null });
    } else if (command === 'sudo') {
      try {
        await execFileAsync('sudo', ['-n', 'kill', '-KILL', '--', String(-child.pid)], { env: killEnv });
      } catch (error) {
        try { process.kill(-child.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') return; }
        throw error;
      }
    } else {
      const signalGroup = name => {
        try { process.kill(-child.pid, name); return true; } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      };
      if (expired && interruptGraceMs !== undefined && !signal?.aborted) {
        if (!signalGroup('SIGINT')) return false;
        let grace;
        try {
          await Promise.race([completion, new Promise(resolve => {
            finishGrace = resolve;
            grace = setTimeout(resolve, interruptGraceMs);
          })]);
        } finally {
          clearTimeout(grace);
          finishGrace = undefined;
        }
        // Ninja can exit before a compiler that still owns its outputs or pipes.
        signalGroup('SIGKILL');
        return true;
      }
      return signalGroup('SIGKILL');
    }
    return true;
  };
  const stop = () => {
    if (signal?.aborted) finishGrace?.();
    stopping ??= killTree().catch(cause => {
      // No fallback may modify the tree if stopping its previous owner failed.
      child.unref();
      child.stdout?.destroy();
      child.stderr.destroy();
      terminationFailure = Object.assign(new Error('Cannot stop native preparation processes.', { cause }), { code: 'REUSE_TERMINATION_FAILED' });
      rejectCompletion(terminationFailure);
    });
  };
  signal?.addEventListener('abort', stop, { once: true });
  const timer = deadline === undefined ? undefined : setTimeout(() => { expired = true; stop(); }, deadline - Date.now());
  try {
    const result = await completion;
    const stopped = await stopping;
    if (terminationFailure) throw terminationFailure;
    signal?.throwIfAborted();
    if (expired && stopped) throw timeoutError();
    if (result.code !== 0) {
      throw Object.assign(new Error(`Native command failed: ${result.code ?? result.signal}`),
        { exitCode: result.code, signal: result.signal, stdout });
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

export function withoutGitHubTokens(environment) {
  const result = { ...environment };
  delete result.GH_TOKEN;
  delete result.GITHUB_TOKEN;
  return result;
}

export function createReuseBudget({ started, stageDeadline, budgetMinutes }) {
  const milliseconds = Number(budgetMinutes) * 60 * 1000;
  if (!/^\d+$/.test(String(budgetMinutes)) || !Number.isSafeInteger(milliseconds)) {
    throw new Error('Expected a cache-reuse budget in whole minutes.');
  }
  let optionalDeadline = started + milliseconds;
  return {
    stageDeadline,
    get deadline() { return Math.min(optionalDeadline, stageDeadline); },
    get spentMilliseconds() { return Math.max(0, Date.now() - (optionalDeadline - milliseconds)); },
    async required(operation) {
      const started = Date.now();
      try { return await operation(); }
      finally { optionalDeadline += Math.max(0, Date.now() - started); }
    },
  };
}

export async function removeNativeTree(directory, { deadline, signal } = {}) {
  await runNativeCommand(process.execPath, ['--input-type=commonjs', '-e',
    'require("node:fs/promises").rm(process.argv[1], { recursive: true, force: true }).catch(error => { console.error(error); process.exitCode = 1; })',
    directory], { cwd: path.dirname(directory), env: withoutGitHubTokens(process.env), deadline, signal });
}

// Packaging and shell inputs are refreshed after restoration. Native inputs must match.
// The configuration includes the effective GN args and .gclient profile checkout setting.
export function nativeKey(root, configuration) {
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--',
    'chromium/CHROMIUM_VERSION', 'chromium/patches', 'chromium/branding',
    'chromium/build', 'chromium/scripts/ci-windows-sdk.ps1'], { cwd: root, env: withoutGitHubTokens(process.env) });
  return createHash('sha256').update(tree).update(JSON.stringify(configuration)).digest('hex');
}

function* indexedCheckpoints(artifacts, platform, key) {
  const available = new Map(artifacts.filter(artifact => !artifact.expired).map(artifact => [artifact.name, artifact.id]));
  const prefix = `reuse-${platform}-${key}-`;
  const stages = [...available.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length))
    .filter(stage => /^(0|[1-9]\d*)$/.test(stage)).sort((a, b) => Number(b) - Number(a));
  for (const stage of stages) {
    const name = `checkpoint-${platform}-${stage}`;
    if (available.has(name)) yield { id: available.get(name), name, archive: 'checkpoint.tar.gz' };
  }
}

export function trustedRun(run, { repository, branch, currentRun }) {
  return String(run.id) !== currentRun && run.head_repository?.full_name === repository &&
    run.path === '.github/workflows/nightly-release.yml' && run.head_branch === branch &&
    ['schedule', 'workflow_dispatch'].includes(run.event);
}

async function* listArtifacts(endpoint, options, api, name) {
  let visited = 0;
  for (let page = 1; ; page++) {
    options.signal?.throwIfAborted();
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw new Error('Native reuse reached the stage deadline.');
    // GitHub documents 100 as the maximum artifacts page size.
    const filter = name === undefined ? '' : `name=${encodeURIComponent(name)}&`;
    const response = await api(`${endpoint}?${filter}per_page=100&page=${page}`);
    visited += response.artifacts.length;
    yield* response.artifacts;
    if (visited >= response.total_count || !response.artifacts.length) return;
  }
}

// Search only this repository's default-branch nightly workflow, including failed runs.
export async function* findReusableArtifacts(options, api) {
  const { repository, branch, currentRun, platform, key, releaseName } = options;
  const actions = `repos/${repository}/actions`;
  const runArtifacts = async (id, name) => {
    try {
      return await Array.fromAsync(listArtifacts(`${actions}/runs/${id}/artifacts`, options, api, name));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  };
  const runs = new Map();
  const source = async artifact => {
    const id = String(artifact.workflow_run?.id);
    if (artifact.expired || !artifact.workflow_run || id === currentRun) return;
    if (!runs.has(id)) {
      let run;
      try { run = await api(`${actions}/runs/${id}`); }
      catch (error) { if (error.status !== 404) throw error; }
      runs.set(id, run && String(run.id) === id && trustedRun(run, { repository, branch, currentRun }) ? run : null);
    }
    return runs.get(id);
  };
  if (options.portableOnly) {
    const packages = releaseName + '-packages';
    const reruns = releaseName + '-reruns';
    const prefix = releaseName + '-attempt-';
    const packageAttempt = name => {
      if (!name.startsWith(prefix)) return 0;
      const match = /^([1-9]\d*)-job-[1-9]\d*$/.exec(name.slice(prefix.length));
      return match ? Number(match[1]) : 0;
    };
    const scanned = new Set();
    const candidateFor = run => ({ run: String(run.id), sha: run.head_sha,
      archive: `Flecha-${platform}.${platform.startsWith('windows-') ? 'zip' : 'tar.gz'}` });
    const jobPackages = async function* (run) {
      const candidate = candidateFor(run);
      if (scanned.has(candidate.run)) return;
      scanned.add(candidate.run);
      const artifacts = await runArtifacts(candidate.run);
      if (!artifacts) return;
      const uploads = artifacts.filter(upload => !upload.expired)
        .map(upload => ({ upload, attempt: packageAttempt(upload.name) }))
        .filter(({ attempt }) => attempt > 0 && attempt <= run.run_attempt)
        .sort((a, b) => b.attempt - a.attempt);
      for (const { upload } of uploads) yield { ...candidate, id: upload.id, name: upload.name };
    };

    // Try the exact index and legacy names before scanning for unindexed packages.
    for (const name of [packages, releaseName + '-attempt-1', reruns, releaseName]) {
      for await (const artifact of listArtifacts(`${actions}/artifacts`, options, api, name)) {
        if (artifact.name !== name) continue;
        const run = await source(artifact);
        if (!run) continue;
        if (name === packages) {
          yield* jobPackages(run);
          continue;
        }
        const candidate = candidateFor(run);
        if (name !== reruns) {
          yield { ...candidate, id: artifact.id, name };
          continue;
        }
        for (let attempt = run.run_attempt; attempt > 1; attempt--) {
          const scoped = `${releaseName}-attempt-${attempt}`;
          const uploads = await runArtifacts(candidate.run, scoped);
          if (!uploads) break;
          for (const upload of uploads) {
            if (upload.name === scoped && !upload.expired) yield { ...candidate, id: upload.id, name: scoped };
          }
        }
      }
    }
    for await (const artifact of listArtifacts(`${actions}/artifacts`, options, api)) {
      if (!packageAttempt(artifact.name) || scanned.has(String(artifact.workflow_run?.id))) continue;
      const run = await source(artifact);
      if (run) yield* jobPackages(run);
    }
    return;
  }
  const nativeName = `native-${platform}-${key}`;
  for await (const artifact of listArtifacts(`${actions}/artifacts`, options, api, nativeName)) {
    if (artifact.name !== nativeName) continue;
    const run = await source(artifact);
    if (run) yield { id: artifact.id, name: nativeName, archive: 'native.tar.gz', run: String(run.id), sha: run.head_sha };
  }

  // A checkpoint index includes an unknown stage suffix. Only this prefix search
  // needs unfiltered pages. Rank the run's indexes with their still-live checkpoints.
  const indexed = new Set();
  const prefix = `reuse-${platform}-${key}-`;
  for await (const artifact of listArtifacts(`${actions}/artifacts`, options, api)) {
    if (!artifact.name.startsWith(prefix) || indexed.has(artifact.workflow_run?.id)) continue;
    const run = await source(artifact);
    if (!run) continue;
    indexed.add(artifact.workflow_run.id);
    const artifacts = await runArtifacts(run.id);
    if (!artifacts) continue;
    for (const candidate of indexedCheckpoints(artifacts, platform, key)) {
      yield { ...candidate, run: String(run.id), sha: run.head_sha };
    }
  }
}

async function downloadArtifact(candidate, directory, options) {
  // gh run download --name enumerates the whole run again. Use the immutable
  // ID we already selected, streaming the ZIP directly to disk.
  if (!/^[1-9]\d*$/.test(String(candidate.id))) throw new Error('Missing reuse artifact ID.');
  const zip = path.join(directory, 'download.zip');
  const command = { cwd: directory, deadline: options.deadline, signal: options.signal };
  await runNativeCommand('gh', ['api', `repos/${options.repository}/actions/artifacts/${candidate.id}/zip`],
    { ...command, stdoutFile: zip });
  const env = withoutGitHubTokens(process.env);
  // Windows and macOS ship bsdtar. Ubuntu ships Info-ZIP. Write only the
  // expected regular files, never ZIP-supplied paths, modes or symlinks.
  const linux = process.platform === 'linux';
  let tool = 'tar';
  if (linux) tool = 'unzip';
  else if (process.platform === 'win32') tool = path.join(process.env.SystemRoot, 'System32/tar.exe');
  const names = (await runNativeCommand(tool, linux ? ['-Z1', zip] : ['-tf', zip],
    { ...command, env, capture: true })).trimEnd().split(/\r?\n/);
  let expected;
  if (options.portableOnly) expected = [candidate.archive, options.platform + '.json', options.platform + '-SHA256SUMS'];
  else if (names.includes(candidate.archive)) expected = [candidate.archive];
  else expected = [candidate.archive.replace(/\.gz$/, '.zst')];
  if (names.length !== expected.length || !expected.every(name => names.includes(name))) throw new Error('Unexpected reuse artifact contents.');
  for (const name of expected) {
    await runNativeCommand(tool, linux ? ['-p', zip, name] : ['-xOf', zip, name],
      { ...command, env, stdoutFile: path.join(directory, name) });
  }
  await fs.rm(zip);
}

export async function downloadReusableTree(root, options, restore,
  gh = args => runNativeCommand('gh', args, { cwd: root, deadline: options.deadline, signal: options.signal, capture: true }),
  download = downloadArtifact) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository || '') || !options.branch || !/^\d+$/.test(options.currentRun || '')) {
    throw new Error('Missing GitHub context for native checkpoint reuse.');
  }
  const candidates = findReusableArtifacts(options, async endpoint => {
    if (!endpoint.includes('/actions/runs/')) return JSON.parse(await gh(['api', endpoint]));
    try {
      const response = await gh(['api', endpoint, '--include']);
      // The CLI prints the status and headers before the JSON payload.
      return JSON.parse(response.replace(/^HTTP\/.*?\r?\n\r?\n/s, ''));
    } catch (error) {
      if (/^HTTP\/\S+ 404\b/.test(error?.stdout || '')) {
        throw Object.assign(new Error('The nightly run disappeared during discovery.', { cause: error }), { status: 404 });
      }
      throw error;
    }
  });
  const cleanup = directory => options.cleanup ? options.cleanup(directory) : removeNativeTree(directory,
    { deadline: options.cleanupDeadline, signal: options.signal });
  for (;;) {
    options.signal?.throwIfAborted();
    if (options.deadline !== undefined && Date.now() >= options.deadline) return undefined;
    let candidate;
    try {
      candidate = (await candidates.next()).value;
    } catch (error) {
      options.signal?.throwIfAborted();
      preserveCancellation(error);
      console.warn('Native checkpoint lookup unavailable; preparing a clean tree.');
      return undefined;
    }
    if (!candidate) return undefined;
    const directory = await fs.mkdtemp(path.join(root, 'native-download-'));
    let preserveDirectory = false;
    try {
      try {
        await download(candidate, directory, options);
      } catch (error) {
        preserveDirectory = preservesOwnedTree(error, options.signal);
        options.signal?.throwIfAborted();
        preserveCancellation(error);
        console.warn('Native checkpoint download unavailable; checking other compatible trees.');
        continue;
      }
      // Refuse pre-existing trees. Only this successfully created directory may be removed.
      await fs.mkdir(options.work);
      try {
        await restore(path.join(directory, candidate.archive), candidate);
      } catch (error) {
        preserveDirectory = preservesOwnedTree(error, options.signal);
        options.signal?.throwIfAborted();
        preserveCancellation(error);
        try { await cleanup(options.work); }
        catch (error) { preserveDirectory = true; throw error; }
        console.warn('Native checkpoint restoration failed; checking other compatible trees.');
        continue;
      }
    } finally {
      if (!preserveDirectory && !options.signal?.aborted) await cleanup(directory);
    }
    console.log(`Restored native inputs from run ${candidate.run}, source ${candidate.sha}.`);
    return candidate;
  }
}
