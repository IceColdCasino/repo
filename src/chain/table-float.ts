import { rentExemptLamports, RENT_LAMPORTS_PER_BYTE } from './fund-sol';

/**
 * Data lengths of accounts opened while a table is created.
 * Each length includes the 8-byte discriminator. Rent is `rate × (length + 128)`.
 * Lengths match the Anchor `InitSpace` layouts in the casino and light-casino programs.
 */
export const SPL_MINT_DATA = 82;
export const SPL_TOKEN_ACCOUNT_DATA = 165;
export const ROOM_DATA = 152;
export const TABLE_DATA = 495;
export const WHITELIST_DATA = 72;
export const ROOM_WALLET_DATA = 184;
export const TABLE_ESCROW_DATA = 177;
export const PENDING_DEPOSIT_DATA = 80;
export const PLAYER_GAME_ESCROW_DATA = 178;
export const DEALER_POOL_DATA = 190;
export const PROTOCOL_TREASURY_DATA = 88;
export const POOL_STAKE_DATA = 128;
export const CASINO_GAME_STATE_DATA = 1020;
export const LIGHT_GAME_STATE_DATA = 139;
export const LIGHT_PLAYER_STATE_DATA = 269;
export const CASINO_PLAYER_STATE_DATA = 235;
export const ENCRYPTED_BETTING_DATA = 728;
export const BET_ACTION_LOG_DATA = 6200;

function sumRent(lengths: number[], lamportsPerByte: number): number {
  return lengths.reduce((total, length) => total + rentExemptLamports(length, lamportsPerByte), 0);
}

/**
 * Accounts one seat opens. Casino seats open a token account and a pending
 * deposit. Poker seats open neither, so those rents stay out of that float.
 */
export function seatTableLamports(
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
  opts: { tokenAccount?: boolean; pendingDeposit?: boolean } = {},
): number {
  const lengths = [WHITELIST_DATA, ROOM_WALLET_DATA, TABLE_ESCROW_DATA];
  if (opts.tokenAccount !== false) lengths.push(SPL_TOKEN_ACCOUNT_DATA);
  if (opts.pendingDeposit !== false) lengths.push(PENDING_DEPOSIT_DATA);
  return sumRent(lengths, lamportsPerByte);
}

/**
 * Accounts the operator vault pre-funds for the whole table. The operator is
 * not a seat. House tables add the dealer pool. Poker adds the betting
 * accounts. Player-state rent is what the CPI authority must hold so register
 * can open each seat without the seat carrying it.
 */
export function operatorTableLamports(
  numPlayers: number,
  opts: { housePool: boolean; pokerBetting: boolean; operatorSeat?: boolean },
  lamportsPerByte = RENT_LAMPORTS_PER_BYTE,
): number {
  const shared = [
    SPL_MINT_DATA,
    ROOM_DATA,
    SPL_TOKEN_ACCOUNT_DATA,
    TABLE_DATA,
    CASINO_GAME_STATE_DATA,
    LIGHT_GAME_STATE_DATA,
  ];
  if (opts.housePool) shared.push(DEALER_POOL_DATA, PROTOCOL_TREASURY_DATA, POOL_STAKE_DATA);
  if (opts.pokerBetting) shared.push(ENCRYPTED_BETTING_DATA, BET_ACTION_LOG_DATA);
  const perPlayer = rentExemptLamports(PLAYER_GAME_ESCROW_DATA, lamportsPerByte)
    + rentExemptLamports(LIGHT_PLAYER_STATE_DATA, lamportsPerByte)
    + rentExemptLamports(CASINO_PLAYER_STATE_DATA, lamportsPerByte);
  // The CPI authority is an empty system account. It keeps its own rent and
  // pays each seat's player-state rent during register.
  const operatorSeat = opts.operatorSeat === false
    ? 0
    : seatTableLamports(lamportsPerByte);
  return sumRent(shared, lamportsPerByte)
    + operatorSeat
    + rentExemptLamports(0, lamportsPerByte)
    + numPlayers * perPlayer;
}
