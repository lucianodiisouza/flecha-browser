// Hosted release stages keep one prepared Chromium tree at a stable absolute path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { nativeKey, downloadReusableTree, createReuseBudget, removeNativeTree, runNativeCommand, withoutGitHubTokens } from './ci-reuse.mjs';
import { verifyRelease } from './ci-publish.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const cpu = mac ? 'arm64' : 'x64';
const platform = `${mac ? 'macos' : windows ? 'windows' : 'linux'}-${cpu}`;
const python = windows ? path.join(process.env.pythonLocation || '', 'python.exe') : 'python3';
export const depotRevision = 'a20039648c0de69d8156906b18052bd47e9bf230';
// Node sets the native working directory; GNU tar receives slash-separated archive paths.
const checkpointTar = windows ? path.join(process.env.ProgramFiles, 'Git/usr/bin/tar.exe') : 'tar';

function releaseArgs(template, { platform, version, buildNumber }) {
  let args = template.replace(/^target_cpu = .*$/m, `target_cpu = "${platform === 'macos-arm64' ? 'arm64' : 'x64'}"`);
  // Nightlies must never consult the stable upstream Sparkle feed.
  args = args.replace(/^flecha_sparkle_.*$/gm, '');
  if (!platform.startsWith('macos-')) args = args.replace(/^flecha_shell_dir = .*$/m, '');
  return `${args}\nuse_siso = false\nflecha_version = "${version}"\nflecha_build_number = "${buildNumber}"\n`;
}

// Chromium's DEPS hooks fetch the native platform and V8 builtins profiles.
export async function releaseConfiguration(options) {
  const template = options.platform === 'linux-x64' ? 'linux-release.gn' : 'release.gn';
  const args = releaseArgs(await fs.readFile(path.join(root, 'chromium/build', template), 'utf8'), options);
  const checkoutPgoProfiles = /^[ \t]*chrome_pgo_phase[ \t]*=[ \t]*2[ \t]*(?:#[^\r\n]*)?$/m.test(args);
  const gclient = `solutions = [{"name": "src", "url": "https://chromium.googlesource.com/chromium/src.git", "managed": False, "custom_deps": {}, "custom_vars": {"checkout_configuration": "small", "checkout_pgo_profiles": ${checkoutPgoProfiles ? 'True' : 'False'}}}]\n`;
  return { args, gclient };
}

export function checkpointIdentity({ sha, chromium, platform, depot }) {
  return { sha, chromium, platform, depot };
}

export function checkIdentity(actual, expected) {
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) throw new Error(`Checkpoint ${key} does not match this build.`);
  }
  if (typeof actual.complete !== 'boolean') throw new Error('Checkpoint has no completion state.');
}

export async function prepareNativeTree({ work, depot, src, configuration, run, chromium, signal }) {
  signal?.throwIfAborted();
  await fs.mkdir(work);
  signal?.throwIfAborted();
  await fs.mkdir(depot);
  await run('git', ['init', depot], work);
  await run('git', ['-C', depot, 'fetch', '--depth=1', 'https://chromium.googlesource.com/chromium/tools/depot_tools.git', depotRevision], work);
  await run('git', ['-C', depot, 'checkout', '--detach', 'FETCH_HEAD'], work);
  signal?.throwIfAborted();
  await fs.writeFile(path.join(work, '.gclient'), configuration.gclient);
  await run(python, [path.join(depot, 'gclient.py'), 'sync', '--no-history', '--nohooks', '--revision', `src@${chromium}`], work);
  await run(python, [path.join(depot, 'gclient.py'), 'runhooks'], work);
  for (const patch of (await fs.readdir(path.join(root, 'chromium/patches'))).filter(p => p.endsWith('.patch')).sort()) {
    await run('git', ['apply', path.join(root, 'chromium/patches', patch)]);
  }
  signal?.throwIfAborted();
  const theme = path.join(src, 'chrome/app/theme/chromium');
  await fs.copyFile(path.join(root, 'chromium/branding/BRANDING'), path.join(theme, 'BRANDING'));
  signal?.throwIfAborted();
  await fs.cp(path.join(root, 'chromium/branding/mac'), path.join(theme, 'mac'), { recursive: true });
  for (const png of (await fs.readdir(path.join(root, 'chromium/branding/logo'))).filter(p => p.endsWith('.png'))) {
    signal?.throwIfAborted();
    await fs.copyFile(path.join(root, 'chromium/branding/logo', png), path.join(theme, png));
  }
}

