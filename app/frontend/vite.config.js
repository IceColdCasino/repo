import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { solanaTableApiPlugin } from './vite-plugin-solana-table-api.js';

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendDir, '../..');

/** Force server-only poker modules onto browser shims (including async chunks). */
function browserPokerShims() {
  const entries = [
    ['zk-verify', path.join(frontendDir, 'src/poker/zk-verify-shim.ts')],
    ['rapidsnark-ffi', path.join(frontendDir, 'src/poker/rapidsnark-shim.ts')],
    ['zkey-cache', path.join(frontendDir, 'src/poker/zkey-cache-shim.ts')],
    ['witness', path.join(frontendDir, 'src/poker/witness-shim.ts')],
    ['circuit', path.join(frontendDir, 'src/poker/circuit-shim.ts')],
    ['player-ffi', path.join(frontendDir, 'src/poker/player-ffi-shim.ts')],
    ['player-bridge-ffi', path.join(frontendDir, 'src/poker/player-bridge-ffi-shim.ts')],
    ['assert', path.join(frontendDir, 'src/poker/assert-shim.ts')],
    ['node:assert', path.join(frontendDir, 'src/poker/assert-shim.ts')],
    ['process', path.join(frontendDir, 'src/poker/process-shim.ts')],
    ['node:process', path.join(frontendDir, 'src/poker/process-shim.ts')],
  ];

  function shimFor(source) {
    const normalized = source.replace(/\\/g, '/');
    for (const [name, shimPath] of entries) {
      if (
        normalized === name
        || normalized.endsWith(`/${name}`)
        || normalized.endsWith(`/${name}.ts`)
        || normalized.endsWith(`/${name}.js`)
      ) {
        return shimPath;
      }
    }
    return null;
  }

  return {
    name: 'browser-poker-shims',
    enforce: 'pre',
    resolveId(source, _importer, options) {
      if (options?.ssr) {
        return null;
      }
      return shimFor(source);
    },
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/poker-player.ts')) return null;
      const needle = 'ffi.requirePlayerBridge();';
      if (!code.includes(needle)) return null;
      return code.replace(
        needle,
        'if (!ffi.playerBridgeFfiAvailable()) return false;\n    ffi.requirePlayerBridge();',
      );
    },
  };
}

