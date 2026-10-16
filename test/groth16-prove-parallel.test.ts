/**
 * Two register proves must overlap. Shuffle stays serial in the hand; this
 * only checks the native prover can run two register witnesses at once.
 */
import { expect, test } from 'bun:test';
import { GameKind } from '../src/game-config';
import { tryOpenGameSession } from '../src/player-zig-session';
import { verifyCircuit } from '../src/zk-verify';

test('two register proves overlap', async () => {
  const warm = await tryOpenGameSession({ kind: GameKind.Craps });
  await warm.register();
  warm.close();

  const parallelSeats = await Promise.all([
    tryOpenGameSession({ kind: GameKind.Craps }),
    tryOpenGameSession({ kind: GameKind.Craps }),
  ]);
  const parallelStarted = performance.now();
  const parallel = await Promise.all(parallelSeats.map((seat) => seat.register()));
  const parallelMs = performance.now() - parallelStarted;
  for (const seat of parallelSeats) seat.close();

  const serialSeats = await Promise.all([
    tryOpenGameSession({ kind: GameKind.Craps }),
    tryOpenGameSession({ kind: GameKind.Craps }),
  ]);
  const serialStarted = performance.now();
  const first = await serialSeats[0]!.register();
  const second = await serialSeats[1]!.register();
  const serialMs = performance.now() - serialStarted;
  for (const seat of serialSeats) seat.close();

  expect(parallel[0]!.publicSignals[0]).not.toBe(parallel[1]!.publicSignals[0]);
  expect(first.publicSignals[0]).not.toBe(second.publicSignals[0]);
  for (const proved of [...parallel, first, second]) {
    expect(verifyCircuit('register_main', proved.proof, proved.publicSignals)).toBe(true);
  }
  console.log(`[prove-parallel] parallel ${parallelMs.toFixed(0)}ms serial ${serialMs.toFixed(0)}ms`);
  expect(parallelMs).toBeLessThan(serialMs * 0.85);
});
