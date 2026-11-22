import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);

const oxlint = join(
  dirname(require.resolve('oxlint/package.json')),
  'bin/oxlint',
);

const baselineFile = new URL('./lint-baseline.json', import.meta.url);

const child = spawn(
  process.execPath,
  [oxlint, '--deny-warnings', '--format', 'json', '.'],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);

const completion = once(child, 'exit');
const { diagnostics } = await new Response(child.stdout).json();
const [status] = await completion;

if (status !== 0 && (status !== 1 || !diagnostics?.length)) {
  throw new Error(`Oxlint exited with ${status} without a lint report`);
}

const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
let existing = 0;
let added = 0;

for (const diagnostic of diagnostics) {
  const { filename, code, message, labels } = diagnostic;
  const path = filename.replaceAll('\\', '/');
  const allowances = baseline[path];

  if (allowances?.[code] > 0) {
    allowances[code]--;
    existing++;
    continue;
  }

  const { line, column } = labels[0].span;
  console.error(`${path}:${line}:${column} ${code}: ${message}`);
  added++;
}

console.log(`Oxlint: ${added} above baseline, ${existing} existing`);

if (added) process.exitCode = 1;
