// TypeScript utilities for DeckStaging PDA lifecycle and Light Protocol integration
//
// This module provides:
//   1. GameState PDA helpers (initialize, record reveal)
//   2. DeckStaging PDA helpers (create, write chunks, close)
//   3. RevealedCards PDA helpers (close after Light Protocol storage)
//   4. Light Protocol integration skeleton (requires @lightprotocol/stateless.js)
//
// Usage for a 10-player game (25 cards total, 2 chunks of 16):
//   const game = new GameStateHelper(pokerProgram, provider);
//   await game.initialize(gameId, 25); // 25 cards total
//
//   const staging = new DeckStagingHelper(pokerProgram, provider);
//   await staging.create(gameId);
//   await staging.writeChunks(gameId, commitments);
//
//   // For each chunk:
//   //   1. Arcis reveal callback writes to RevealedCards PDA
//   //   2. Client stores in Light Protocol
//   //   3. Client closes RevealedCards PDA
//   //   4. Client calls game.recordReveal(chunkCount)
//
//   // After all 25 cards revealed:
//   await staging.close(gameId); // checks GameState.revealedCards >= totalCards

import { Program, web3, BN, type AnchorProvider, type Provider } from "@coral-xyz/anchor";
import { confirmOrResend } from "./confirm-tx";
import { withRetry } from "../arcium/verify-chunk-parallel";
import { loadWhitelistAdminProvider } from "./admin-provider";
import { casinoVaultRemaining, frontExtendFromVault, frontFromVault } from "./rent-vault";
import { isLocalCluster } from "./fund-sol";
import { MAX_CPI_ALLOC } from "./shuffle-account";
import { KeypairWallet } from "./keypair-wallet";
import {
  REVEAL_ABSORB_PER_TX,
  REVEAL_CHUNK_ACCOUNT_SIZE,
  REVEAL_LANE_FEE,
  REVEAL_LANES,
  absorbRevealChunksInstruction,
  chunkPayloadMatches,
  packRevealRanges,
  revealChunkPda,
  writeRevealChunkInstruction,
  type RevealRange,
} from "./reveal-chunks";

/**
 * `initialize_game` on devnet is signed by the whitelist admin, and that key
 * is stored as `game_state.staging_authority`. Deck-staging create, reveal
 * credit, and close must use the same signer.
 */
async function stagingRentPayer(
  provider: Provider,
  explicit?: web3.Keypair,
): Promise<web3.Keypair | undefined> {
  if (explicit) return explicit;
  if (isLocalCluster(provider.connection.rpcEndpoint)) return undefined;
  const admin = await loadWhitelistAdminProvider(provider.connection, undefined, 20_000_000);
  return (admin.wallet as KeypairWallet).payer;
}

export const DECK_STAGING_SEED = "deck_staging";
export const SHARE_DECK_STAGING_SEED = "share_deck_staging";
export const REVEALED_CARDS_SEED = "RevealedCards";
export const GAME_STATE_SEED = "game_state";
/** 900 limbs + 35 zero-pad limbs for trailing 36-wide Arcis share reads. */
export const DECK_STAGING_ACCOUNT_SIZE = 29_920;

/// Helper class for managing the GameState PDA.
export class GameStateHelper {
  constructor(
    private program: Program,
    private provider: Provider
  ) {}

  /// Derive the GameState PDA address for a given game.
  derivePDA(gameId: Uint8Array): web3.PublicKey {
    if (gameId.length !== 32) {
      throw new Error(`gameId must be 32 bytes, got ${gameId.length}`);
    }
    const [pda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from(GAME_STATE_SEED),
        Buffer.from(gameId),
      ],
      this.program.programId
    );
    return pda;
  }

  /// Initialize a GameState PDA to track reveal progress.
  ///
  /// Call this once at game start.
  /// `numPlayers` determines partials per card: (n - 1) * 4 BN254 values.
  /// `numCards` is the total cards (e.g., 25 for 20 hole + 5 community).
  async initialize(
    gameId: Uint8Array,
    numPlayers: number,
    numCards: number,
    payer?: web3.Keypair
  ): Promise<web3.PublicKey> {
    const pda = this.derivePDA(gameId);

    await this.program.methods
      .initializeGame!(Array.from(gameId) as [number], numPlayers, numCards)
      .accounts({
        payer: payer ? payer.publicKey : this.provider.wallet!.publicKey,
        gameState: pda,
        systemProgram: web3.SystemProgram.programId,
      } as any)
      .signers(payer ? [payer] : [])
      .rpc();

    return pda;
  }

  /// Record that partials have been revealed.
  ///
  /// Call this after each successful Arcis reveal callback and Light Protocol
  /// storage. `count` is the number of partials revealed (not cards).
  /// For a `reveal_card` call that returns all partials for one card,
  /// count = numPlayers - 1.
  async recordReveal(
    gameId: Uint8Array,
    count: number,
    authority?: web3.Keypair
  ): Promise<void> {
    const pda = this.derivePDA(gameId);
    const signer = await stagingRentPayer(this.provider, authority);

    await this.program.methods
      .recordReveal!(count)
      .accounts({
        authority: signer
          ? signer.publicKey
          : this.provider.wallet!.publicKey,
        gameState: pda,
      } as any)
      .signers(signer ? [signer] : [])
      .rpc();
  }

  /// Fetch the current GameState.
  async fetch(gameId: Uint8Array): Promise<any> {
    const pda = this.derivePDA(gameId);
    return await (this.program.account as { gameState: { fetch: (address: web3.PublicKey) => Promise<unknown> } }).gameState.fetch(pda);
  }
}

