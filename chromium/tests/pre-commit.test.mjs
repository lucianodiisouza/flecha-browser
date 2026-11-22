import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('the pre-commit hook formats before checking the complete index in isolation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flecha-hook-test-')));

  t.after(() => rm(root, { recursive: true, force: true }));

  const committing = join(root, 'committing');
  const fixture = join(root, 'fixture');
  const modules = join(committing, 'node_modules');
  const hooks = join(root, 'hooks');
  const report = join(root, 'report.json');

  await mkdir(modules, { recursive: true });
  await mkdir(fixture);
  await mkdir(hooks);

  for (const dir of [committing, fixture]) execFileSync('git', ['-C', dir, 'init', '-q']);

  const hook = await readFile(new URL('../../.husky/pre-commit', import.meta.url), 'utf8');

  await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\nset -e\n${hook}`, { mode: 0o755 });
  await copyFile(new URL('../../tools/checks/staged.mjs', import.meta.url), join(committing, 'staged.mjs'));
  await writeFile(join(committing, 'package.json'), JSON.stringify({
    scripts: {
      'format:staged': 'node format.mjs',
      'check:staged': 'node staged.mjs',
      'check:code': 'node check.mjs',
    },
  }));
  await writeFile(join(committing, 'format.mjs'), `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
writeFileSync('formatted.txt', 'formatted by the hook');
execFileSync('git', ['add', 'formatted.txt']);
`);
  await writeFile(join(committing, 'check.mjs'), `import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
const fixture = execFileSync('git', ['-C', process.env.FLECHA_HOOK_TEST_FIXTURE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
writeFileSync(process.env.FLECHA_HOOK_TEST_REPORT, JSON.stringify({
  value: readFileSync('value.txt', 'utf8'),
  formatted: readFileSync('formatted.txt', 'utf8'),
  sparse: readFileSync('sparse.txt', 'utf8'),
  untracked: existsSync('untracked.txt'),
  dependency: readFileSync('node_modules/dependency.txt', 'utf8'),
  fixture: realpathSync(fixture),
}));
throw new Error('check rejected the staged snapshot');
`);
  await writeFile(join(committing, 'value.txt'), 'staged');
  await writeFile(join(committing, 'sparse.txt'), 'outside the sparse checkout');
  execFileSync('git', ['-C', committing, 'add', 'package.json', 'format.mjs', 'staged.mjs', 'check.mjs', 'value.txt', 'sparse.txt']);
  execFileSync('git', ['-C', committing, 'update-index', '--skip-worktree', 'sparse.txt']);
  await rm(join(committing, 'sparse.txt'));
  await writeFile(join(committing, 'value.txt'), 'unstaged');
  await writeFile(join(committing, 'untracked.txt'), 'untracked');
  await writeFile(join(modules, 'dependency.txt'), 'installed');

  const commit = () => execFileSync('git', [
    '-c', `core.hooksPath=${hooks}`,
    '-c', 'user.name=Flecha fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Test the pre-commit hook',
  ], {
    cwd: committing,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_DIR: join(committing, '.git'),
      GIT_WORK_TREE: committing,
      GIT_INDEX_FILE: join(committing, '.git', 'index'),
      FLECHA_HOOK_TEST_FIXTURE: fixture,
      FLECHA_HOOK_TEST_REPORT: report,
    },
  });

  assert.throws(commit, /check rejected the staged snapshot/);
  assert.throws(() => execFileSync('git', ['-C', committing, 'rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }));
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {
    value: 'staged',
    formatted: 'formatted by the hook',
    sparse: 'outside the sparse checkout',
    untracked: false,
    dependency: 'installed',
    fixture,
  });
  assert.equal(await readFile(join(committing, 'value.txt'), 'utf8'), 'unstaged');
  assert.equal(execFileSync('git', ['-C', committing, 'show', ':value.txt'], { encoding: 'utf8' }), 'staged');
});
