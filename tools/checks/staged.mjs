import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const snapshot = await mkdtemp(join(tmpdir(), 'flecha-staged-'));

try {
  execFileSync('git', ['checkout-index', '--all', `--prefix=${snapshot}/`], {
    stdio: 'inherit',
  });
  await symlink(
    join(process.cwd(), 'node_modules'),
    join(snapshot, 'node_modules'),
    'junction',
  );

  // The fixture repositories must discover their own Git directory and index.
  const env = { ...process.env };

  const gitVariables = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
  });

  for (const name of gitVariables.trim().split(/\s+/)) delete env[name];

  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath, 'run', 'check:code'],
    {
      cwd: snapshot,
      env,
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(snapshot, { recursive: true, force: true });
}
