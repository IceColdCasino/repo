let origin = now();
const marks = new Map<string, number>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function resetTiming(label = 'timing origin'): void {
  origin = now();
  marks.clear();
  logTiming(label);
}

export function logTiming(label: string, detail?: string): void {
  const elapsed = now() - origin;
  const suffix = detail ? ` ${detail}` : '';
  console.log(`[timing +${elapsed.toFixed(0)}ms] ${label}${suffix}`);
}

export function markTiming(label: string): void {
  marks.set(label, now());
}

export function elapsedSince(label: string, detail?: string): number {
  const start = marks.get(label);
  if (start === undefined) {
    logTiming(`${label} (no mark)`, detail);
    return 0;
  }
  const delta = now() - start;
  console.log(`[timing ${label} ${delta.toFixed(0)}ms]${detail ? ` ${detail}` : ''}`);
  return delta;
}

export async function timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = now();
  logTiming(`${label} start`);
  markTiming(label);
  try {
    return await fn();
  } finally {
    elapsedSince(label, 'done');
    void start;
  }
}

export function timeSync<T>(label: string, fn: () => T): T {
  const start = now();
  logTiming(`${label} start`);
  markTiming(label);
  try {
    return fn();
  } finally {
    elapsedSince(label, 'done');
    void start;
  }
}

export function warnIfOverBudget(label: string, ms: number, budgetMs: number): void {
  if (ms > budgetMs) {
    console.warn(`[timing] ${label} exceeded ${budgetMs}ms budget (${ms.toFixed(0)}ms)`);
  }
}
