import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const { arch, platform } = process;

const supported =
  (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
  (platform === 'darwin' && arch === 'arm64');

if (!supported) {
  console.log(
    `tsrs skipped: no binary for ${platform}/${arch}; tsc remains required`,
  );
  process.exit(0);
}

const require = createRequire(import.meta.url);
const tsrs = join(dirname(require.resolve('tsrs/package.json')), 'bin/tsrs');

for (const project of ['chromium/shell', 'chromium/native-host']) {
  const run = spawnSync(process.execPath, [tsrs, '-p', project], {
    stdio: 'inherit',
  });

  if (run.error) throw run.error;

  if (run.status !== 0) process.exit(run.status ?? 1);
}
