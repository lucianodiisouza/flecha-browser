import { getSubdomain } from 'tldts';
import type { ActiveEnvironment, Environment, EnvironmentTarget } from '../../shared/types';
import { webAddress } from './url';

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

function autoLabel(target: EnvironmentTarget) {
  return typeof target.autoLabel === 'boolean' ? target.autoLabel :
    target.label === target.origin.replace(/^[a-z]+:\/\//i, '');
}

export function formatTargets(targets: EnvironmentTarget[]): string {
  return targets.map((target) => autoLabel(target) ? target.origin : `${target.label} ${target.origin}`).join('\n');
}

/** Production is red so it is never mistaken for a safe place to click around. */
function tone(target: EnvironmentTarget): ActiveEnvironment['tone'] {
  const address = target.origin.replace(/^[a-z]+:\/\//i, '').toLowerCase();
  const label = autoLabel(target) ? '' : target.label.toLowerCase().replaceAll('_', ' ');
  const staging = /\b(stag(e|ing)|preview|qa|test(ing)?|dev(elop(ment)?)?|sandbox|uat)\d*\b/;
  if (/\bprod(uction)?\b/.test(label)) return 'production';
  if (/\blocal\b/.test(label)) return 'local';
  if (staging.test(label)) return 'staging';
  const hostname = address.replace(/:\d+$/, '').replace(/\.$/, '');
  if (/^(local|localhost|\[::1\]|0\.0\.0\.0|127(?:\.\d+){3})$|\.(localhost|test|local)$/i.test(hostname)) return 'local';
  const subdomains = hostname.includes('.') ? getSubdomain(hostname, { allowPrivateDomains: true }) : hostname;
  if (subdomains && staging.test(subdomains)) return 'staging';
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
      const address = webAddress(raw, { allowBareHost: true });
      if (!address) continue;
      const url = new URL(address);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const autoLabel = parts.length === 1;
      const label = autoLabel ? url.host : parts.slice(0, -1).join(' ');
      targets.push({ label, origin: url.origin, autoLabel });
    } catch {
      // Skip lines that aren't a URL.
    }
  }
  return targets;
}
