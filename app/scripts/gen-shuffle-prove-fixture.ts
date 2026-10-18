#!/usr/bin/env bun
/** Writes app/ios/testdata/shuffle_prove_payload.json for native iOS shuffle prove E2E. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Game } from '../../src/poker-game.ts';
import { Player } from '../../src/poker-player.ts';
import { preloadCircuits } from '../../src/circuit-manager.ts';
import { padPublicKeysForShuffle } from '../../src/shuffle-common.ts';
import { generateWitnessFfi } from '../../src/witness.ts';

function normalizeParams(params: Record<string, unknown>): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    let v: unknown = value;
    if (!Array.isArray(v)) v = [v];
    const flat = (v as unknown[]).flat(5);
    normalized[key] = flat.map((item) =>
      typeof item === 'bigint' || typeof item === 'number' ? String(item) : String(item),
    );
  }
  return normalized;
}

const outPath = join(import.meta.dir, '../ios/testdata/shuffle_prove_payload.json');
mkdirSync(dirname(outPath), { recursive: true });

const circuits = await preloadCircuits();
const player = new Player(circuits);
await player.init();
player.generateKey();
const game = new Game();
await game.init();
const reg = await player.registerProve();
game.addPlayer(reg.proof, reg.publicSignals, { verified: true });
game.start();
const deck = game.deck;
const keys = padPublicKeysForShuffle(game.publicKeys);
player.preloadShuffle(deck, keys);

const origProve = circuits.shuffle.prove.bind(circuits.shuffle);
let captured: Record<string, string[]> | null = null;
circuits.shuffle.prove = async (params) => {
  captured = normalizeParams(params as Record<string, unknown>);
  throw new Error('fixture-capture');
};
try {
  await player.shuffleProve(deck, keys);
} catch {
  // expected
}
if (!captured) {
  throw new Error('failed to capture shuffle prove input');
}

const payload = {
  circuitName: 'shuffle_1_deck_52_main',
  input: captured,
};
writeFileSync(outPath, JSON.stringify(payload));

const wtnsPath = join(dirname(outPath), 'shuffle_prove.wtns');
try {
  const wtns = generateWitnessFfi('shuffle_1_deck_52_main', captured);
  writeFileSync(wtnsPath, wtns);
  console.log(`[gen-shuffle-prove-fixture] wrote ${wtnsPath} (${wtns.length} bytes)`);
} catch (err) {
  console.warn(
    `[gen-shuffle-prove-fixture] skipped ${wtnsPath} (Mac witness FFI unavailable):`,
    err instanceof Error ? err.message : err,
  );
}
console.log(`[gen-shuffle-prove-fixture] wrote ${outPath} (${JSON.stringify(payload).length} bytes)`);
