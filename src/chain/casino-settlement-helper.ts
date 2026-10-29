/**
 * Arcium MPC settlement helpers for casino games vs the shared Dealer Pool.
 * ZK verifies outcomes; these helpers queue encrypted settlement jobs on-chain.
 *
 * Escrow layers:
 * - table_escrow = seat bankroll (buying power)
 * - player_game_escrow = hand stake (fund → apply net → return)
 * - dealer_pool = house bank (settle_casino_hand)
 */

import { BN, type AnchorProvider, Program, web3 } from '@coral-xyz/anchor';
import {
  BACCARAT_FEES,
  BLACKJACK_FEES,
  WAR_FEES,
  ROULETTE_FEES,
  type CasinoGame,
} from '../casino-fees';
import { encryptBetFieldsAtNonce, generateTableEncryptionKey, type TableEncryptionKey } from '../bet-encryption';
import { ArciumPollingHelper } from '../arcium/polling';
import { ArciumMPCHelper } from '../arcium/mpc';

export interface CasinoSettlementParams {
  game: CasinoGame;
  roomId: Uint8Array;
  tableId: bigint;
  /** Current hand game_id — used to mark GameState.settlement_status = SETTLED. */
  gameId: Uint8Array;
  totalAction: bigint;
  poolGrossWin: bigint;
  playerPayout: bigint;
  /** Key that decrypts the dealer pool. The action and pool win are sealed with it. */
  encryptionKey: TableEncryptionKey;
  nonce: bigint;
  /** Polynomial terms Arcis range-checks. Unused slots stay 0. */
  showdownResults: readonly (number | bigint)[];
  /** Blackjack hand count. Other games leave this 0. */
  resultCount?: number;
}

export interface ApplyCasinoPlayerNetParams {
  roomId: Uint8Array;
  tableId: bigint;
  gameId: Uint8Array;
  playerIndex: number;
  playerNetAbs: bigint;
  playerWon: boolean;
  encryptionPubkey: Uint8Array;
  nonce: bigint;
  player?: web3.PublicKey;
  /** Polynomial terms Arcis range-checks. Unused slots stay 0. */
  showdownResults: readonly (number | bigint)[];
  /** Blackjack hand count. Other games leave this 0. */
  resultCount?: number;
}

/** Fourteen showdown terms. Slots past `values` are zero. */
export function showdownResultWords(values: readonly (number | bigint)[]): BN[] {
  const words = Array.from({ length: 14 }, () => new BN(0));
  const n = Math.min(14, values.length);
  for (let i = 0; i < n; i++) {
    words[i] = new BN(values[i]!.toString());
  }
  return words;
}

export interface FundGameEscrowParams {
  roomId: Uint8Array;
  tableId: bigint;
  gameId: Uint8Array;
  playerIndex: number;
  stake: bigint;
  encryptionPubkey: Uint8Array;
  nonce: bigint;
  player?: web3.PublicKey;
}

export interface ReturnGameEscrowParams {
  roomId: Uint8Array;
  tableId: bigint;
  gameId: Uint8Array;
  playerIndex: number;
  encryptionPubkey: Uint8Array;
  nonce: bigint;
  player?: web3.PublicKey;
}

function feeBpsForGame(game: CasinoGame): {
  actionFeeBps: number;
  poolWinFeeBps: number;
  bankerCommissionBps: number;
} {
  switch (game) {
    case 'baccarat':
      return {
        actionFeeBps: BACCARAT_FEES.totalActionCollectionBps,
        poolWinFeeBps: 0,
        bankerCommissionBps: BACCARAT_FEES.bankerWinCommissionBps,
      };
    case 'blackjack':
      return {
        actionFeeBps: BLACKJACK_FEES.totalActionCollectionBps,
        poolWinFeeBps: BLACKJACK_FEES.poolWinEdgeShareBps,
        bankerCommissionBps: 0,
      };
    case 'war':
      return {
        actionFeeBps: WAR_FEES.totalActionCollectionBps,
        poolWinFeeBps: WAR_FEES.poolWinEdgeShareBps,
        bankerCommissionBps: 0,
      };
    case 'roulette':
    case 'craps':
    case 'keno':
    case 'slots':
    case 'bingo':
      return {
        actionFeeBps: ROULETTE_FEES.totalActionCollectionBps,
        poolWinFeeBps: ROULETTE_FEES.poolWinEdgeShareBps,
        bankerCommissionBps: 0,
      };
  }
}

