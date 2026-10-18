import { Buffer } from 'buffer';

globalThis.Buffer = globalThis.Buffer ?? Buffer;
globalThis.__dirname = globalThis.__dirname ?? '/';
// Browser / WKWebView: Node `process` is absent. Chain modules and some deps
// read process.env at import time — stub before any other app code runs.
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {}, browser: true, cwd: () => '/' };
} else if (!globalThis.process.env) {
  globalThis.process.env = {};
}
// Localnet Arcium cluster offset — avoid getArciumEnv() in WebView share/bet paths.
if (globalThis.process.env.ARCIUM_CLUSTER_OFFSET == null) {
  globalThis.process.env.ARCIUM_CLUSTER_OFFSET = '0';
}
if (globalThis.process.env.ARCIUM_BACKUP_CLUSTER_OFFSET == null) {
  globalThis.process.env.ARCIUM_BACKUP_CLUSTER_OFFSET = '0';
}