export async function validateReusableTree(work, expected) {
  checkIdentity(JSON.parse(await fs.readFile(path.join(work, 'state.json'), 'utf8')), expected);
  if (!(await fs.stat(path.join(work, 'src'))).isDirectory() || !(await fs.stat(path.join(work, 'depot_tools'))).isDirectory()) {
    throw new Error('Reusable checkpoint has no source tree.');
  }
}

export async function configureReleaseTree({ root, work, identity, key, reused, args, generate }) {
  const src = path.join(work, 'src');
  const out = path.join(src, 'out/Release');
  const stateFile = path.join(work, 'state.json');
  // The restored extension can contain files removed from the current shell build.
  await fs.rm(path.join(src, 'flecha/shell'), { recursive: true, force: true });
  await fs.mkdir(path.join(src, 'flecha'), { recursive: true });
  await fs.cp(path.join(root, 'chromium/shell/dist'), path.join(src, 'flecha/shell'), { recursive: true });
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'args.gn'), args);
  await generate();
  // A compatible native tree still needs current shell packaging and provenance.
  await fs.writeFile(stateFile, JSON.stringify({ ...identity, nativeKey: key, complete: false,
    ...(reused ? { reusedFrom: reused } : {}) }));
}

export function checkpointPath(directory, name) {
  const zstd = spawnSync('zstd', ['--version'], { stdio: 'ignore', env: withoutGitHubTokens(process.env) });
  if (zstd.error && zstd.error.code !== 'ENOENT') throw zstd.error;
  return path.join(directory, `${name}.tar.${zstd.status === 0 ? 'zst' : 'gz'}`);
}

function checkpointArgs(archive, writing) {
  // -I means different things in GNU tar and macOS bsdtar.
  let compression = ['-z'];
  if (archive.endsWith('.tar.zst')) {
    let program = 'zstd';
    if (writing) program = 'zstd -T0';
    else if (mac) program = 'zstd -d';
    compression = ['--use-compress-program', program];
  }
  return [...(windows ? ['--force-local'] : []), ...(writing ? ['--format=pax'] : []),
    ...compression, writing ? '-cf' : '-xf', archive.replaceAll(path.sep, '/')];
}

export function saveCheckpoint(work, archive, complete) {
  // Windows' system tar crashes on the Chromium tree. Git ships GNU tar.
  execFileSync(checkpointTar, [...checkpointArgs(archive, true),
    ...(complete ? ['state.json'] : ['.'])], { cwd: work, env: withoutGitHubTokens(process.env), stdio: 'inherit' });
}

// Owner-selected upload reserve, separate from the one-hour reuse lookup budget.
const nativeUploadReserveMilliseconds = 60 * 60 * 1000;

