/** Which badge a target gets, and how Settings' text becomes targets. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, findEnvironment, parseTargets } from '../lib/environments.ts';

function toneOf(line: string) {
  const targets = parseTargets(line);
  return describe(`${targets[0].origin}/`, [{ id: '1', name: 'Project', targets }])?.tone;
}

const tones: Record<string, Record<string, string>> = {
  production: {
    'prod https://flecha.dev': 'production',
    'production https://app.latest.com': 'production',
    'prod https://devices.example.com': 'production',
    'prod https://staging.example.com': 'production',
    'prod https://example.com': 'production',
  },
  'no label': {
    'https://flecha.dev': 'production',
    'https://contest.com': 'production',
    'https://example.test': 'local',
    'https://dev.example.com': 'staging',
    'https://myapp-staging.example.com': 'staging',
  },
  staging: {
    'staging https://example.com': 'staging',
    'dev https://example.com': 'staging',
    'qa https://qa.example.dev': 'staging',
  },
  local: {
    'local http://localhost:3000': 'local',
    'http://127.0.0.1:8080': 'local',
    'mine https://app.local': 'local',
  },
};

for (const [name, lines] of Object.entries(tones)) {
  test(`tone: ${name}`, () => {
    for (const [line, tone] of Object.entries(lines)) assert.equal(toneOf(line), tone, line);
  });
}
