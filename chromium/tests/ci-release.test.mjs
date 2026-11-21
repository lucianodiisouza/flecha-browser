import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { checkpointPath, checkIdentity, compile, installLinuxDependencies, configureReleaseTree, depotRevision, extractPortable, packagePortable, prepareNativeTree, preserveNativeOutputs, releaseConfiguration, repackPortableCandidate, saveCheckpoint, restoreCheckpoint, restorePortableRuntime, validateReusableTree } from '../scripts/ci-release.mjs';
import { createReuseBudget, downloadReusableTree, findReusableArtifacts, nativeKey, removeNativeTree, runNativeCommand, stopWindowsTree, withoutGitHubTokens } from '../scripts/ci-reuse.mjs';
import { publicationSource, publishAssets, reconcileAssets, verifyRelease } from '../scripts/ci-publish.mjs';

// Fixture transfers put their already-extracted files in the download directory.
function restoreFixture(root, options, restore, gh) {
  return downloadReusableTree(root, options, restore, gh,
    (candidate, directory) => gh(['download', candidate.run, '--name', candidate.name, '--dir', directory]));
}

test('the owner-selected reuse budget leaves clean preparation time and never exceeds the stage deadline', () => {
  const started = Date.now();
  const stageDeadline = started + 5 * 60 * 60 * 1000;
  const deadline = createReuseBudget({ started, stageDeadline, budgetMinutes: '60' }).deadline;
  assert.equal(deadline, started + 60 * 60 * 1000);
  assert.equal(createReuseBudget({ started: deadline, stageDeadline, budgetMinutes: '0' }).deadline, deadline);
  assert.equal(createReuseBudget({ started: stageDeadline, stageDeadline, budgetMinutes: '60' }).deadline, stageDeadline);
  for (const budgetMinutes of [undefined, '', 'invalid', '-1', Infinity]) {
    assert.throws(() => createReuseBudget({ started, stageDeadline, budgetMinutes }), /whole minutes/);
  }
});

test('required preparation time preserves optional reuse time across candidate pages and stays within the stage', async t => {
  const hour = 60 * 60 * 1000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const stageDeadline = now + 5 * hour;
  const budget = createReuseBudget({ started: now, stageDeadline, budgetMinutes: '60' });
  const options = { repository: 'owner/repo', branch: 'main', currentRun: '2', platform: 'linux-x64', key: 'key',
    get deadline() { return budget.deadline; } };
  const candidates = findReusableArtifacts(options, endpoint => {
    if (endpoint.includes('/runs/1/artifacts?')) return {
      artifacts: ['native-linux-x64-key', 'reuse-linux-x64-key-1', 'checkpoint-linux-x64-1'].map(name => ({ name })), total_count: 3 };
    if (endpoint.endsWith('page=1')) return { artifacts: [{ name: endpoint.includes('name=') ? 'native-linux-x64-key' : 'reuse-linux-x64-key-1', workflow_run: { id: 1 } }], total_count: 1 };
    return { id: 1, head_sha: 'source', head_repository: { full_name: 'owner/repo' },
      path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'workflow_dispatch' };
  });
  assert.equal((await candidates.next()).value.name, 'native-linux-x64-key');
  await budget.required(async () => { now += hour; });
  assert.equal(budget.deadline - now, hour);
  assert.equal((await candidates.next()).value.name, 'checkpoint-linux-x64-1');
  await budget.required(async () => { now += 5 * hour; });
  assert.equal(budget.deadline, stageDeadline);
});

