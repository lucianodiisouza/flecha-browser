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

const [output, [status, signal]] = await Promise.all([
  new Response(child.stdout).text(),
  once(child, 'close'),
]);

const termination = signal ? `signal ${signal}` : `status ${status}`;
let report;

try {
  report = JSON.parse(output);
} catch {
  throw new Error(
    `Oxlint exited with ${termination} without a valid JSON report`,
  );
}

const { diagnostics } = report ?? {};

if (
  !Array.isArray(diagnostics) ||
  (status !== 0 && (status !== 1 || !diagnostics.length))
) {
  throw new Error(
    `Oxlint exited with ${termination} without a usable lint report`,
  );
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

let stale = 0;

for (const [path, allowances] of Object.entries(baseline)) {
  for (const [code, remaining] of Object.entries(allowances)) {
    if (remaining === 0) continue;
    console.error(
      `${path} ${code}: remove ${remaining} unused allowances from lint-baseline.json`,
    );
    stale += remaining;
  }
}

console.log(
  `Oxlint: ${added} above baseline, ${existing} existing, ${stale} stale allowances`,
);

if (added || stale) process.exitCode = 1;
