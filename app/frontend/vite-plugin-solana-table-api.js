/**
 * Mount LocalnetTableSession HTTP routes on Vite dev/preview so Solana dual
 * native clients share table state on the same origin as the UI — no :3850
 * chain worker required for gameplay.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} repoRoot
 * @returns {import('vite').Plugin}
 */
export function solanaTableApiPlugin(repoRoot) {
  /** @type {import('../../src/chain/localnet-table-api.ts').LocalnetTableApiHost | null} */
  let apiHost = null;
  /** @type {Promise<import('../../src/chain/localnet-table-api.ts').LocalnetTableApiHost> | null} */
  let loading = null;

  async function getHost() {
    if (apiHost) {
      return apiHost;
    }
    if (loading) {
      return loading;
    }
    loading = (async () => {
      const modUrl = pathToFileURL(
        path.join(repoRoot, 'src/chain/localnet-table-api.ts'),
      ).href;
      const { createLocalnetTableApiHost } = await import(modUrl);
      const host = createLocalnetTableApiHost({
        hostKind: 'vite-preview',
        eagerAttach: true,
      });
      host.ensureChainEventLog();
      apiHost = host;
      return host;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {() => void} next
   */
  async function middleware(req, res, next) {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    if (
      pathname !== '/health'
      && pathname !== '/api/health'
      && !pathname.startsWith('/api/game')
      && !pathname.startsWith('/api/games')
      && pathname !== '/api/admin/reset'
      && pathname !== '/api/debug/event-log'
    ) {
      next();
      return;
    }

    try {
      const host = await getHost();
      const { handleLocalnetTableRequest } = await import(
        pathToFileURL(path.join(repoRoot, 'src/chain/localnet-table-api.ts')).href
      );

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      /** @type {Record<string, string>} */
      const headerInit = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
          headerInit[key] = value;
        } else if (Array.isArray(value)) {
          headerInit[key] = value.join(', ');
        }
      }
      const request = new Request(new URL(url, origin), {
        method: req.method ?? 'GET',
        headers: headerInit,
        body: req.method && req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0
          ? body
          : undefined,
      });

      const response = await handleLocalnetTableRequest(host, request);
      if (!response) {
        next();
        return;
      }

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[solana-table-api]', message);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: message }));
    }
  }

  return {
    name: 'solana-table-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next);
      });
    },
  };
}
