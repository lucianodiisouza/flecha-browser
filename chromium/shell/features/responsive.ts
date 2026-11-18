/**
 * The responsive view: the active page again as a phone-sized mirror beside it (the Store's
 * openResponsive, as in Electron), its Chromium tab emulating a phone through the DevTools
 * protocol, the same mechanism as Chrome's device mode: a mobile viewport (so
 * `width=device-width` works), touch input and a mobile user agent.
 *
 * Only mirror tabs get the protocol attached, and only while they are open.
 */
import type { Store } from '../../shared/store';
import { hold, isHeld, onDebuggerDetach, release, send } from './debuggee';
import { PHONE_WIDTH } from '../lib/responsiveViewport';

const chromeVersion = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '140.0.0.0';
/** Electron's PHONE_USER_AGENT: a mobile Chrome user agent. */
export const PHONE_USER_AGENT = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;

const HOLDER = 'responsive';

export interface ResponsiveContext {
  store: Store;
  liveTabId(flechaTabId: string): number | undefined;
}

export function responsive(ctx: ResponsiveContext) {
  const { store } = ctx;
  /** Chromium tabs that are emulating, and those whose emulation the user cancelled (left alone). */
  const emulating = new Set<number>();
  const refused = new Set<number>();
  /** The desktop side's address each mirror last followed. */
  const followed = new Map<string, string>();

  onDebuggerDetach((tabId, reason) => {
    const wasEmulating = emulating.delete(tabId);
    if (reason === 'canceled_by_user') refused.add(tabId);
    if (reason === 'reset' && wasEmulating && Object.entries(store.state.tabs).some(
      ([id, tab]) => tab.device === 'mobile' && ctx.liveTabId(id) === tabId,
    )) void emulate(tabId, false);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    emulating.delete(tabId);
    refused.delete(tabId);
  });

  async function emulate(chromeId: number, reload = true) {
    emulating.add(chromeId);
    if (!(await hold(chromeId, HOLDER))) return void emulating.delete(chromeId);
    await Promise.all([
      send(chromeId, 'Emulation.setUserAgentOverride', { userAgent: PHONE_USER_AGENT, platform: 'Android' }),
      // Height 0 keeps the tab's real height.
      send(chromeId, 'Emulation.setDeviceMetricsOverride', { width: PHONE_WIDTH, height: 0, deviceScaleFactor: 3, mobile: true }),
      send(chromeId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
      send(chromeId, 'Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }),
    ]);
    if (!reload) return;
    // The first load went out as a desktop; load it again as the phone (Electron emulated before loading).
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    if (tab?.url && /^https?:/.test(tab.url)) await send(chromeId, 'Page.reload', { ignoreCache: false });
  }

  /** Brings Chromium in line with the Store: mirrors emulate, other tabs let go, mirrors follow. */
  function sync() {
    const mirrors = new Set<number>();
    for (const [id, tab] of Object.entries(store.state.tabs)) {
      if (tab.device !== 'mobile') continue;
      const chromeId = ctx.liveTabId(id);
      if (chromeId === undefined) continue;
      mirrors.add(chromeId);
      if (!emulating.has(chromeId) && !refused.has(chromeId)) void emulate(chromeId);
    }
    for (const chromeId of emulating) {
      if (!mirrors.has(chromeId) && isHeld(chromeId, HOLDER)) {
        emulating.delete(chromeId);
        void release(chromeId, HOLDER);
      }
    }
    // The phone follows the desktop side. Only that way: sites often send phones to an m.
    // domain, which must not drag the desktop side along.
    for (const space of store.state.windows.flatMap((w) => store.windowView(w.id).spaces)) {
      if (space.splitMode !== 'responsive' || !space.split) continue;
      const [sourceId, mirrorId] = space.split;
      const source = store.state.tabs[sourceId];
      const mirror = store.state.tabs[mirrorId];
      if (!source || !mirror) continue;
      const last = followed.get(mirrorId);
      followed.set(mirrorId, source.url);
      if (last === undefined || last === source.url || mirror.url === source.url) continue;
      const chromeId = ctx.liveTabId(mirrorId);
      if (chromeId !== undefined) void chrome.tabs.update(chromeId, { url: source.url }).catch(() => undefined);
      else store.updateTab(mirrorId, { url: source.url });
    }
  }

  function toggle(windowId?: string) {
    const space = store.activeSpaceIn(windowId);
    if (space.splitMode === 'responsive') {
      // A mirror has no life of its own: ending the split closes it, and the background
      // closes its Chromium tab.
      const source = space.split?.[0];
      const mirror = store.unsplit(windowId);
      // Back to the desktop side, not whichever tab is next to the phone.
      if (source && store.state.tabs[source]) store.activate(source, { windowId });
      if (mirror) store.closeTab(mirror);
      return;
    }
    store.openResponsive(windowId);
  }

  return { sync, toggle };
}