/**
 * Conservative roulette max liability per seat at `maxBet` across 12 unique classes.
 * Multipliers match even-money / dozen / column / street / line / corner / split / straight
 * style classes used by the 12-coeff showdown layout (profit multiples, not including stake).
 */
/** Profit multipliers for the 12 roulette bet classes (see roulette_eval.circom). */
export const ROULETTE_CLASS_PAYOUT_MULT = [
  35, 17, 17, 11, 8, 8, 5, 2, 2, 1, 1, 1,
] as const;

export function rouletteMaxPayoutCoverage(maxBet: bigint, seats: number): bigint {
  let perSeat = 0n;
  for (const m of ROULETTE_CLASS_PAYOUT_MULT) {
    perSeat += maxBet * BigInt(m);
  }
  return perSeat * BigInt(seats);
}

/** BJ worst-case: bet × 4 hands × 1.5 (BJ 3:2 profit) ≈ 6×B liability per seat. */
export function blackjackMaxPayoutCoverage(betPerHand: bigint, seats: number): bigint {
  const maxHands = 4n;
  // Profit at 3:2 on BJ; doubles increase stake — reserve 2× stake × 1.5 ≈ 3×B per hand.
  const perHandLiability = (betPerHand * 3n) / 1n; // 3×B covers double+even
  return perHandLiability * maxHands * BigInt(seats);
}

export class CasinoSettlementHelper {
  readonly polling: ArciumPollingHelper;
  private readonly arcium: ArciumMPCHelper;

  constructor(
    readonly provider: AnchorProvider,
    readonly program: Program,
  ) {
    this.polling = new ArciumPollingHelper(provider);
    this.arcium = new ArciumMPCHelper(program, provider);
  }