export async function preserveNativeOutputs(work, archive, { stageDeadline, signal, save } = {}) {
  signal?.throwIfAborted();
  const deadline = stageDeadline === undefined ? undefined : stageDeadline - nativeUploadReserveMilliseconds;
  if (deadline !== undefined && deadline <= Date.now()) return false;
  let owned = false;
  try {
    await fs.writeFile(archive, '', { flag: 'wx' });
    owned = true;
    const saved = await (save ? save() : runNativeCommand(checkpointTar,
      [...checkpointArgs(archive, true), '.'],
      { cwd: work, env: withoutGitHubTokens(process.env), deadline, signal }));
    if (saved === false || (deadline !== undefined && Date.now() > deadline)) {
      await fs.rm(archive);
      console.warn('Native snapshot reached its compression deadline; retaining the previous checkpoint.');
      return false;
    }
    return true;
  } catch (error) {
    if (error?.code === 'REUSE_TERMINATION_FAILED') throw error;
    if (owned) await fs.rm(archive, { force: true });
    signal?.throwIfAborted();
    if (error?.code === 'ABORT_ERR' || ['SIGINT', 'SIGTERM'].includes(error?.signal)) throw error;
    console.warn('Native snapshot unavailable; retaining the previous checkpoint.');
    return false;
  }
}

function remainingStageTime() {
  const started = Number(process.env.FLECHA_STAGE_STARTED);
  if (!Number.isFinite(started) || started <= 0) throw new Error('Missing stage start time.');
  return 5 * 60 * 60 * 1000 - (Date.now() - started);
}

// Use the pinned Chromium installer's own dependency list on each fresh VM.
export async function installLinuxDependencies(cwd, { env, signal, deadline }, run = runNativeCommand) {
  const options = { cwd, env, signal, deadline };
  const script = 'build/install-build-deps.sh';
  try {
    await run('bash', [script, '--quick-check'], options);
    // quick-check covers packages; Chromium's no-prompt installer also generates these locales.
    const locales = (await run('locale', ['-a'], { ...options, capture: true })).toLowerCase().replaceAll('-', '').split(/\s+/);
    if (['da_dk', 'en_us', 'fr_fr', 'he_il', 'zh_tw'].every(name => locales.includes(name + '.utf8'))) return;
  } catch (error) {
    signal.throwIfAborted();
    if (error.exitCode !== 1) throw error;
  }
  console.log('Missing Chromium build dependencies or locales. Running the pinned installer.');
  await run('sudo', ['-n', 'bash', script, '--no-prompt'], options);
  await run('bash', [script, '--quick-check'], options);
}

async function withStageCancellation(operation) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Build cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    return await operation(controller.signal);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

export async function restoreCheckpoint(work, archive, { create = true, deadline, signal } = {}) {
  // Older artifacts contain gzip. The artifact name stays stable across codecs.
  if (archive.endsWith('.tar.gz')) {
    const zstd = archive.slice(0, -3) + '.zst';
    const files = await fs.readdir(path.dirname(archive));
    if (files.includes(path.basename(zstd))) {
      if (files.includes(path.basename(archive))) throw new Error('Ambiguous checkpoint archive format.');
      archive = zstd;
    }
  }
  if (create) await fs.mkdir(work);
  // MSYS otherwise copies link targets, which fails for dangling or later-extracted targets.
  const env = { ...withoutGitHubTokens(process.env), ...(windows ? { MSYS: 'winsymlinks:nativestrict' } : {}) };
  const args = checkpointArgs(archive, false);
  const { size } = await fs.stat(archive);
  if (deadline === undefined) execFileSync(checkpointTar, args, { cwd: work, env, stdio: 'inherit' });
  else await runNativeCommand(checkpointTar, args, { cwd: work, env, deadline, signal });
  await fs.rm(archive);
  return { size, name: path.basename(archive) };
}

export async function compile(command, args, { cwd, env, milliseconds, signal }) {
  try {
    // GitHub's runner allows 7500 ms for SIGINT. Keep that grace within the handoff reserve.
    await runNativeCommand(command, args, { cwd, env, signal, interruptGraceMs: Math.min(7500, nativeUploadReserveMilliseconds),
      deadline: milliseconds === undefined ? undefined : Date.now() + milliseconds });
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ETIMEDOUT') return false;
    if (Number.isInteger(error.exitCode)) throw new Error(`Chromium build failed: ${error.exitCode}`, { cause: error });
    throw error;
  }
}

