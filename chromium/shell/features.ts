/**
 * Flecha's developer features in the Chromium shell: Boosts, Environments, local dev servers,
 * the responsive view and console error badges, and the ad blocker. Each lives in
 * features/*.ts; this wires them to the Store and the hub.
 *
 * The feature modules add their Chromium listeners as they are imported, in the background's
 * first turn, so an event that wakes the background (a page loading, a console error) isn't lost.
 */
import type { Store } from '../shared/store';
import type { LocalServer } from '../shared/types';
import type { BoostKind } from './lib/boostFiles';
import { describe as describeEnvironment } from './lib/environments';
import { displayKeys } from './lib/shortcuts';
import { broadcast, handle, run } from './hub';
import * as boosts from './features/boosts';
import { consoleErrors, watchConsoleErrors } from './features/consoleErrors';
import { watchLocalServers } from './features/localServers';
import { responsive } from './features/responsive';
import { setAdBlocking } from './features/adblock';

export interface FeaturesContext {
  store: Store;
  /** Sends every page the new state. */
  broadcastState(): void;
  /** The Chromium tab showing a Flecha tab, if it is open. */
  liveTabId(flechaTabId: string): number | undefined;
  /** The Chromium tab of the active Flecha tab. */
  activeChromeTabId(): number | undefined;
}

/** What the background's uiState() reads from the features. */
export interface Features {
  localServers(): LocalServer[];
  consoleErrors(): Record<string, number>;
  boostedHosts(): string[];
}

export function registerFeatures(ctx: FeaturesContext): Features {
  const { store } = ctx;
  const flechaIdFor = (chromeId: number) => Object.keys(store.state.tabs).find((id) => ctx.liveTabId(id) === chromeId);

  // ---- Boosts ----
  const boostsChanged = () => {
    broadcast('boosts:changed');
    ctx.broadcastState();
  };
  void boosts.ready().then(ctx.broadcastState);

  // ---- local dev servers ----
  const servers = watchLocalServers(() => ctx.broadcastState());

  // ---- console errors ----
  watchConsoleErrors(() => ctx.broadcastState());

  // ---- responsive view ----
  const phone = responsive(ctx);

  // ---- ad blocker: follows state.adBlock, whoever changes it (Settings, the tour) ----
  const adBlockOn = () => store.state.adBlock !== false;
  void setAdBlocking(adBlockOn());

  store.onChange(() => {
    phone.sync();
    void setAdBlocking(adBlockOn());
  });
  // A mirror's Chromium tab can open without a Store change (the background opening it on show).
  chrome.tabs.onCreated.addListener(() => setTimeout(phone.sync, 0));
  phone.sync();

  handle({
    // ⌥⌘B and the site menu: the active site's boost, created from the template the first time.
    editBoost: async (kind: BoostKind) => {
      const name = await boosts.fileFor(store.activeTab?.url, kind === 'styles' ? 'styles' : 'script');
      if (name) boostsChanged();
      // No site (a blank tab): the list, as Electron opened the folder.
      await boosts.openPage(name);
    },
    openBoostsFolder: () => boosts.openPage(),
    'settings:open-boosts': () => boosts.openPage(),
    'boosts:list': () => boosts.list(),
    'boosts:get': (name: string) => boosts.get(String(name)),
    'boosts:create': async (host: string, kind: BoostKind) => {
      const name = await boosts.create(String(host), kind);
      if (name) boostsChanged();
      return name;
    },
    'boosts:save': async (name: string, code: string, build?: boosts.CompiledBoost) => {
      const saved = await boosts.save(String(name), String(code), { build: build && typeof build === 'object' ? build : undefined });
      if (saved) boostsChanged();
      return saved;
    },
    'boosts:delete': async (name: string) => {
      await boosts.remove(String(name));
      boostsChanged();
    },

    // ⌥⌘E: the same page on the project's next environment.
    nextEnvironment: () => {
      const tab = store.activeTab;
      const env = tab && describeEnvironment(tab.url, store.state.environments);
      const chromeId = ctx.activeChromeTabId();
      if (!env?.switches.length || chromeId === undefined) return;
      void chrome.tabs.update(chromeId, { url: env.switches[0].url });
    },

    toggleResponsive: () => phone.toggle(),

    // The sidebar's error badge: that tab, with DevTools open.
    showConsole: async (tabId: string) => {
      if (!store.state.tabs[tabId]) return;
      store.activate(String(tabId));
      // DevTools opens on the active Chromium tab, so wait for the background to show this one.
      for (let i = 0; i < 20; i++) {
        const chromeId = ctx.liveTabId(tabId);
        const tab = chromeId !== undefined ? await chrome.tabs.get(chromeId).catch(() => undefined) : undefined;
        if (tab?.active) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!run('openDevTools', { console: true })) broadcast('flash', `Press ${displayKeys('Alt+CmdOrCtrl+I')} for the console`);
    },
  });

  return {
    localServers: () => servers.servers(),
    consoleErrors: () => consoleErrors(flechaIdFor),
    boostedHosts: () => boosts.boostedHosts(),
  };
}