test('reuse stops signal-resistant descendants before deadline fallback or cancellation returns', async t => {
  assert.equal(await runNativeCommand(process.execPath, ['-e', 'process.stdout.write("captured output")'], { capture: true }), 'captured output');
  const outcomes = ['deadline', 'cancellation'];
  if (process.platform !== 'win32') outcomes.push('compile deadline', 'abort during compile interrupt grace');
  for (const outcome of outcomes) {
    await t.test(outcome, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-reuse-process-'));
      const controller = new AbortController();
      t.after(() => controller.abort(new Error('Fixture cleanup')));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const readyFile = path.join(root, 'ready');
      const ready = (async () => {
        for await (const event of fs.watch(root, { signal: controller.signal })) {
          if (event.filename === 'ready') return;
        }
      })();
      const descendant = `
        process.on('SIGTERM', () => {});
        process.on('SIGINT', () => { require('node:fs').writeFileSync(process.argv[1], 'interrupted'); });
        process.on('message', () => {});
        process.send('ready');
      `;
      const fixture = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        process.on('SIGINT', () => {});
        const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1] + '.sigint'], { stdio: ['ignore', 1, 2, 'ipc'] });
        descendant.on('message', () => {
          fs.writeFileSync(process.argv[1] + '.tmp', String(descendant.pid));
          fs.renameSync(process.argv[1] + '.tmp', process.argv[1]);
        });
      `;
      // The inherited stdout pipe stays open until the descendant is stopped too.
      const privileged = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true';
      let settled = false;
      const hour = 60 * 60 * 1000;
      const compiling = outcome.startsWith('compile') || outcome === 'abort during compile interrupt grace';
      const command = compiling ? compile(process.execPath, ['-e', fixture, readyFile],
        { signal: controller.signal, milliseconds: hour }) : runNativeCommand(privileged ? 'sudo' : process.execPath,
        [...(privileged ? ['-n', process.execPath] : []), '-e', fixture, readyFile], {
        capture: true, signal: controller.signal, deadline: outcome === 'deadline' ? Date.now() + 60 * 60 * 1000 : undefined,
      });
      const result = command.catch(error => error).finally(() => { settled = true; });
      await Promise.race([ready, result.then(error => { throw error; })]);
      const reason = new Error('User cancelled reuse');
      if (compiling) {
        const interrupted = (async () => {
          for await (const event of fs.watch(root, { signal: controller.signal })) {
            if (event.filename === 'ready.sigint') return;
          }
        })();
        t.mock.timers.tick(hour);
        await interrupted;
        assert.equal(settled, false, 'the descendant holds stdout open during the grace period');
        if (outcome === 'abort during compile interrupt grace') {
          const send = process.kill;
          const kill = t.mock.method(process, 'kill', (pid, signal) => send(pid, signal));
          controller.abort(reason);
          await setImmediate();
          const escalated = kill.mock.calls.some(({ arguments: [pid, signal] }) => pid < 0 && signal === 'SIGKILL');
          // Drain the timers and process even if a regression made escalation wait.
          t.mock.timers.tick(7500);
          assert.equal(await result, reason);
          assert.ok(escalated, 'abort must kill the process group before the grace clock advances');
          return;
        }
        t.mock.timers.tick(7500); // GitHub runner's SIGINT grace.
        assert.equal(await result, false, 'compilation released its pipes and requested a checkpoint');
        return;
      } else if (outcome === 'deadline') t.mock.timers.tick(hour);
      else {
        t.mock.timers.tick(60 * 60 * 1000);
        assert.equal(settled, false, 'Required preparation has no optional reuse timer');
        controller.abort(reason);
      }
      const error = await result;
      if (outcome === 'deadline') assert.equal(error.code, 'ETIMEDOUT');
      else assert.equal(error, reason);
    });
  }
});

test('build subprocesses cannot inherit GitHub tokens while the gh environment remains intact', () => {
  const original = { ...process.env, GH_TOKEN: 'fixture-gh-token', GITHUB_TOKEN: 'fixture-github-token' };
  const sanitized = withoutGitHubTokens(original);
  execFileSync(process.execPath, ['-e', 'if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) process.exit(1)'], { env: sanitized });
  assert.equal(Object.hasOwn(sanitized, 'GH_TOKEN'), false);
  assert.equal(Object.hasOwn(sanitized, 'GITHUB_TOKEN'), false);
  assert.equal(original.GH_TOKEN, 'fixture-gh-token');
  assert.equal(original.GITHUB_TOKEN, 'fixture-github-token');
});

test('clean preparation awaits each command and starts no further work after cancellation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-clean-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = new Error('User cancelled clean preparation');
  const work = path.join(root, 'work');
  const calls = [];
  let started;
  let rejectCommand;
  const commandStarted = new Promise(resolve => { started = resolve; });
  const command = new Promise((resolve, reject) => { rejectCommand = reject; });
  t.after(() => rejectCommand(reason));
  const options = { work, depot: path.join(work, 'depot_tools'), src: path.join(work, 'src'),
    configuration: { gclient: 'fixture' }, chromium: 'fixture', signal: controller.signal,
    run: (...args) => { calls.push(args); started(); return command; } };
  const preparation = prepareNativeTree(options).then(() => assert.fail('Preparation must reject cancellation'), error => error);
  await commandStarted;
  assert.equal(calls.length, 1, 'Do not fetch while initialization is still running');
  controller.abort(reason);
  rejectCommand(reason);
  assert.equal(await preparation, reason);
  assert.equal(calls.length, 1);
  await assert.rejects(fs.stat(path.join(work, '.gclient')), { code: 'ENOENT' });
  const untouched = path.join(root, 'cancelled-before-start');
  await assert.rejects(prepareNativeTree({ ...options, work: untouched }), error => error === reason);
  await assert.rejects(fs.stat(untouched), { code: 'ENOENT' });
});

test('native reuse ignores shell-only commits and invalidates native inputs and toolchains', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-native-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'chromium/patches'), { recursive: true });
  await fs.mkdir(path.join(root, 'chromium/shell'));
  await fs.writeFile(path.join(root, 'chromium/patches/native.patch'), 'native input');
  await fs.writeFile(path.join(root, 'chromium/shell/app.ts'), 'old shell');
  await fs.mkdir(path.join(root, 'chromium/build'));
  const recipe = path.join(root, 'chromium/build/linux-release.gn');
  await fs.copyFile(new URL('../build/linux-release.gn', import.meta.url), recipe);
  execFileSync('git', ['init', '--quiet', root]);
  const commit = () => {
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid',
      'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  };
  commit();
  const release = await releaseConfiguration({ platform: 'linux-x64', version: '0.1.0', buildNumber: '0' });
  const configuration = { ...release, platform: 'linux-x64', depot: 'toolchain', work: '/stable/work',
    image: { os: 'ubuntu24', version: 'runner-image-version' } };
  const original = nativeKey(root, configuration);
  await fs.writeFile(path.join(root, 'chromium/shell/app.ts'), 'new shell');
  commit();
  assert.equal(nativeKey(root, configuration), original);
  const changedInputs = { ...configuration, platform: 'windows-x64', depot: 'other-toolchain', work: '/other/work',
    args: release.args.replace('chrome_pgo_phase = 2', 'chrome_pgo_phase = 0'),
    gclient: release.gclient.replace('"checkout_pgo_profiles": True', '"checkout_pgo_profiles": False'),
    image: { ...configuration.image, version: 'updated-image' } };
  for (const [field, value] of Object.entries(changedInputs)) {
    assert.notEqual(nativeKey(root, { ...configuration, [field]: value }), original, field);
  }
  await fs.appendFile(recipe, '\n# updated release recipe\n');
  commit();
  const updatedRecipe = nativeKey(root, configuration);
  assert.notEqual(updatedRecipe, original);
  await fs.writeFile(path.join(root, 'chromium/patches/native.patch'), 'changed native input');
  commit();
  assert.notEqual(nativeKey(root, configuration), updatedRecipe);
});

test('optional reuse rejects unavailable or invalid trees and preserves unowned trees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-optional-reuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const options = { repository: 'owner/repo', branch: 'main', currentRun: '2', platform: 'linux-x64', key: 'key', work };
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.mkdir(path.join(source, 'src'));
  await fs.mkdir(path.join(source, 'depot_tools'));
  const expected = { sha: 'source', chromium: '158', platform: 'linux-x64', depot: 'tools', nativeKey: 'key' };
  const state = JSON.stringify({ ...expected, complete: false });
  await fs.writeFile(path.join(source, 'state.json'), state);
  const archive = path.join(root, 'native.tar.gz');
  saveCheckpoint(source, archive, false);
  const gh = (failure) => args => {
    if (failure === 'api') throw new Error('API unavailable');
    if (failure === 'timeout') throw Object.assign(new Error('API timed out'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
    if (args[0] === 'api') return JSON.stringify(args[1].includes('/artifacts?') ? {
      artifacts: [{ name: 'native-linux-x64-key', workflow_run: { id: 1 } }], total_count: 1,
    } : { id: 1, head_sha: 'source', head_repository: { full_name: 'owner/repo' },
      path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'workflow_dispatch' });
    if (failure === 'download') throw new Error('Artifact disappeared');
    return fs.copyFile(archive, path.join(args.at(-1), 'native.tar.gz'));
  };
  for (const failure of ['api', 'timeout', 'download', 'restore', 'malformed-state', 'missing-state', 'identity', 'missing-source', 'missing-depot']) {
    const reused = await restoreFixture(root, options, async archive => {
      if (failure === 'restore') {
        await fs.writeFile(path.join(work, 'partial'), 'partial extraction');
        throw new Error('Invalid archive');
      }
      await restoreCheckpoint(work, archive, { create: false });
      if (failure === 'malformed-state') await fs.writeFile(path.join(work, 'state.json'), '{');
      if (failure === 'missing-state') await fs.rm(path.join(work, 'state.json'));
      if (failure === 'identity') await fs.writeFile(path.join(work, 'state.json'), JSON.stringify({ ...expected, nativeKey: 'wrong', complete: false }));
      if (failure === 'missing-source') await fs.rmdir(path.join(work, 'src'));
      if (failure === 'missing-depot') await fs.rmdir(path.join(work, 'depot_tools'));
      await validateReusableTree(work, expected);
    }, gh(failure));
    assert.equal(reused, undefined);
    await assert.rejects(fs.stat(work), { code: 'ENOENT' });
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('native-download-')), false);
  }
  const cancelled = Object.assign(new Error('cancelled'), { signal: 'SIGINT' });
  await assert.rejects(restoreFixture(root, options, () => {}, () => { throw cancelled; }), error => error === cancelled);
  await assert.rejects(restoreFixture(root, options, () => { throw cancelled; }, gh()), error => error === cancelled);
  assert.equal((await fs.stat(work)).isDirectory(), true);
  await fs.rm(work, { recursive: true });
  for (const name of (await fs.readdir(root)).filter(name => name.startsWith('native-download-'))) {
    await fs.rm(path.join(root, name), { recursive: true });
  }
  const unsafe = Object.assign(new Error('Cannot stop previous attempt'), { code: 'REUSE_TERMINATION_FAILED' });
  await assert.rejects(restoreFixture(root, options, async () => {
    await fs.writeFile(path.join(work, 'partial'), 'Previous process may still own this tree');
    throw unsafe;
  }, gh()), error => error === unsafe);
  assert.equal(await fs.readFile(path.join(work, 'partial'), 'utf8'), 'Previous process may still own this tree');
  const preserved = (await fs.readdir(root)).filter(name => name.startsWith('native-download-'));
  assert.equal(preserved.length, 1);
  await fs.rm(work, { recursive: true });
  await fs.rm(path.join(root, preserved[0]), { recursive: true });
  const candidate = await restoreFixture(root, options, async archive => {
    await restoreCheckpoint(work, archive, { create: false });
    await validateReusableTree(work, expected);
  }, gh());
  assert.equal(candidate.run, '1');
  assert.equal(await fs.readFile(path.join(work, 'state.json'), 'utf8'), state);
  await assert.rejects(restoreFixture(root, options, () => assert.fail('Must not restore into a pre-existing tree'), gh()), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(work, 'state.json'), 'utf8'), state);
});

test('restored GN failure falls back to a compatible indexed checkpoint before clean preparation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-alternate-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'src/out/Release'), { recursive: true });
  await fs.mkdir(path.join(source, 'depot_tools'));
  const identity = { sha: 'source', chromium: '158', platform: 'linux-x64', depot: 'tools' };
  await fs.writeFile(path.join(source, 'state.json'), JSON.stringify({ ...identity, nativeKey: 'key', complete: false }));
  await fs.writeFile(path.join(source, 'src/out/Release/compiled'), 'usable previous compilation');
  await fs.mkdir(path.join(root, 'chromium/shell/dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'chromium/shell/dist/current.js'), 'current shell');
  const archive = path.join(root, 'checkpoint.tar.gz');
  saveCheckpoint(source, archive, false);
  const options = { repository: 'owner/repo', branch: 'main', currentRun: '2', platform: 'linux-x64', key: 'key', work };
  assert.equal(await restoreFixture(root, { ...options, deadline: 0 }, () => assert.fail('No expired restoration'),
    () => assert.fail('No API call after deadline')), undefined);
  const requests = [];
  const gh = args => {
    if (args[0] === 'api') requests.push(args[1]);
    if (args[0] === 'api') return JSON.stringify(args[1].includes('/artifacts?') ? {
      artifacts: ['native-linux-x64-key', 'reuse-linux-x64-key-1', 'checkpoint-linux-x64-1']
        .map(name => ({ name, workflow_run: { id: 1 } })), total_count: 3,
    } : { id: 1, head_sha: 'source', head_repository: { full_name: 'owner/repo' },
      path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'workflow_dispatch' });
    const name = args[args.indexOf('--name') + 1];
    return fs.copyFile(archive, path.join(args.at(-1), name.startsWith('native-') ? 'native.tar.gz' : 'checkpoint.tar.gz'));
  };
  const attempts = [];
  const candidate = await restoreFixture(root, options, async (archive, candidate) => {
    attempts.push(candidate.name);
    await restoreCheckpoint(work, archive, { create: false });
    await validateReusableTree(work, { ...identity, nativeKey: 'key' });
    await configureReleaseTree({ root, work, identity: { ...identity, sha: 'current' }, key: 'key', reused: candidate, args: 'current flags',
      generate: () => { if (candidate.name.startsWith('native-')) throw new Error('Missing GN binary'); } });
  }, gh);
  assert.deepEqual(attempts, ['native-linux-x64-key', 'checkpoint-linux-x64-1']);
  assert.equal(candidate.name, 'checkpoint-linux-x64-1');
  assert.equal(await fs.readFile(path.join(work, 'src/out/Release/compiled'), 'utf8'), 'usable previous compilation');
  assert.equal(JSON.parse(await fs.readFile(path.join(work, 'state.json'), 'utf8')).sha, 'current');
  assert.equal(await fs.readFile(path.join(work, 'src/flecha/shell/current.js'), 'utf8'), 'current shell');
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('native-download-')), false);
  assert.equal(requests.length, new Set(requests).size, 'Each artifact page and run metadata is fetched once across retries');
});

test('failed-tree cleanup stops on cancellation or stage expiry before another attempt can start', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-reuse-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  for (const outcome of ['deadline', 'cancellation']) {
    const controller = new AbortController();
    const reason = new Error('Cancel cleanup');
    const options = { repository: 'owner/repo', branch: 'main', currentRun: '2', platform: 'linux-x64', key: 'key', work,
      signal: controller.signal, cleanup: directory => {
        assert.equal(directory, work);
        if (outcome === 'cancellation') controller.abort(reason);
        return removeNativeTree(directory, { signal: controller.signal, deadline: outcome === 'deadline' ? 0 : undefined });
      } };
    const gh = args => args[0] !== 'api' ? undefined : JSON.stringify(args[1].includes('/artifacts?') ? {
      artifacts: [{ name: 'native-linux-x64-key', workflow_run: { id: 1 } }], total_count: 1,
    } : { id: 1, head_sha: 'source', head_repository: { full_name: 'owner/repo' },
      path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'workflow_dispatch' });
    await assert.rejects(restoreFixture(root, options, async () => {
      await fs.writeFile(path.join(work, 'partial'), 'owned extraction');
      throw new Error('Extraction failed');
    }, gh), error => outcome === 'deadline' ? error.code === 'ETIMEDOUT' : error === reason);
    assert.equal(await fs.readFile(path.join(work, 'partial'), 'utf8'), 'owned extraction');
    await fs.rm(work, { recursive: true });
    for (const name of (await fs.readdir(root)).filter(name => name.startsWith('native-download-'))) {
      await fs.rm(path.join(root, name), { recursive: true });
    }
  }
});

test('optional native snapshot failures retain compiler outputs and preserve existing files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-native-snapshot-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const work = path.join(dir, 'work');
  await fs.mkdir(work);
  await fs.writeFile(path.join(work, 'compiled'), 'native output');
  const archive = path.join(dir, 'native.tar.gz');
  assert.equal(await preserveNativeOutputs(work, archive, { save: () => { throw new Error('No snapshot space'); } }), false);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(work, 'compiled'), 'utf8'), 'native output');
  assert.equal(await preserveNativeOutputs(work, archive, { stageDeadline: Date.now() }), false);
  assert.equal(await preserveNativeOutputs(work, archive, { save: () => false }), false);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  const cancelled = Object.assign(new Error('cancelled'), { signal: 'SIGTERM' });
  await assert.rejects(preserveNativeOutputs(work, archive, { save: () => { throw cancelled; } }), error => error === cancelled);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  const controller = new AbortController();
  const reason = new Error('User cancelled snapshot');
  await assert.rejects(preserveNativeOutputs(work, archive, { signal: controller.signal, save: () => {
    controller.abort(reason);
    throw reason;
  } }), error => error === reason);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  const unsafe = Object.assign(new Error('Snapshot process may still be running'), { code: 'REUSE_TERMINATION_FAILED' });
  await assert.rejects(preserveNativeOutputs(work, archive, { save: () => { throw unsafe; } }), error => error === unsafe);
  assert.equal((await fs.stat(archive)).isFile(), true);
  await fs.rm(archive);
  assert.equal(await preserveNativeOutputs(work, archive), true);
  const restored = path.join(dir, 'restored');
  await restoreCheckpoint(restored, archive);
  assert.equal(await fs.readFile(path.join(restored, 'compiled'), 'utf8'), 'native output');
  await fs.writeFile(archive, 'pre-existing file');
  assert.equal(await preserveNativeOutputs(work, archive, { save: () => assert.fail('Must not overwrite existing archive') }), false);
  assert.equal(await fs.readFile(archive, 'utf8'), 'pre-existing file');
});

test('native compression preserves the owner-selected upload hour at the deadline boundary', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-upload-reserve-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'native.tar.gz');
  const reserve = 60 * 60 * 1000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal(await preserveNativeOutputs(root, archive, { stageDeadline: now + reserve,
    save: () => assert.fail('No compression time remains after reserving the upload hour') }), false);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
  const stageDeadline = now + reserve + reserve;
  assert.equal(await preserveNativeOutputs(root, archive, { stageDeadline, save: () => { now = stageDeadline - reserve; } }), true);
  assert.equal(stageDeadline - now, reserve);
  await fs.rm(archive);
  assert.equal(await preserveNativeOutputs(root, archive, { stageDeadline: now + reserve + reserve,
    save: () => { now += reserve + reserve; } }), false);
  await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
});

test('native checkpoint CLI recovers completed compilation after packaging failure and skips expired allowance', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-native-cli-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'release tooling');
  const scripts = path.join(root, 'chromium/scripts');
  await fs.mkdir(scripts, { recursive: true });
  for (const file of ['ci-release.mjs', 'ci-reuse.mjs', 'ci-publish.mjs']) {
    await fs.copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(scripts, file));
  }
  await fs.writeFile(path.join(root, 'chromium/CHROMIUM_VERSION'), 'fixture');
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid',
    'commit', '--allow-empty', '-m', 'Release fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const platform = process.platform === 'darwin' ? 'macos-arm64' : process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
  const workspace = path.join(dir, 'workspace');
  const work = path.join(workspace, 'flecha-chromium');
  await fs.mkdir(path.join(work, 'src'), { recursive: true });
  const state = { sha, chromium: 'fixture', platform, depot: depotRevision, nativeKey: 'key', nativeComplete: true, complete: false };
  await fs.writeFile(path.join(work, 'state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(work, 'src/compiled'), 'completed compilation, packaging failed');
  const output = path.join(dir, 'outputs');
  const env = { ...process.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_WORKSPACE: workspace,
    FLECHA_STAGE_STARTED: String(Date.now()), GITHUB_OUTPUT: output };
  const script = path.join(scripts, 'ci-release.mjs');
  execFileSync(process.execPath, [script, 'native-checkpoint'], { env });
  assert.match(await fs.readFile(output, 'utf8'), /native-key=key/);
  const minutes = Number((await fs.readFile(output, 'utf8')).match(/upload-minutes=(\d+)/)[1]);
  assert.ok(minutes > 0 && minutes <= 5 * 60);
  const restored = path.join(dir, 'restored');
  await restoreCheckpoint(restored, path.join(root, 'native.tar.gz'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(restored, 'state.json'), 'utf8')), state);
  assert.equal(await fs.readFile(path.join(restored, 'src/compiled'), 'utf8'), 'completed compilation, packaging failed');
  await fs.rm(output);
  execFileSync(process.execPath, [script, 'native-checkpoint'], { env: { ...env, FLECHA_STAGE_STARTED: '1' } });
  await assert.rejects(fs.stat(checkpointPath(root, 'native')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  execFileSync(process.execPath, [script, 'native-checkpoint'], { env: { ...env,
    FLECHA_STAGE_STARTED: String(Date.now() - (5 - 1) * 60 * 60 * 1000) } });
  await assert.rejects(fs.stat(checkpointPath(root, 'native')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
});

test('recovery searches trusted nightly runs and skips expired or superseded checkpoints', async () => {
  const options = { repository: 'owner/repo', branch: 'main', currentRun: '10', platform: 'linux-x64', key: 'native-key' };
  const native = 'native-linux-x64-native-key';
  const index = 'reuse-linux-x64-native-key-';
  const requests = [];
  const rejected = new Map([
    [9, { head_branch: 'feature' }], [8, { head_repository: { full_name: 'fork/repo' } }],
    [7, { event: 'pull_request' }], [6, { path: '.github/workflows/untrusted.yml' }],
  ]);
  const candidates = await Array.fromAsync(findReusableArtifacts(options, endpoint => {
    requests.push(endpoint);
    const url = new URL('https://api.github.com/' + endpoint);
    if (url.pathname.endsWith('/runs/4/artifacts')) throw Object.assign(new Error('Run removed'), { status: 404 });
    if (url.pathname.endsWith('/runs/5/artifacts')) {
      const names = url.searchParams.get('page') === '1' ? [index + '2', index + '1', 'reuse-linux-x64-other-3'] :
        ['checkpoint-linux-x64-1', 'checkpoint-linux-x64-2', 'checkpoint-linux-x64-3'];
      return { artifacts: names.map(name => ({ name, expired: name === 'checkpoint-linux-x64-2' })), total_count: 6 };
    }
    if (url.pathname.endsWith('/artifacts')) {
      const name = url.searchParams.get('name');
      if (name !== null) assert.equal(name, native);
      const ids = name ? (url.searchParams.get('page') === '1' ? [10, ...rejected.keys()] : [5, 3]) : [10, ...rejected.keys(), 4, 5];
      return { artifacts: ids.map(id => ({ name: name || index + '1', workflow_run: { id } })), total_count: 7 };
    }
    const id = Number(url.pathname.split('/').at(-1));
    return { id, head_sha: `sha-${id}`, head_repository: { full_name: options.repository },
      path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'workflow_dispatch', ...rejected.get(id) };
  }));
  assert.deepEqual(candidates.map(c => [c.name, c.run]), [[native, '5'], [native, '3'], ['checkpoint-linux-x64-1', '5']]);
  assert.equal(requests.length, new Set(requests).size);
  assert.equal((await findReusableArtifacts(options, () => ({ artifacts: [], total_count: 0 })).next()).done, true);
});

test('a restored native tree retains compiler outputs and adopts current shell, build metadata and source provenance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-reconfigure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original');
  const work = path.join(root, 'restored work');
  const src = path.join(work, 'src');
  const out = path.join(src, 'out/Release');
  await fs.mkdir(path.join(original, 'src/out/Release'), { recursive: true });
  await fs.mkdir(path.join(original, 'depot_tools'));
  await fs.mkdir(path.join(original, 'src/flecha/shell'), { recursive: true });
  await fs.mkdir(path.join(root, 'chromium/shell/dist'), { recursive: true });
  const identity = { sha: 'current-source', chromium: '158', platform: 'linux-x64', depot: 'tools' };
  await fs.writeFile(path.join(original, 'state.json'), JSON.stringify({ ...identity, sha: 'previous-source', nativeKey: 'key', complete: true }));
  await fs.writeFile(path.join(original, 'src/out/Release/chrome.o'), 'retained compiler output');
  await fs.writeFile(path.join(original, 'src/flecha/shell/removed.js'), 'stale shell');
  await fs.writeFile(path.join(root, 'chromium/shell/dist/current.js'), 'current shell');
  const archive = path.join(root, 'native.tar.gz');
  saveCheckpoint(original, archive, false);
  await restoreCheckpoint(work, archive);
  let generated = false;
  const reused = { sha: 'previous-source', run: '123' };
  const configure = { root, work, identity, key: 'key', reused, args: 'current version and build number', generate: () => { generated = true; } };
  await assert.rejects(validateReusableTree(work, { ...identity, sha: reused.sha, nativeKey: 'wrong' }), /nativeKey does not match/);
  assert.equal(generated, false);
  await validateReusableTree(work, { ...identity, sha: reused.sha, nativeKey: 'key' });
  await configureReleaseTree(configure);
  assert.equal(generated, true);
  assert.equal(await fs.readFile(path.join(out, 'chrome.o'), 'utf8'), 'retained compiler output');
  assert.equal(await fs.readFile(path.join(out, 'args.gn'), 'utf8'), 'current version and build number');
  assert.equal(await fs.readFile(path.join(src, 'flecha/shell/current.js'), 'utf8'), 'current shell');
  await assert.rejects(fs.stat(path.join(src, 'flecha/shell/removed.js')), { code: 'ENOENT' });
  const state = JSON.parse(await fs.readFile(path.join(work, 'state.json'), 'utf8'));
  checkIdentity(state, identity);
  assert.equal(state.complete, false);
  assert.deepEqual(state.reusedFrom, reused);
});

test('completed platforms pass through later build and checkpoint CLI stages without source', async t => {
  // Node resolves module filenames through macOS's /var -> /private/var alias.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-completed-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'release tooling');
  const scripts = path.join(root, 'chromium/scripts');
  await fs.mkdir(scripts, { recursive: true });
  const script = path.join(scripts, 'ci-release.mjs');
  await fs.copyFile(fileURLToPath(new URL('../scripts/ci-release.mjs', import.meta.url)), script);
  await fs.copyFile(fileURLToPath(new URL('../scripts/ci-reuse.mjs', import.meta.url)), path.join(scripts, 'ci-reuse.mjs'));
  await fs.copyFile(fileURLToPath(new URL('../scripts/ci-publish.mjs', import.meta.url)), path.join(scripts, 'ci-publish.mjs'));
  await fs.writeFile(path.join(root, 'chromium/CHROMIUM_VERSION'), 'fixture');
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid',
    'commit', '--allow-empty', '-m', 'Release fixture'], { cwd: root });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const platform = process.platform === 'darwin' ? 'macos-arm64' : process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
  const state = { sha, chromium: 'fixture', platform, depot: depotRevision, complete: true };
  let workspace = path.join(dir, 'first workspace');
  const work = path.join(workspace, 'flecha-chromium');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'state.json'), JSON.stringify(state));
  for (const stage of ['first', 'second']) {
    const env = { ...process.env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_WORKSPACE: workspace };
    execFileSync(process.execPath, [script, 'build'], { env });
    execFileSync(process.execPath, [script, 'checkpoint'], { env });
    assert.equal((await fs.stat(checkpointPath(root, 'checkpoint'))).isFile(), true);
    const next = path.join(dir, `${stage} restored workspace`);
    await fs.mkdir(next);
    const restored = path.join(next, 'flecha-chromium');
    await restoreCheckpoint(restored, path.join(root, 'checkpoint.tar.gz'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(restored, 'state.json'), 'utf8')), state);
    await assert.rejects(fs.stat(path.join(restored, 'src')), { code: 'ENOENT' });
    workspace = next;
  }
});

test('checkpoint archives restore the tree, and completed checkpoints carry only state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-checkpoint-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = new URL('../scripts/ci-release.mjs', import.meta.url).href;
  const withoutZstd = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { checkpointPath } from ${JSON.stringify(script)}; console.log(checkpointPath('.', 'checkpoint'));`],
    { env: { ...process.env, PATH: dir }, encoding: 'utf8' });
  assert.equal(withoutZstd.trim(), 'checkpoint.tar.gz');
  const work = path.join(dir, 'work tree');
  await fs.mkdir(path.join(work, 'src/out/Release'), { recursive: true });
  await fs.writeFile(path.join(work, 'state.json'), '{"complete":false}');
  const out = path.join(work, 'src/out/Release');
  await fs.writeFile(path.join(out, 'chrome'), 'compiled object', { mode: 0o755 });
  await fs.writeFile(path.join(out, '.ninja_deps'), Buffer.from([0, 255, 10]));
  await fs.writeFile(path.join(out, '.ninja_log'), '# ninja log v5\n');
  const modified = new Date('2026-01-02T03:04:05Z');
  await fs.utimes(path.join(out, 'chrome'), modified, modified);
  for (const complete of [false, true]) {
    const archive = path.join(dir, `checkpoint-${complete}.tar.gz`);
    const restored = path.join(dir, `restored tree-${complete}`);
    saveCheckpoint(work, archive, complete);
    await restoreCheckpoint(restored, archive);
    await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(restored, 'state.json'), 'utf8'), '{"complete":false}');
    const binary = path.join(restored, 'src/out/Release/chrome');
    if (complete) await assert.rejects(fs.stat(binary), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(binary, 'utf8'), 'compiled object');
  }
  await t.test('restore preserves dangling links and links archived before their targets', async t => {
    try {
      await fs.symlink('src/out/Release/chrome', path.join(work, 'a-forward-link'), 'file');
      await fs.symlink('src/out/Release', path.join(work, 'a-directory-link'), 'dir');
      await fs.symlink('missing-target', path.join(work, 'dangling-link'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && process.env.GITHUB_ACTIONS !== 'true' && error.code === 'EPERM') {
        t.skip('Local Windows account lacks native symlink privileges. Hosted CI requires this test.');
        return;
      }
      throw error;
    }
    for (const archive of new Set([path.join(dir, 'checkpoint.tar.gz'), checkpointPath(dir, 'checkpoint')])) {
      saveCheckpoint(work, archive, false);
      const restored = path.join(dir, 'roundtrip-' + path.extname(archive));
      await restoreCheckpoint(restored, path.join(dir, 'checkpoint.tar.gz'));
      const binary = path.join(restored, 'src/out/Release/chrome');
      const stat = await fs.stat(binary);
      assert.equal(stat.mtimeMs, modified.getTime());
      if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, (await fs.stat(path.join(out, 'chrome'))).mode & 0o777);
      assert.deepEqual(await fs.readFile(path.join(path.dirname(binary), '.ninja_deps')), Buffer.from([0, 255, 10]));
      assert.equal(await fs.readFile(path.join(path.dirname(binary), '.ninja_log'), 'utf8'), '# ninja log v5\n');
      assert.equal(await fs.readlink(path.join(restored, 'dangling-link')), await fs.readlink(path.join(work, 'dangling-link')));
      assert.equal(await fs.readFile(path.join(restored, 'a-forward-link'), 'utf8'), 'compiled object');
    }
    const archive = path.join(dir, 'links-first.tar.gz');
    const restored = path.join(dir, 'restored links');
    const tar = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/usr/bin/tar.exe') : 'tar';
    const flags = process.platform === 'win32' ? ['--force-local'] : [];
    const archivePath = archive.replaceAll(path.sep, '/');
    const links = ['a-directory-link', 'a-forward-link', 'dangling-link'];
    // Explicit arguments control member order, independent of filesystem enumeration.
    execFileSync(tar, [...flags, '-czf', archivePath, ...links, 'src'], { cwd: work });
    const members = execFileSync(tar, [...flags, '-tzf', archivePath], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.deepEqual(members.slice(0, links.length), links);
    await restoreCheckpoint(restored, archive);
    for (const link of links) {
      assert.equal((await fs.lstat(path.join(restored, link))).isSymbolicLink(), true, link);
    }
    assert.equal(await fs.readFile(path.join(restored, 'a-forward-link'), 'utf8'), 'compiled object');
    assert.equal(await fs.readFile(path.join(restored, 'a-directory-link/chrome'), 'utf8'), 'compiled object');
    await assert.rejects(fs.stat(path.join(restored, 'dangling-link')), { code: 'ENOENT' });
  });
});

