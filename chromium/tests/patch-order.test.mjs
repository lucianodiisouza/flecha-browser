import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('Chromium patch filenames have unique sequence numbers', async () => {
  const patches = (await readdir(new URL('../patches/', import.meta.url))).filter(name => name.endsWith('.patch')).sort();
  const patchesByNumber = new Map();

  assert.ok(patches.length, 'The Chromium patch series is empty');

  for (const name of patches) {
    const match = /^(\d{4})-.+\.patch$/.exec(name);
    assert.ok(match, `Use NNNN-description.patch for ${name}`);
    const [, number] = match;
    const previous = patchesByNumber.get(number);
    assert.equal(previous, undefined, `Patch ${number} is shared by ${previous} and ${name}`);
    patchesByNumber.set(number, name);
  }
});

test('applying the series twice works from a checkout path with spaces', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'flecha patch fixture-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const upstream = join(root, 'chromium source');
  const theme = 'chrome/app/theme/chromium';
  const patchDir = join(root, 'patches');
  const scripts = join(root, 'scripts');
  const branding = join(root, 'branding');

  for (const dir of [join(upstream, theme, 'mac'), patchDir, scripts, join(branding, 'mac'), join(branding, 'logo')]) {
    await mkdir(dir, { recursive: true });
  }

  for (const name of ['apply.sh', 'env.sh']) {
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name));
  }

  for (const asset of ['BRANDING', 'mac/app.icns', 'mac/Assets.car', 'logo/example.png']) {
    await writeFile(join(branding, asset), 'fixture');
  }

  const target = join(upstream, 'target');

  await writeFile(target, 'before\n');
  await writeFile(join(upstream, theme, 'BRANDING'), 'before');
  execFileSync('git', ['init', '-q'], { cwd: upstream });
  execFileSync('git', ['add', theme], { cwd: upstream });

  const upstreamBranding = join(upstream, theme, 'BRANDING');

  const apply = () => execFileSync('bash', [join(scripts, 'apply.sh')], {
    env: { ...process.env, CHROMIUM_SRC: upstream },
  });

  await writeFile(upstreamBranding, 'local branding');
  assert.throws(apply, /no patches in/);
  assert.equal(await readFile(upstreamBranding, 'utf8'), 'local branding');

  for (const [number, before, after] of [['0001', 'before', 'intermediate'], ['0002', 'intermediate', 'after']]) {
    const patch = `--- a/target\n+++ b/target\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

    await writeFile(join(patchDir, `${number}-fixture.patch`), patch);
  }

  apply();
  assert.equal(await readFile(target, 'utf8'), 'after\n');
  apply();
  assert.equal(await readFile(target, 'utf8'), 'after\n');
  await mkdir(join(patchDir, '0003-directory.patch'));
  await writeFile(upstreamBranding, 'local branding after applying');
  assert.throws(apply, /not a regular patch file/);
  assert.equal(await readFile(upstreamBranding, 'utf8'), 'local branding after applying');
  assert.equal(await readFile(target, 'utf8'), 'after\n');
});
