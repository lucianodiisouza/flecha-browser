/** Which pages get the "this site needs DRM" note. Run with `npm test`. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drmSite } from '../lib/drm.ts';

test('streaming sites, with or without www', () => {
  assert.equal(drmSite('https://www.netflix.com/browse'), 'netflix.com');
  assert.equal(drmSite('https://netflix.com/'), 'netflix.com');
  assert.equal(drmSite('https://open.spotify.com/track/1'), 'open.spotify.com');
  assert.equal(drmSite('https://globoplay.globo.com/'), 'globoplay.globo.com');
});

test('look-alikes and other pages stay quiet', () => {
  assert.equal(drmSite('https://notnetflix.com/'), undefined);
  assert.equal(drmSite('https://spotify.com/'), undefined);
  assert.equal(drmSite('https://www.youtube.com/watch?v=1'), undefined);
  assert.equal(drmSite('chrome-extension://abc/netflix.com'), undefined);
  assert.equal(drmSite('not a url'), undefined);
});
