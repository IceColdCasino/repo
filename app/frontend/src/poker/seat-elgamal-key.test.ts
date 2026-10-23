import { describe, expect, it } from 'vitest';
import { parseSeatElgamalRecord, seatElgamalMetaKey } from './seat-elgamal-key';

describe('seat elgamal disk record', () => {
  it('names one file per seat', () => {
    expect(seatElgamalMetaKey(0)).toBe('elgamal-seat0');
    expect(seatElgamalMetaKey(1)).toBe('elgamal-seat1');
  });

  it('restores a key written for this seat', () => {
    const raw = JSON.stringify({
      handNumber: 1,
      privateKey: '99',
      publicKey: ['5', '6'],
    });
    expect(parseSeatElgamalRecord(raw)).toEqual({
      privateKey: 99n,
      publicKey: [5n, 6n],
    });
  });

  it('rejects a record without a private key', () => {
    expect(parseSeatElgamalRecord(JSON.stringify({ publicKey: ['1', '2'] }))).toBeNull();
    expect(parseSeatElgamalRecord('not-json')).toBeNull();
  });
});
