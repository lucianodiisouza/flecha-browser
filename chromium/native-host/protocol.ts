/**
 * What the shell extension (chromium/shell/nativeHost.ts) and the native messaging host
 * (host.ts) say to each other. Chromium frames each message as JSON with a length prefix;
 * the host's messages may be at most 1 MB, so bigger ones go as `chunk`s.
 */

/** The host's name in its manifest and in chrome.runtime.connectNative. */
export const HOST_NAME = 'dev.oprimo.flecha.host';

/** Things only Node can do, which the shell asks for and the host answers with a `reply`. */
export interface HostMethods {
  detectBrowsers(): import('../shared/types').DetectedBrowser[];
  readBrowser(id: string): import('../shared/importApply').BrowserImportData;
  /** A bookmarks file exported from any browser as HTML, by its text; `fileName` is for warnings. */
  readBookmarksHtml(html: string, fileName?: string): import('../shared/importApply').BrowserImportData;
  /** The Electron spike's saved state (its flecha-state.json), if it has one. */
  readFlechaState(): string | undefined;
}

export type ToShell =
  | { type: 'reply'; id: number; value?: unknown; error?: string }
  /** The agent bridge started (with its address), stopped, or failed. */
  | { type: 'agent'; endpoint?: string; error?: string }
  /** A coding agent called a tool: the shell runs it and answers with a `toolResult`. */
  | { type: 'tool'; id: number; name: string; args: Record<string, unknown> }
  /** One part of a message too big to send at once; the parts, joined, are its JSON. */
  | { type: 'chunk'; id: number; index: number; total: number; data: string };

export type ToHost =
  | { type: 'call'; id: number; method: keyof HostMethods; params: unknown[] }
  /** Starts or stops the agent bridge; the token is checked on every request. */
  | { type: 'agent'; enabled: boolean; token: string }
  | { type: 'toolResult'; id: number; result: import('../shared/agentTools').AgentResult };