test('release checkpoints reject another source, toolchain or platform', () => {
  const expected = { sha: 'source', chromium: '158', platform: 'linux-x64', depot: 'tools' };
  checkIdentity({ ...expected, complete: false }, expected);
  for (const key of Object.keys(expected)) {
    assert.throws(() => checkIdentity({ ...expected, complete: false, [key]: 'other' }, expected), /does not match/);
  }
  assert.throws(() => checkIdentity(expected, expected), /completion state/);
});

test('nightly preparation selects platform GN settings and the required PGO checkout', async () => {
  for (const platform of ['linux-x64', 'windows-x64', 'macos-arm64']) {
    const { args, gclient } = await releaseConfiguration({ platform, version: '0.1.0', buildNumber: '1' });
    assert.doesNotMatch(args, /flecha_sparkle_/);
    assert.match(args, /use_siso = false/);
    assert.match(args, /proprietary_codecs = false/);
    assert.equal(args.includes('flecha_shell_dir'), platform.startsWith('macos-'));
    assert.ok(args.includes(`target_cpu = "${platform.startsWith('macos-') ? 'arm64' : 'x64'}"`));
    assert.match(args, /flecha_version = "0\.1\.0"/);
    assert.match(args, /flecha_build_number = "1"/);
    assert.match(args, /^is_official_build = true$/m);
    assert.match(args, /^chrome_pgo_phase = 2$/m);
    assert.match(gclient, /"checkout_pgo_profiles": True/);
    assert.doesNotMatch(args, /ffmpeg_branding = "Chrome"/);
    for (const flag of ['v8_enable_builtins_gearbox', 'v8_enable_runtime_call_stats', 'enable_pdf_ink2',
      'enable_pdf_save_to_drive', 'enable_hosted_apps', 'enable_vr', 'enable_openxr']) {
      assert.match(args, new RegExp(`^${flag} = false$`, 'm'), `${platform}: ${flag}`);
    }
  }
});

