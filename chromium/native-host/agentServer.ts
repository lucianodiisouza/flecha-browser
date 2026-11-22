import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const DEFAULT_AGENT_PORT = 7390;

/**
 * An MCP server (Streamable HTTP) that lets coding agents see and drive Flecha's tabs.
 *
 * It only listens on 127.0.0.1, only answers requests whose Host is local, and every
 * request needs the bearer token shown in Settings. `register` adds the tools.
 */
export class McpBridge {
  private server?: http.Server;
  port?: number;

  constructor(
    private register: (mcp: McpServer) => void,
    private token: () => string,
  ) {}

  async start(preferredPort = DEFAULT_AGENT_PORT) {
    if (this.server) return;
    for (let port = preferredPort; port < preferredPort + 10; port++) {
      const server = http.createServer((req, res) => void this.handle(req, res));
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.port = port;
        return;
      }
    }
    throw new Error('No free port for the agent bridge');
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(hostname)) return reply(res, 403, 'Forbidden host');
    const token = this.token();
    if (!token || req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, 'Missing or wrong token');
    if (!req.url?.startsWith('/mcp')) return reply(res, 404, 'Not found');

    // Stateless: a fresh server and transport per request, as the SDK recommends.
    const mcp = new McpServer({ name: 'flecha', version: '0.1.0' });
    this.register(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
  }
}

function reply(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(message);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
