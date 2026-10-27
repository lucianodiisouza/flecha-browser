/**
 * Flecha's native messaging host: the parts of the Electron spike that need Node, for the
 * Chromium build's shell extension, which can't read files or listen on a port.
 *
 * - Importing from other browsers (browserImport.ts), or from a bookmarks file one exported:
 *   the host reads, the shell adds.
 * - The Electron spike's own saved state, for "import from Flecha".
 * - The agent bridge (agentServer.ts): an MCP server on 127.0.0.1 whose tool calls
 *   go to the shell, which runs them with chrome.tabs, chrome.scripting and chrome.debugger.
 *
 * Chromium starts it when the shell calls chrome.runtime.connectNative and stops it (closes
 * stdin) when the port closes. stdout carries only messages; logs go to stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectBrowsers, readBookmarksHtml, readBrowser } from './browserImport';
import { AGENT_TOOLS, McpBridge, fail, type AgentResult } from './agentServer';
import type { HostMethods, ToHost, ToShell } from './protocol';

const SHELL_ORIGIN = 'chrome-extension://abdiaepfgbbhdjaecjipmaailijaaide/';
/** Chromium refuses messages from a host over 1 MB; leave room for the chunk's own fields. */
const MAX_MESSAGE = 1024 * 1024 - 1024;
const CHUNK = 128 * 1024;
/** How long a tool may take in the shell before the agent is told it failed. */
const TOOL_TIMEOUT = 60_000;

const log = (...args: unknown[]) => console.error('[flecha-host]', ...args);

// Chromium passes the caller's origin first; only the shell may use the host.
const caller = process.argv.find((a) => a.startsWith('chrome-extension://'));
if (caller && caller !== SHELL_ORIGIN) {
  log('refusing', caller);
  process.exit(1);
}

// ---- framing: a 32-bit length in native byte order (little-endian on Macs), then JSON ----

let nextChunk = 1;
function send(message: ToShell) {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) <= MAX_MESSAGE) return write(json);
  // A UTF-16 unit is at most 6 bytes once escaped again for the chunk, so CHUNK units fit.
  const id = nextChunk++;
  const size = CHUNK;
  const total = Math.ceil(json.length / size);
  for (let index = 0; index < total; index++) {
    write(JSON.stringify({ type: 'chunk', id, index, total, data: json.slice(index * size, (index + 1) * size) } satisfies ToShell));
  }
}

function write(json: string) {
  const body = Buffer.from(json);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (data: Buffer) => {
  pending = Buffer.concat([pending, data]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (pending.length < 4 + length) break;
    const body = pending.subarray(4, 4 + length).toString('utf8');
    pending = pending.subarray(4 + length);
    try {
      void receive(JSON.parse(body) as ToHost);
    } catch (err) {
      log('bad message', err);
    }
  }
});
process.stdin.on('end', () => void bridge.stop().finally(() => process.exit(0)));

// ---- what the shell asks for --------------------------------------------------

const methods: { [K in keyof HostMethods]: (...args: any[]) => Promise<ReturnType<HostMethods[K]>> | ReturnType<HostMethods[K]> } = {
  detectBrowsers: () => detectBrowsers(),
  readBrowser: (id: string) => readBrowser(String(id)),
  readBookmarksHtml: (html: string, fileName?: string) => readBookmarksHtml(String(html), fileName ? String(fileName) : undefined),
  readFlechaState: () => {
    const file = path.join(os.homedir(), 'Library', 'Application Support', 'Flecha', 'flecha-state.json');
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
};

async function receive(message: ToHost) {
  if (message.type === 'call') {
    const method = methods[message.method];
    try {
      if (!method) throw new Error(`No method ${message.method}`);
      send({ type: 'reply', id: message.id, value: await method(...(message.params ?? [])) });
    } catch (err) {
      send({ type: 'reply', id: message.id, error: err instanceof Error ? err.message : String(err) });
    }
  } else if (message.type === 'agent') {
    token = String(message.token ?? '');
    await setAgent(!!message.enabled && !!token);
  } else if (message.type === 'toolResult') {
    tools.get(message.id)?.(message.result);
  }
}

// ---- the agent bridge -----------------------------------------------------------

let token = '';
let nextTool = 1;
const tools = new Map<number, (result: AgentResult) => void>();

/** Each tool, as agentServer.ts describes it, is run by the shell. */
function register(mcp: McpServer) {
  for (const [name, spec] of Object.entries(AGENT_TOOLS)) {
    const run = (args: Record<string, unknown> = {}) =>
      new Promise<AgentResult>((resolve) => {
        const id = nextTool++;
        const wait = TOOL_TIMEOUT + (typeof args.timeoutMs === 'number' ? args.timeoutMs : 0);
        const timer = setTimeout(() => finish(fail(`Flecha didn’t answer ${name} within ${wait / 1000}s`)), wait);
        const finish = (result: AgentResult) => {
          clearTimeout(timer);
          tools.delete(id);
          resolve(result);
        };
        tools.set(id, finish);
        send({ type: 'tool', id, name, args });
      });
    // The specs are typed one by one; in a loop they're all the same to us.
    (mcp.registerTool as (name: string, spec: object, cb: (args: Record<string, unknown>) => Promise<AgentResult>) => void)(
      name,
      spec,
      (args) => run('inputSchema' in spec ? args : {}),
    );
  }
}

const bridge = new McpBridge(register, () => token);

let agentChange = Promise.resolve();
function setAgent(enabled: boolean) {
  agentChange = agentChange.then(async () => {
    try {
      if (enabled) await bridge.start();
      else await bridge.stop();
      send({ type: 'agent', endpoint: bridge.port ? `http://127.0.0.1:${bridge.port}/mcp` : undefined });
    } catch (err) {
      log('agent bridge failed', err);
      send({ type: 'agent', error: err instanceof Error ? err.message : String(err) });
    }
  });
  return agentChange;
}

log('ready', process.pid);
