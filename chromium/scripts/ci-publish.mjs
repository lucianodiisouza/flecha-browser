// Only a platform's complete, checksummed package from this source commit can be released.
import fs from 'node:fs/promises';
import { createReadStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { trustedRun } from './ci-reuse.mjs';

export async function verifyRelease(dir, platforms, { sha, chromium, nativeKey }, { signal } = {}) {
  signal?.throwIfAborted();
  const files = new Set(await fs.readdir(dir));
  for (const { platform } of platforms) {
    const archive = `Flecha-${platform}.${platform.startsWith('windows-') ? 'zip' : 'tar.gz'}`;
    const provenanceName = `${platform}.json`;
    const checksumsName = `${platform}-SHA256SUMS`;
    for (const file of [archive, provenanceName, checksumsName]) {
      if (!files.has(file)) throw new Error(`Missing release asset: ${file}`);
      files.delete(file);
    }
    const provenance = JSON.parse(await fs.readFile(path.join(dir, provenanceName), 'utf8'));
    if (provenance.sha !== sha || provenance.chromium !== chromium || provenance.platform !== platform ||
        (nativeKey !== undefined && provenance.nativeKey !== nativeKey)) {
      throw new Error(`Release provenance mismatch: ${platform}`);
    }
    const checksums = new Map();
    for (const line of (await fs.readFile(path.join(dir, checksumsName), 'utf8')).trim().split('\n')) {
      const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
      if (!match || checksums.has(match[2])) throw new Error(`Invalid checksum manifest: ${platform}`);
      checksums.set(match[2], match[1]);
    }
    if (checksums.size !== 2 || !checksums.has(archive) || !checksums.has(provenanceName)) {
      throw new Error(`Checksum manifest does not cover the package and provenance: ${platform}`);
    }
    for (const [file, expected] of checksums) {
      const hash = createHash('sha256');
      await pipeline(createReadStream(path.join(dir, file)), hash, { signal });
      if (hash.digest('hex') !== expected) throw new Error(`Checksum mismatch: ${file}`);
    }
  }
  if (files.size) throw new Error(`Unexpected release assets: ${[...files].join(', ')}`);
}

// Platforms publish separately. The first to finish creates the run's release
// without assets, a single API call, so a concurrent platform's create fails
// instead of leaving a second draft. Every platform then uploads its own assets.
// The release is public during uploads, so the platform's SHA256SUMS file goes
// last and marks it complete. A failed upload of the other files leaves no
// checksum file. A retry removes the previous marker before replacing any data.
function assetLabel(name, owner) {
  return `${name} (${owner})`;
}

export function reconcileAssets(repository, releaseId, owner, marker, gh) {
  const pages = JSON.parse(gh(['api', `repos/${repository}/releases/${releaseId}/assets`, '--paginate', '--slurp']));
  const owned = pages.flat().filter(asset => asset.label === assetLabel(asset.name, owner));
  // Remove this publisher's marker first. Immutable IDs protect later replacements.
  for (const asset of owned.sort((a, b) => Number(b.name === marker) - Number(a.name === marker))) {
    gh(['api', '--method', 'DELETE', `repos/${repository}/releases/assets/${asset.id}`]);
  }
}

export function publishAssets({ repository, tag, sha, title, notes, files, checksums, owner }, gh, requireCurrent, recordRelease) {
  requireCurrent();
  let createError;
  try {
    gh(['release', 'create', tag, '--repo', repository, '--target', sha, '--title', title,
      '--prerelease', '--latest=false', '--notes-file', notes]);
  } catch (error) {
    // Another platform, or an earlier attempt of this job, may have created it first.
    createError = error;
  }
  let release;
  try {
    release = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`]));
  } catch (error) {
    throw createError ?? error;
  }
  const { object } = JSON.parse(gh(['api', `repos/${repository}/git/ref/tags/${tag}`]));
  if (object?.type !== 'commit' || object.sha !== sha) throw new Error(`Release tag ${tag} does not point to ${sha}.`);
  requireCurrent();
  const marker = path.basename(checksums);
  const uploadFile = file => file + '#' + assetLabel(path.basename(file), owner);
  recordRelease(release.id);
  const previous = release.assets.find(asset => asset.name === marker);
  if (previous) gh(['api', '--method', 'DELETE', `repos/${repository}/releases/assets/${previous.id}`]);
  try {
    requireCurrent();
    gh(['release', 'upload', tag, ...files.map(uploadFile), '--repo', repository, '--clobber']);
    requireCurrent();
    gh(['release', 'upload', tag, uploadFile(checksums), '--repo', repository]);
    requireCurrent();
  } catch (error) {
    try {
      reconcileAssets(repository, release.id, owner, marker, gh);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Publication and release asset cleanup failed.');
    }
    throw error;
  }
}

function currentSourceRun({ repository, branch, currentRun, run, monitorAttempt, platform, monitorId }, gh) {
  const source = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${run}`]));
  if (String(source.id) !== run || !/^[a-f0-9]{40}$/.test(source.head_sha || '') || !trustedRun(source, { repository, branch, currentRun })) {
    throw new Error('The package must come from a default-branch nightly build in this repository.');
  }
  if (String(source.run_attempt) !== monitorAttempt || source.status !== 'in_progress' || source.conclusion != null) {
    throw new Error('The source nightly attempt was cancelled or superseded.');
  }
  // The run can still be in_progress while its cancelled monitor winds down.
  const monitor = JSON.parse(gh(['api', `repos/${repository}/actions/jobs/${monitorId}`]));
  if (String(monitor.id) !== monitorId || monitor.head_sha !== source.head_sha ||
      String(monitor.run_id) !== run || String(monitor.run_attempt) !== monitorAttempt ||
      monitor.name?.split(' / ').at(-1) !== `Monitor ${platform} publication` || monitor.status !== 'in_progress' ||
      monitor.conclusion != null || monitor.steps.some(step => ['cancelled', 'failure', 'timed_out'].includes(step.conclusion) ||
      (step.name === 'Cancel an unfinished publisher after a failed wait' && step.status === 'in_progress'))) {
    throw new Error('The source publication monitor is inactive or cancelling.');
  }
  return { source, monitor };
}

