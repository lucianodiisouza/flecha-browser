import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

test('the commit hook isolates Git fixture commands from the committing worktree', { skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'flecha-hook-test-')));

  t.after(() => rm(root, { recursive: true, force: true }));

  const committing = join(root, 'committing');
  const fixture = join(root, 'fixture');
  const bin = join(root, 'bin');

  for (const dir of [committing, fixture, bin]) await mkdir(dir);

  for (const dir of [committing, fixture]) execFileSync('git', ['-C', dir, 'init', '-q']);

  await writeFile(join(bin, 'npm'), `#!/bin/sh
set -eu
case "$2" in
  format:staged) git rev-parse --show-toplevel ;;
  check:code) git -C "$FLECHA_HOOK_TEST_FIXTURE" rev-parse --show-toplevel ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

  const paths = execFileSync('sh', ['.husky/pre-commit'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GIT_DIR: join(committing, '.git'),
      GIT_WORK_TREE: committing,
      GIT_INDEX_FILE: join(committing, '.git', 'index'),
      FLECHA_HOOK_TEST_FIXTURE: fixture,
    },
  });

  assert.deepEqual(paths.trim().split('\n'), [committing, fixture]);
});
