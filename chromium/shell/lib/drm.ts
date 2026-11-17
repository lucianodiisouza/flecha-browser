/**
 * Streaming sites that only play behind Widevine DRM. Flecha doesn't ship Widevine: a custom
 * Chromium needs a paid VMP certification for it, and Flecha stays free of paid parts. On these
 * sites the sidebar says so once, and offers to open the page in Safari.
 */
export const DRM_HOSTS = [
  'netflix.com',
  'disneyplus.com',
  'primevideo.com',
  'max.com',
  'hbomax.com',
  'hulu.com',
  'open.spotify.com',
  'tv.apple.com',
  'paramountplus.com',
  'peacocktv.com',
  'crunchyroll.com',
  'globoplay.globo.com',
  'mubi.com',
  'tidal.com',
];

/** The DRM site a page is on (its entry in DRM_HOSTS), if any. */
export function drmSite(url: string): string | undefined {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return DRM_HOSTS.find((host) => hostname === host || hostname.endsWith(`.${host}`));
}
