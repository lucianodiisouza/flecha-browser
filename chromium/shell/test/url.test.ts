/** What the command bar makes of typed text. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webAddress } from '../lib/url.ts';

const cases: Record<string, Record<string, string | undefined>> = {
  'full URLs stay as typed': {
    'https://github.com/a': 'https://github.com/a',
    'chrome://settings': 'chrome://settings',
    'about:blank': 'about:blank',
    'mailto:a@b.com': 'mailto:a@b.com',
  },
  'local and network hosts get http': {
    'localhost:3000': 'http://localhost:3000',
    '127.0.0.1:8080': 'http://127.0.0.1:8080',
    '[::1]:3000': 'http://[::1]:3000',
    '0.0.0.0:3000': 'http://0.0.0.0:3000',
    '192.168.0.10': 'http://192.168.0.10',
    '192.168.0.10:3000': 'http://192.168.0.10:3000',
    '10.0.0.5/admin': 'http://10.0.0.5/admin',
    'myapp.localhost:3000': 'http://myapp.localhost:3000',
  },
  'domains get https': {
    'github.com': 'https://github.com',
    'github.com/a/b': 'https://github.com/a/b',
    'app.test:8000': 'https://app.test:8000',
  },
  'everything else is a search': {
    'how to center.div': undefined,
    '1.2.3': undefined,
    react: undefined,
  },
};

for (const [name, inputs] of Object.entries(cases)) {
  test(name, () => {
    for (const [input, url] of Object.entries(inputs)) assert.equal(webAddress(input), url, input);
  });
}
