/**
 * Dev servers on this machine, for the sidebar and the new tab page. Electron asked `lsof`
 * which processes listen; an extension can't, so this knocks on the ports dev tools use by
 * default and keeps the ones that answer HTTP. Each is named after its page's <title>
 * (Electron used the project folder, which only lsof knows), or `localhost:port`.
 *
 * Scans while a Flecha window is in front and once as soon as focus returns.
 */
import type { LocalServer } from '../../shared/types';

/** Default ports of common dev servers: Next/Rails/Express, Vite, Astro, Angular, Storybook, Django, Hugo… */
export const DEV_PORTS = [
  1234, 1313, 2368, 3000, 3001, 3002, 3003, 3004, 3005, 3030, 3333, 4000, 4173, 4200, 4321, 4400, 4567, 5000, 5001, 5005, 5173, 5174, 5175,
  5176, 5500, 6006, 7000, 7777, 8000, 8001, 8008, 8010, 8080, 8081, 8082, 8088, 8443, 8787, 8888, 9000, 9001, 9090, 19006, 24678,
];

const FOCUSED_EVERY_MS = 4000;

async function probe(port: number): Promise<{ ok: boolean; airplay?: boolean }> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(800),
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
    });
    // macOS's AirPlay receiver listens on 5000 and 7000; it isn't anyone's project.
    return { ok: true, airplay: /AirTunes/i.test(res.headers.get('server') ?? '') };
  } catch {
    return { ok: false };
  }
}

async function nameOf(port: number) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500), cache: 'no-store', credentials: 'omit' });
    const text = (await res.text()).slice(0, 20000);
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    const decoded = title
      ?.replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (decoded) return decoded.slice(0, 60);
  } catch {
    // Named after the port below.
  }
  return `localhost:${port}`;
}

export function watchLocalServers(onChange: (servers: LocalServer[]) => void) {
  let servers: LocalServer[] = [];
  const names = new Map<number, string>();
  let focused = false;
  let focusChanged = false;
  let scanning = false;
  let rescan = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function scan() {
    const found = await Promise.all(DEV_PORTS.map(async (port) => ({ port, ...(await probe(port)) })));
    const up = found.filter((f) => f.ok && !f.airplay).map((f) => f.port);
    for (const port of names.keys()) if (!up.includes(port)) names.delete(port);
    const next: LocalServer[] = [];
    for (const port of up) {
      if (!names.has(port)) names.set(port, await nameOf(port));
      next.push({ port, url: `http://localhost:${port}/`, name: names.get(port)! });
    }
    if (JSON.stringify(next) !== JSON.stringify(servers)) {
      servers = next;
      onChange(servers);
    }
  }

  async function tick() {
    if (!focused) return;
    if (scanning) { rescan = true; return; }
    scanning = true;
    await scan().catch((err) => console.warn('Flecha: looking for local servers failed', err));
    scanning = false;
    if (!focused) return;
    if (rescan) { rescan = false; void tick(); }
    else timer = setTimeout(tick, FOCUSED_EVERY_MS);
  }

  function setFocus(next: boolean) {
    if (focused === next) return;
    focused = next;
    clearTimeout(timer);
    rescan = false;
    if (focused) void tick();
  }

  // Flecha's windows are the only ones this browser has, so any focused window is Flecha's.
  chrome.windows.onFocusChanged.addListener((windowId) => {
    focusChanged = true;
    setFocus(windowId !== chrome.windows.WINDOW_ID_NONE);
  });
  void chrome.windows.getLastFocused().then(
    (w) => { if (!focusChanged) setFocus(!!w.focused); },
    () => { /* The next focus event starts discovery. */ },
  );

  return { servers: () => servers };
}