test('local macOS release fetches the target and V8 profiles before GN unless PGO is disabled',
  { skip: process.platform === 'win32' && 'POSIX release script fixture' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-local-release-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const dir of ['bin', 'src', 'sparkle/Sparkle.framework', 'node_modules/esbuild', 'chromium/build',
      'chromium/scripts', 'chromium/shell/dist/rules', 'chromium/patches', 'chromium/branding/mac', 'chromium/branding/logo']) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
    }
    for (const file of ['scripts/build-release.sh', 'scripts/env.sh', 'build/release.gn']) {
      await fs.copyFile(new URL(`../${file}`, import.meta.url), path.join(root, 'chromium', file));
    }
    for (const [file, contents] of Object.entries({
      'package.json': '{"version":"0.1.0"}',
      'chromium/shell/build.mjs': '',
      'chromium/shell/dist/manifest.json': '{}',
      'chromium/shell/dist/rules/easylist.json': '[]',
      'chromium/patches/a.patch': '',
      'chromium/branding/BRANDING': '',
      'chromium/branding/mac/fixture': '',
      'chromium/branding/logo/fixture.png': '',
      '.gclient': 'fixture checkout configuration',
    })) await fs.writeFile(path.join(root, file), contents);
    for (const [file, body] of Object.entries({
      'chromium/scripts/apply.sh': 'exit 0',
      'chromium/scripts/fetch-sparkle.sh': 'printf "%s\\n" "$FIXTURE_SPARKLE"',
      'bin/python3': 'printf "python3 %s\\n" "$*" >> "$FIXTURE_LOG"',
      'bin/gn': 'printf "gn %s\\n" "$*" >> "$FIXTURE_LOG"',
      'bin/caffeinate': 'printf "caffeinate %s\\n" "$*" >> "$FIXTURE_LOG"',
    })) await fs.writeFile(path.join(root, file), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

    const log = path.join(root, 'commands');
    const src = path.join(root, 'src');
    for (const [arch, target, disablePgo] of [['arm64', 'mac-arm', false], ['x64', 'mac', false], ['x64', 'mac', true]]) {
      await fs.writeFile(log, '');
      execFileSync('bash', ['chromium/scripts/build-release.sh', '--no-package'], {
        cwd: root, stdio: 'pipe', env: { ...process.env, CHROMIUM_SRC: src, FLECHA_ARCH: arch,
          FLECHA_PGO: disablePgo ? '0' : '', FLECHA_BUILD_NUMBER: '1', FLECHA_REAPPLY: '1',
          FIXTURE_LOG: log, FIXTURE_SPARKLE: path.join(root, 'sparkle'),
          PATH: [path.join(root, 'bin'), path.dirname(process.execPath), process.env.PATH].join(path.delimiter) },
      });
      const out = path.join(src, 'out', arch === 'arm64' ? 'Release' : 'Release-x64');
      const args = await fs.readFile(path.join(out, 'args.gn'), 'utf8');
      assert.match(args, /^is_official_build = true$/m);
      assert.deepEqual(args.match(/^chrome_pgo_phase = .*$/gm), [`chrome_pgo_phase = ${disablePgo ? 0 : 2}`]);
      assert.match(args, new RegExp(`^target_cpu = "${arch}"$`, 'm'));
      assert.match(args, new RegExp(`^flecha_sparkle_feed_url = "https://flecha\\.dev/appcast${arch === 'x64' ? '-x64' : ''}\\.xml"$`, 'm'));
      assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), [
        ...(!disablePgo ? [
          `python3 tools/update_pgo_profiles.py --target=${target} update --gs-url-base=chromium-optimization-profiles/pgo_profiles`,
          'python3 v8/tools/builtins-pgo/download_profiles.py download --depot-tools third_party/depot_tools --check-v8-revision --quiet',
        ] : []),
        `gn gen ${out}`,
        `caffeinate -i autoninja -C ${out} chrome`,
      ]);
    }
    assert.equal(await fs.readFile(path.join(root, '.gclient'), 'utf8'), 'fixture checkout configuration');
  });

