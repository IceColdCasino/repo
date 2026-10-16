import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEVNET_ARCIUM_IN_FLIGHT,
  casinoRevealConcurrency,
  devnetArcis,
  arciumQueueGateMax,
  kenoRevealConcurrency,
  KENO_REVEAL_IN_FLIGHT,
  revealCardConcurrency,
  revealConcurrencyProduct,
  revealLimbConcurrency,
  revealRecipientConcurrency,
  shareChunkConcurrency,
  sharePlayerConcurrency,
} from '../src/arcium/heap';

const ENV_KEYS = [
  'E2E_CLUSTER',
  'ARCIUM_CLUSTER',
  'SHARE_VERIFY_PLAYER_CONCURRENCY',
  'SHARE_CHUNK_CONCURRENCY',
  'CASINO_REVEAL_CONCURRENCY',
  'KENO_REVEAL_CONCURRENCY',
  'REVEAL_RECIPIENT_CONCURRENCY',
  'REVEAL_CARD_CONCURRENCY',
  'REVEAL_LIMB_CONCURRENCY',
] as const;

const saved: Record<string, string | undefined> = {};

function clearConcurrencyEnv(): void {
  for (const key of ENV_KEYS) {
    if (!(key in saved)) saved[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('arcis concurrency', () => {
  test('localnet keeps share folds and N>2 reveal serial', () => {
    clearConcurrencyEnv();
    expect(devnetArcis()).toBe(false);
    expect(arciumQueueGateMax()).toBe(2);
    expect(sharePlayerConcurrency(2, 1)).toBe(1);
    expect(shareChunkConcurrency(2)).toBe(1);
    expect(casinoRevealConcurrency(20)).toBe(1);
    expect(kenoRevealConcurrency(20)).toBe(1);
    expect(revealConcurrencyProduct(10, 2)).toBe(1);
    expect(revealLimbConcurrency(10)).toBe(1);
    expect(revealCardConcurrency(2, 5)).toBe(5);
    expect(revealRecipientConcurrency(2, true)).toBe(2);
  });

  test('devnet overlaps seats, folds, and reveal cards', () => {
    clearConcurrencyEnv();
    process.env.E2E_CLUSTER = 'devnet';
    expect(devnetArcis()).toBe(true);
    expect(sharePlayerConcurrency(2, 1)).toBe(2);
    expect(shareChunkConcurrency(2)).toBe(DEVNET_ARCIUM_IN_FLIGHT / 2);
    expect(shareChunkConcurrency(1)).toBe(DEVNET_ARCIUM_IN_FLIGHT);
    expect(sharePlayerConcurrency(10, 3)).toBe(DEVNET_ARCIUM_IN_FLIGHT);
    expect(casinoRevealConcurrency(20)).toBe(DEVNET_ARCIUM_IN_FLIGHT);
    expect(kenoRevealConcurrency(20)).toBe(KENO_REVEAL_IN_FLIGHT);
    expect(arciumQueueGateMax()).toBe(KENO_REVEAL_IN_FLIGHT);
    expect(kenoRevealConcurrency(20, 2)).toBe(KENO_REVEAL_IN_FLIGHT);
    expect(kenoRevealConcurrency(20, 12)).toBe(1);
    expect(kenoRevealConcurrency(3)).toBe(3);
    expect(casinoRevealConcurrency(3)).toBe(3);
    expect(revealRecipientConcurrency(10, true)).toBe(2);
    expect(revealCardConcurrency(10, 5)).toBe(4);
    expect(revealLimbConcurrency(10)).toBe(1);
    expect(revealConcurrencyProduct(10, 5)).toBe(8);
    expect(revealCardConcurrency(2, 3)).toBe(3);
  });

  test('env overrides beat the devnet defaults', () => {
    clearConcurrencyEnv();
    process.env.E2E_CLUSTER = 'devnet';
    process.env.SHARE_CHUNK_CONCURRENCY = '1';
    process.env.CASINO_REVEAL_CONCURRENCY = '1';
    process.env.KENO_REVEAL_CONCURRENCY = '1';
    process.env.SHARE_VERIFY_PLAYER_CONCURRENCY = '1';
    expect(shareChunkConcurrency(2)).toBe(1);
    expect(casinoRevealConcurrency(20)).toBe(1);
    expect(kenoRevealConcurrency(20)).toBe(1);
    expect(sharePlayerConcurrency(2, 1)).toBe(1);
  });
});