export async function stagePortableShell(root, stage, nodeExecutable = process.execPath, signal) {
  const copy = async (from, to) => {
    signal?.throwIfAborted();
    const { mode } = await fs.stat(from);
    await pipeline(createReadStream(from), createWriteStream(to), { signal });
    await fs.chmod(to, mode);
  };
  const copyDirectory = async (from, to) => {
    signal?.throwIfAborted();
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) await copyDirectory(source, target);
      else if (entry.isFile()) await copy(source, target);
      else await fs.cp(source, target);
    }
  };
  const shell = path.join(stage, 'resources/flecha-shell');
  const host = path.join(stage, 'native-host');
  signal?.throwIfAborted();
  await fs.rm(shell, { recursive: true, force: true });
  signal?.throwIfAborted();
  await fs.rm(host, { recursive: true, force: true });
  signal?.throwIfAborted();
  await fs.mkdir(host);
  await copyDirectory(path.join(root, 'chromium/shell/dist'), shell);
  await copy(nodeExecutable, path.join(stage, windows ? 'node.exe' : 'node'));
  await copy(path.join(root, 'chromium/native-host/dist/flecha-host.cjs'), path.join(host, 'flecha-host.cjs'));
  await copy(path.join(root, 'chromium/scripts/portable-launch.mjs'), path.join(stage, 'portable-launch.mjs'));
  await copy(path.join(root, 'LICENSE'), path.join(stage, 'FLECHA-LICENSE'));
  const nodeLicense = path.join(path.dirname(nodeExecutable), windows ? 'LICENSE' : '../LICENSE');
  await copy(nodeLicense, path.join(stage, 'NODE-LICENSE'));
  signal?.throwIfAborted();
  if (windows) {
    await fs.writeFile(path.join(stage, 'Flecha.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0portable-launch.mjs" %*\r\n', { signal });
  } else {
    await fs.chmod(path.join(stage, 'node'), 0o755);
    await fs.writeFile(path.join(stage, 'flecha'), '#!/bin/sh\nhere="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$here/node" "$here/portable-launch.mjs" "$@"\n', { mode: 0o755, signal });
  }
}

export async function restorePortableRuntime(archive, stage, source, extract, signal) {
  const directory = path.dirname(archive);
  await verifyRelease(directory, [{ platform: source.platform }], source, { signal });
  const provenance = JSON.parse(await fs.readFile(path.join(directory, `${source.platform}.json`), 'utf8'));
  if (provenance.depot !== source.depot || typeof provenance.args !== 'string') {
    throw new Error('Portable runtime has no compatible build configuration.');
  }
  await fs.mkdir(stage);
  await extract(archive, stage);
  const executable = path.join(stage, source.platform === 'windows-x64' ? 'chrome.exe' : 'chrome');
  if (!(await fs.stat(executable)).isFile()) throw new Error('Portable runtime has no browser executable.');
  return provenance.args;
}