test('compilation errors cannot become resumable success', async () => {
  await assert.rejects(compile(process.execPath, ['-e', 'process.exit(7)'],
    {}), /Chromium build failed: 7/);
});

test('Windows termination distinguishes a vanished PID from a still-owned live process', async () => {
  const missing = Object.assign(new Error('process not found'), { code: 'ESRCH' });
  const exited = Object.assign(new Error('taskkill could not find the process'), { code: 128 });
  const kill = async (command, args) => {
    assert.equal(command, 'taskkill');
    assert.deepEqual(args, ['/PID', '17', '/T', '/F']);
    throw exited;
  };
  const snapshot = () => [17, 18];
  const gone = () => { throw missing; };
  assert.equal(await stopWindowsTree(17, {}, { snapshot, exec: kill, probe: gone }), false);
  await assert.rejects(stopWindowsTree(17, {}, { snapshot, exec: kill, probe: id => id === 18 ? true : gone() }), error => error === exited);
  const partial = Object.assign(new Error('a member exited before taskkill'), { code: 1, stdout: 'SUCCESS: terminated child' });
  assert.equal(await stopWindowsTree(17, {}, { snapshot, exec: () => { throw partial; }, probe: gone }), true);
});

test('Linux dependency checks install only when needed and observe the same stage deadline and cancellation', async () => {
  const src = '/source';
  const script = 'build/install-build-deps.sh';
  const deadline = Date.now();
  for (const outcome of ['installed', 'missing', 'timeout', 'cancelled']) {
    const controller = new AbortController();
    const options = { env: {}, deadline, signal: controller.signal };
    const calls = [];
    const install = installLinuxDependencies(src, options, async (command, args, runOptions) => {
      assert.equal(runOptions.deadline, deadline);
      assert.equal(runOptions.signal, controller.signal);
      assert.equal(runOptions.cwd, src);
      calls.push([command, ...args]);
      if (command === 'locale') return 'da_DK.utf8\nen_US.utf8\nfr_FR.utf8\nhe_IL.utf8\nzh_TW.utf8';
      if (outcome !== 'installed' && calls.length === 1) throw Object.assign(new Error('missing'), { exitCode: 1 });
      if (command === 'sudo' && outcome === 'timeout') throw Object.assign(new Error('stage deadline'), { code: 'ETIMEDOUT' });
      if (command === 'sudo' && outcome === 'cancelled') {
        controller.abort(new Error('stage cancelled'));
        runOptions.signal.throwIfAborted();
      }
    });
    if (outcome === 'timeout') await assert.rejects(install, { code: 'ETIMEDOUT' });
    else if (outcome === 'cancelled') await assert.rejects(install, /stage cancelled/);
    else await install;
    const check = ['bash', script, '--quick-check'];
    assert.deepEqual(calls, outcome === 'installed' ? [check, ['locale', '-a']] :
      [check, ['sudo', '-n', 'bash', script, '--no-prompt'], ...(outcome === 'missing' ? [check] : [])]);
  }
});

