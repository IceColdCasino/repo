/** Browser shim for Node `process` (Anchor and chain modules). */
const env: Record<string, string | undefined> = {};

const processShim = {
  env,
  browser: true,
  cwd: () => '/',
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => fn(...args));
  },
  version: '',
  versions: {},
};

export default processShim;
export { env };
