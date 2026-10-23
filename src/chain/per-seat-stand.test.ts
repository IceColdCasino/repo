import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import { PerSeatClient } from './per-seat-client';
import { setSharedMetaStore } from './shared-meta-store';

const RPC = 'http://127.0.0.1:8899';

function useTable(tableId: string): void {
  const file = path.resolve(import.meta.dir, '../../.local/shared-table.json');
  const disk = JSON.parse(readFileSync(file, 'utf8')) as {
    roomSeed?: string;
    roomIdHex?: string;
    tableId?: string;
  };
  const mem = new Map<string, string>();
  mem.set('shared-table', JSON.stringify({ ...disk, tableId }));
  setSharedMetaStore({
    read: (key) => mem.get(key) ?? null,
    write: (key, data) => {
      mem.set(key, data);
    },
    remove: (key) => {
      mem.delete(key);
    },
  });
}

describe('seated chips', () => {
  test('faucet after sitting raises the seat stack, and stand returns it', async () => {
    useTable('1');
    const client = await PerSeatClient.create(Keypair.generate().secretKey, RPC);
    const before = await client.snapshot();
    const open = before.seats.map((seat) => seat.seat);
    const seat = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !open.includes(n));
    expect(seat).not.toBeUndefined();

    await client.faucet(1000n);
    const sat = await client.join(seat!);
    const satSeat = sat.seats.find((entry) => entry.publicKey === client.publicKey);
    expect(satSeat?.chips).toBe('1000');
    expect(sat.callerPersonalEscrow).toBe('0');

    await client.faucet(1000n);
    const topped = await client.transferToSeat(1000n);
    const toppedSeat = topped.seats.find((entry) => entry.publicKey === client.publicKey);
    expect(toppedSeat?.chips).toBe('2000');
    expect(topped.callerPersonalEscrow).toBe('0');

    const stood = await client.stand();
    expect(stood.seats.some((entry) => entry.publicKey === client.publicKey)).toBe(false);
    expect(stood.callerPersonalEscrow).toBe('2000');
  }, 120_000);
});