test('the release workflow uploads fast hits and runs native setup on misses, while cold stage zero checkpoints', async () => {
  const workflow = await fs.readFile(new URL('../../.github/workflows/release-stage.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^      - /m).slice(1);
  const step = start => {
    const found = steps.find(s => s.startsWith(start));
    assert.ok(found, start);
    return found;
  };
  const probe = step('name: Try verified portable');
  assert.match(probe, /if: inputs.stage == 0 && runner.os != 'macOS'/);
  for (const name of ['name: Reclaim unused', 'uses: actions/setup-python', 'name: Install Chromium Windows SDK',
    'name: Read Chromium revision', 'name: Verify and install Chromium Linux', 'name: Prepare Chromium source']) {
    const setup = step(name);
    assert.ok(steps.indexOf(probe) < steps.indexOf(setup));
    assert.match(setup, /if: [^\n]*steps\.portable\.outputs\.package == ''/);
  }
  assert.match(step('name: Upload completed platform package'), /if: steps.portable.outputs.package != '' \|\| steps.compile.outputs.package != ''/);
  assert.match(step('name: Save checkpoint'), /if: steps.portable.outputs.package == '' && steps.compile.outputs.package == ''/);
  assert.match(step('name: Compile and package'), /if: inputs.stage != 0 \|\| steps.prepare.outputs.compile == 'true'/);
  const deletion = step('name: Delete superseded checkpoint');
  assert.match(deletion, /if: inputs.stage != 0 && !inputs.last && steps.checkpoint.outputs.complete == 'false'/);
  assert.match(deletion, /artifacts\?name=\$PREVIOUS_NAME/);
});

test('package handoff requires exactly one upload and publication metadata precedes extraction', async t => {
  const workflows = new URL('../../.github/workflows/', import.meta.url);
  const stage = await fs.readFile(new URL('release-stage.yml', workflows), 'utf8');
  const publish = await fs.readFile(new URL('publish-nightly-platform.yml', workflows), 'utf8');
  assert.match(publish, /run: node chromium\/scripts\/ci-publish\.mjs preflight\s+- uses: actions\/download-artifact@/);
  assert.match(stage, /inputs\[build_attempt\]=\$BUILD_ATTEMPT/);
  assert.match(stage, /inputs\[monitor_attempt\]=\$GITHUB_RUN_ATTEMPT/);
  const platform = await fs.readFile(new URL('release-platform.yml', workflows), 'utf8');
  assert.match(platform, /!contains\(needs\.\*\.outputs\.published, 'true'\)/);
  if (process.platform === 'win32') return; // The Bash step uses POSIX output paths.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-handoff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'outputs');
  const handoff = stage.split('id: handoff\n')[1].split('\n      - ')[0].split('run: |\n')[1];
  for (const [checkpoint, pkg, expected] of [['7', '', 'incomplete=true\n'], ['', '8', 'incomplete=false\nbuild-attempt=1\n'],
    ['', '', undefined], ['7', '8', undefined]]) {
    await fs.writeFile(output, '');
    const invoke = () => execFileSync('bash', ['-e', '-c', handoff], { env: { ...process.env,
      GITHUB_OUTPUT: output, GITHUB_RUN_ATTEMPT: '1', CHECKPOINT_ID: checkpoint, PACKAGE_ID: pkg } });
    if (expected === undefined) assert.throws(invoke, { status: 1 });
    else {
      invoke();
      assert.equal(await fs.readFile(output, 'utf8'), expected);
    }
  }
});

test('portable discovery tries exact repository queries before its prefix fallback', async () => {
  const options = { portableOnly: true, repository: 'owner/repo', branch: 'main', currentRun: '10',
    platform: 'linux-x64', releaseName: 'release-linux-x64-key-layout' };
  for (const format of ['none', 'legacy', 'job-scoped']) {
    const names = [];
    const suffixes = ['-attempt-3-job-91', '-attempt-2-job-78'];
    const candidates = await Array.fromAsync(findReusableArtifacts(options, endpoint => {
      const url = new URL('https://api.github.com/' + endpoint);
      if (url.pathname.endsWith('/runs/9')) return { id: 9, run_attempt: 3, head_sha: 'sha', head_repository: { full_name: 'owner/repo' },
        path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'schedule' };
      const name = url.searchParams.get('name');
      if (url.pathname.endsWith('/runs/9/artifacts') && !name) {
        assert.equal(format, 'job-scoped');
        const artifacts = ['-packages', suffixes[1], '-attempt-5-job-92', suffixes[0], '-attempt-1-job-69']
          .map((suffix, id) => ({ id, name: options.releaseName + suffix, expired: id === 4 }));
        return { artifacts, total_count: artifacts.length };
      }
      names.push(name);
      if (!name) return { artifacts: [], total_count: 0 };
      const exists = format === 'legacy' && (name.endsWith('-reruns') || name.endsWith('-attempt-2')) ||
        format === 'job-scoped' && name.endsWith('-packages');
      return { artifacts: exists ? [{ name, workflow_run: { id: 9 } }] : [], total_count: Number(exists) };
    }));
    assert.deepEqual(names, ['-packages', '-attempt-1', '-reruns', ...(format === 'legacy' ? ['-attempt-3', '-attempt-2'] : []), '']
      .map(suffix => options.releaseName + suffix).concat(null));
    const expected = { none: [], legacy: ['-attempt-2'], 'job-scoped': suffixes };
    assert.deepEqual(candidates.map(c => c.name), expected[format].map(suffix => options.releaseName + suffix));
  }
});

test('portable discovery skips a deleted indexed run and finds an older package', async () => {
  const repository = 'owner/repo';
  const releaseName = 'release-linux-x64-key-layout';
  const options = { portableOnly: true, repository, branch: 'main', currentRun: '10', platform: 'linux-x64', releaseName };
  for (const [index, name] of [
    [releaseName + '-packages', releaseName + '-attempt-2-job-70'],
    [releaseName + '-reruns', releaseName + '-attempt-2'],
  ]) {
    let deletedListings = 0;
    const candidates = findReusableArtifacts(options, endpoint => {
      const url = new URL('https://api.github.com/' + endpoint);
      if (url.pathname.endsWith('/actions/artifacts')) {
        const artifacts = url.searchParams.get('name') === index ? [9, 8].map(id => ({ name: index, workflow_run: { id } })) : [];
        return { artifacts, total_count: artifacts.length };
      }
      if (url.pathname.endsWith('/runs/9/artifacts')) {
        deletedListings++;
        throw Object.assign(new Error('run deleted'), { status: 404 });
      }
      if (url.pathname.endsWith('/runs/8/artifacts')) return { artifacts: [{ id: 80, name }], total_count: 1 };
      const id = Number(url.pathname.split('/').at(-1));
      assert.ok(id === 8 || id === 9, endpoint);
      return { id, run_attempt: id === 9 ? 3 : 2, head_sha: `sha-${id}`, head_repository: { full_name: repository },
        path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'schedule' };
    });
    assert.deepEqual((await candidates.next()).value, { id: 80, name, run: '8', sha: 'sha-8', archive: 'Flecha-linux-x64.tar.gz' });
    assert.equal(deletedListings, 1);
  }
});

test('portable discovery finds a job-scoped package without an index and ignores untrusted runs', async () => {
  const repository = 'owner/repo';
  const releaseName = 'release-linux-x64-key-layout';
  const name = releaseName + '-attempt-2-job-70';
  const options = { portableOnly: true, repository, branch: 'main', currentRun: '10', platform: 'linux-x64', releaseName };
  const candidates = await Array.fromAsync(findReusableArtifacts(options, endpoint => {
    const url = new URL('https://api.github.com/' + endpoint);
    if (url.pathname.endsWith('/actions/artifacts')) {
      if (url.searchParams.has('name')) return { artifacts: [], total_count: 0 };
      const id = url.searchParams.get('page') === '1' ? 9 : 8;
      return { artifacts: [{ name, workflow_run: { id } }], total_count: 2 };
    }
    if (url.pathname.endsWith('/runs/8/artifacts')) return { artifacts: [{ id: 80, name }], total_count: 1 };
    const id = Number(url.pathname.split('/').at(-1));
    assert.ok(id === 8 || id === 9, endpoint);
    return { id, run_attempt: 2, head_sha: `sha-${id}`, head_repository: { full_name: repository },
      path: '.github/workflows/nightly-release.yml', head_branch: id === 8 ? 'main' : 'feature', event: 'schedule' };
  }));
  assert.deepEqual(candidates, [{ id: 80, name, run: '8', sha: 'sha-8', archive: 'Flecha-linux-x64.tar.gz' }]);
});

test('an intentional compilation deadline creates a checkpoint outcome', async () => {
  // An already-expired deadline exercises handoff without waiting for real compilation.
  assert.equal(await compile(process.execPath, ['-e', 'setInterval(() => {}, 1)'],
    { milliseconds: 0 }), false);
});

test('cancellation rejects rather than requesting a checkpoint', async () => {
  const controller = new AbortController();
  const result = compile(process.execPath, ['-e', 'setInterval(() => {}, 1)'],
    { signal: controller.signal });
  controller.abort(new Error('user cancelled'));
  await assert.rejects(result, /user cancelled/);
});

test('publication requires every platform, matching provenance and untampered packages', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-release-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const platforms = [{ platform: 'linux-x64' }, { platform: 'windows-x64' }, { platform: 'macos-arm64' }];
  const expected = { sha: 'source', chromium: '158' };
  for (const { platform } of platforms) {
    const archive = `Flecha-${platform}.${platform.startsWith('windows-') ? 'zip' : 'tar.gz'}`;
    const files = { [archive]: 'package', [`${platform}.json`]: JSON.stringify({ ...expected, platform }) };
    let sums = '';
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content);
      sums += `${createHash('sha256').update(content).digest('hex')}  ${name}\n`;
    }
    await fs.writeFile(path.join(dir, `${platform}-SHA256SUMS`), sums);
  }
  await verifyRelease(dir, platforms, expected);
  const controller = new AbortController();
  controller.abort(new Error('Verification cancelled'));
  await assert.rejects(verifyRelease(dir, platforms, expected, { signal: controller.signal }), /Verification cancelled/);
  await assert.rejects(verifyRelease(dir, platforms, { ...expected, sha: 'other' }), /provenance mismatch/);
  await fs.writeFile(path.join(dir, 'Flecha-linux-x64.tar.gz'), 'corrupt');
  await assert.rejects(verifyRelease(dir, platforms, expected), /Checksum mismatch/);
  await fs.rm(path.join(dir, 'Flecha-windows-x64.zip'));
  await assert.rejects(verifyRelease(dir, [platforms[1]], expected), /Missing release asset/);
});

