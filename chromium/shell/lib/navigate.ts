/**
 * Takes a tab to an address the user typed or picked in Flecha: the command bar, a Flechinha's
 * address, the next environment, a favorite's or pinned tab's home.
 *
 * The browser navigates it as the omnibox would (flechaPrivate.navigate, patch 0061). With
 * tabs.update() Chromium counts it as the extension's navigation, and then the page left
 * behind is skipped by Back unless someone clicked or typed in it: you go from one site to
 * another by its address and Back has nowhere to go. Without the patch, or for what the
 * browser won't take (a javascript: URL), tabs.update() as before.
 */
export async function navigateTab(tabId: number, url: string): Promise<void> {
  if (typeof chrome.flechaPrivate?.navigate === 'function' && !/^javascript:/i.test(url)) {
    try {
      return await chrome.flechaPrivate.navigate(tabId, url);
    } catch {
      // Falls through to tabs.update(), which reports its own errors.
    }
  }
  await chrome.tabs.update(tabId, { url });
}
