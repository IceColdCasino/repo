#!/usr/bin/env bun
/**
 * Times showdown witness + Groth16 prove for seat 0 (p0) and seat 1 (p1).
 * Uses bridge-chain payloads when present; otherwise regenerates fixtures.
 *
 * Usage:
 *   bun app/scripts/benchmark-showdown-prove.ts
 *   bun app/scripts/benchmark-showdown-prove.ts --seat=1 --runs=2
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { preloadCircuits, releaseLoadedProvers } from '../../src/circuit-manager.ts';
import { generateWitnessFfi } from '../../src/witness.ts';
import { getSharedProver } from '../../src/zkey-cache.ts';
import { warnIfOverBudget } from '../../src/timing-log.ts';

const ROOT = join(import.meta.dir, '../..');
const PAYLOAD_DIR = join(ROOT, 'app/ios/testdata/bridge-chain');
const CIRCUIT = 'poker_showdown_hashout_main';
const BUDGET_MS = 60_000;

type Payload = { circuitName: string; input: Record<string, string[]> };

function parseArgs() {
  const seats = new Set<number>();
  let runs = 2;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--seat=')) {
      seats.add(Number(arg.slice('--seat='.length)));
    } else if (arg.startsWith('--runs=')) {
      runs = Math.max(1, Number(arg.slice('--runs='.length)));
    }
  }
  if (seats.size === 0) {
    seats.add(0);
    seats.add(1);
  }
  return { seats, runs };
}

function loadPayload(seat: number): Payload {
  const path = join(PAYLOAD_DIR, `showdown_p${seat}_payload.json`);
  if (!existsSync(path)) {
    throw new Error(`missing ${path} — run: bun app/scripts/bridge-chain/generate-fixtures.ts`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Payload;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function timeShowdownRun(
  seat: number,
  runIndex: number,
  warmZkey: boolean,
): Promise<{ witnessMs: number; proveMs: number; totalMs: number; wtnsBytes: number }> {
  const payload = loadPayload(seat);
  if (payload.circuitName !== CIRCUIT) {
    throw new Error(`expected ${CIRCUIT}, got ${payload.circuitName}`);
  }

  const circuits = await preloadCircuits();
  releaseLoadedProvers(circuits);
  await circuits.showdown.load();

  const zkeyPath = join(ROOT, `zkey/${CIRCUIT}_0001.zkey`);
  const params = payload.input;

  const witnessStart = nowMs();
  const witness = await generateWitnessFfi(CIRCUIT, params);
  const witnessMs = nowMs() - witnessStart;

  const prover = getSharedProver(zkeyPath);
  const proveStart = nowMs();
  await prover.prove(witness);
  const proveMs = nowMs() - proveStart;
  const totalMs = witnessMs + proveMs;

  const label = `showdown p${seat} run${runIndex}${warmZkey ? ' (warm zkey)' : ' (cold zkey)'}`;
  console.log(
    `[benchmark] ${label}: witness=${witnessMs.toFixed(0)}ms prove=${proveMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms wtns=${witness.length}`,
  );
  warnIfOverBudget(label, totalMs, BUDGET_MS);

  return { witnessMs, proveMs, totalMs, wtnsBytes: witness.length };
}

async function main() {
  const { seats, runs } = parseArgs();
  console.log(`[benchmark] showdown prove budget=${BUDGET_MS}ms seats=[${[...seats].join(',')}] runs=${runs}`);

  const summary: Record<string, { witnessMs: number[]; proveMs: number[]; totalMs: number[] }> = {};

  for (const seat of [...seats].sort()) {
    const key = `p${seat}`;
    summary[key] = { witnessMs: [], proveMs: [], totalMs: [] };
    for (let run = 0; run < runs; run += 1) {
      const result = await timeShowdownRun(seat, run + 1, run > 0);
      summary[key]!.witnessMs.push(result.witnessMs);
      summary[key]!.proveMs.push(result.proveMs);
      summary[key]!.totalMs.push(result.totalMs);
    }
  }

  console.log('\n[benchmark] summary');
  for (const [key, stats] of Object.entries(summary)) {
    const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const minTotal = Math.min(...stats.totalMs);
    const maxTotal = Math.max(...stats.totalMs);
    console.log(
      `  ${key}: witness avg=${avg(stats.witnessMs).toFixed(0)}ms prove avg=${avg(stats.proveMs).toFixed(0)}ms total min=${minTotal.toFixed(0)}ms max=${maxTotal.toFixed(0)}ms`,
    );
    if (minTotal > BUDGET_MS) {
      console.warn(`  ${key}: exceeds ${BUDGET_MS}ms budget even on best run`);
    }
  }
}

main().catch((err) => {
  console.error('[benchmark] fatal:', err);
  process.exit(1);
});