test('the publisher uses the active default-branch build’s platform catalog and Chromium pin', () => {
  const repository = 'owner/repo';
  const branch = 'main';
  const platform = 'linux-x64';
  const nativeKey = 'a'.repeat(64);
  const base = `release-${platform}-${nativeKey}`;
  const artifact = `${base}-attempt-2-job-32`;
  const secondArtifact = `${base}-attempt-2-job-34`;
  const sha = 'b'.repeat(40);
  const run = { id: 11, run_attempt: 2, status: 'in_progress', head_sha: sha, path: '.github/workflows/nightly-release.yml',
    head_branch: branch, head_repository: { full_name: repository }, event: 'schedule' };
  const inputs = { repository, branch, currentRun: '12', run: '11', buildAttempt: '2', monitorAttempt: '2',
    buildId: '32', platform, artifact, artifactId: '22', monitorId: '33' };
  const readRun = (overrides = {}, upload = {}, job = {}, build = {}) => args => {
    if (args[1] === `repos/${repository}/actions/jobs/35`) return JSON.stringify({ id: 35, head_sha: sha, name: `build-2 / Monitor ${platform} publication`,
      run_id: 11, run_attempt: 2, status: 'in_progress', steps: [] });
    if (args[1] === `repos/${repository}/actions/jobs/33`) return JSON.stringify({ id: 33, head_sha: sha, name: `build-1 / Monitor ${platform} publication`,
      run_id: 11, run_attempt: 2, status: 'in_progress', steps: [], ...job });
    for (const [id, stage] of [[32, 1], [34, 2]]) {
      if (args[1] === `repos/${repository}/actions/jobs/${id}`) return JSON.stringify({ id, head_sha: sha,
        name: `build-${stage} / ${platform} stage ${stage}`, run_id: 11, run_attempt: 2, status: 'completed', conclusion: 'success',
        steps: [{ name: 'Upload completed platform package', conclusion: 'success' }], ...build });
    }
    if (args[1] === `repos/${repository}/actions/runs/11`) return JSON.stringify({ ...run, ...overrides });
    if (args[1] === `repos/${repository}/actions/artifacts/22`) {
      return JSON.stringify({ id: 22, name: artifact, workflow_run: { id: 11, head_sha: sha }, ...upload });
    }
    if (args[1] === `repos/${repository}/actions/artifacts/23`) {
      return JSON.stringify({ id: 23, name: secondArtifact, workflow_run: { id: 11, head_sha: sha } });
    }
    if (args.at(-1) === `repos/${repository}/contents/chromium/build/ci-platforms.json?ref=${sha}`) {
      return JSON.stringify([{ platform }]);
    }
    assert.equal(args.at(-1), `repos/${repository}/contents/chromium/CHROMIUM_VERSION?ref=${sha}`);
    return '158.0.8127.2\n';
  };
  assert.deepEqual(publicationSource(inputs, readRun()), { sha, chromium: '158.0.8127.2', nativeKey });
  const second = { ...inputs, buildId: '34', monitorId: '35', artifact: secondArtifact, artifactId: '23' };
  assert.deepEqual(publicationSource(second, readRun()), { sha, chromium: '158.0.8127.2', nativeKey });
  assert.throws(() => publicationSource({ ...inputs, artifactId: second.artifactId }, readRun()), /does not match the source nightly upload/);
  assert.throws(() => publicationSource({ ...second, artifactId: inputs.artifactId }, readRun()), /does not match the source nightly upload/);
  assert.throws(() => publicationSource({ ...inputs, artifact: second.artifact, artifactId: second.artifactId }, readRun()), /Invalid nightly/);
  const portable = `${base}-${'c'.repeat(64)}-attempt-2-job-32`;
  assert.deepEqual(publicationSource({ ...inputs, artifact: portable }, readRun({}, { name: portable })),
    { sha, chromium: '158.0.8127.2', nativeKey });
  const unknownPlatform = `release-linux-other-${nativeKey}-attempt-2-job-32`;
  assert.throws(() => publicationSource({ ...inputs, platform: 'linux-other', artifact: unknownPlatform },
    readRun({}, { name: unknownPlatform }, { name: 'Monitor linux-other publication' })), /Unknown release platform/);
  for (const untrusted of [{ head_repository: { full_name: 'other/repo' } }, { head_branch: 'other' },
    { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { id: 13 }]) {
    assert.throws(() => publicationSource(inputs, readRun(untrusted)), /default-branch nightly/);
  }
  assert.throws(() => publicationSource({ ...inputs, artifact: 'release-windows-x64-*' }, readRun()), /Invalid nightly/);
  for (const obsolete of [{ run_attempt: 3 }, { status: 'cancelling' }, { status: 'completed', conclusion: 'cancelled' }]) {
    assert.throws(() => publicationSource(inputs, readRun(obsolete)), /cancelled or superseded/);
  }
  const old = `${base}-attempt-1-job-32`;
  const rerun = { ...inputs, buildAttempt: '1', artifact: old };
  assert.deepEqual(publicationSource(rerun, readRun({}, { name: old }, {}, { run_attempt: 1 })),
    { sha, chromium: '158.0.8127.2', nativeKey });
  for (const build of [{ run_attempt: 2 }, { conclusion: 'failure' }, { head_sha: 'wrong' }, { id: 34 }, { run_id: 12 },
    { name: 'another stage / linux-x64 stage 1' }, { steps: [{ name: 'Upload completed platform package', conclusion: 'skipped' }] }]) {
    assert.throws(() => publicationSource(rerun, readRun({}, { name: old }, {}, { run_attempt: 1, ...build })), /producing build job/);
  }
  assert.throws(() => publicationSource({ ...inputs, buildAttempt: '3', artifact: base + '-attempt-3-job-32' }, readRun()), /Invalid nightly/);
  assert.throws(() => publicationSource(inputs, readRun({}, { name: old })), /does not match/);
  assert.throws(() => publicationSource({ ...inputs, artifact: old }, readRun({}, { name: old })), /Invalid nightly/);
  for (const job of [{ run_attempt: 1 }, { run_id: 13 }, { status: 'completed' }, { steps: [{ conclusion: 'cancelled' }] }]) {
    assert.throws(() => publicationSource(inputs, readRun({}, {}, job)), /inactive or cancelling/);
  }
  for (const wrong of [{ id: 23 }, { workflow_run: { id: 12 } }, { workflow_run: { id: 11, head_sha: 'wrong' } },
    { name: portable }, { expired: true }]) {
    assert.throws(() => publicationSource(inputs, readRun({}, wrong)), /does not match/);
  }
});

test('a portable release reuses the verified browser with the current shell and host', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flecha-portable-reuse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
  const exe = platform === 'windows-x64' ? 'chrome.exe' : 'chrome';
  const release = path.join(root, 'previous-release');
  const stage = path.join(root, 'portable');
  const previousStage = path.join(root, 'previous-portable');
  const repacked = path.join(root, 'repacked');
  const verified = path.join(root, 'verified');
  const shellSource = path.join(root, 'chromium/shell/dist');
  const bin = path.join(root, 'node/bin');
  const node = path.join(bin, 'fixture-node');
  const provenance = { platform, sha: 'previous', nativeKey: 'native-key', chromium: 'fixture', depot: 'toolchain', args: 'native args' };
  await Promise.all([previousStage, shellSource, path.join(root, 'chromium/native-host/dist'),
    path.join(root, 'chromium/scripts'), bin].map(directory => fs.mkdir(directory, { recursive: true })));
  const hostSource = path.join(root, 'chromium/native-host/dist/flecha-host.cjs');
  await Promise.all([
    fs.writeFile(path.join(previousStage, exe), 'original browser', { mode: 0o755 }),
    fs.writeFile(path.join(shellSource, 'obsolete.js'), 'old shell'),
    fs.writeFile(hostSource, 'old host'),
    fs.writeFile(path.join(root, 'chromium/scripts/portable-launch.mjs'), 'new launcher'),
    fs.writeFile(path.join(root, 'LICENSE'), 'Flecha license'),
    fs.writeFile(path.join(bin, platform === 'windows-x64' ? 'LICENSE' : '../LICENSE'), 'Node license'),
    fs.writeFile(node, 'node'),
  ]);
  const invoke = (command, args, cwd) => execFileSync(command, args, { cwd });
  await packagePortable(root, previousStage, release, invoke, node);
  const archiveName = `Flecha-${platform}.${platform === 'windows-x64' ? 'zip' : 'tar.gz'}`;
  const archive = path.join(release, archiveName);
  const provenanceName = `${platform}.json`;
  const files = { [archiveName]: await fs.readFile(archive), [provenanceName]: JSON.stringify(provenance) };
  await fs.writeFile(path.join(release, provenanceName), files[provenanceName]);
  await fs.writeFile(path.join(release, `${platform}-SHA256SUMS`), Object.entries(files).map(([file, contents]) =>
    `${createHash('sha256').update(contents).digest('hex')}  ${file}\n`).join(''));
  const extract = (file, target) => extractPortable(file, target, invoke);
  await assert.rejects(restorePortableRuntime(archive, stage, { ...provenance, nativeKey: 'other' }, extract), /provenance mismatch/);
  assert.equal(await restorePortableRuntime(archive, stage, provenance, extract), provenance.args);
  await fs.unlink(path.join(shellSource, 'obsolete.js'));
  await fs.writeFile(path.join(shellSource, 'frame.js'), 'new shell');
  await fs.writeFile(hostSource, 'new host');
  await packagePortable(root, stage, repacked, invoke, node);
  await fs.mkdir(verified);
  await extract(path.join(repacked, archiveName), verified);
  const shell = path.join(verified, 'resources/flecha-shell');
  assert.equal(await fs.readFile(path.join(verified, exe), 'utf8'), 'original browser');
  assert.equal(await fs.readFile(path.join(shell, 'frame.js'), 'utf8'), 'new shell');
  assert.deepEqual(await fs.readdir(shell), ['frame.js']);
  assert.equal(await fs.readFile(path.join(verified, 'native-host/flecha-host.cjs'), 'utf8'), 'new host');
  assert.deepEqual(await fs.readdir(path.join(verified, 'native-host')), ['flecha-host.cjs']);
  const launcher = platform === 'windows-x64' ? 'Flecha.cmd' : 'flecha';
  assert.match(await fs.readFile(path.join(verified, launcher), 'utf8'), /portable-launch\.mjs/);
  if (platform === 'linux-x64') {
    for (const file of [exe, launcher]) assert.ok((await fs.stat(path.join(verified, file))).mode & 0o111);
  }

  await t.test('cancellation during shell staging prevents further copies and archiving', async t => {
    const controller = new AbortController();
    const reason = new Error('cancel mid-copy');
    const open = nativeFs.createWriteStream;
    const hook = t.mock.method(nativeFs, 'createWriteStream', (file, ...options) => {
      const stream = open(file, ...options);
      if (file === path.join(stage, 'resources/flecha-shell/frame.js')) {
        stream.once('pipe', source => source.once('data', () => controller.abort(reason)));
      }
      return stream;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(packagePortable(root, stage, path.join(root, 'cancelled-output'),
        () => assert.fail('must not start archiver'), node, controller.signal), { code: 'ABORT_ERR' });
      assert.equal(controller.signal.reason, reason);
      assert.deepEqual(await fs.readdir(path.join(stage, 'native-host')), []);
    } finally {
      hook.mock.restore();
      syncBuiltinESMExports();
    }
  });

  await t.test('failed promotion preserves the destination and retries a verified package', async () => {
    const releaseName = 'release-' + platform + '-native-layout';
    const name = releaseName + '-attempt-1';
    const work = path.join(root, 'chromium-work');
    const dist = path.join(root, 'release');
    await fs.mkdir(dist);
    await fs.writeFile(path.join(dist, 'existing'), 'untouched');
    const options = { portableOnly: true, repository: 'owner/repo', branch: 'main', currentRun: '3', platform, releaseName, work };
    const requests = [];
    const attempts = [];
    const gh = async args => {
      if (args[0] === 'api') {
        const url = args[1];
        requests.push(url);
        if (url.includes('/artifacts?')) return JSON.stringify({
          total_count: 2, artifacts: [1, 2].map(id => ({ name, workflow_run: { id } })),
        });
        return JSON.stringify({ id: Number(url.split('/').at(-1)), head_sha: provenance.sha, head_repository: { full_name: 'owner/repo' },
          path: '.github/workflows/nightly-release.yml', head_branch: 'main', event: 'schedule' });
      }
      if (attempts.length) {
        assert.equal(await fs.readFile(path.join(dist, 'existing'), 'utf8'), 'untouched');
        await fs.rm(dist, { recursive: true });
      }
      await fs.cp(release, args.at(-1), { recursive: true });
    };
    const candidate = await restoreFixture(root, options, (archive, candidate) => {
      attempts.push(candidate.run);
      return repackPortableCandidate({ root, archive, stage: path.join(work, 'stage'), dist, source: provenance,
        signal: new AbortController().signal, invoke, nodeExecutable: node,
        metadata: (dir, args) => fs.writeFile(path.join(dir, 'provenance'), args) });
    }, gh);
    assert.deepEqual(attempts, ['1', '2']);
    assert.equal(candidate.run, '2');
    assert.equal(await fs.readFile(path.join(dist, 'provenance'), 'utf8'), provenance.args);
    assert.deepEqual(requests.filter(url => url.includes('/artifacts?')).map(url =>
      new URL('https://api.github.com/' + url).searchParams.get('name')), [releaseName + '-packages', name]);
  });
});

test('publication writes the marker last and reconciles only this publisher attempt by asset ID', () => {
  const repository = 'owner/repo';
  const marker = 'linux-x64-SHA256SUMS';
  const owner = 'Nightly publisher 50 attempt 2';
  const options = { repository, tag: 'nightly-1', sha: 'source', title: 'Nightly', notes: 'notes.md', owner,
    files: ['dir/Flecha-linux-x64.tar.gz', 'dir/linux-x64.json'], checksums: 'dir/' + marker };
  const dataNames = options.files.map(file => path.basename(file));
  function fixture({ created = true, exists = true, tagSha = 'source', failFile, supersedeOn } = {}) {
    const assets = [{ id: 1, name: marker, label: 'previous attempt' }, { id: 2, name: 'windows-x64-SHA256SUMS', label: 'other' }];
    const writes = [];
    let nextId = 3;
    let current = true;
    let journal;
    const gh = args => {
      if (args[1] === 'create') {
        if (!created) throw new Error('already exists');
      } else if (args[1] === 'upload') {
        for (const file of args.slice(3, args.indexOf('--repo'))) {
          const [name, label] = path.basename(file).split('#');
          assert.equal(label, `${name} (${owner})`);
          assert.equal(args.includes('--clobber'), name !== marker);
          writes.push('upload ' + name);
          assets.push({ name, label, id: nextId++ });
          if (name === supersedeOn) current = false;
          if (name === failFile) throw new Error('upload interrupted');
        }
      } else if (args[1] === '--method') {
        assert.equal(args[2], 'DELETE');
        const index = assets.findIndex(asset => args[3] === 'repos/owner/repo/releases/assets/' + asset.id);
        assert.notEqual(index, -1);
        writes.push('delete ' + assets[index].name);
        assets.splice(index, 1);
      } else if (args[1] === 'repos/owner/repo/releases/tags/nightly-1') {
        if (!exists) throw new Error('not found');
        return JSON.stringify({ id: 6, assets });
      } else if (args[1] === 'repos/owner/repo/git/ref/tags/nightly-1') {
        return JSON.stringify({ object: { type: 'commit', sha: tagSha } });
      } else {
        assert.deepEqual(args, ['api', 'repos/owner/repo/releases/6/assets', '--paginate', '--slurp']);
        return JSON.stringify([assets]);
      }
    };
    const publish = () => publishAssets(options, gh, () => {
      if (!current) throw new Error('Source attempt superseded');
    }, id => { journal = id; });
    return { writes, assets, publish, cancel: () => reconcileAssets(repository, journal, owner, marker, gh) };
  }
  for (const created of [true, false]) {
    const successful = fixture({ created });
    successful.publish();
    assert.deepEqual(successful.writes, ['delete ' + marker, ...[...dataNames, marker].map(name => 'upload ' + name)]);
    // The workflow cancellation step runs even if the publishing process already returned.
    successful.assets.find(asset => asset.name === dataNames[0]).label = 'later publisher';
    successful.cancel();
    assert.deepEqual(successful.assets.map(asset => asset.label), ['other', 'later publisher']);
    assert.deepEqual(successful.writes.slice(-2), ['delete ' + marker, 'delete ' + dataNames[1]]);
    successful.cancel(); // A repeated reconciliation finds no remaining owned assets.
  }
  for (const name of [dataNames[0], marker]) {
    for (const failure of ['failFile', 'supersedeOn']) {
      const interrupted = fixture({ [failure]: name });
      assert.throws(interrupted.publish, failure === 'failFile' ? /upload interrupted/ : /Source attempt superseded/);
      assert.deepEqual(interrupted.assets.map(asset => asset.label), ['other']);
      if (name === marker) assert.deepEqual(interrupted.writes.slice(-3),
        [marker, ...dataNames].map(name => 'delete ' + name));
    }
  }
  const moved = fixture({ created: false, tagSha: 'other' });
  assert.throws(moved.publish, /does not point to source/);
  assert.deepEqual(moved.writes, []);
  assert.throws(fixture({ created: false, exists: false }).publish, /already exists/);
});