/** WKWebView + zero://: static entry in body only — no dynamic import, no head module scripts. */
function nativeWebViewHtml() {
  /** @type {{ bufferSrc: string | null, mainSrc: string | null, cssHref: string | null }} */
  let scripts = { bufferSrc: null, mainSrc: null, cssHref: null };

  function collectScripts(bundle) {
    let bufferSrc = null;
    let mainSrc = null;
    let mainBytes = 0;
    let cssHref = null;
    for (const [fileName, chunk] of Object.entries(bundle)) {
      if (fileName.endsWith('.css') && chunk.type === 'asset') {
        cssHref = `./assets/${path.basename(fileName)}`;
        continue;
      }
      if (chunk.type !== 'chunk') continue;
      const base = `./assets/${path.basename(fileName)}`;
      const baseName = path.basename(fileName);
      if (baseName.includes('buffer-polyfill')) {
        bufferSrc = base;
        continue;
      }
      const isHtmlEntry = chunk.isEntry === true
        || /^index-[^.]+\.js$/.test(baseName)
        || baseName.includes('main-');
      if (!isHtmlEntry) continue;
      const size = chunk.code?.length ?? 0;
      if (size > mainBytes) {
        mainBytes = size;
        mainSrc = base;
      }
    }
    scripts = { bufferSrc, mainSrc, cssHref };
  }

  function collectScriptsFromDist() {
    const assetsDir = path.join(frontendDir, 'dist/assets');
    if (!fs.existsSync(assetsDir)) return;
    let bufferSrc = scripts.bufferSrc;
    let mainSrc = scripts.mainSrc;
    let mainBytes = 0;
    let cssHref = scripts.cssHref;
    for (const name of fs.readdirSync(assetsDir)) {
      if (name.endsWith('.css') && !cssHref) {
        cssHref = `./assets/${name}`;
        continue;
      }
      if (!name.endsWith('.js')) continue;
      if (name.includes('buffer-polyfill')) {
        bufferSrc = `./assets/${name}`;
        continue;
      }
      if (!/^index-[^.]+\.js$/.test(name) && !name.includes('main-')) continue;
      const size = fs.statSync(path.join(assetsDir, name)).size;
      if (size > mainBytes) {
        mainBytes = size;
        mainSrc = `./assets/${name}`;
      }
    }
    scripts = { bufferSrc, mainSrc, cssHref };
  }

  function rewriteHtml(html) {
    let out = html.replace(/\scrossorigin(="[^"]*")?/g, '');
    out = out.replace(/<script type="module"[^>]*><\/script>\n?/g, '');
    out = out.replace(/<link rel="stylesheet" href="\.\/assets\/[^"]+">\n?/g, '');

    const tags = [];
    if (scripts.cssHref) tags.push(`<link rel="stylesheet" href="${scripts.cssHref}">`);
    if (scripts.mainSrc) tags.push(`<script type="module" src="${scripts.mainSrc}"></script>`);
    if (tags.length === 0) return out;

    return out.replace('</body>', `    ${tags.join('\n    ')}\n  </body>`);
  }

  return {
    name: 'native-webview-html',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.bundle) collectScripts(ctx.bundle);
        return html.replace(/\scrossorigin(="[^"]*")?/g, '');
      },
    },
    closeBundle() {
      const htmlPath = path.join(frontendDir, 'dist/index.html');
      if (!fs.existsSync(htmlPath)) return;
      if (!scripts.mainSrc) collectScriptsFromDist();
      const html = fs.readFileSync(htmlPath, 'utf8');
      fs.writeFileSync(htmlPath, rewriteHtml(html));
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  define: {
    global: 'globalThis',
  },
  plugins: [
    browserPokerShims(),
    svelte(),
    nativeWebViewHtml(),
    // Opt-in only (VITE_SOLANA_TABLE_API=1). Default Solana gameplay uses
    // in-WebView executePerSeatOp → RPC (not Vite /api/game*). The apps never launch Bun.
    ...(process.env.VITE_SOLANA_TABLE_API === '1'
      ? [solanaTableApiPlugin(repoRoot)]
      : []),
  ],
  optimizeDeps: {
    include: [
      'buffer',
      '@coral-xyz/anchor',
      '@solana/web3.js',
      '@solana/spl-token',
      '@noble/hashes/sha256',
    ],
  },
  resolve: {
    alias: [
      {
        find: /[/\\]src[/\\]zk-verify(\.ts)?$/,
        replacement: path.join(frontendDir, 'src/poker/zk-verify-shim.ts'),
      },
      {
        find: /[/\\]src[/\\]rapidsnark-ffi(\.ts)?$/,
        replacement: path.join(frontendDir, 'src/poker/rapidsnark-shim.ts'),
      },
      {
        find: /[/\\]src[/\\]zkey-cache(\.ts)?$/,
        replacement: path.join(frontendDir, 'src/poker/zkey-cache-shim.ts'),
      },
      {
        find: /[/\\]src[/\\]circuit(\.ts)?$/,
        replacement: path.join(frontendDir, 'src/poker/circuit-shim.ts'),
      },
      {
        find: /[/\\]src[/\\]player-ffi(\.ts)?$/,
        replacement: path.join(frontendDir, 'src/poker/player-ffi-shim.ts'),
      },
      {
        find: /[/\\]src[/\\]player-bridge-ffi(\.ts)?$/,
        replacement: path.join(frontendDir, 'src/poker/player-bridge-ffi-shim.ts'),
      },
      ...(command === 'build'
        ? [{
            find: 'circomlibjs',
            replacement: path.join(frontendDir, 'src/poker/circomlibjs-shim.ts'),
          }]
        : []),

      { find: 'buffer', replacement: 'buffer/' },
      { find: '@poker-src', replacement: path.join(repoRoot, 'src') },
      // Force Node ESM Anchor (browser build omits Wallet / Provider).
      {
        find: '@coral-xyz/anchor',
        replacement: path.join(frontendDir, 'src/poker/anchor-browser.ts'),
      },
      {
        find: '@anchor-lang/core',
        replacement: path.join(frontendDir, 'src/poker/anchor-lang-browser.ts'),
      },
      { find: /^assert$/, replacement: path.join(frontendDir, 'src/poker/assert-shim.ts') },
      { find: 'node:assert', replacement: path.join(frontendDir, 'src/poker/assert-shim.ts') },
      { find: 'node:path', replacement: path.join(frontendDir, 'src/poker/node-path-shim.ts') },
      { find: 'node:fs', replacement: path.join(frontendDir, 'src/poker/node-fs-shim.ts') },
      { find: /^fs$/, replacement: path.join(frontendDir, 'src/poker/node-fs-shim.ts') },
      { find: 'node:os', replacement: path.join(frontendDir, 'src/poker/node-os-shim.ts') },
      { find: /^os$/, replacement: path.join(frontendDir, 'src/poker/node-os-shim.ts') },
      { find: 'node:child_process', replacement: path.join(frontendDir, 'src/poker/node-child-process-shim.ts') },
      { find: /^child_process$/, replacement: path.join(frontendDir, 'src/poker/node-child-process-shim.ts') },
      { find: 'node:crypto', replacement: path.join(frontendDir, 'node_modules/crypto-browserify/index.js') },
      { find: /^crypto$/, replacement: path.join(frontendDir, 'node_modules/crypto-browserify/index.js') },
      { find: 'node:stream', replacement: path.join(frontendDir, 'node_modules/stream-browserify/index.js') },
      { find: /^stream$/, replacement: path.join(frontendDir, 'node_modules/stream-browserify/index.js') },
      { find: /^events$/, replacement: path.join(frontendDir, 'node_modules/events/events.js') },
      { find: 'bun:ffi', replacement: path.join(frontendDir, 'src/poker/bun-ffi-shim.ts') },
      // Anchor / Node deps import bare `process` — must not be externalized as undefined.
      { find: /^process$/, replacement: path.join(frontendDir, 'src/poker/process-shim.ts') },
      { find: 'node:process', replacement: path.join(frontendDir, 'src/poker/process-shim.ts') },
    ],
    // Prefer Node Anchor build so provider APIs resolve; KeypairWallet is used for signing.
    conditions: ['import', 'module', 'browser', 'default'],
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3847',
    },
    fs: {
      allow: [repoRoot, frontendDir],
    },
  },
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:3847',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
  build: {
    modulePreload: false,
    rolldownOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
}));