export type StagingWriteAuth = {
  /** TableState PDA for the active hand (required for typed staging writes). */
  tableState: web3.PublicKey;
  /** Seated signer; defaults to provider.wallet when omitted. */
  authority?: web3.Keypair;
};

/// Helper class for managing the DeckStaging PDA lifecycle.
export class DeckStagingHelper {
  /** Set after room/table setup — required by writeRange / writeShareRange. */
  writeAuth?: StagingWriteAuth;
  /** Lane dust returned after absorb. Awaited outside the reveal write timer. */
  private revealLaneSweep: Promise<void> | null = null;

  constructor(
    private program: Program,
    private provider: Provider
  ) {}

  private resolveWriteAuth(auth?: StagingWriteAuth): {
    authority: web3.PublicKey;
    signers: web3.Keypair[];
    tableState: web3.PublicKey;
    gameState: (gameId: Uint8Array) => web3.PublicKey;
  } {
    const resolved = auth ?? this.writeAuth;
    if (!resolved?.tableState) {
      throw new Error(
        'DeckStagingHelper.writeAuth.tableState (or per-call auth) is required for staging writes',
      );
    }
    const authorityKp = resolved.authority;
    return {
      authority: authorityKp
        ? authorityKp.publicKey
        : this.provider.wallet!.publicKey,
      signers: authorityKp ? [authorityKp] : [],
      tableState: resolved.tableState,
      gameState: (gameId: Uint8Array) =>
        web3.PublicKey.findProgramAddressSync(
          [Buffer.from(GAME_STATE_SEED), Buffer.from(gameId)],
          this.program.programId,
        )[0],
    };
  }