export function publicationSource(input, gh) {
  const { repository, branch, run, buildAttempt, buildId, monitorAttempt, platform, artifact, artifactId, monitorId } = input;
  const prefix = `release-${platform}-`;
  const suffix = `-attempt-${buildAttempt}-job-${buildId}`;
  const keys = artifact?.startsWith(prefix) && artifact.endsWith(suffix) && artifact.slice(prefix.length, -suffix.length);
  const match = /^([a-f0-9]{64})(?:-[a-f0-9]{64})?$/.exec(keys || '');
  if (!repository || !branch || ![run, buildAttempt, buildId, monitorAttempt, artifactId, monitorId].every(id => /^[1-9]\d*$/.test(id || '')) ||
      BigInt(buildAttempt) > BigInt(monitorAttempt) || !match) {
    throw new Error('Invalid nightly publication inputs.');
  }
  const { source: { head_sha: sha }, monitor } = currentSourceRun(input, gh);
  const upload = JSON.parse(gh(['api', `repos/${repository}/actions/artifacts/${artifactId}`]));
  if (String(upload.id) !== artifactId || String(upload.workflow_run?.id) !== run || upload.workflow_run.head_sha !== sha ||
      upload.name !== artifact || upload.expired) {
    throw new Error('The artifact does not match the source nightly upload.');
  }
  const readSource = file => gh(['api', '-H', 'Accept: application/vnd.github.raw+json',
    `repos/${repository}/contents/chromium/${file}?ref=${sha}`]);
  const platforms = JSON.parse(readSource('build/ci-platforms.json'));
  if (!platforms.some(entry => entry.platform === platform)) throw new Error(`Unknown release platform: ${platform}`);
  const build = JSON.parse(gh(['api', `repos/${repository}/actions/jobs/${buildId}`]));
  const stagePrefix = monitor.name.slice(0, -`Monitor ${platform} publication`.length) + platform + ' stage ';
  if (String(build.id) !== buildId || String(build.run_id) !== run || String(build.run_attempt) !== buildAttempt ||
      build.head_sha !== sha || build.status !== 'completed' || build.conclusion !== 'success' ||
      !build.name?.startsWith(stagePrefix) || !/^\d+$/.test(build.name.slice(stagePrefix.length)) ||
      !build.steps?.some(step => step.name === 'Upload completed platform package' && step.conclusion === 'success')) {
    throw new Error('The producing build job does not match the successful nightly package upload.');
  }
  const chromium = readSource('CHROMIUM_VERSION').trim();
  const nativeKey = match[1];
  return { sha, chromium, nativeKey };
}

