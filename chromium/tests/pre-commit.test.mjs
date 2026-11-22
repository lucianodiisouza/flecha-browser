import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the commit hook checks staged files and isolates Git fixture commands', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flecha-hook-test-')));

  t.after(() => rm(root, { recursive: true, force: true }));

  const committing = join(root, 'committing');
  const fixture = join(root, 'fixture');
  const modules = join(committing, 'node_modules');
  const runner = join(root, 'npm.mjs');

  await mkdir(modules, { recursive: true });
  await mkdir(fixture);

  for (const dir of [committing, fixture]) execFileSync('git', ['-C', dir, 'init', '-q']);

  await writeFile(join(committing, 'value.txt'), 'staged');
  execFileSync('git', ['-C', committing, 'add', 'value.txt']);
  await writeFile(join(committing, 'value.txt'), 'unstaged');
  await writeFile(join(committing, 'untracked.txt'), 'untracked');
  await writeFile(join(modules, 'dependency.txt'), 'installed');
  await writeFile(runner, `import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
const fixture = execFileSync('git', ['-C', process.env.FLECHA_HOOK_TEST_FIXTURE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
console.log(JSON.stringify({
  command: process.argv.slice(2),
  value: readFileSync('value.txt', 'utf8'),
  untracked: existsSync('untracked.txt'),
  dependency: readFileSync('node_modules/dependency.txt', 'utf8'),
  fixture: realpathSync(fixture),
}));
`);

  const stagedScript = fileURLToPath(new URL('../../tools/checks/staged.mjs', import.meta.url));

  const output = execFileSync(process.execPath, [stagedScript], {
    cwd: committing,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: runner,
      GIT_DIR: join(committing, '.git'),
      GIT_WORK_TREE: committing,
      GIT_INDEX_FILE: join(committing, '.git', 'index'),
      FLECHA_HOOK_TEST_FIXTURE: fixture,
    },
  });

  assert.deepEqual(JSON.parse(output), {
    command: ['run', 'check:code'],
    value: 'staged',
    untracked: false,
    dependency: 'installed',
    fixture,
  });
  assert.equal(await readFile(join(committing, 'value.txt'), 'utf8'), 'unstaged');
  assert.equal(execFileSync('git', ['-C', committing, 'show', ':value.txt'], { encoding: 'utf8' }), 'staged');
});