  /// Derive the DeckStaging PDA address for a given game.
  derivePDA(gameId: Uint8Array): web3.PublicKey {
    if (gameId.length !== 32) {
      throw new Error(`gameId must be 32 bytes, got ${gameId.length}`);
    }
    const [pda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from(DECK_STAGING_SEED),
        Buffer.from(gameId),
      ],
      this.program.programId
    );
    return pda;
  }

  /// Create a DeckStaging PDA for a game.
  ///
  /// The payer funds the PDA with ~0.2 SOL (rent-exempt for 28,840 bytes).
  /// This rent is fully refunded when the PDA is closed.
  ///
  /// Solana caps CPI realloc at 10 KiB, so we create a small account then
  /// call `extendDeckStaging` until it reaches full size.
  async create(gameId: Uint8Array, payer?: web3.Keypair): Promise<web3.PublicKey> {
    const pda = this.derivePDA(gameId);
    const signer = await stagingRentPayer(this.provider, payer);
    const payerKey = signer ? signer.publicKey : this.provider.wallet!.publicKey;
    const existing = await this.provider.connection.getAccountInfo(pda, 'processed');
    await frontFromVault(
      this.provider as AnchorProvider,
      payerKey,
      MAX_CPI_ALLOC,
      existing?.lamports ?? 0,
      signer,
    );

    try {
      const gameStatePda = new GameStateHelper(this.program, this.provider).derivePDA(gameId);
      await this.program.methods
        .createDeckStaging!(Array.from(gameId) as [number])
        .accounts({
          payer: signer ? signer.publicKey : this.provider.wallet!.publicKey,
          gameState: gameStatePda,
          deckStaging: pda,
          systemProgram: web3.SystemProgram.programId,
        } as any)
        .signers(signer ? [signer] : [])
        .rpc();
    } catch (e: any) {
      // PDA may already exist (idempotent)
      if (!e.toString().includes("already in use")) {
        throw e;
      }
    }

    // Grow to full size in ≤10 KiB CPI realloc steps.
    for (;;) {
      const info = await this.provider.connection.getAccountInfo(pda, 'confirmed');
      if (!info) throw new Error(`deck_staging missing after create: ${pda.toBase58()}`);
      if (info.data.length >= DECK_STAGING_ACCOUNT_SIZE) break;
      await frontExtendFromVault(
        this.provider as AnchorProvider,
        payerKey,
        info.data.length,
        info.lamports,
        DECK_STAGING_ACCOUNT_SIZE,
        signer,
      );
      await this.program.methods
        .extendDeckStaging!()
        .accounts({
          payer: signer ? signer.publicKey : this.provider.wallet!.publicKey,
          deckStaging: pda,
          systemProgram: web3.SystemProgram.programId,
        } as any)
        .signers(signer ? [signer] : [])
        .rpc();
    }

    return pda;
  }

  deriveSharePDA(gameId: Uint8Array, playerIndex: number): web3.PublicKey {
    if (gameId.length !== 32) {
      throw new Error(`gameId must be 32 bytes, got ${gameId.length}`);
    }
    return web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from(SHARE_DECK_STAGING_SEED),
        Buffer.from(gameId),
        Buffer.from([playerIndex]),
      ],
      this.program.programId,
    )[0];
  }

  async createShare(
    gameId: Uint8Array,
    playerIndex: number,
    payer?: web3.Keypair,
  ): Promise<web3.PublicKey> {
    const pda = this.deriveSharePDA(gameId, playerIndex);
    const auth = this.resolveWriteAuth();
    const payerKey = payer ? payer.publicKey : auth.authority;
    const existing = await this.provider.connection.getAccountInfo(pda, 'processed');
    await frontFromVault(
      this.provider as AnchorProvider,
      payerKey,
      MAX_CPI_ALLOC,
      existing?.lamports ?? 0,
      payer,
    );
    const gameState = web3.PublicKey.findProgramAddressSync(
      [Buffer.from(GAME_STATE_SEED), Buffer.from(gameId)],
      this.program.programId,
    )[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.provider.connection.getAccountInfo(pda, 'processed')) break;
      try {
        await (this.program.methods as any)
          .createShareDeckStaging(Array.from(gameId), playerIndex)
          .accounts({
            payer: payer ? payer.publicKey : auth.authority,
            gameState,
            tableState: auth.tableState,
            shareDeckStaging: pda,
            systemProgram: web3.SystemProgram.programId,
          })
          .signers(payer ? [payer] : auth.signers)
          .rpc({ commitment: 'processed', preflightCommitment: 'processed' });
      } catch (e: any) {
        // Busy localnet confirmation can time out after the transaction landed.
        // Poll for the created PDA before deciding whether it is safe to retry.
        let landed = false;
        for (let poll = 0; poll < 100; poll++) {
          if (await this.provider.connection.getAccountInfo(pda, 'processed')) {
            landed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (landed || String(e).includes('already in use')) break;
        if (attempt === 2) throw e;
      }
    }
    let info = null;
    for (let poll = 0; poll < 100 && !info; poll++) {
      info = await this.provider.connection.getAccountInfo(pda, 'confirmed');
      if (!info) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!info) throw new Error(`share_deck_staging missing after create: ${pda.toBase58()}`);
    for (;;) {
      if (info.data.length >= DECK_STAGING_ACCOUNT_SIZE) break;
      await frontExtendFromVault(
        this.provider as AnchorProvider,
        payerKey,
        info.data.length,
        info.lamports,
        DECK_STAGING_ACCOUNT_SIZE,
        payer,
      );
      await (this.program.methods as any)
        .extendShareDeckStaging(playerIndex)
        .accounts({
          payer: payer ? payer.publicKey : auth.authority,
          gameState,
          shareDeckStaging: pda,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers(payer ? [payer] : auth.signers)
        .rpc();
      info = await this.provider.connection.getAccountInfo(pda, 'confirmed');
      if (!info) throw new Error(`share_deck_staging disappeared during extend: ${pda.toBase58()}`);
    }
    return pda;
  }

  async writeShareRange(
    gameId: Uint8Array,
    playerIndex: number,
    byteOffset: number,
    data: Uint8Array,
    chunkSize: number = 800,
    auth?: StagingWriteAuth,
  ): Promise<void> {
    const pda = this.deriveSharePDA(gameId, playerIndex);
    if (byteOffset < 0 || byteOffset + data.length > DECK_STAGING_ACCOUNT_SIZE) {
      throw new Error(
        `Share range exceeds staging bounds: ${byteOffset}+${data.length} > ${DECK_STAGING_ACCOUNT_SIZE}`,
      );
    }
    const { authority, signers, tableState, gameState } = this.resolveWriteAuth(auth);
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
      await this.program.methods
        .writeShareDeckStaging!(
          Array.from(gameId),
          playerIndex,
          byteOffset + i,
          Buffer.from(chunk),
        )
        .accounts({
          authority,
          gameState: gameState(gameId),
          tableState,
          shareDeckStaging: pda,
        } as any)
        .signers(signers)
        .rpc();
    }
    const info = await this.provider.connection.getAccountInfo(pda, 'confirmed');
    if (!info) throw new Error(`share_deck_staging missing after write: ${pda.toBase58()}`);
    const onchain = info.data.subarray(byteOffset, byteOffset + data.length);
    if (!Buffer.from(onchain).equals(Buffer.from(data))) {
      throw new Error(`share_deck_staging write mismatch at offset ${byteOffset}`);
    }
  }

  /// Write encrypted deck data to the staging PDA in chunks.
  ///
  /// The deck size depends on the number of players:
  ///   - 2 players:  3,200 bytes (100 values)
  ///   - 5 players:  12,800 bytes (400 values)
  ///   - 10 players: 28,800 bytes (900 values)
  ///
  /// We write in 800-byte chunks to stay within transaction limits.
  async writeChunks(
    gameId: Uint8Array,
    commitments: Uint8Array[],
    chunkSize: number = 800
  ): Promise<void> {
    // Flatten all commitments into a single buffer
    const data = Buffer.concat(commitments.map((c) => Buffer.from(c)));
    // Staging PDA is always max size, but card-major payloads stay ≤900 limbs.
    if (data.length > 28_800) {
      throw new Error(`Deck data exceeds max logical staging size: ${data.length} > 28,800`);
    }
    await this.writeRange(gameId, 0, data, chunkSize);
  }

  /**
   * Write and confirm one sparse range at its absolute staging offset.
   *
   * Callers may queue MPC work for this range as soon as this resolves: the
   * confirmed account bytes have been compared with the requested payload.
   */
  async writeRange(
    gameId: Uint8Array,
    byteOffset: number,
    data: Uint8Array,
    chunkSize: number = 800,
    auth?: StagingWriteAuth,
    confirm = true,
  ): Promise<void> {
    const pda = this.derivePDA(gameId);
    if (byteOffset < 0 || byteOffset + data.length > DECK_STAGING_ACCOUNT_SIZE) {
      throw new Error(
        `Deck range exceeds staging bounds: ${byteOffset}+${data.length} > ${DECK_STAGING_ACCOUNT_SIZE}`
      );
    }

    const { authority, signers, tableState, gameState } = this.resolveWriteAuth(auth);
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(offset, offset + chunkSize);
      await this.program.methods
        .writeDeckStaging!(Array.from(gameId), byteOffset + offset, chunk)
        .accounts({
          authority,
          gameState: gameState(gameId),
          tableState,
          deckStaging: pda,
        } as any)
        .signers(signers)
        .rpc({ commitment: 'processed', preflightCommitment: 'processed' });
    }

    if (confirm) {
      await this.confirmRange(gameId, byteOffset, data);
    }
  }

  /**
   * Pack reveal rows into chunk accounts, write those accounts in parallel,
   * then copy them into `deck_staging`.
   */
  async writeRevealRows(
    gameId: Uint8Array,
    rows: { startIndex: number; ciphertexts: ArrayLike<number>[] }[],
    auth?: StagingWriteAuth,
  ): Promise<void> {
    const ranges = rows.map((row) => ({
      byteOffset: row.startIndex * 32,
      data: Buffer.concat(row.ciphertexts.map((ct) => Buffer.from(ct))),
    }));
    await this.writePackedRanges(gameId, ranges, auth);
  }

  async writePackedRanges(
    gameId: Uint8Array,
    ranges: RevealRange[],
    auth?: StagingWriteAuth,
  ): Promise<void> {
    if (ranges.length === 0) return;
    const chunks = packRevealRanges(ranges);
    if (chunks.length <= 2) {
      for (const range of ranges) {
        await this.writeRange(gameId, range.byteOffset, range.data, 800, auth, false);
      }
      await this.confirmRanges(gameId, ranges);
      return;
    }

    const { authority, signers, tableState, gameState } = this.resolveWriteAuth(auth);
    const authorityKp = signers[0];
    const wallet = this.provider.wallet!;
    const connection = this.provider.connection;
    const programId = this.program.programId;
    const deck = this.derivePDA(gameId);
    const gameStatePda = gameState(gameId);
    const laneCount = Math.min(REVEAL_LANES, chunks.length);
    const lanes = Array.from({ length: laneCount }, () => web3.Keypair.generate());
    const perLane = Math.ceil(chunks.length / laneCount);
    const [empty, rent] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(0),
      connection.getMinimumBalanceForRentExemption(REVEAL_CHUNK_ACCOUNT_SIZE),
    ]);
    // A lane that writes a second chunk must stay rent-exempt between waves.
    // One chunk per lane must finish at exactly zero. A leftover below the
    // empty-account minimum is rejected even when the instruction succeeds.
    const fee = perLane > 1 ? REVEAL_LANE_FEE : 10_000;
    const amount = (perLane > 1 ? empty : 0) + perLane * (rent + fee);
    console.log(
      `[tx-size] reveal_chunks: ${chunks.length} chunks, ${laneCount} lanes, ${Math.ceil(chunks.length / laneCount)} per lane`,
    );
    try {
      await this.sendPayer(
        lanes.map((lane) =>
          web3.SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: lane.publicKey,
            lamports: amount,
          }),
        ),
        wallet.publicKey,
        [],
        true,
        'processed',
      );
      const latest = await connection.getLatestBlockhash('confirmed');
      const pending: { offset: number; data: Buffer; pda: web3.PublicKey }[] = [];
      await Promise.all(chunks.map(async (chunk, index) => {
        const lane = lanes[index % laneCount]!;
        const chunkPda = revealChunkPda(programId, gameId, chunk.offset);
        const existing = await connection.getAccountInfo(chunkPda, 'processed');
        if (existing && chunkPayloadMatches(existing.data, chunk.data)) return;
        pending.push({ offset: chunk.offset, data: chunk.data, pda: chunkPda });
        const write = writeRevealChunkInstruction({
          programId,
          authority,
          payer: lane.publicKey,
          refund: wallet.publicKey,
          gameState: gameStatePda,
          tableState,
          chunk: chunkPda,
          gameId,
          offset: chunk.offset,
          data: chunk.data,
        });
        await this.submitPayer(
          [write],
          lane.publicKey,
          authorityKp ? [lane, authorityKp] : [lane],
          !authorityKp,
          latest,
        );
      }));
      for (let attempt = 0; attempt < 80 && pending.length > 0; attempt++) {
        const infos = await connection.getMultipleAccountsInfo(
          pending.map((chunk) => chunk.pda),
          'processed',
        );
        for (let i = pending.length - 1; i >= 0; i--) {
          const info = infos[i];
          if (info && chunkPayloadMatches(info.data, pending[i]!.data)) pending.splice(i, 1);
        }
        if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (pending.length > 0) {
        throw new Error(
          `reveal chunks not written: ${pending.map((chunk) => chunk.offset).join(',')}`,
        );
      }
      for (let i = 0; i < chunks.length; i += REVEAL_ABSORB_PER_TX) {
        const group = chunks.slice(i, i + REVEAL_ABSORB_PER_TX);
        const absorb = absorbRevealChunksInstruction({
          programId,
          authority,
          gameState: gameStatePda,
          tableState,
          deckStaging: deck,
          gameId,
          pairs: group.map((chunk) => ({
            chunk: revealChunkPda(programId, gameId, chunk.offset),
            lane: wallet.publicKey,
          })),
        });
        await withRetry(async () => {
          await this.sendPayer(
            [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), absorb],
            wallet.publicKey,
            authorityKp ? [authorityKp] : [],
            true,
            'processed',
          );
        }, { retries: 5, delayMs: 200 });
      }
      this.revealLaneSweep = this.sweepRevealLanes(lanes);
    } catch (error) {
      await this.sweepRevealLanes(lanes).catch(() => undefined);
      throw error;
    }
    await this.confirmRanges(gameId, ranges);
  }

  /** Return lane signature dust. Call after the reveal write timer has ended. */
  async finishRevealLaneSweep(): Promise<void> {
    const pending = this.revealLaneSweep;
    this.revealLaneSweep = null;
    if (pending) await pending;
  }

  async confirmRanges(gameId: Uint8Array, ranges: RevealRange[]): Promise<void> {
    const pda = this.derivePDA(gameId);
    for (let attempt = 0; attempt < 100; attempt++) {
      const info = await this.provider.connection.getAccountInfo(pda, 'processed');
      if (
        info
        && ranges.every((range) => {
          const actual = info.data.subarray(range.byteOffset, range.byteOffset + range.data.length);
          return Buffer.from(actual).equals(Buffer.from(range.data));
        })
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`deck_staging packed ranges not confirmed (${ranges.length} ranges)`);
  }

  private async sweepRevealLanes(lanes: web3.Keypair[]): Promise<void> {
    const wallet = this.provider.wallet!.publicKey;
    const infos = await this.provider.connection.getMultipleAccountsInfo(
      lanes.map((lane) => lane.publicKey),
      'processed',
    );
    const transfers: web3.TransactionInstruction[] = [];
    const signers: web3.Keypair[] = [];
    lanes.forEach((lane, index) => {
      const info = infos[index];
      if (!info || info.lamports === 0) return;
      transfers.push(
        web3.SystemProgram.transfer({
          fromPubkey: lane.publicKey,
          toPubkey: wallet,
          lamports: info.lamports,
        }),
      );
      signers.push(lane);
    });
    if (transfers.length === 0) return;
    for (let i = 0; i < transfers.length; i += 6) {
      await this.sendPayer(
        transfers.slice(i, i + 6),
        wallet,
        signers.slice(i, i + 6),
        true,
        'processed',
      );
    }
  }

  /** Send a signed transaction without waiting for confirmation. */
  private async submitPayer(
    instructions: web3.TransactionInstruction[],
    feePayer: web3.PublicKey,
    signers: web3.Keypair[],
    walletSigns: boolean,
    blockhash?: { blockhash: string; lastValidBlockHeight: number },
    skipPreflight = true,
  ): Promise<void> {
    const latest = blockhash ?? await this.provider.connection.getLatestBlockhash('confirmed');
    const transaction = new web3.Transaction({
      feePayer,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(...instructions);
    if (signers.length > 0) transaction.partialSign(...signers);
    const signed = walletSigns
      ? await this.provider.wallet!.signTransaction(transaction)
      : transaction;
    await this.provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight,
      preflightCommitment: 'processed',
    });
  }

  private async sendPayer(
    instructions: web3.TransactionInstruction[],
    feePayer: web3.PublicKey,
    signers: web3.Keypair[],
    walletSigns: boolean,
    commitment: web3.Commitment,
    _blockhash?: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<void> {
    await confirmOrResend(this.provider.connection, async (latest) => {
      const transaction = new web3.Transaction({
        feePayer,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(...instructions);
      if (signers.length > 0) transaction.partialSign(...signers);
      const signed = walletSigns
        ? await this.provider.wallet!.signTransaction(transaction)
        : transaction;
      return this.provider.connection.sendRawTransaction(signed.serialize(), {
        preflightCommitment: commitment,
      });
    }, commitment);
  }

  async confirmRange(
    gameId: Uint8Array,
    byteOffset: number,
    data: Uint8Array,
  ): Promise<void> {
    const pda = this.derivePDA(gameId);
    for (let attempt = 0; attempt < 100; attempt++) {
      const info = await this.provider.connection.getAccountInfo(pda, 'confirmed');
      const actual = info?.data.subarray(byteOffset, byteOffset + data.length);
      if (actual && Buffer.from(actual).equals(Buffer.from(data))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `deck_staging range not confirmed at offset=${byteOffset} length=${data.length}`
    );
  }

  /// Close the DeckStaging PDA and refund all rent to the authority.
  ///
  /// On-chain check: `gameState.revealedPartials >= gameState.totalPartials`.
  /// For a 10-player game, this means all 25 cards have been revealed.
  async close(gameId: Uint8Array, authority?: web3.Keypair): Promise<void> {
    const pda = this.derivePDA(gameId);
    const gameStatePDA = new GameStateHelper(this.program, this.provider).derivePDA(gameId);
    const signer = await stagingRentPayer(this.provider, authority);

    await this.program.methods
      .closeDeckStaging!()
      .accounts({
        authority: signer
          ? signer.publicKey
          : this.provider.wallet!.publicKey,
        deckStaging: pda,
        gameState: gameStatePDA,
      } as any)
      .remainingAccounts(
        casinoVaultRemaining(
          signer ? signer.publicKey : this.provider.wallet!.publicKey,
          this.program.programId,
        ),
      )
      .signers(signer ? [signer] : [])
      .rpc();
  }

  /// Close a per-player `share_deck_staging` PDA after `finalize_share_phase`.
  ///
  /// On-chain check: `gameState.shareFinalized`. Arcis share verify must be done.
  async closeShare(
    gameId: Uint8Array,
    playerIndex: number,
    authority?: web3.Keypair,
  ): Promise<void> {
    const pda = this.deriveSharePDA(gameId, playerIndex);
    const auth = this.resolveWriteAuth();
    const gameStatePDA = new GameStateHelper(this.program, this.provider).derivePDA(gameId);

    await (this.program.methods as any)
      .closeShareDeckStaging(playerIndex)
      .accounts({
        authority: authority
          ? authority.publicKey
          : auth.authority,
        gameState: gameStatePDA,
        tableState: auth.tableState,
        shareDeckStaging: pda,
      })
      .remainingAccounts(
        casinoVaultRemaining(
          authority ? authority.publicKey : auth.authority,
          this.program.programId,
        ),
      )
      .signers(authority ? [authority] : auth.signers)
      .rpc();
  }
}

/// Helper class for managing RevealedCard PDAs (one per recipient × card).
export class RevealedCardsHelper {
  constructor(
    private program: Program,
    private provider: Provider
  ) {}

  /// Derive the RevealedCard PDA for a recipient-scoped card reveal.
  derivePDA(
    gameId: Uint8Array,
    recipientIndex: number,
    cardIndex: number,
  ): web3.PublicKey {
    const cardIndexLe = Buffer.alloc(2);
    cardIndexLe.writeUInt16LE(cardIndex);
    const [pda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from('RevealedCard'),
        Buffer.from(gameId),
        Buffer.from([recipientIndex]),
        cardIndexLe,
      ],
      this.program.programId,
    );
    return pda;
  }

  /// Explicitly close a completed RevealedCard PDA and refund its recipient.
  async close(
    gameId: Uint8Array,
    recipientIndex: number,
    cardIndex: number,
    gameState: web3.PublicKey,
    tableState: web3.PublicKey,
    authority?: web3.Keypair,
  ): Promise<void> {
    const pda = this.derivePDA(gameId, recipientIndex, cardIndex);
    const revealed = await (this.program.account as any).revealedCard.fetch(pda);
    const refundTo = revealed.refundTo ?? revealed.refund_to;

    await (this.program.methods as any)
      .closeRevealedCard()
      .accounts({
        authority: authority
          ? authority.publicKey
          : this.provider.wallet!.publicKey,
        refundTo,
        gameState,
        tableState,
        revealedCard: pda,
      } as any)
      .signers(authority ? [authority] : [])
      .rpc();
  }
}

/// Light Protocol integration for storing revealed partials in compressed accounts.
///
/// ARCHITECTURE:
///   The light-casino program (Anchor 0.31.1 + light-sdk 0.13.0) stores revealed
///   card partials in Light Protocol compressed accounts. Each account holds
///   up to 8 commitments (32 bytes each) plus metadata.
///
///   For a 10-player game, each card produces 36 partial values = 9 commitments,
///   requiring 2 compressed accounts per card. The TypeScript orchestration layer
///   handles chunking across multiple accounts.
///
/// PRODUCTION NOTE:
///   This helper uses the Light Protocol SDK's placeholder validity proof
///   for E2E testing on localnet. In production, replace with real proofs
///   generated by the Light Protocol prover service.
///
///   Install the SDK: npm install @lightprotocol/stateless.js
///   Documentation: https://github.com/Lightprotocol/light-protocol
export class LightProtocolHelper {
  constructor(
    private lightPokerProgram: any,
    private provider: Provider,
  ) {}

  /**
   * Store revealed partials in Light Protocol compressed accounts.
   *
   * @param gameId - 32-byte game identifier
   * @param chunkIndex - Which chunk of partials this is (0-based)
   * @param startIndex - Starting card index in the deck
   * @param count - Number of commitments in this chunk (max 8)
   * @param commitments - Array of 32-byte commitment hashes
   */
  async storeRevealedPartials(
    gameId: Uint8Array,
    chunkIndex: number,
    startIndex: number,
    count: number,
    commitments: Uint8Array[],
  ): Promise<void> {
    if (commitments.length > 8) {
      throw new Error('Max 8 commitments per compressed account');
    }

    // Pad to exactly 8 commitments
    const padded = [...commitments];
    while (padded.length < 8) {
      padded.push(new Uint8Array(32).fill(0));
    }

    // Validity proof for compressed account creation.
    // In production, this is generated by the Light Protocol prover service.
    // For E2E testing on localnet, we use the SDK's placeholder proof which
    // is accepted by the Light Protocol system program in test environments.
    const { placeholderValidityProof } = await import('@lightprotocol/stateless.js');
    const validityProof = placeholderValidityProof();

    await this.lightPokerProgram.methods
      .createRevealedPartials(
        validityProof,
        null as any,
        0,
        new web3.PublicKey(gameId),
        0,
        chunkIndex,
        startIndex,
        count,
        ...padded.map((c) => Array.from(c) as [number]),
      )
      .accounts({
        signer: this.provider.wallet!.publicKey,
      })
      .remainingAccounts([])
      .rpc();
  }

  /**
   * Read revealed partials from a Light Protocol compressed account.
   *
   * @param gameId - 32-byte game identifier
   * @param chunkIndex - Which chunk to read
   * @returns Array of 32-byte commitments (only `count` are valid)
   */
  async readRevealedPartials(
    gameId: Uint8Array,
    chunkIndex: number,
  ): Promise<{ commitments: Uint8Array[]; count: number }> {
    // Production: use Light Protocol indexer to find compressed accounts
    // For E2E testing, we use the Anchor account fetcher as fallback
    const account = await this.lightPokerProgram.account
      .revealedPartialsCompressedAccount
      .fetch(
        web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('revealed_partials'),
            Buffer.from(gameId),
            Buffer.from([chunkIndex]),
          ],
          this.lightPokerProgram.programId,
        )[0],
      );

    if (!account) {
      throw new Error(`No revealed partials found for chunk ${chunkIndex}`);
    }

    // Extract valid commitments (up to account.count)
    const commitments = [
      account.commitment_0,
      account.commitment_1,
      account.commitment_2,
      account.commitment_3,
      account.commitment_4,
      account.commitment_5,
      account.commitment_6,
      account.commitment_7,
    ].slice(0, account.count);

    return { commitments, count: account.count };
  }
}

/// Full game flow demonstrating staging PDA + Light Protocol integration.
///
/// The deck size depends on the number of players:
///   - 2 players:  25 cards × 4 values  = 100 values  = 3,200 bytes
///   - 5 players:  25 cards × 16 values = 400 values  = 12,800 bytes
///   - 10 players: 25 cards × 36 values = 900 values  = 28,800 bytes
///
/// The staging PDA is always created at max size (28,800 bytes) but only
/// the needed bytes are written. Rent is fully refunded on close.
///
/// Flow:
///   1. Client initializes GameState with numPlayers and numCards
///   2. Client creates DeckStaging PDA (max 28,800 bytes)
///   3. Client writes deck data to DeckStaging PDA
///   4. Client calls poker.verify_deck_hash_chunk (Arcis reads staging PDA)
///
///   // For each card:
///   5. Client calls poker.reveal_card (Arcis reads staging PDA)
///   6. Arcis callback writes to RevealedCard PDA
///   7. Client calls light_casino.create_revealed_partials (compressed account)
///   8. Client closes RevealedCard PDA (refund rent)
///   9. Client calls game.recordReveal(numPlayers - 1)
///
///   10. After all cards: client closes DeckStaging PDA
///       (on-chain check: revealedPartials >= totalPartials)
///
/// Rent economics for 25-card, 10-player game:
///   - DeckStaging: ~0.2 SOL funded, 100% refunded on close
///   - RevealedCard: ~0.004 SOL per card × 25 = ~0.1 SOL, 100% refunded
///   - Light Protocol compressed account: ~0.0001 SOL per card permanent
///   - Net cost: ~0.0025 SOL (vs 0.2 SOL for uncompressed permanent storage)
///
export async function runGameFlow(
  pokerProgram: Program,
  lightPokerProgram: Program,
  provider: Provider,
  gameId: Uint8Array,
  commitments: Uint8Array[],
  numPlayers: number = 10,
  numCards: number = 25
): Promise<void> {
  const game = new GameStateHelper(pokerProgram, provider);
  const staging = new DeckStagingHelper(pokerProgram, provider);
  const revealed = new RevealedCardsHelper(pokerProgram, provider);
  const lightProtocol = new LightProtocolHelper(lightPokerProgram, provider);

  // Step 1: Initialize game state
  await game.initialize(gameId, numPlayers, numCards);

  // Step 2-3: Create staging PDA and populate with deck data
  const stagingPDA = await staging.create(gameId);
  await staging.writeChunks(gameId, commitments);

  // Step 4: Arcis hash verification
  // ... verify_deck_hash_chunk ...

  // Step 5-9: Reveal each card, store in Light Protocol, record progress
  const partialsPerCard = numPlayers - 1;
  for (let cardIndex = 0; cardIndex < numCards; cardIndex++) {
    // Arcis reveal for this card
    // ... reveal_card(cardIndex) ...
    // ... callback writes to RevealedCard PDA ...

    // Store in Light Protocol compressed account
    // Read revealed data from RevealedCard PDA after Arcis callback
    // const revealedPDA = revealed.derivePDA(computationAccount);
    // const revealedData = await pokerProgram.account.revealedCard.fetch(revealedPDA);
    // 
    // Chunk commitments into groups of 8 for Light Protocol storage
    // const chunkCommitments = revealedData.partials.slice(0, partialsPerCard * 4);
    // await lightProtocol.storeRevealedPartials(
    //   gameId, cardIndex, cardIndex * 4, partialsPerCard * 4, chunkCommitments
    // );

    // Close temporary RevealedCard PDA after Light write
    // await revealed.close(gameId, recipientIndex, cardIndex);

    // Record reveal progress (partialsPerCard partials revealed)
    await game.recordReveal(gameId, partialsPerCard);
  }

  // Step 10: Close staging PDA after all reveals complete
  // On-chain check: gameState.revealedPartials >= gameState.totalPartials
  await staging.close(gameId);
}