async function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { FLECHA_BUILD_RUN: run, FLECHA_DEFAULT_BRANCH: branch, FLECHA_PACKAGE_ARTIFACT: artifact, FLECHA_PLATFORM: platform,
    GITHUB_RUN_ID: currentRun, GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: server,
    GITHUB_RUN_ATTEMPT: publisherAttempt, FLECHA_BUILD_ATTEMPT: buildAttempt, FLECHA_BUILD_ID: buildId,
    FLECHA_MONITOR_ATTEMPT: monitorAttempt, FLECHA_PACKAGE_ARTIFACT_ID: artifactId, FLECHA_MONITOR_ID: monitorId } = process.env;
  if (!currentRun || !server) throw new Error('Missing GitHub release context.');
  const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const input = { repository, branch, currentRun, run, buildAttempt, buildId, monitorAttempt, platform, artifact, artifactId, monitorId };
  const owner = `Nightly publisher ${currentRun} attempt ${publisherAttempt}`;
  const journal = path.join(process.env.RUNNER_TEMP, 'nightly-publisher-release-id');
  if (process.argv[2] === 'reconcile') {
    let id;
    try { id = await fs.readFile(journal, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    reconcileAssets(repository, id, owner, platform + '-SHA256SUMS', gh);
    return;
  }
  const source = publicationSource(input, gh);
  if (process.argv[2] === 'preflight') return;
  const { sha, chromium } = source;
  const dir = path.join(root, 'release');
  await verifyRelease(dir, [{ platform }], source);
  const tag = `nightly-${run}`;
  const notes = path.join(root, 'release-notes.md');
  await fs.writeFile(notes, `Nightly build of Flecha from ${sha}, based on Chromium ${chromium}.\n\n` +
    `Build: ${server}/${repository}/actions/runs/${run}\n\n` +
    'Each platform is added when its own build finishes, so a platform can be missing while it still builds or after its build fails. Each platform uploads its SHA256SUMS file last, so a platform is complete only when that file downloads and its checksums verify.\n\n' +
    'Linux and Windows are portable packages. Extract them to a writable directory and run flecha or Flecha.cmd. Their profiles stay beside the browser. Windows registers the bundled native host for your user.\n\n' +
    'The macOS app is ad hoc signed and is not notarized. Its native host can be registered with chromium/scripts/install-native-host.sh --app /path/to/Flecha.app from the matching source checkout.\n\n' +
    'These prereleases do not use the stable Sparkle update feed. SHA256SUMS files cover each package and its source provenance.\n');
  // verifyRelease left exactly this platform's archive, provenance and checksum file in dir.
  const checksums = path.join(dir, `${platform}-SHA256SUMS`);
  const files = (await fs.readdir(dir)).map(file => path.join(dir, file)).filter(file => file !== checksums);
  publishAssets({ repository, tag, sha, notes, files, checksums, owner, title: `Nightly ${new Date().toISOString().slice(0, 10)} (${run})` }, gh,
    () => currentSourceRun(input, gh), id => writeFileSync(journal, String(id), { flag: 'wx' }));
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Published ${platform} to [${tag}](${server}/${repository}/releases/tag/${tag}) from ${sha}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