  private tablePDA(roomId: Uint8Array, tableId: bigint): web3.PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(tableId);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('table'), Buffer.from(roomId), idBuf],
      this.program.programId,
    )[0];
  }

  private dealerPoolPDA(roomId: Uint8Array, tableId: bigint): web3.PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(tableId);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('dealer_pool'), Buffer.from(roomId), idBuf],
      this.program.programId,
    )[0];
  }

  private protocolTreasuryPDA(roomId: Uint8Array): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('protocol_treasury'), Buffer.from(roomId)],
      this.program.programId,
    )[0];
  }

  private roomPDA(roomId: Uint8Array): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('room'), Buffer.from(roomId)],
      this.program.programId,
    )[0];
  }

  private whitelistPDA(roomId: Uint8Array, player: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('whitelist'), Buffer.from(roomId), player.toBuffer()],
      this.program.programId,
    )[0];
  }

  private tableEscrowPDA(
    roomId: Uint8Array,
    tableId: bigint,
    player: web3.PublicKey,
  ): web3.PublicKey {
    const idBuf = Buffer.alloc(8);
    idBuf.writeBigUInt64LE(tableId);
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('table_escrow'), player.toBuffer(), Buffer.from(roomId), idBuf],
      this.program.programId,
    )[0];
  }

  private gameStatePDA(gameId: Uint8Array): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('game_state'), Buffer.from(gameId)],
      this.program.programId,
    )[0];
  }

  private playerGameEscrowPDA(gameId: Uint8Array, playerIndex: number): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('player_game_escrow'), Buffer.from(gameId), Buffer.from([playerIndex])],
      this.program.programId,
    )[0];
  }

  /** Default encryption key for settlement MPC args (matches room wallet ops). */
  static defaultEncryptionKey() {
    return generateTableEncryptionKey();
  }

  private async withPlayerSigner(
    builder: { signers: (s: web3.Signer[]) => { rpc: () => Promise<string> }; rpc: () => Promise<string> },
    playerSigner?: web3.Keypair,
  ): Promise<void> {
    if (
      playerSigner
      && !playerSigner.publicKey.equals(this.provider.wallet.publicKey)
    ) {
      await builder.signers([playerSigner]).rpc();
    } else {
      await builder.rpc();
    }
  }

  /** Lock stake from table_escrow into player_game_escrow. */
  async fundPlayerGameEscrow(
    params: FundGameEscrowParams,
    computationOffset: number,
    playerSigner?: web3.Keypair,
  ): Promise<void> {
    const player = params.player
      ?? playerSigner?.publicKey
      ?? this.provider.wallet.publicKey;
    const gameEscrowPda = this.playerGameEscrowPDA(params.gameId, params.playerIndex);
    const before = await (this.program.account as any).playerGameEscrow.fetch(gameEscrowPda);

    const offsetBn = new BN(computationOffset);
    const builder = (this.program.methods as any)
      .fundPlayerGameEscrow(
        offsetBn,
        params.playerIndex,
        new BN(params.stake.toString()),
        Array.from(params.encryptionPubkey),
        new BN(params.nonce.toString()),
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(params.roomId),
        tableState: this.tablePDA(params.roomId, params.tableId),
        gameState: this.gameStatePDA(params.gameId),
        whitelistEntry: this.whitelistPDA(params.roomId, player),
        player,
        tableEscrow: this.tableEscrowPDA(params.roomId, params.tableId, player),
        playerGameEscrow: gameEscrowPda,
        ...this.arcium.arciumQueueAccounts(offsetBn, 'fundPlayerGameEscrow'),
      });
    await this.arcium.payComputationFromFloat(offsetBn, () =>
      this.withPlayerSigner(builder, playerSigner),
    );
    this.arcium.noteComputation(offsetBn);

    await this.polling.waitForCallback(
      gameEscrowPda,
      async (pda) => (this.program.account as any).playerGameEscrow.fetch(pda),
      (state) => state.nonce !== before.nonce,
      { timeout: 90000, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }

  /** Queue Arcium `apply_casino_player_net` against player_game_escrow. */
  async applyCasinoPlayerNet(
    params: ApplyCasinoPlayerNetParams,
    computationOffset: number,
    playerSigner?: web3.Keypair,
  ): Promise<void> {
    const player = params.player
      ?? playerSigner?.publicKey
      ?? this.provider.wallet.publicKey;
    const gameEscrowPda = this.playerGameEscrowPDA(params.gameId, params.playerIndex);
    const before = await (this.program.account as any).playerGameEscrow.fetch(gameEscrowPda);

    const offsetBn = new BN(computationOffset);
    const builder = (this.program.methods as any)
      .applyCasinoPlayerNet(
        offsetBn,
        params.playerIndex,
        new BN(params.playerNetAbs.toString()),
        params.playerWon,
        Array.from(params.encryptionPubkey),
        new BN(params.nonce.toString()),
        showdownResultWords(params.showdownResults),
        params.resultCount ?? 0,
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(params.roomId),
        tableState: this.tablePDA(params.roomId, params.tableId),
        gameState: this.gameStatePDA(params.gameId),
        whitelistEntry: this.whitelistPDA(params.roomId, player),
        player,
        tableEscrow: this.tableEscrowPDA(params.roomId, params.tableId, player),
        playerGameEscrow: gameEscrowPda,
        ...this.arcium.arciumQueueAccounts(offsetBn, 'applyCasinoPlayerNet'),
      });
    await this.arcium.payComputationFromFloat(offsetBn, () =>
      this.withPlayerSigner(builder, playerSigner),
    );
    this.arcium.noteComputation(offsetBn);

    await this.polling.waitForCallback(
      gameEscrowPda,
      async (pda) => (this.program.account as any).playerGameEscrow.fetch(pda),
      (state) => state.nonce !== before.nonce,
      { timeout: 90000, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }

  /** Return remaining game escrow balance to table_escrow. */
  async returnPlayerGameEscrow(
    params: ReturnGameEscrowParams,
    computationOffset: number,
    playerSigner?: web3.Keypair,
  ): Promise<void> {
    const player = params.player
      ?? playerSigner?.publicKey
      ?? this.provider.wallet.publicKey;
    const gameEscrowPda = this.playerGameEscrowPDA(params.gameId, params.playerIndex);
    const before = await (this.program.account as any).playerGameEscrow.fetch(gameEscrowPda);

    const offsetBn = new BN(computationOffset);
    const builder = (this.program.methods as any)
      .returnPlayerGameEscrow(
        offsetBn,
        params.playerIndex,
        Array.from(params.encryptionPubkey),
        new BN(params.nonce.toString()),
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        room: this.roomPDA(params.roomId),
        tableState: this.tablePDA(params.roomId, params.tableId),
        gameState: this.gameStatePDA(params.gameId),
        whitelistEntry: this.whitelistPDA(params.roomId, player),
        player,
        tableEscrow: this.tableEscrowPDA(params.roomId, params.tableId, player),
        playerGameEscrow: gameEscrowPda,
        ...this.arcium.arciumQueueAccounts(offsetBn, 'returnPlayerGameEscrow'),
      });
    await this.arcium.payComputationFromFloat(offsetBn, () =>
      this.withPlayerSigner(builder, playerSigner),
    );
    this.arcium.noteComputation(offsetBn);

    await this.polling.waitForCallback(
      gameEscrowPda,
      async (pda) => (this.program.account as any).playerGameEscrow.fetch(pda),
      (state) => state.nonce !== before.nonce || Number(state.balanceU64?.toString?.() ?? state.balanceU64) === 0,
      { timeout: 90000, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }

  /** Queue Arcium `settle_casino_hand` after ZK outcome verification. */
  async settleCasinoHand(
    params: CasinoSettlementParams,
    computationOffset: number,
    authority?: web3.Keypair,
  ): Promise<void> {
    const fees = feeBpsForGame(params.game);
    const payerKp = authority;
    const payer = payerKp?.publicKey ?? this.provider.wallet.publicKey;
    const signers = payerKp && !payerKp.publicKey.equals(this.provider.wallet.publicKey)
      ? [payerKp]
      : [];
    const tablePda = this.tablePDA(params.roomId, params.tableId);
    const gameStatePda = this.gameStatePDA(params.gameId);

    const offsetBn = new BN(computationOffset);
    const [totalAction, poolGrossWin] = await encryptBetFieldsAtNonce(
      params.encryptionKey,
      this.provider,
      this.program.programId,
      [params.totalAction, params.poolGrossWin],
      params.nonce,
    );
    await this.arcium.payComputationFromFloat(offsetBn, () =>
      (this.program.methods as any)
      .settleCasinoHand(
        offsetBn,
        Array.from(totalAction),
        Array.from(poolGrossWin),
        new BN(params.playerPayout.toString()),
        fees.actionFeeBps,
        fees.poolWinFeeBps,
        fees.bankerCommissionBps,
        Array.from(params.encryptionKey.publicKey),
        new BN(params.nonce.toString()),
        showdownResultWords(params.showdownResults),
        params.resultCount ?? 0,
      )
      .accountsPartial({
        payer,
        room: this.roomPDA(params.roomId),
        tableState: tablePda,
        gameState: gameStatePda,
        whitelistEntry: this.whitelistPDA(params.roomId, payer),
        dealerPool: this.dealerPoolPDA(params.roomId, params.tableId),
        protocolTreasury: this.protocolTreasuryPDA(params.roomId),
        ...this.arcium.arciumQueueAccounts(offsetBn, 'settleCasinoHand'),
      })
      .signers(signers)
      .preInstructions([
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc(),
    payerKp);
    this.arcium.noteComputation(offsetBn);

    await this.polling.waitForCallback(
      tablePda,
      async (pda) => (this.program.account as any).tableState.fetch(pda),
      (state) => state.handInProgress === false,
      { timeout: 90000, interval: 2000 },
    );
    // Casino close gate: SETTLEMENT_SETTLED (3), not poker phase 6.
    await this.polling.waitForCallback(
      gameStatePda,
      async (pda) => (this.program.account as any).gameState.fetch(pda),
      (state) => Number(state.settlementStatus ?? state.settlement_status ?? 0) === 3,
      { timeout: 90000, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
  }
}