async function stagePortableRuntime(src, out, stage, dependencies) {
  await fs.mkdir(stage);
  for (const file of dependencies) {
    if (!file) continue;
    const source = path.resolve(out, file);
    const relative = path.relative(out, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Runtime dependency outside output: ${file}`);
    const target = path.join(stage, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, preserveTimestamps: true });
  }
  await fs.copyFile(path.join(src, 'LICENSE'), path.join(stage, 'CHROMIUM-LICENSE'));
}

export async function packagePortable(root, stage, dist, invoke, nodeExecutable = process.execPath, signal) {
  signal?.throwIfAborted();
  await fs.mkdir(dist);
  await stagePortableShell(root, stage, nodeExecutable, signal);
  signal?.throwIfAborted();
  if (windows) await invoke('7z', ['a', '-tzip', path.join(dist, 'Flecha-windows-x64.zip'), '.'], stage);
  else await invoke('tar', ['-czf', path.join(dist, 'Flecha-linux-x64.tar.gz'), '-C', stage, '.'], root);
}

export function extractPortable(archive, directory, invoke) {
  return windows ? invoke('7z', ['x', '-y', archive], directory) : invoke('tar', ['-xzf', archive], directory);
}

export async function repackPortableCandidate({ root, archive, stage, dist, source, signal, invoke, metadata, nodeExecutable }) {
  // The download directory is under dist's parent. Never promote across the
  // Chromium work tree mount or expose a package before its checksums exist.
  const staging = path.join(path.dirname(archive), 'repacked');
  try {
    const args = await restorePortableRuntime(archive, stage, source,
      (file, directory) => extractPortable(file, directory, invoke), signal);
    await packagePortable(root, stage, staging, invoke, nodeExecutable, signal);
    await metadata(staging, args);
    signal.throwIfAborted();
    await fs.rename(staging, dist);
  } catch (error) {
    // pipeline() wraps the signal reason in AbortError. A budget expiry can
    // fall back; a workflow cancellation must propagate unchanged.
    if (error.code === 'ABORT_ERR') signal.throwIfAborted();
    throw error;
  }
}

function packageArtifact(key) {
  if (mac) return `release-${platform}-${key}`;
  // Package layout can change while the underlying Chromium outputs remain reusable.
  const layout = createHash('sha256').update(stagePortableRuntime.toString()).update(stagePortableShell.toString())
    .update(packagePortable.toString()).digest('hex');
  return `release-${platform}-${key}-${layout}`;
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('This script writes only to disposable GitHub-hosted build trees.');
  }
  const mode = process.argv[2];
  if (!['portable', 'prepare', 'dependencies', 'restore', 'build', 'checkpoint', 'native-checkpoint'].includes(mode)) throw new Error('Unknown release stage command.');
  const work = path.resolve(process.env.RUNNER_WORKSPACE, 'flecha-chromium');
  if (mode === 'restore') {
    await restoreCheckpoint(work, path.join(root, 'checkpoint/checkpoint.tar.gz'));
    return;
  }
  const src = path.join(work, 'src');
  const depot = path.join(work, 'depot_tools');
  const out = path.join(src, 'out/Release');
  const env = { ...withoutGitHubTokens(process.env), DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
    ...(windows ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.longpaths', GIT_CONFIG_VALUE_0: 'true' } : {}),
    PATH: `${depot}${path.delimiter}${process.env.PATH}` };
  const run = (command, args, cwd = src) => execFileSync(command, args, { cwd, env, stdio: 'inherit' });
  const capture = (command, args, cwd = src) => execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim();
  const chromium = (await fs.readFile(path.join(root, 'chromium/CHROMIUM_VERSION'), 'utf8')).trim();
  const sha = capture('git', ['rev-parse', 'HEAD'], root);
  const identity = checkpointIdentity({ sha, chromium, platform, depot: depotRevision });
  const stateFile = path.join(work, 'state.json');
  const gn = path.join(src, 'buildtools', windows ? 'win/gn.exe' : mac ? 'mac/gn' : 'linux64/gn');
  const dist = path.join(root, 'release');
  const showDisk = () => {
    const disk = capture(windows ? 'fsutil' : 'df', windows ? ['volume', 'diskfree', path.parse(work).root] : ['-h', work], work);
    console.log(disk);
  };
  const output = async (key, value) => {
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };

  const writePackageMetadata = async (directory, key, args, reusedFrom, signal) => {
    const provenance = { ...identity, nativeKey: key, reusedFrom, args };
    await fs.writeFile(path.join(directory, `${platform}.json`), JSON.stringify(provenance, null, 2) + '\n', { signal });
    for (const file of await fs.readdir(directory)) {
      const hash = createHash('sha256');
      await pipeline(createReadStream(path.join(directory, file)), hash, { signal });
      await fs.appendFile(path.join(directory, `${platform}-SHA256SUMS`), `${hash.digest('hex')}  ${file}\n`, { signal });
    }
  };

  if (mode === 'dependencies') {
    const cwd = process.env.FLECHA_DEPS_ROOT || src;
    return withStageCancellation(signal => installLinuxDependencies(cwd, { env, signal, deadline: Date.now() + remainingStageTime() }));
  }

  if (mode === 'prepare' || mode === 'portable') return withStageCancellation(async signal => {
    if (mode === 'portable' && mac) throw new Error('macOS requires a native rebuild and signing.');
    const prepareRun = (command, args, cwd = src, commandDeadline) => runNativeCommand(command, args,
      { cwd, env, deadline: commandDeadline, signal });
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const configuration = await releaseConfiguration({ platform, version, buildNumber: process.env.GITHUB_RUN_NUMBER });
    const normalized = await releaseConfiguration({ platform, version, buildNumber: '0' });
    const image = { os: process.env.ImageOS, version: process.env.ImageVersion };
    const key = nativeKey(root, { ...normalized, platform, depot: depotRevision, work,
      preparation: prepareNativeTree.toString() + (platform === 'linux-x64' ? installLinuxDependencies.toString() : ''),
      image,
      // Unknown runner images must not share native outputs across runs.
      ...(!image.os || !image.version ? { uncachedRun: process.env.GITHUB_RUN_ID } : {}),
      xcode: mac ? capture('xcodebuild', ['-version'], root) : null,
      visualStudio: windows ? capture(path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe'),
        ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion'], root) : null });
    const spent = Number(process.env.FLECHA_REUSE_SPENT_MS || 0);
    if (!Number.isSafeInteger(spent) || spent < 0) throw new Error('Invalid elapsed reuse budget.');
    const started = Date.now();
    const budget = createReuseBudget({ started: started - spent, stageDeadline: started + remainingStageTime(),
      budgetMinutes: process.env.FLECHA_REUSE_BUDGET_MINUTES });
    const configure = candidate => configureReleaseTree({ root, work, identity, key, reused: candidate, args: configuration.args,
      generate: async () => {
        await prepareRun(gn, ['gen', 'out/Release', '--fail-on-unused-args'], src, candidate ? budget.deadline : undefined);
      } });
    const stage = path.join(work, 'portable');
    const portableOnly = mode === 'portable';
    const releaseName = portableOnly ? packageArtifact(key) : undefined;
    const reused = await downloadReusableTree(root, { repository: process.env.GITHUB_REPOSITORY,
      branch: process.env.FLECHA_DEFAULT_BRANCH, currentRun: process.env.GITHUB_RUN_ID, platform, key, work, releaseName, portableOnly,
      get deadline() { return budget.deadline; }, signal,
      cleanup: directory => budget.required(() => removeNativeTree(directory, { deadline: budget.stageDeadline, signal })) },
    async (archive, candidate) => {
      if (portableOnly) {
        const reuseSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, budget.deadline - Date.now()))]);
        const invoke = (command, args, cwd) => runNativeCommand(command, args, { cwd, env, signal: reuseSignal, deadline: budget.deadline });
        await repackPortableCandidate({ root, archive, dist, stage, invoke, signal: reuseSignal,
          source: { ...identity, sha: candidate.sha, nativeKey: key },
          metadata: (directory, args) => writePackageMetadata(directory, key, args, candidate, reuseSignal) });
        return;
      }
      const restored = await restoreCheckpoint(work, archive, { create: false, deadline: budget.deadline, signal });
      await validateReusableTree(work, { ...identity, sha: candidate.sha, nativeKey: key });
      await configure({ ...candidate, archive: restored.name });
      // Extraction has removed the local archive. Reject inside the restore transaction
      // so its owner releases the tree before trying another candidate or preparing from scratch.
      const disks = await Promise.all([work, root].map(directory => fs.statfs(directory)));
      if (Math.min(...disks.map(disk => disk.bsize * disk.bavail)) < restored.size) {
        throw new Error('Insufficient space to checkpoint this warm build.');
      }
    });
    if (portableOnly) {
      if (reused) await output('package', releaseName);
      else await output('spent-ms', String(budget.spentMilliseconds));
      return;
    }
    if (!reused) {
      await prepareNativeTree({ work, depot, src, configuration, run: prepareRun, chromium, signal });
      await configure();
      await output('compile', 'false');
    } else {
      await output('compile', String(remainingStageTime() > 0));
    }
    showDisk();
    return;
  });

  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  checkIdentity(state, identity);
  if (mode === 'checkpoint') {
    // Completed stages carry only a marker; browser packages have a separate artifact.
    const archive = checkpointPath(root, 'checkpoint');
    saveCheckpoint(work, archive, state.complete);
    await output('archive', path.basename(archive));
    await output('complete', String(state.complete));
    if (!state.complete && state.nativeKey) {
      await fs.writeFile(path.join(root, 'reuse.json'), JSON.stringify(state));
      await output('reuse-key', state.nativeKey);
    }
    showDisk();
    return;
  }
  if (mode === 'native-checkpoint') {
    if (!state.nativeComplete) return;
    // Later completed-marker jobs have no source tree to preserve.
    try {
      await fs.access(src);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const archive = checkpointPath(root, 'native');
    const saved = await withStageCancellation(signal => preserveNativeOutputs(work, archive,
      { stageDeadline: Date.now() + remainingStageTime(), signal }));
    if (saved) {
      // GitHub step timeouts use whole minutes; retain the existing handoff margin.
      const uploadMinutes = Math.floor(remainingStageTime() / (60 * 1000));
      if (uploadMinutes > 0) {
        await output('archive', path.basename(archive));
        await output('upload-minutes', String(uploadMinutes));
        await output('native-key', state.nativeKey);
      } else {
        await fs.rm(archive);
        console.log('No upload window remains in the stage allowance; retaining the previous checkpoint.');
      }
    }
    return;
  }
  if (state.complete) return;
  showDisk();
  // The successful portablelinux workflow uses five-hour compilation stages.
  // Include restoration/setup in that allowance, preserving its observed handoff margin.
  const remaining = remainingStageTime();
  if (remaining <= 0) {
    if (process.env.FLECHA_STAGE === '0') return;
    throw new Error('Restoration used the compilation allowance; checkpoint remains available.');
  }
  const complete = await withStageCancellation(signal => compile(python, [path.join(depot, 'ninja.py'), '-C', 'out/Release', 'chrome'],
    { cwd: src, env, milliseconds: remaining, signal }));
  if (!complete) {
    console.log('Compilation checkpoint requested; next stage will resume.');
    return;
  }

  // A later optional step can preserve native outputs even if packaging fails.
  state.nativeComplete = true;
  await fs.writeFile(stateFile, JSON.stringify(state));

  if (mac) {
    // Existing signing code seals the app ad hoc. No stable updater or notarization credentials.
    await fs.mkdir(dist);
    run('bash', [path.join(root, 'chromium/scripts/package-release.sh')], root);
    run('tar', ['-czf', path.join(dist, 'Flecha-macos-arm64.tar.gz'), '-C', path.join(out, 'flecha-release/Flecha'), 'Flecha.app'], root);
  } else {
    const stage = path.join(root, 'portable');
    const deps = capture(gn, ['desc', 'out/Release', '//chrome:chrome', 'runtime_deps']).split(/\r?\n/);
    await stagePortableRuntime(src, out, stage, deps);
    await packagePortable(root, stage, dist, run);
  }
  await writePackageMetadata(dist, state.nativeKey, await fs.readFile(path.join(out, 'args.gn'), 'utf8'), state.reusedFrom);
  await fs.writeFile(stateFile, JSON.stringify({ ...state, complete: true }));
  showDisk();
  await output('package', packageArtifact(state.nativeKey));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
