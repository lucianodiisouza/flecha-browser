/**
 * Settings in the Chromium shell's background: the same rules as Electron's Settings window
 * (lib/settingsCore.ts, lib/tabManager.ts), answering the Settings page over the hub.
 * Every name starts with `settings:` so it never clashes with the sidebar's.
 */
import type { SettingsPatch, SettingsView, TabsEdit } from '../shared/types';
import type { Store } from '../shared/store';
import { applySettings, renewAgentToken, settingsView } from './lib/settingsCore';
import { IS_MAC } from './lib/shortcuts';
import { TabManager, type AskOptions, type TabsMenuRequest, type TabsMenuRun } from './lib/tabManager';
import { broadcast, handle } from './hub';

export interface SettingsContext {
  store: Store;
  /** Closes the Chromium tabs of these Flecha tabs; they reopen from the Store when next shown. */
  unload(tabIds: string[]): void;
  /** Sends every page the new state, as after any change from the sidebar. */
  broadcastState(): void;
  /** Whether a Flecha tab has a live Chromium tab. Without it, Tabs & Spaces shows every tab as closed. */
  isOpen?(tabId: string): boolean;
  /** Navigates a Flecha tab's live Chromium tab. Without it, the tab is unloaded and reopens at the new address. */
  load?(tabId: string, url: string): void;
  /** The agent bridge's address while it runs (nativeHost.ts). */
  agentEndpoint?(): string | undefined;
  /** Whether Flecha is the default browser, and whether it can become it (patch 0027). */
  defaultBrowser?(): { isDefault: boolean; canSet: boolean };
  /** Asks macOS to make Flecha the default browser. */
  makeDefaultBrowser?(): Promise<void>;
}

/** What a stub answers with, so the page can say so instead of doing nothing. */
export interface NotYet {
  notYet: string;
}

const notYet = (what: string): NotYet => ({ notYet: `${what} isn't in the Chromium build yet.` });

export function registerSettings(ctx: SettingsContext) {
  const { store } = ctx;

  // Questions go to the open Settings page, which answers with the button's index.
  const questions = new Map<number, (response: number) => void>();
  let nextQuestion = 1;
  const ask = (options: AskOptions) =>
    new Promise<number>((resolve) => {
      const id = nextQuestion++;
      // A page that closes without answering counts as Cancel.
      const timer = setTimeout(() => answer(options.cancelId), 10 * 60_000);
      const answer = (response: number) => {
        clearTimeout(timer);
        questions.delete(id);
        resolve(response);
      };
      questions.set(id, answer);
      broadcast('settings:ask', id, options);
    });

  const tabs = new TabManager(store, {
    isOpen: (tabId) => ctx.isOpen?.(tabId) ?? false,
    load: (tabId, url) => (ctx.load ? ctx.load(tabId, url) : ctx.unload([tabId])),
    destroyView: (tabId) => ctx.unload([tabId]),
    show: (tabId) => {
      // The background follows the Store's active tab into Chromium.
      store.activate(tabId);
      ctx.broadcastState();
    },
    // TODO(chromium): site icons come from chrome://favicon2 / _favicon, not a favicon:// cache; tabs use their own favicon URL for now.
    faviconHosts: () => [],
    // A Space with separate cookies and logins has its own storage partition, named after it
    // (background.ts partitionFor, patch 0034): tabs moving across it reopen in the other one.
    sessionOf: (space) => (space?.isolated ? space.id : 'default'),
    ask,
    push: (view) => broadcast('settings:tabs', view),
  });

  const view = (): SettingsView =>
    settingsView(store, {
      // TODO(chromium): Chromium's download folder (prefs download.default_directory) isn't readable from an extension.
      downloadsFolder: store.state.downloadsFolder ?? '~/Downloads',
      defaultBrowser: ctx.defaultBrowser?.() ?? { isDefault: false, canSet: false },
      agentEndpoint: ctx.agentEndpoint?.(),
    });

  handle({
    'settings:get': view,
    'settings:set': async (patch: SettingsPatch) => {
      const notice = await applySettings(store, patch && typeof patch === 'object' ? patch : {}, {
        // TODO(chromium): Chromium's own light/dark mode isn't settable from an extension; Flecha's pages follow the system.
        theme: () => {},
        // TODO(chromium): no agent bridge yet; the choice is kept for when there is one.
        agent: async () => {},
        // features/adblock.ts follows state.adBlock itself, whoever sets it.
        adBlock: async () => {},
      });
      ctx.broadcastState();
      return { ...view(), notice };
    },
    'settings:new-agent-token': () => {
      renewAgentToken(store);
      return view();
    },
    // TODO(chromium): needs a native folder picker.
    'settings:choose-downloads-folder': () => ({ ...view(), ...notYet('Choosing the downloads folder') }),
    'settings:make-default-browser': async () => {
      if (!ctx.makeDefaultBrowser) return { ...view(), ...notYet('Making Flecha the default browser') };
      await ctx.makeDefaultBrowser();
      return view();
    },
    // 'settings:open-boosts' opens the Boosts page; features.ts handles it.
    // TODO(chromium): the welcome tour (ui/onboarding.ts) isn't in the shell's sidebar yet.
    'settings:show-tour': () => notYet('The welcome tour'),
    // TODO(chromium): there's no extension API for the macOS emoji picker; ⌃⌘Space opens it.
    'settings:emoji-panel': () => notYet(IS_MAC ? 'The emoji picker button (press ⌃⌘Space)' : 'The emoji picker button'),

    'settings:tabs': () => tabs.view(),
    'settings:edit-tabs': (edit: TabsEdit) => tabs.edit(edit),
    'settings:tabs-menu': (request: TabsMenuRequest) => tabs.menu(request),
    'settings:tabs-menu-run': (run: TabsMenuRun) => (run && typeof run === 'object' ? tabs.run(run) : undefined),
    'settings:show-tab': (tabId: string) => tabs.show(tabId),
    'settings:answer': (id: number, response: number) => questions.get(id)?.(Number(response)),
  });

  return { tabs, view };
}

/** The Settings page's address; a hash picks the pane (`#shortcuts`). */
export const SETTINGS_PAGE = 'settings.html';

/** Opens Settings in a tab, or brings the open one forward on the given pane. */
export async function openSettings(pane?: string) {
  const url = chrome.runtime.getURL(SETTINGS_PAGE);
  // Match patterns don't cover chrome-extension:// URLs, so compare addresses instead.
  const open = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(url));
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true });
    if (pane) broadcast('settings:pane', pane);
    return;
  }
  // Its own small window, as in Electron, not a tab among the pages; centred on Flecha's window.
  const main = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const size = { width: 780, height: 580 };
  const at =
    main?.left !== undefined && main.width !== undefined && main.top !== undefined && main.height !== undefined
      ? { left: Math.round(main.left + (main.width - size.width) / 2), top: Math.round(main.top + (main.height - size.height) / 3) }
      : {};
  await chrome.windows.create({ url: pane ? `${url}#${pane}` : url, type: 'popup', focused: true, ...size, ...at });
}
