const randomUUID = () => crypto.randomUUID();
import type { ActiveEnvironment, Environment, EnvironmentTarget } from '../../shared/types';

/**
 * Environments group the origins one project lives on (local, staging, production…).
 * Switching keeps the path, query and hash and only swaps the origin.
 */

export function findEnvironment(url: string, environments: Environment[] = []) {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  for (const env of environments) {
    const index = env.targets.findIndex((t) => t.origin === origin);
    if (index >= 0) return { env, index };
  }
  return undefined;
}

export function switchTo(url: string, target: EnvironmentTarget) {
  const current = new URL(url);
  return target.origin + current.pathname + current.search + current.hash;
}

/** For the address bar badge and the command bar's `env` results. */
export function describe(url: string, environments: Environment[] = []): ActiveEnvironment | undefined {
  const found = findEnvironment(url, environments);
  if (!found) return undefined;
  const { env, index } = found;
  return {
    name: env.name,
    label: env.targets[index].label,
    tone: tone(env.targets[index]),
    // Starting after the current one, so the first switch is "next" and ⌥⌘E cycles through all.
    switches: [...env.targets.slice(index + 1), ...env.targets.slice(0, index)].map((t) => ({
      label: t.label,
      tone: tone(t),
      url: switchTo(url, t),
    })),
  };
}

/** Production is red so it is never mistaken for a safe place to click around. */
function tone(target: EnvironmentTarget): ActiveEnvironment['tone'] {
  const address = target.origin.replace(/^[a-z]+:\/\//i, '').toLowerCase();
  // A target with no label of its own is labelled with its host, which says nothing more.
  const label = target.label.toLowerCase() === address ? '' : target.label.toLowerCase();
  if (/\bprod(uction)?\b/.test(label)) return 'production';
  if (/localhost|127\.0\.0\.1|\blocal\b|\.test\b|\.local\b/.test(`${label} ${address}`)) return 'local';
  // Whole words, without the top-level domain: flecha.dev and app.latest.com are not staging.
  const host = address.replace(/:\d+$/, '').replace(/\.[^.]+$/, '');
  if (/\b(stag(e|ing)|preview|qa|test(ing)?|dev(elop(ment)?)?|sandbox|uat)\b/.test(`${label} ${host}`)) return 'staging';
  return 'production';
}

/** Settings edit targets as text, one per line: `label origin` or just `origin`. */
export function parseTargets(text: string): EnvironmentTarget[] {
  const targets: EnvironmentTarget[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const raw = parts[parts.length - 1];
    try {
      // Dev servers and devices on the network speak plain http, so these don't get https.
      const scheme = /^(localhost|[a-z0-9.-]+\.localhost|(\d{1,3}\.){3}\d{1,3}|\[::1\])(:\d+)?(\/|$)/i.test(raw) ? 'http' : 'https';
      const origin = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `${scheme}://${raw}`).origin;
      const label = parts.length > 1 ? parts.slice(0, -1).join(' ') : new URL(origin).host;
      targets.push({ label, origin });
    } catch {
      // Skip lines that aren't a URL.
    }
  }
  return targets;
}

export function sanitize(environments: unknown): Environment[] {
  if (!Array.isArray(environments)) return [];
  return environments
    .map((e) => ({
      id: typeof e?.id === 'string' ? e.id : randomUUID(),
      name: String(e?.name ?? '').trim() || 'Project',
      targets: parseTargets(typeof e?.targetsText === 'string' ? e.targetsText : ''),
    }))
    .filter((e) => e.targets.length > 0);
}
