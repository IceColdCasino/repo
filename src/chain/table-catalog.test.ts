import { describe, expect, test } from 'bun:test';
import { deriveGameRoomId } from '../room-lifecycle';
import {
  ROOM_ACCOUNT_SIZE,
  ROOM_DISCRIMINATOR,
  bytesToHex,
  decodeRoomAccount,
  decodeTableAccount,
  roomListLabel,
  roomSeedForId,
  tableListLabel,
} from './table-catalog';

function roomBytes(roomId: Uint8Array, tableCount: bigint, smallBlind: bigint): Uint8Array {
  const data = new Uint8Array(ROOM_ACCOUNT_SIZE);
  data.set(ROOM_DISCRIMINATOR, 0);
  data.set(roomId, 8);
  const view = new DataView(data.buffer);
  view.setBigUint64(8 + 32 * 4, tableCount, true);
  view.setBigUint64(8 + 32 * 4 + 8, smallBlind, true);
  return data;
}

describe('table catalog decoding', () => {
  test('reads room id, table count, and blinds', () => {
    const roomId = deriveGameRoomId('poker', 'catalog-room');
    const decoded = decodeRoomAccount(roomBytes(roomId, 2n, 10n));
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.roomId)).toEqual(Array.from(roomId));
    expect(decoded!.tableCount).toBe(2);
    expect(decoded!.smallBlind).toBe(10n);
  });

  test('rejects a short or foreign account', () => {
    expect(decodeRoomAccount(new Uint8Array(32))).toBeNull();
    const foreign = roomBytes(new Uint8Array(32), 1n, 1n);
    foreign[0] = 0;
    expect(decodeRoomAccount(foreign)).toBeNull();
  });

  test('reads seated players and an open hand', () => {
    const data = new Uint8Array(500);
    const view = new DataView(data.buffer);
    view.setBigUint64(40, 3n, true);
    data[48] = 0;
    data[51 + 32] = 1;
    data[436] = 1;
    const decoded = decodeTableAccount(data);
    expect(decoded).toEqual({
      tableId: 3n,
      gameKind: 'poker',
      occupied: 1,
      handInProgress: true,
    });
  });

  test('labels rooms from the id and matches a known seed', () => {
    const roomId = deriveGameRoomId('poker', 'catalog-room');
    expect(roomListLabel(roomId, 2)).toContain('poker');
    expect(roomListLabel(roomId, 2)).toContain('2 tables');
    expect(roomListLabel(roomId, 2)).not.toContain('catalog-room');
    const hex = bytesToHex(roomId);
    expect(roomSeedForId(hex, ['other', 'catalog-room'])).toBe('catalog-room');
    expect(roomSeedForId(hex, ['other'])).toBeNull();
  });

  test('labels a table with seats and an open hand', () => {
    expect(tableListLabel({
      tableId: '1',
      gameKind: 'poker',
      occupied: 2,
      handInProgress: true,
    })).toBe('Table 1 · poker · 2 seated · hand open');
  });
});
