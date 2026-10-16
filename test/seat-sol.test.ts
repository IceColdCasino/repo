import { describe, expect, test } from 'bun:test';
import { DECK_STAGING_ACCOUNT_SIZE } from '../src/chain/staging';
import { SHUFFLE_INPUTS_ACCOUNT_SIZE } from '../src/chain/onchain-game-lifecycle';
import {
  DEVNET_SEAT_LAMPORTS,
  SEAT_FEE_CUSHION_LAMPORTS,
  SEAT_SHARE_STAGING_BYTES,
  SEAT_SHUFFLE_INPUTS_BYTES,
  rentExemptLamports,
  RENT_LAMPORTS_PER_BYTE,
  reusedStagingLamports,
  seatFloorLamports,
  seatTopUpLamports,
} from '../src/chain/fund-sol';
import { MAX_CPI_ALLOC, shuffleCallerInputs, shuffleInputsAccountSize } from '../src/chain/shuffle-account';
import { rentVaultFloat } from '../src/chain/rent-vault';
import {
  DEALER_POOL_DATA,
  ENCRYPTED_BETTING_DATA,
  BET_ACTION_LOG_DATA,
  POOL_STAKE_DATA,
  PROTOCOL_TREASURY_DATA,
  operatorTableLamports,
  seatTableLamports,
} from '../src/chain/table-float';

describe('devnet seat top-up', () => {
  test('staging rent stays in the float and the seat keeps signature fees', () => {
    expect(SEAT_SHUFFLE_INPUTS_BYTES).toBe(SHUFFLE_INPUTS_ACCOUNT_SIZE);
    expect(SEAT_SHUFFLE_INPUTS_BYTES).toBe(60_342);
    expect(SEAT_SHARE_STAGING_BYTES).toBe(DECK_STAGING_ACCOUNT_SIZE);
    const peak = rentExemptLamports(SHUFFLE_INPUTS_ACCOUNT_SIZE)
      + rentExemptLamports(DECK_STAGING_ACCOUNT_SIZE);
    expect(seatFloorLamports()).toBe(SEAT_FEE_CUSHION_LAMPORTS);
    expect(DEVNET_SEAT_LAMPORTS).toBe(SEAT_FEE_CUSHION_LAMPORTS);
    expect(rentVaultFloat()).toBeGreaterThan(peak);
    expect(seatTopUpLamports(0)).toBe(SEAT_FEE_CUSHION_LAMPORTS);
    expect(seatTopUpLamports(3_512_520)).toBe(SEAT_FEE_CUSHION_LAMPORTS - 3_512_520);
  });

  test('a one-deck table keeps the same seat floor and a smaller float', () => {
    const caller = shuffleCallerInputs(0, 1, 0);
    expect(shuffleInputsAccountSize(caller)).toBeLessThan(SEAT_SHARE_STAGING_BYTES);
    const shuffleBytes = Math.max(shuffleInputsAccountSize(caller), MAX_CPI_ALLOC);
    expect(reusedStagingLamports(caller)).toBe(
      rentExemptLamports(shuffleBytes) + rentExemptLamports(SEAT_SHARE_STAGING_BYTES),
    );
    expect(seatFloorLamports(caller)).toBe(DEVNET_SEAT_LAMPORTS);
    expect(rentVaultFloat(caller)).toBeLessThan(rentVaultFloat());
  });

  test('six and eight deck shoes grow the float with the shoe', () => {
    const six = shuffleCallerInputs(2, 6, 0);
    const eight = shuffleCallerInputs(2, 8, 0);
    expect(shuffleInputsAccountSize(eight)).toBe(60_342);
    expect(reusedStagingLamports(six)).toBeLessThan(reusedStagingLamports(eight));
    expect(rentVaultFloat(six)).toBeLessThan(rentVaultFloat(eight));
    expect(rentVaultFloat(eight)).toBe(rentVaultFloat());
  });

  test('a seat already at the floor is left alone', () => {
    expect(seatTopUpLamports(DEVNET_SEAT_LAMPORTS)).toBe(0);
    expect(seatTopUpLamports(DEVNET_SEAT_LAMPORTS + 1)).toBe(0);
  });

  test('an empty seat receives the full floor', () => {
    expect(seatTopUpLamports(0)).toBe(DEVNET_SEAT_LAMPORTS);
  });

  test('table rent sits on top of the hand float', () => {
    const seat = seatTableLamports();
    const pokerSeat = seatTableLamports(RENT_LAMPORTS_PER_BYTE, {
      tokenAccount: false,
      pendingDeposit: false,
    });
    expect(pokerSeat).toBeLessThan(seat);
    const shared = operatorTableLamports(2, { housePool: false, pokerBetting: false });
    const house = operatorTableLamports(2, { housePool: true, pokerBetting: false });
    expect(house - shared).toBe(
      rentExemptLamports(DEALER_POOL_DATA)
        + rentExemptLamports(PROTOCOL_TREASURY_DATA)
        + rentExemptLamports(POOL_STAKE_DATA),
    );
    expect(house).toBeGreaterThan(seat);
    const poker = operatorTableLamports(2, {
      housePool: false,
      pokerBetting: true,
      operatorSeat: false,
    });
    const pokerBase = operatorTableLamports(2, {
      housePool: false,
      pokerBetting: false,
      operatorSeat: false,
    });
    expect(poker - pokerBase).toBe(
      rentExemptLamports(ENCRYPTED_BETTING_DATA) + rentExemptLamports(BET_ACTION_LOG_DATA),
    );
    expect(poker).toBeGreaterThan(pokerSeat);
  });
});
