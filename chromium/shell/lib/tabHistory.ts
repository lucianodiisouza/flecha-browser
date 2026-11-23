/** Whether a tab has a page to go back to, and one to go forward to. */
export interface TabHistory {
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * Chromium's extension APIs don't say, so the browser is asked (getTabHistory, patch 0056).
 * Without the patch both buttons stay on, as they did before.
 */
export async function tabHistory(tabId: number): Promise<TabHistory> {
  if (typeof chrome.flechaPrivate?.getTabHistory === 'function') {
    const history = await chrome.flechaPrivate.getTabHistory(tabId).catch(() => undefined);
    if (history) return history;
  }
  return { canGoBack: true, canGoForward: true };
}
