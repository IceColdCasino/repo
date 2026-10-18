import fs from 'node:fs';
import path from 'node:path';
import { Program, type AnchorProvider, web3, BN } from '@coral-xyz/anchor';
import {
  getArciumProgram,
  getCircuitState,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getRawCircuitAccAddress,
} from '@arcium-hq/client';
import { createHash, randomBytes } from 'node:crypto';
import { loadWhitelistAdminProvider } from '../chain/admin-provider';
import { isLocalCluster, rentExemptLamports } from '../chain/fund-sol';
import { KeypairWallet } from '../chain/keypair-wallet';
import { installDurableConfirm } from '../chain/confirm-tx';
import { ComputationRentLedger } from './claim-computation-rent';
import { casinoVaultRemaining, clusterRentLamportsPerByte, drawStagedRent, withComputationFloat } from '../chain/rent-vault';
import { PLAYER_GAME_ESCROW_DATA } from '../chain/table-float';
import { VERIFY_CHUNK_LEN } from '../chain/share-deck-staging';
import {
  revealLimbConcurrency,
  arciumQueueGate,
  revealQueueGate,
  withArciumMempoolRetry,
} from './heap';
import {
  assertCardRevealAllowed,
  CardRevealNotAllowedError,
  expectedRevealLimbCount,
} from '../backend/reveal-policy';
import { decodeSealAccount, type SealedShowdownAccount } from '../casino-calc';

const POKER_BUILD_DIR = (typeof process !== 'undefined' && typeof process.cwd === 'function')
  ? path.join(process.cwd(), 'rust/casino/build')
  : 'rust/casino/build';
/** Matches `@arcium-hq/client` MAX_ACCOUNT_SIZE (not re-exported). */
const RAW_CIRCUIT_MAX_ACCOUNT_SIZE = 10_485_760;
const RAW_CIRCUIT_HEADER = 9;
/** Matches `@arcium-hq/client` upload and resize limits. */
const MAX_UPLOAD_PER_TX_BYTES = 814;
const MAX_REALLOC_PER_IX = 10_240;
const MAX_EMBIGGEN_IX_PER_TX = 18;
/** Slots after deactivation before a computation definition can be closed. */
const COMP_DEF_TTL_SLOTS = 180;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  console.time(label);
  try {
    return await work();
  } finally {
    console.timeEnd(label);
  }
}

export function deriveRevealedCardPDA(
  programId: web3.PublicKey,
  gameId: Uint8Array,
  recipientIndex: number,
  cardIndex: number,
): web3.PublicKey {
  const cardIndexLe = Buffer.alloc(2);
  cardIndexLe.writeUInt16LE(cardIndex);
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('RevealedCard'), Buffer.from(gameId), Buffer.from([recipientIndex]), cardIndexLe],
    programId,
  )[0];
}

/** Canonical recipient-scoped MPC showdown material commitment PDA. */
export function deriveShowdownMaterialCommitmentPDA(
  programId: web3.PublicKey,
  gameId: Uint8Array,
  generation: number | BN,
  recipientIndex: number,
): web3.PublicKey {
  const generationLe = new BN(generation).toArrayLike(Buffer, 'le', 8);
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('showdown_material'), Buffer.from(gameId), generationLe, Buffer.from([recipientIndex])],
    programId,
  )[0];
}

export function derivePlayerGameEscrowPDA(
  programId: web3.PublicKey,
  gameId: Uint8Array,
  playerIndex: number,
): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from('player_game_escrow'), Buffer.from(gameId), Buffer.from([playerIndex])],
    programId,
  )[0];
}

/**
 * Seal-account bytes locked by `seal_progress_offsets` in the casino program.
 * The 8-byte discriminator is included.
 */
/**
 * `PendingOperation` sits just before `input_nonce` (serialized offset 779).
 * `expires_slot` is the u64 at serialized 770; `status` is the byte at 778.
 * Account offsets include the 8-byte discriminator. Status 1 is pending.
 */
const SEAL_PENDING_EXPIRES_OFFSET = 778;
const SEAL_PENDING_STATUS_OFFSET = 786;
const SEAL_PENDING_STATUS = 1;
/** Locked by `seal_progress_offsets`: consumed byte, then the slot bitmask. */
export const SEAL_CONSUMED_OFFSET = 1126;

function sealPendingExpiresSlot(data: Uint8Array): bigint {
  if (data.length < SEAL_PENDING_EXPIRES_OFFSET + 8) return 0n;
  const view = new DataView(data.buffer, data.byteOffset + SEAL_PENDING_EXPIRES_OFFSET, 8);
  return view.getBigUint64(0, true);
}

function sealErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/https?:\/\/\S+/g, '[rpc]');
}

/**
 * CompDef for the showdown seal. Both coefficients and the revealed rows
 * are one circuit. `activeCoeffs` stays in the signature for callers.
 */
export function sealShowdownCompDefNames(activeCoeffs: number): string[] {
  if (!Number.isInteger(activeCoeffs) || activeCoeffs !== 2) {
    throw new Error(`showdown coefficient count ${activeCoeffs} is out of range`);
  }
  return ['sealShowdownPair'];
}

/** Snake_case circuit name → Anchor initCompDef method suffix. */
const CIRCUIT_OFFSET_ALIAS: Record<string, string> = {
  revealCard: 'reveal_card_v2',
  applyCasinoPlayerNet: 'apply_casino_player_net_v2',
  settleCasinoHand: 'settle_casino_hand_v2',
  computePots: 'compute_pots_v4',
  distributeAndSettle: 'distribute_and_settle_v3',
  sealShowdownPair: 'seal_showdown_pair',
};

function launchClusterOffset(): number | null {
  const launch = (globalThis as {
    window?: { __ZK_LAUNCH_CONFIG?: { clusterOffset?: number | string } };
  }).window?.__ZK_LAUNCH_CONFIG;
  if (launch?.clusterOffset == null) return null;
  const n = Number(launch.clusterOffset);
  return Number.isFinite(n) ? n : null;
}

function circuitOffsetName(camelName: string): string {
  const aliased = CIRCUIT_OFFSET_ALIAS[camelName];
  if (aliased) return aliased;
  return camelName
    // hash10 → hash_10 (digit after lowercase only)
    .replace(/([a-z])(\d)/g, '$1_$2')
    // camelCase / PascalCase boundaries
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export class ArciumMPCHelper {
  private readonly clusterOffset: number;
  private readonly clusterAccount: web3.PublicKey;
  private readonly rentLedger: ComputationRentLedger;

  constructor(private pokerProgram: Program, private provider: AnchorProvider) {
    installDurableConfirm(provider.connection);
    // Localnet default 0. Do NOT call getArciumEnv() — it throws in browsers
    // ("Arcium local env is not available in browser") and breaks WebView share/bet.
    // Launch config carries the devnet cluster. A process shim that starts at 0
    // must not hide that offset.
    const launchOffset = launchClusterOffset();
    if (typeof process !== 'undefined' && process.env) {
      const current = process.env.ARCIUM_CLUSTER_OFFSET;
      if ((current == null || current === '0') && launchOffset != null && launchOffset !== 0) {
        process.env.ARCIUM_CLUSTER_OFFSET = String(launchOffset);
      } else if (current == null) {
        process.env.ARCIUM_CLUSTER_OFFSET = '0';
      }
    }
    const parsed = Number(
      launchOffset != null && launchOffset !== 0
        ? launchOffset
        : (typeof process !== 'undefined' ? process.env?.ARCIUM_CLUSTER_OFFSET : 0),
    );
    this.clusterOffset = Number.isFinite(parsed) ? parsed : 0;
    this.clusterAccount = getClusterAccAddress(this.clusterOffset);
    this.rentLedger = new ComputationRentLedger(provider, this.clusterOffset);
  }

  /**
   * Remember a queued computation so its rent can be claimed after the callback.
   * `authority` is the seat key when that seat is the instruction payer.
   */
  noteComputation(
    offset: number | BN,
    authority?: web3.Keypair | null,
    restoreToVault = true,
  ): void {
    this.rentLedger.note(offset, authority, restoreToVault);
  }

  /**
   * Move one computation account's rent out of the payer's vault for `run`,
   * then return the unused part. `authority` signs when that seat is the payer.
   */
  async payComputationFromFloat(
    offset: BN,
    run: () => Promise<void>,
    authority?: web3.Keypair | null,
  ): Promise<void> {
    const payer = authority?.publicKey ?? this.provider.wallet.publicKey;
    const computation = getComputationAccAddress(this.clusterOffset, offset);
    await withComputationFloat(
      this.provider,
      payer,
      computation,
      run,
      authority ?? undefined,
    );
  }

  /** Claim rent for every tracked computation that has already finalized. */
  async reclaimFinalizedComputations(): Promise<void> {
    await this.rentLedger.reclaimFinalized();
  }

  /** Wait until one computation finalizes, then claim its rent back to its payer. */
  async reclaimComputationWhenFinalized(offset: BN, timeoutMs = 180_000): Promise<void> {
    await this.rentLedger.reclaimWhenFinalized(offset, timeoutMs);
  }

  private derivePDA(gameId: Uint8Array, seed: string, extra?: Buffer): web3.PublicKey {
    const seeds: Buffer[] = [Buffer.from(seed), Buffer.from(gameId)];
    if (extra) seeds.push(extra);
    return web3.PublicKey.findProgramAddressSync(seeds, this.pokerProgram.programId)[0];
  }

  deriveShowdownMaterialCommitment(
    gameId: Uint8Array,
    generation: number | BN,
    recipientIndex: number,
  ): web3.PublicKey {
    return deriveShowdownMaterialCommitmentPDA(
      this.pokerProgram.programId,
      gameId,
      generation,
      recipientIndex,
    );
  }

  async fetchShowdownMaterialCommitment(
    gameId: Uint8Array,
    generation: number | BN,
    recipientIndex: number,
  ): Promise<any> {
    const address = this.deriveShowdownMaterialCommitment(gameId, generation, recipientIndex);
    return (this.pokerProgram.account as any).showdownMaterialCommitment.fetch(address);
  }

  /** Shared Arcium queue accounts for a computation offset + circuit name. */
  arciumQueueAccounts(computationOffset: number | BN, circuitCamel: string) {
    const offsetBn =
      typeof computationOffset === 'number'
        ? new BN(computationOffset)
        : computationOffset;
    const circuit = circuitOffsetName(circuitCamel);
    return {
      mxeAccount: getMXEAccAddress(this.pokerProgram.programId),
      mempoolAccount: getMempoolAccAddress(this.clusterOffset),
      executingPool: getExecutingPoolAccAddress(this.clusterOffset),
      computationAccount: getComputationAccAddress(this.clusterOffset, offsetBn),
      compDefAccount: getCompDefAccAddress(
        this.pokerProgram.programId,
        Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE(),
      ),
      clusterAccount: this.clusterAccount,
    };
  }

  deriveRevealedCardPDA(
    gameId: Uint8Array,
    recipientIndex: number,
    cardIndex: number,
  ): web3.PublicKey {
    return deriveRevealedCardPDA(
      this.pokerProgram.programId,
      gameId,
      recipientIndex,
      cardIndex,
    );
  }

  derivePlayerGameEscrowPDA(gameId: Uint8Array, playerIndex: number): web3.PublicKey {
    return derivePlayerGameEscrowPDA(this.pokerProgram.programId, gameId, playerIndex);
  }

  deriveVerifyAccumulatorPDA(gameId: Uint8Array): web3.PublicKey {
    return this.derivePDA(gameId, 'verify_accumulator');
  }

  deriveShareVerifyAccPDA(gameId: Uint8Array, playerIndex: number): web3.PublicKey {
    return this.derivePDA(gameId, 'share_verify_acc', Buffer.from([playerIndex]));
  }

  deriveShareDeckStagingPDA(gameId: Uint8Array, playerIndex: number): web3.PublicKey {
    return this.derivePDA(gameId, 'share_deck_staging', Buffer.from([playerIndex]));
  }

  derivePlayerMpcKeyPDA(
    gameId: Uint8Array,
    playerIndex: number,
    purpose: number,
    generation: bigint | number,
  ): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync([
      Buffer.from('player_mpc_key'),
      Buffer.from(gameId),
      Buffer.from([playerIndex]),
      Buffer.from([purpose]),
      new BN(generation.toString()).toArrayLike(Buffer, 'le', 8),
    ], this.pokerProgram.programId)[0];
  }

  /** True when MXE.computationDefinitions includes this circuit's CompDef offset. */
  async isCompDefRegisteredOnMxe(name: string): Promise<boolean> {
    const circuit = circuitOffsetName(name);
    const programId = this.pokerProgram.programId;
    const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
    const arciumProgram = getArciumProgram(this.provider);
    const mxe = await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(programId));
    return mxe.computationDefinitions.some((n: any) => Number(n) === offset);
  }

  /**
   * Read CompDef circuit state without uploading.
   * Returns `missing` when the account does not exist.
   * Returns `stale` when finalized metadata exists but on-chain raw circuit
   * bytes do not match `build/<circuit>.arcis` (genesis skip-upload trap).
   * Returns `mxe_orphan` when CompDef is finalized but MXE does not list its
   * offset — queue_computation then fails with InvalidComputationDefinition.
   */
  async getCompDefState(
    name: string,
  ): Promise<
    'OnchainFinalized' | 'OnchainPending' | 'Offchain' | 'missing' | 'stale' | 'mxe_orphan'
  > {
    const circuit = circuitOffsetName(name);
    const programId = this.pokerProgram.programId;
    const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
    const arciumProgram = getArciumProgram(this.provider);
    const compDefAccount = getCompDefAccAddress(programId, offset);
    const existing = await this.provider.connection.getAccountInfo(compDefAccount);
    if (!existing) return 'missing';
    const acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefAccount);
    const state = getCircuitState(acc.circuitSource as any);
    if (state === 'OnchainFinalized') {
      // A deactivated definition cannot be queued, and there is no reactivate.
      if (acc.deactivationSlot != null) return 'stale';
      const arcisPath = path.join(POKER_BUILD_DIR, `${circuit}.arcis`);
      if (fs.existsSync(arcisPath)) {
        const ok = await this.rawCircuitMatchesLocal(circuit, compDefAccount, fs.readFileSync(arcisPath));
        if (!ok) return 'stale';
      }
      if (!(await this.isCompDefRegisteredOnMxe(name))) return 'mxe_orphan';
    }
    return state;
  }

  /** Compare on-chain raw circuit payload to local .arcis bytes. */
  private async rawCircuitMatchesLocal(
    circuit: string,
    compDefAccount: web3.PublicKey,
    local: Uint8Array,
  ): Promise<boolean> {
    const maxPayload = RAW_CIRCUIT_MAX_ACCOUNT_SIZE - RAW_CIRCUIT_HEADER;
    const numAccs = Math.ceil(local.length / maxPayload);
    const parts: Buffer[] = [];
    for (let i = 0; i < numAccs; i++) {
      const info = await this.provider.connection.getAccountInfo(
        getRawCircuitAccAddress(compDefAccount, i),
      );
      if (!info || info.data.length < RAW_CIRCUIT_HEADER) return false;
      parts.push(Buffer.from(info.data.subarray(RAW_CIRCUIT_HEADER)));
    }
    const onchain = Buffer.concat(parts).subarray(0, local.length);
    if (onchain.length !== local.length) return false;
    return createHash('sha256').update(onchain).digest('hex') ===
      createHash('sha256').update(local).digest('hex');
  }

  /**
   * Repair a definition whose raw bytes do not match `build/<circuit>.arcis`.
   * A finalized definition whose bytes already match stays active. A length
   * change, a deactivated definition, or a finalized shell whose bytes do not
   * match is closed and initialized again. `uploadCircuit` is rejected once a
   * definition is completed.
   * Returns true when new bytes were written.
   */
  async forceUploadCircuit(name: string): Promise<boolean> {
    const circuit = circuitOffsetName(name);
    const programId = this.pokerProgram.programId;
    const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
    const arciumProgram = getArciumProgram(this.provider);
    const compDefAccount = getCompDefAccAddress(programId, offset);
    const arcisPath = path.join(POKER_BUILD_DIR, `${circuit}.arcis`);
    if (!fs.existsSync(arcisPath)) throw new Error(`Missing circuit artifact: ${arcisPath}`);
    const raw = fs.readFileSync(arcisPath);
    const acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefAccount);
    const onchainLen = Number(acc.definition.circuitLen.toString());
    const deactivated = acc.deactivationSlot != null;
    if (onchainLen !== raw.length || deactivated) {
      console.log(
        `[comp-def] replace ${circuit}: on-chain ${onchainLen} bytes, local ${raw.length}, deactivated=${deactivated}`,
      );
      await this.replaceCompDef(name);
      return true;
    }
    if (getCircuitState(acc.circuitSource as any) === 'OnchainFinalized') {
      if (await this.rawCircuitMatchesLocal(circuit, compDefAccount, raw)) {
        console.log(`[comp-def] ${circuit} is finalized (${raw.length} bytes). Leaving it active.`);
        return false;
      }
      // uploadCircuit is rejected after finalize, so a same-length shell has to
      // be closed and initialized again before the bytes can be written.
      console.log(
        `[comp-def] replace ${circuit}: finalized ${raw.length} bytes do not match the local circuit`,
      );
      await this.replaceCompDef(name);
      return true;
    }
    console.log(`[comp-def] rewrite raw ${circuit} (${raw.length} bytes)`);
    try {
      await this.writeRawCircuit(offset, raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(
        `rewrite of finalized ${circuit} failed (${detail}). Leaving the definition active.`,
      );
    }
    if (!(await this.rawCircuitMatchesLocal(circuit, compDefAccount, raw))) {
      throw new Error(`force-upload ${circuit} completed but on-chain hash still mismatches`);
    }
    return true;
  }

  /**
   * Write every upload transaction for one raw account in a single wave.
   * The bytes land in one circuit account, so extra fee payers would not make
   * the writes concurrent. The previous batches of 20 waited for confirmation
   * before the next group was sent.
   */
  private async sendCircuitUploadWave(
    arciumProgram: ReturnType<typeof getArciumProgram>,
    offset: number,
    programId: web3.PublicKey,
    rawIndex: number,
    part: Buffer,
  ): Promise<void> {
    const txs = Math.ceil(part.length / MAX_UPLOAD_PER_TX_BYTES);
    console.log(`[comp-def] sending ${txs} upload txs in one wave`);
    const signer = this.provider.wallet.publicKey;
    let pending = Array.from({ length: txs }, (_, index) => index);
    const rounds = Math.max(8, Math.ceil(txs / 16) + 4);
    for (let round = 0; round < rounds && pending.length > 0; round++) {
      const block = await this.provider.connection.getLatestBlockhash('processed');
      const signatures = new Map<number, string>();
      await Promise.all(pending.map(async (index) => {
        try {
          const off = MAX_UPLOAD_PER_TX_BYTES * index;
          const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
          padded.set(part.subarray(off, Math.min(part.length, off + MAX_UPLOAD_PER_TX_BYTES)));
          const tx = await (arciumProgram.methods as any)
            .uploadCircuit(offset, programId, rawIndex, Array.from(padded), off)
            .accounts({ signer })
            .transaction();
          tx.recentBlockhash = block.blockhash;
          tx.feePayer = signer;
          const signed = await this.provider.wallet.signTransaction(tx);
          const signature = await this.provider.connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: true,
            preflightCommitment: 'processed',
          });
          signatures.set(index, signature);
        } catch (error) {
          console.warn(`[comp-def] upload tx ${index} was not accepted: ${error instanceof Error ? error.message : error}`);
        }
      }));
      const failed = await this.unconfirmedUploads(signatures);
      const missing = pending.filter((index) => !signatures.has(index));
      pending = [...new Set([...failed, ...missing])];
      if (pending.length > 0) {
        console.log(`[comp-def] ${pending.length} upload txs still open`);
      }
    }
    if (pending.length > 0) {
      throw new Error(`${pending.length} circuit upload txs did not land`);
    }
  }

  private async unconfirmedUploads(signatures: Map<number, string>): Promise<number[]> {
    const entries = [...signatures.entries()];
    const failed: number[] = [];
    let open = entries.slice();
    const deadline = Date.now() + 1_500;
    while (open.length > 0 && Date.now() < deadline) {
      const next: [number, string][] = [];
      for (let i = 0; i < open.length; i += 200) {
        const slice = open.slice(i, i + 200);
        const { value } = await this.provider.connection.getSignatureStatuses(
          slice.map(([, signature]) => signature),
        );
        slice.forEach(([index], at) => {
          const status = value[at];
          if (!status?.confirmationStatus) {
            next.push(slice[at]!);
            return;
          }
          if (status.err) failed.push(index);
        });
      }
      open = next;
      if (open.length > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [...failed, ...open.map(([index]) => index)];
  }

  private async finalizeUploadedCircuit(offset: number): Promise<void> {
    const programId = this.pokerProgram.programId;
    const arciumProgram = getArciumProgram(this.provider);
    const tx = await (arciumProgram.methods as any)
      .finalizeComputationDefinition(offset, programId)
      .accounts({ signer: this.provider.wallet.publicKey })
      .transaction();
    await this.provider.sendAndConfirm(tx, [], {
      commitment: 'confirmed',
      skipPreflight: true,
    });
  }

  /** Create any missing raw accounts, grow them, and write the local circuit bytes. */
  private async writeRawCircuit(offset: number, raw: Buffer, rewrite = true): Promise<void> {
    const programId = this.pokerProgram.programId;
    const arciumProgram = getArciumProgram(this.provider);
    const compDefAccount = getCompDefAccAddress(programId, offset);
    const maxPayload = RAW_CIRCUIT_MAX_ACCOUNT_SIZE - RAW_CIRCUIT_HEADER;
    const numAccs = Math.ceil(raw.length / maxPayload);
    const signer = this.provider.wallet.publicKey;
    for (let ai = 0; ai < numAccs; ai++) {
      const part = raw.subarray(ai * maxPayload, (ai + 1) * maxPayload);
      const required = part.length + RAW_CIRCUIT_HEADER;
      const rawPda = getRawCircuitAccAddress(compDefAccount, ai);
      let info = await this.provider.connection.getAccountInfo(rawPda);
      // Size is checked before embiggen. A freshly grown account is still
      // zeros, so treating "already big enough" as "already written" skips
      // the upload and leaves the node with a circuit of weight 0.
      const priorPayload = info && info.data.length >= required
        ? Buffer.from(info.data.subarray(RAW_CIRCUIT_HEADER, RAW_CIRCUIT_HEADER + part.length))
        : null;
      if (!info) {
        await (arciumProgram.methods as any)
          .initRawCircuitAcc(offset, programId, ai)
          .accounts({ signer })
          .rpc({ commitment: 'confirmed' });
        info = await this.provider.connection.getAccountInfo(rawPda);
      }
      for (let grown = 0; info && info.data.length < required; grown++) {
        if (grown > 64) {
          throw new Error(`raw circuit account stayed at ${info.data.length} bytes, need ${required}`);
        }
        const ix = await (arciumProgram.methods as any)
          .embiggenRawCircuitAcc(offset, programId, ai)
          .accounts({ signer })
          .instruction();
        const gap = required - info.data.length;
        const n = Math.min(MAX_EMBIGGEN_IX_PER_TX, Math.ceil(gap / MAX_REALLOC_PER_IX));
        const tx = new web3.Transaction();
        for (let k = 0; k < n; k++) tx.add(ix);
        await this.provider.sendAndConfirm(tx, [], { commitment: 'confirmed' });
        info = await this.provider.connection.getAccountInfo(rawPda);
      }
      if (!rewrite && priorPayload?.equals(part)) continue;
      await this.sendCircuitUploadWave(arciumProgram, offset, programId, ai, part);
    }
  }

  /**
   * Deactivate, wait out the 180-slot TTL, close, and init the definition again
   * so the on-chain circuit length matches the local `.arcis`.
   */
  private async replaceCompDef(name: string): Promise<void> {
    const circuit = circuitOffsetName(name);
    const programId = this.pokerProgram.programId;
    const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
    const arciumProgram = getArciumProgram(this.provider);
    const compDefAccount = getCompDefAccAddress(programId, offset);
    const signer = this.provider.wallet.publicKey;

    let acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefAccount);
    if (acc.deactivationSlot == null) {
      try {
        await (arciumProgram.methods as any)
          .deactivateComputationDefinition(offset, programId)
          .accountsPartial({ signer })
          .rpc({ commitment: 'confirmed' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!/6306|ComputationDefinitionDeactivated/i.test(msg)) throw error;
      }
      acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefAccount);
    }
    if (acc.deactivationSlot == null) {
      throw new Error(`deactivate ${circuit} did not set a deactivation slot`);
    }
    const readyAt = BigInt(acc.deactivationSlot.toString()) + BigInt(COMP_DEF_TTL_SLOTS);
    for (;;) {
      const slot = BigInt(await this.provider.connection.getSlot('confirmed'));
      if (slot >= readyAt) break;
      const behind = readyAt - slot;
      console.log(`[comp-def] ${circuit} TTL wait, ${behind} slots left`);
      await sleep(Math.min(15_000, Math.max(1000, Number(behind) * 400)));
    }

    for (let i = 0; i < 8; i++) {
      const rawInfo = await this.provider.connection.getAccountInfo(
        getRawCircuitAccAddress(compDefAccount, i),
      );
      if (!rawInfo) break;
      await (arciumProgram.methods as any)
        .closeComputationDefinitionBuffers(offset, programId, i)
        .accountsPartial({ signer })
        .rpc({ commitment: 'confirmed' });
    }
    await (arciumProgram.methods as any)
      .closeComputationDefinition(offset, programId, this.clusterOffset)
      .accountsPartial({ signer })
      .rpc({ commitment: 'confirmed' });
    await this.initCompDef(name);
  }

  /**
   * Ensure CompDefs are finalized. Skips already-finalized circuits (no upload).
   * Checks status in parallel; uploads only what is missing/pending.
   */
  async ensureCompDefs(
    names: string[],
    options: { uploadConcurrency?: number } = {},
  ): Promise<{ finalized: string[]; uploaded: string[] }> {
    const uploadConcurrency = options.uploadConcurrency ?? 1;
    const states = await Promise.all(
      names.map(async (name) => ({ name, state: await this.getCompDefState(name) })),
    );
    const finalized = states.filter((s) => s.state === 'OnchainFinalized').map((s) => s.name);
    const stale = states.filter((s) => s.state === 'stale').map((s) => s.name);
    const orphans = states.filter((s) => s.state === 'mxe_orphan').map((s) => s.name);
    const needUpload = states
      .filter(
        (s) =>
          s.state !== 'OnchainFinalized'
          && s.state !== 'stale'
          && s.state !== 'mxe_orphan',
      )
      .map((s) => s.name);
    const uploaded: string[] = [];

    for (const name of finalized) {
      console.log(`[comp-def] ${circuitOffsetName(name)} already finalized — skip`);
    }
    if (orphans.length > 0) {
      const circuits = orphans.map((n) => circuitOffsetName(n));
      throw new Error(
        `CompDef finalized but missing from MXE.computationDefinitions (InvalidComputationDefinition):\n`
          + orphans.map((n) => `  - ${n}`).join('\n')
          + `\nPatch genesis + restart localnet:\n`
          + `  bun run scripts/write-comp-def-genesis.ts ${circuits.join(' ')}\n`
          + `  bun run localnet:stop && bun run localnet:start:detach\n`
          + `  bun run localnet:compdefs`,
      );
    }
    for (const name of stale) {
      console.log(
        `[comp-def] ${circuitOffsetName(name)} finalized but raw circuit hash stale — force-upload`,
      );
      const wrote = await this.forceUploadCircuit(name);
      if (wrote) {
        uploaded.push(name);
        console.log(`[comp-def] ${name} force-upload complete`);
      } else {
        console.log(`[comp-def] ${circuitOffsetName(name)} left active`);
      }
    }
    if (needUpload.length === 0) {
      return { finalized, uploaded };
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(uploadConcurrency, needUpload.length) }, async () => {
      while (cursor < needUpload.length) {
        const i = cursor++;
        const name = needUpload[i]!;
        console.log(`[comp-def] init+upload ${name}...`);
        await this.initCompDef(name);
        uploaded.push(name);
        console.log(`[comp-def] ${name} ready`);
      }
    });
    await Promise.all(workers);
    return { finalized, uploaded };
  }

  /**
   * Ensure computation definition is ready for queueing.
   *
   * Prefer an already-finalized on-chain CompDef (genesis for large EncData
   * circuits like verify_deck_hash_chunk). Otherwise init via the poker wrapper
   * (small circuits) and upload `.arcis` when still pending.
   *
   * Must be signed by the MXE authority (`MXE_AUTHORITY_KEYPAIR`, or `~/.config/solana/id.json`).
   */
  async initCompDef(name: string): Promise<void> {
    const circuit = circuitOffsetName(name);
    const programId = this.pokerProgram.programId;
    const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
    const arciumProgram = getArciumProgram(this.provider);
    const compDefAccount = getCompDefAccAddress(programId, offset);

    const existing = await this.provider.connection.getAccountInfo(compDefAccount);
    if (existing) {
      const acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefAccount);
      const state = getCircuitState(acc.circuitSource as any);
      if (state === 'OnchainFinalized') {
        console.log(`[comp-def] ${circuit} already finalized`);
        return;
      }
      if (state === 'OnchainPending') {
        const arcisPath = path.join(POKER_BUILD_DIR, `${circuit}.arcis`);
        if (!fs.existsSync(arcisPath)) {
          throw new Error(`Missing circuit artifact: ${arcisPath}`);
        }
        const raw = fs.readFileSync(arcisPath);
        await this.writeRawCircuit(offset, raw, false);
        await this.finalizeUploadedCircuit(offset);
        return;
      }
    }

    // Small circuits: poker init_comp_def + upload.
    const method = `init${name.charAt(0).toUpperCase() + name.slice(1)}CompDef`;
    const mxeAccount = getMXEAccAddress(programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const addressLookupTable = getLookupTableAddress(programId, mxeAcc.lutOffsetSlot);

    try {
      const heapIx = web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });
      const cuIx = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 });
      await (this.pokerProgram.methods as any)[method]()
        .accountsPartial({
          payer: this.provider.wallet.publicKey,
          mxeAccount,
          compDefAccount,
          addressLookupTable,
          lutProgram: web3.AddressLookupTableProgram.programId,
        })
        .preInstructions([heapIx, cuIx])
        .rpc({ commitment: 'confirmed' });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/already in use|already initialized|0x0/i.test(msg)) {
        throw e;
      }
    }

    const arcisPath = path.join(POKER_BUILD_DIR, `${circuit}.arcis`);
    if (!fs.existsSync(arcisPath)) {
      throw new Error(`Missing circuit artifact: ${arcisPath}`);
    }
    const raw = fs.readFileSync(arcisPath);
    await this.writeRawCircuit(offset, raw, false);
    await this.finalizeUploadedCircuit(offset);
  }

  async initRevealCardCompDef(): Promise<void> {
    await this.initCompDef('revealCard');
  }

  async revealCard(
    gameId: Uint8Array,
    cardIndex: number,
    offset: number | BN,
    opts: {
      encryptionPubkey: Uint8Array;
      baseNonce: bigint;
      /** Absolute commitment index in the 900-wide staging layout. */
      startIndex: number;
      fromOffset: number;
      destOffset: number;
      chunkCount: number;
      totalCount: number;
      recipientIndex: number;
      recipient: web3.Keypair;
      tableState: web3.PublicKey;
    },
  ): Promise<void> {
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const deckStaging = this.derivePDA(gameId, 'deck_staging');
    // The slot covers the queue transaction only. The callback wait stays in
    // the caller, so the next card is not stuck behind this card's callback.
    // Devnet allows a full keno draw in that slot. Localnet stays narrow
    // (HeapFull / 6602). See test/e2e/arcium-heap.ts.
    await this.payComputationFromFloat(offsetBn, () =>
      revealQueueGate.run(() =>
        withArciumMempoolRetry(
          () =>
            timed(
              `tx:queue_reveal:r${opts.recipientIndex}:card${cardIndex}:dest${opts.destOffset}`,
              () =>
                (this.pokerProgram.methods as any)
                  .revealCard(
                    offsetBn,
                    deckStaging,
                    Array.from(opts.encryptionPubkey),
                    new BN(opts.baseNonce.toString()),
                    cardIndex,
                    opts.startIndex,
                    opts.fromOffset,
                    opts.destOffset,
                    opts.chunkCount,
                    opts.totalCount,
                    opts.recipientIndex,
                  )
                  .accountsPartial({
                    payer: this.provider.wallet.publicKey,
                    recipient: opts.recipient.publicKey,
                    tableState: opts.tableState,
                    deckStaging,
                    revealedCard: this.deriveRevealedCardPDA(
                      gameId,
                      opts.recipientIndex,
                      cardIndex,
                    ),
                    gameState: this.derivePDA(gameId, 'game_state'),
                    ...this.arciumQueueAccounts(offsetBn, 'revealCard'),
                  })
                  .preInstructions([
                    web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
                    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
                  ])
                  .signers([opts.recipient])
                  .rpc(),
            ),
          { retries: 8, delayMs: 750 },
        ),
      ),
    );
    this.noteComputation(offsetBn);
  }

  /**
   * Queue Arcis `reveal_card` job(s) for card-major staging at `cardIndex * 36`.
   * Each 4-limb slice is its own Rescue batch at `base_nonce + card*36 + from_offset`.
   * Publishes `totalCount = (numPlayers-1)*4` limbs into RevealedCard.
   *
   * Each MPC job returns at most 4 limbs (callback CU budget). Larger cards
   * are split across multiple jobs with advancing from/dest offsets.
   *
   * Rejects client-side (and on-chain) if the card is not allowed for the
   * current betting phase / verify state.
   */
  async revealCardPartials(
    gameId: Uint8Array,
    cardIndex: number,
    baseOffset: number | BN,
    opts: {
      encryptionPubkey: Uint8Array;
      baseNonce: bigint;
      totalCount: number;
      recipientIndex: number;
      recipient: web3.Keypair;
      tableState: web3.PublicKey;
      /** First limb of this recipient's section in the 36-limb card row. */
      sourceStart?: number;
      /** Skip client-side policy check (on-chain still enforces). */
      skipClientPolicyCheck?: boolean;
    },
  ): Promise<void> {
    const REVEAL_CARD_LIMBS_PER_JOB = 4;
    const totalCount = opts.totalCount;
    if (totalCount <= 0 || totalCount > VERIFY_CHUNK_LEN) {
      throw new Error(`totalCount must be in 1..${VERIFY_CHUNK_LEN}, got ${totalCount}`);
    }

    if (!opts.skipClientPolicyCheck) {
      const gameState = await this.fetchGameState(gameId);
      const numPlayers = Number(gameState.numPlayers);
      const bettingPhase = Number(gameState.bettingPhase);
      const verified = gameState.verified === true;
      assertCardRevealAllowed(
        cardIndex,
        numPlayers,
        bettingPhase,
        verified,
        {
          recipientIndex: opts.recipientIndex,
          foldedMask: Number(gameState.foldedMask ?? 0),
          showOnFoldMask: Number(gameState.showOnFoldMask ?? gameState.show_on_fold_mask ?? 0),
        },
      );
      const expected = expectedRevealLimbCount(numPlayers);
      if (totalCount !== expected) {
        throw new CardRevealNotAllowedError(
          `CardRevealNotAllowed: totalCount ${totalCount} != expected ${expected} for ${numPlayers} players`,
        );
      }
    }

    const startIndex = cardIndex * VERIFY_CHUNK_LEN;
    const base =
      typeof baseOffset === 'number' ? new BN(baseOffset) : baseOffset;
    const jobs: { dest: number; chunkCount: number }[] = [];
    for (let dest = 0; dest < totalCount; dest += REVEAL_CARD_LIMBS_PER_JOB) {
      jobs.push({
        dest,
        chunkCount: Math.min(REVEAL_CARD_LIMBS_PER_JOB, totalCount - dest),
      });
    }
    // First job creates the RevealedCard PDA (init_if_needed); remaining
    // limb chunks queue in parallel against the same card account.
    const sourceStart = opts.sourceStart ?? opts.recipientIndex * totalCount;
    if (sourceStart + totalCount > VERIFY_CHUNK_LEN) {
      throw new CardRevealNotAllowedError(
        `CardRevealNotAllowed: recipient section exceeds ${VERIFY_CHUNK_LEN}-limb card row`,
      );
    }
    const queueJob = (dest: number, chunkCount: number) =>
      this.revealCard(gameId, cardIndex, base.add(new BN(dest)), {
        encryptionPubkey: opts.encryptionPubkey,
        baseNonce: opts.baseNonce,
        startIndex,
        fromOffset: sourceStart + dest,
        destOffset: dest,
        chunkCount,
        totalCount,
        recipientIndex: opts.recipientIndex,
        recipient: opts.recipient,
        tableState: opts.tableState,
      });
    const first = jobs[0]!;
    await queueJob(first.dest, first.chunkCount);
    if (jobs.length > 1) {
      // Serial limbs by default for N>2 (10p W≥2 flooded mempool). Gate in
      // revealCard still caps global in-flight even if REVEAL_LIMB_CONCURRENCY
      // is raised. numPlayers inferred from totalCount = (N-1)*4.
      const numPlayers = totalCount / 4 + 1;
      const concurrency = revealLimbConcurrency(numPlayers);
      for (let offset = 1; offset < jobs.length; offset += concurrency) {
        await Promise.all(
          jobs.slice(offset, offset + concurrency).map((job) =>
            queueJob(job.dest, job.chunkCount),
          ),
        );
      }
    }
  }

  async fetchRevealedCard(
    gameId: Uint8Array,
    recipientIndex: number,
    cardIndex: number,
    minFilled = 0,
  ): Promise<any> {
    const pda = this.deriveRevealedCardPDA(gameId, recipientIndex, cardIndex);
    // RevealCardEvent is delivered from processed logs. A confirmed fetch in
    // that same moment still sees the queue-tx account (count set, limbs 0).
    const deadline = performance.now() + 20_000;
    let card: any;
    for (;;) {
      try {
        card = await (this.pokerProgram.account as any).revealedCard.fetch(pda, 'confirmed');
      } catch {
        card = undefined;
      }
      if (card && Number(card.filled ?? 0) >= minFilled) break;
      if (performance.now() >= deadline) {
        throw new Error(
          `revealed card r${recipientIndex} c${cardIndex} filled ${card?.filled ?? 0}/${minFilled}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.reclaimFinalizedComputations();
    return card;
  }

  async initPlayerGameEscrow(gameId: Uint8Array, playerIndex: number): Promise<web3.PublicKey> {
    const playerGameEscrow = this.derivePlayerGameEscrowPDA(gameId, playerIndex);
    await (this.pokerProgram.methods as any)
      .initPlayerGameEscrow(playerIndex)
      .accounts({
        payer: this.provider.wallet.publicKey,
        gameState: this.derivePDA(gameId, 'game_state'),
        playerGameEscrow,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    return playerGameEscrow;
  }

  /** Open every seat escrow. One float draw covers all of them, then the creates run in order. */
  async initPlayerGameEscrows(gameId: Uint8Array, numPlayers: number): Promise<void> {
    await drawStagedRent(
      this.provider,
      this.provider.wallet.publicKey,
      this.provider.wallet.publicKey,
      numPlayers * rentExemptLamports(
        PLAYER_GAME_ESCROW_DATA,
        await clusterRentLamportsPerByte(this.provider.connection),
      ),
    );
    for (let p = 0; p < numPlayers; p++) {
      await this.initPlayerGameEscrow(gameId, p);
    }
  }

  /** Devnet `initialize_game` stores the whitelist admin as `staging_authority`. */
  private async stagingAuthority(): Promise<{ pubkey: web3.PublicKey; signers: web3.Keypair[] }> {
    if (isLocalCluster(this.provider.connection.rpcEndpoint)) {
      return { pubkey: this.provider.wallet.publicKey, signers: [] };
    }
    const admin = await loadWhitelistAdminProvider(this.provider.connection);
    const payer = (admin.wallet as KeypairWallet).payer;
    return { pubkey: payer.publicKey, signers: [payer] };
  }

  /**
   * Latch the expected Poseidon(4) sum and reset the accumulator before parallel chunks.
   */
  async beginVerifyDeckHash(
    gameId: Uint8Array,
    expectedHashLow: bigint,
    expectedHashHigh: bigint,
  ): Promise<void> {
    const toU128 = (v: bigint) => new BN(v.toString());
    const authority = await this.stagingAuthority();
    await (this.pokerProgram.methods as any)
      .beginVerifyDeckHash(toU128(expectedHashLow), toU128(expectedHashHigh))
      .accountsPartial({
        payer: authority.pubkey,
        gameState: this.derivePDA(gameId, 'game_state'),
        verifyAccumulator: this.deriveVerifyAccumulatorPDA(gameId),
        systemProgram: web3.SystemProgram.programId,
      })
      .signers(authority.signers)
      .rpc();
  }

  async syncVerifyDeckHash(gameId: Uint8Array): Promise<void> {
    const authority = await this.stagingAuthority();
    await (this.pokerProgram.methods as any)
      .syncVerifyDeckHash()
      .accountsPartial({
        authority: authority.pubkey,
        gameState: this.derivePDA(gameId, 'game_state'),
        verifyAccumulator: this.deriveVerifyAccumulatorPDA(gameId),
      })
      .signers(authority.signers)
      .rpc();
  }

  async initPlayerMpcKey(
    gameId: Uint8Array,
    playerIndex: number,
    purpose: number,
    generation: bigint | number,
    encryptionPubkey: Uint8Array,
    nonceBase: bigint,
    authority?: web3.Keypair,
    tableState?: web3.PublicKey,
  ): Promise<void> {
    const payer = authority?.publicKey ?? this.provider.wallet.publicKey;
    const playerState = this.derivePDA(gameId, 'player', Buffer.from([playerIndex]));
    const playerMpcKey = this.derivePlayerMpcKeyPDA(
      gameId,
      playerIndex,
      purpose,
      generation,
    );
    if (await this.provider.connection.getAccountInfo(playerMpcKey, 'confirmed')) {
      return;
    }
    // Poker PlayerState is required by init_player_mpc_key. Bridge register
    // usually creates it; fall back to testing init when missing.
    if (!(await this.provider.connection.getAccountInfo(playerState, 'confirmed'))) {
      await (this.pokerProgram.methods as any)
        .initPlayerState(playerIndex)
        .accounts({
          payer: this.provider.wallet.publicKey,
          gameState: this.derivePDA(gameId, 'game_state'),
          playerState,
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc();
    }
    const builder = (this.pokerProgram.methods as any)
      .initPlayerMpcKey(
        playerIndex,
        purpose,
        new BN(generation.toString()),
        Array.from(encryptionPubkey),
        new BN(nonceBase.toString()),
      )
      .accountsPartial({
        payer,
        authority: payer,
        gameState: this.derivePDA(gameId, 'game_state'),
        playerState,
        tableState: tableState ?? null,
        playerMpcKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(casinoVaultRemaining(payer, this.pokerProgram.programId));
    if (authority && !authority.publicKey.equals(this.provider.wallet.publicKey)) {
      // Seat authority pays + signs alone (same pattern as register_player_receipt).
      const latest = await this.provider.connection.getLatestBlockhash('confirmed');
      const transaction = await builder.transaction();
      transaction.feePayer = authority.publicKey;
      transaction.recentBlockhash = latest.blockhash;
      transaction.sign(authority);
      const signature = await this.provider.connection.sendRawTransaction(
        transaction.serialize(),
        { preflightCommitment: 'confirmed' },
      );
      await this.provider.connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed',
      );
      return;
    }
    await builder.rpc();
  }

  async beginVerifyShareHash(
    gameId: Uint8Array,
    playerIndex: number,
    expectedHashLow: bigint,
    expectedHashHigh: bigint,
    tableState?: web3.PublicKey,
    authority?: web3.Keypair,
    opts?: {
      encryptionPubkey: Uint8Array;
      nonceBase: bigint;
      mpcKeyGeneration?: bigint | number;
    },
  ): Promise<void> {
    if (!tableState) {
      throw new Error('tableState required for authorized share verification');
    }
    const payer = authority?.publicKey ?? this.provider.wallet.publicKey;
    const toU128 = (v: bigint) => new BN(v.toString());
    const mpcKeyGeneration = opts?.mpcKeyGeneration ?? 0;
    if (opts?.encryptionPubkey) {
      await this.initPlayerMpcKey(
        gameId,
        playerIndex,
        1, // share purpose
        mpcKeyGeneration,
        opts.encryptionPubkey,
        opts.nonceBase,
        authority,
        tableState,
      );
    }
    const playerMpcKey = this.derivePlayerMpcKeyPDA(
      gameId,
      playerIndex,
      1,
      mpcKeyGeneration,
    );
    await timed(`tx:arcis_begin_share_verify:p${playerIndex}`, () =>
      (this.pokerProgram.methods as any)
        .beginVerifyShareHash(playerIndex, toU128(expectedHashLow), toU128(expectedHashHigh))
        .accountsPartial({
          payer,
          gameState: this.derivePDA(gameId, 'game_state'),
          tableState,
          playerMpcKey,
          shareVerifyAcc: this.deriveShareVerifyAccPDA(gameId, playerIndex),
          systemProgram: web3.SystemProgram.programId,
        })
        .remainingAccounts(casinoVaultRemaining(payer, this.pokerProgram.programId))
        .signers(authority ? [authority] : [])
        .rpc(),
    );
  }

  async verifyShareHashChunk(
    gameId: Uint8Array,
    playerIndex: number,
    offset: number | BN,
    opts: {
      encryptionPubkey: Uint8Array;
      baseNonce: bigint;
      startIndex: number;
      limbCount: number;
    },
  ): Promise<void> {
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const shareDeckStaging = this.deriveShareDeckStagingPDA(gameId, playerIndex);
    const toU128 = (v: bigint) => new BN(v.toString());
    const method = 'verifyShareHashChunk';
    const circuit = 'verifyDeckHashChunk';
    // priority:low — next-hand share verify yields to live reveal/showdown.
    await arciumQueueGate.run('low', () =>
      this.payComputationFromFloat(offsetBn, () =>
      withArciumMempoolRetry(
        () =>
          timed(`tx:queue_share_verify:p${playerIndex}:start${opts.startIndex}`, () =>
            (this.pokerProgram.methods as any)
              [method](
                offsetBn,
                shareDeckStaging,
                Array.from(opts.encryptionPubkey),
                toU128(opts.baseNonce),
                opts.startIndex,
                opts.limbCount,
              )
              .accountsPartial({
                payer: this.provider.wallet.publicKey,
                gameState: this.derivePDA(gameId, 'game_state'),
                shareVerifyAcc: this.deriveShareVerifyAccPDA(gameId, playerIndex),
                shareDeckStaging,
                systemProgram: web3.SystemProgram.programId,
                ...this.arciumQueueAccounts(offsetBn, circuit),
              })
              .rpc(),
          ),
        { retries: 8, delayMs: 750 },
      ),
      ),
    );
    this.noteComputation(offsetBn);
  }

  async syncVerifyShareHash(gameId: Uint8Array, playerIndex: number): Promise<void> {
    await timed(`tx:arcis_sync_share_verify:p${playerIndex}`, () =>
      (this.pokerProgram.methods as any)
        .syncVerifyShareHash()
        .accountsPartial({
          gameState: this.derivePDA(gameId, 'game_state'),
          shareVerifyAcc: this.deriveShareVerifyAccPDA(gameId, playerIndex),
        })
        .rpc(),
    );
  }

  async reopenShareForNextChunk(gameId: Uint8Array): Promise<void> {
    await timed('tx:arcis_reopen_share_for_next_chunk', () =>
      (this.pokerProgram.methods as any)
        .reopenShareForNextChunk()
        .accountsPartial({
          gameState: this.derivePDA(gameId, 'game_state'),
        })
        .rpc(),
    );
  }

  async finalizeSharePhase(gameId: Uint8Array, numPlayers: number): Promise<void> {
    const remainingAccounts: { pubkey: web3.PublicKey; isSigner: false; isWritable: false }[] = [];
    for (let p = 0; p < numPlayers; p++) {
      const generation = (await this.fetchShareVerifyAccumulator(gameId, p)).generation;
      remainingAccounts.push({
        pubkey: this.deriveShareVerifyAccPDA(gameId, p),
        isSigner: false,
        isWritable: false,
      });
      remainingAccounts.push({
        pubkey: web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('proof_receipt_v2'),
            Buffer.from(gameId),
            Buffer.from(new BN(generation.toString()).toArray('le', 8)),
            Buffer.from([2]),
            Buffer.from([p]),
          ],
          // light-casino program id — receipt accounts live there
          new web3.PublicKey('CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc'),
        )[0],
        isSigner: false,
        isWritable: false,
      });
    }
    await timed('tx:finalize_share_phase', () =>
      (this.pokerProgram.methods as any)
        .finalizeSharePhase()
        .accountsPartial({
          gameState: this.derivePDA(gameId, 'game_state'),
        })
        .remainingAccounts(remainingAccounts)
        .rpc(),
    );
  }

  async fetchShareVerifyAccumulator(gameId: Uint8Array, playerIndex: number): Promise<any> {
    const acc = await (this.pokerProgram.account as any).shareVerifyAccumulator.fetch(
      this.deriveShareVerifyAccPDA(gameId, playerIndex),
      'confirmed',
    );
    await this.reclaimFinalizedComputations();
    return acc;
  }

  async fetchVerifyAccumulator(gameId: Uint8Array): Promise<any> {
    const acc = await (this.pokerProgram.account as any).verifyDeckHashAccumulator.fetch(
      this.deriveVerifyAccumulatorPDA(gameId),
      'confirmed',
    );
    await this.reclaimFinalizedComputations();
    return acc;
  }

  /**
   * Queue one Arcis verify_deck_hash_chunk (VERIFY_FOLD_LEN=4 commitments).
   * `startIndex` must be a multiple of 4 and lie in the card row's active prefix.
   */
  async verifyDeckHashChunk(
    gameId: Uint8Array,
    offset: number | BN,
    opts: {
      encryptionPubkey: Uint8Array;
      baseNonce: bigint;
      startIndex: number;
      expectedHashLow: bigint;
      expectedHashHigh: bigint;
      deckAccount?: web3.PublicKey;
    },
  ): Promise<void> {
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const deckStaging = opts.deckAccount ?? this.derivePDA(gameId, 'deck_staging');
    const toU128 = (v: bigint) => new BN(v.toString());
    await this.payComputationFromFloat(offsetBn, () =>
      (this.pokerProgram.methods as any)
      .verifyDeckHashChunk(
        offsetBn,
        deckStaging,
        Array.from(opts.encryptionPubkey),
        toU128(opts.baseNonce),
        opts.startIndex,
        toU128(opts.expectedHashLow),
        toU128(opts.expectedHashHigh),
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        gameState: this.derivePDA(gameId, 'game_state'),
        verifyAccumulator: this.deriveVerifyAccumulatorPDA(gameId),
        deckStaging,
        systemProgram: web3.SystemProgram.programId,
        ...this.arciumQueueAccounts(offsetBn, 'verifyDeckHashChunk'),
      })
      .rpc(),
    );
    this.noteComputation(offsetBn);
  }

  /** @deprecated Use beginVerifyDeckHash + parallel verifyDeckHashChunk */
  async verifyDeckHash900(
    gameId: Uint8Array,
    offset: number | BN,
    opts: {
      encryptionPubkey: Uint8Array;
      baseNonce: bigint;
      expectedHashLow: bigint;
      expectedHashHigh: bigint;
      deckAccount?: web3.PublicKey;
    },
  ): Promise<void> {
    await this.beginVerifyDeckHash(gameId, opts.expectedHashLow, opts.expectedHashHigh);
    await this.verifyDeckHashChunk(gameId, offset, { ...opts, startIndex: 0 });
  }

  async fetchGameState(gameId: Uint8Array): Promise<any> {
    return (this.pokerProgram.account as any).gameState.fetch(this.derivePDA(gameId, 'game_state'));
  }

  async fetchSealedShowdownCoefficients(owner: web3.PublicKey): Promise<SealedShowdownAccount> {
    const pda = this.deriveSealedShowdownCoeffsPDA(owner);
    const info = await this.provider.connection.getAccountInfo(pda);
    if (!info) throw new Error(`Account does not exist ${pda.toBase58()}`);
    const sealed = decodeSealAccount(Uint8Array.from(info.data));
    await this.reclaimFinalizedComputations();
    return sealed;
  }

  async submitBet(
    gameId: Uint8Array,
    playerIndex: number,
    action: number,
    encryptedFields: {
      encryptedAction: Uint8Array;
      encryptedAmount: Uint8Array;
      encryptedPlayerBalance: Uint8Array;
      encryptedPlayerCurrentBet: Uint8Array;
      encryptedCurrentBet: Uint8Array;
      encryptedLastAggressorAmount: Uint8Array;
      encryptionPubkey: Uint8Array;
      nonce: bigint;
    },
    offset: number | BN,
  ): Promise<void> {
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const toArr = (b: Uint8Array) => Array.from(b) as number[];
    await this.payComputationFromFloat(offsetBn, () =>
      timed(`tx:queue_bet:p${playerIndex}`, () =>
      (this.pokerProgram.methods as any)
        .submitBet(
          action,
          toArr(encryptedFields.encryptedAction),
          toArr(encryptedFields.encryptedAmount),
          toArr(encryptedFields.encryptedPlayerBalance),
          toArr(encryptedFields.encryptedPlayerCurrentBet),
          toArr(encryptedFields.encryptedCurrentBet),
          toArr(encryptedFields.encryptedLastAggressorAmount),
          toArr(encryptedFields.encryptionPubkey),
          new BN(encryptedFields.nonce.toString()),
          offsetBn,
          false,
        )
        .accountsPartial({
          payer: this.provider.wallet.publicKey,
          player: this.provider.wallet.publicKey,
          gameState: this.derivePDA(gameId, 'game_state'),
          playerState: this.derivePDA(gameId, 'player', Buffer.from([playerIndex])),
          ...this.arciumQueueAccounts(offsetBn, 'validateBet'),
        })
        .rpc(),
      ),
    );
    this.noteComputation(offsetBn);
  }

  deriveSealedShowdownCoeffsPDA(owner: web3.PublicKey): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('sealed_showdown_coeffs'), owner.toBuffer()],
      this.pokerProgram.programId,
    )[0];
  }

  /**
   * Queue the two-coefficient seal. The callback writes both ciphertexts and
   * the revealed rows. A written seal that settlement has not consumed is left
   * in place when `playerEncryptionPubkey` is the key that created it.
   */
  async sealShowdownCoefficients(
    gameId: Uint8Array,
    offset: number | BN,
    playerEncryptionPubkey: Uint8Array,
    nonce: bigint,
    playerIndex: number,
    tableState: web3.PublicKey | undefined,
    authority: web3.Keypair | undefined,
    coeffCount: number,
  ): Promise<void> {
    if (!tableState || !authority) {
      throw new Error('tableState required for authorized showdown coefficient sealing');
    }
    if (coeffCount !== 2) {
      throw new Error(`seal coefficient count ${coeffCount} is out of range`);
    }
    const owner = authority.publicKey;
    try {
      const existing = await this.fetchSealedShowdownCoefficients(owner);
      const sameKey = existing.encryptionPubkey.every((b, i) => b === playerEncryptionPubkey[i]);
      if (existing.written && existing.data[SEAL_CONSUMED_OFFSET] === 0 && sameKey) {
        console.log(`[showdown] reuse unconsumed seal p${playerIndex}`);
        return;
      }
    } catch {
      // The seal instruction creates the account.
    }
    const pubkey = Array.from(playerEncryptionPubkey);
    const nonceBn = new BN(nonce.toString());
    const first = typeof offset === 'number' ? new BN(offset) : offset;
    const queue = (step: BN) => this.queueSeal(
      `tx:queue_showdown_seal:p${playerIndex}`,
      'sealShowdownPair',
      [step, pubkey, nonceBn, playerIndex],
      gameId,
      playerIndex,
      tableState,
      authority,
      step,
      false,
    );
    await queue(first);
    const started = performance.now();
    let sentAt = started;
    let last: SealedShowdownAccount | undefined;
    // One lost callback has to outlive the 300-slot pending TTL before it can be requeued.
    while (performance.now() - started < 420_000) {
      try {
        last = await this.fetchSealedShowdownCoefficients(owner);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (last.written) {
        await this.reclaimFinalizedComputations();
        return;
      }
      if (
        performance.now() - sentAt > 20_000
        && await this.sealPendingAllowsRetry(last.data)
      ) {
        console.warn(`[showdown] seal p${playerIndex} missed its callback; retrying`);
        sentAt = performance.now();
        try {
          await queue(new BN(randomBytes(8)));
        } catch (err) {
          console.error(`[showdown] seal p${playerIndex} failed`, sealErrorText(err));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`showdown seal timed out for player ${playerIndex}`);
  }

  /** A fold can be requeued once its pending callback has expired or was never opened. */
  private async sealPendingAllowsRetry(data: Uint8Array): Promise<boolean> {
    if ((data[SEAL_PENDING_STATUS_OFFSET] ?? 0) !== SEAL_PENDING_STATUS) return true;
    const slot = BigInt(await this.provider.connection.getSlot('confirmed'));
    return slot > sealPendingExpiresSlot(data);
  }

  private async queueSeal(
    label: string,
    method: string,
    args: unknown[],
    gameId: Uint8Array,
    playerIndex: number,
    tableState: web3.PublicKey,
    authority: web3.Keypair | undefined,
    offsetBn: BN,
    awaitCallback = true,
  ): Promise<void> {
    const payer = authority?.publicKey ?? this.provider.wallet.publicKey;
    await arciumQueueGate.run('high', () =>
      this.payComputationFromFloat(offsetBn, () =>
      withArciumMempoolRetry(
        () =>
          timed(label, () =>
            (this.pokerProgram.methods as any)
              [method](...args)
              .accountsPartial({
                payer,
                gameState: this.derivePDA(gameId, 'game_state'),
                tableState,
                playerState: this.derivePDA(gameId, 'player', Buffer.from([playerIndex])),
                sealedShowdownCoefficients: this.deriveSealedShowdownCoeffsPDA(payer),
                ...this.arciumQueueAccounts(offsetBn, method),
              })
              .preInstructions([
                web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
                web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
              ])
              .signers(authority ? [authority] : [])
              .rpc(),
          ),
        { retries: 8, delayMs: 750 },
      ),
      authority,
      ),
    );
    this.noteComputation(offsetBn, authority, true);
    if (awaitCallback) await this.reclaimComputationWhenFinalized(offsetBn);
  }

  async distributeAndSettle(
    gameId: Uint8Array,
    offset: number | BN,
    encryptedWinnerMasks: Uint8Array[],
    encryptionPubkey: Uint8Array,
    nonce: bigint,
    playerIndex: number,
    submitter: web3.PublicKey,
  ): Promise<void> {
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const toU128 = (v: bigint) => new BN(v.toString());
    if (encryptedWinnerMasks.length !== 9) {
      throw new Error('Expected 9 encrypted winner masks');
    }
    const masks = encryptedWinnerMasks.map((m) => {
      if (m.length !== 32) throw new Error('Each winner mask ciphertext must be 32 bytes');
      return Array.from(m);
    });
    await this.payComputationFromFloat(offsetBn, () =>
      (this.pokerProgram.methods as any)
      .distributeAndSettle(
        offsetBn,
        masks,
        Array.from(encryptionPubkey),
        toU128(nonce),
        playerIndex,
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        gameState: this.derivePDA(gameId, 'game_state'),
        sealedShowdownCoefficients: this.deriveSealedShowdownCoeffsPDA(submitter),
        playerGameEscrow: this.derivePlayerGameEscrowPDA(gameId, playerIndex),
        ...this.arciumQueueAccounts(offsetBn, 'distributeAndSettle'),
      })
      .preInstructions([
        web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc(),
    );
    this.noteComputation(offsetBn);
  }

  /** Send a large Anchor method via MXE Address Lookup Table (v0 tx). */
  private async rpcWithMxeLut(builder: {
    transaction: () => Promise<web3.Transaction>;
    signers?: web3.Signer[];
  }): Promise<string> {
    const programId = this.pokerProgram.programId;
    const arciumProgram = getArciumProgram(this.provider);
    const mxeAccount = getMXEAccAddress(programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(programId, mxeAcc.lutOffsetSlot);
    const lut = (await this.provider.connection.getAddressLookupTable(lutAddress)).value;
    if (!lut) throw new Error(`MXE address lookup table missing: ${lutAddress.toBase58()}`);

    const legacy = await builder.transaction();
    const { blockhash, lastValidBlockHeight } =
      await this.provider.connection.getLatestBlockhash('confirmed');
    const message = new web3.TransactionMessage({
      payerKey: this.provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: legacy.instructions,
    }).compileToV0Message([lut]);
    const vtx = new web3.VersionedTransaction(message);
    const signed = await this.provider.wallet.signTransaction(vtx);
    const sig = await this.provider.connection.sendTransaction(signed, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });
    await this.provider.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    return sig;
  }

  async computePots(
    gameId: Uint8Array,
    offset: number | BN,
    encryptedWinnerMasks: Uint8Array[],
    encryptionPubkey: Uint8Array,
    nonce: bigint,
    tableState: web3.PublicKey,
    submitter: web3.PublicKey,
  ): Promise<void> {
    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const toU128 = (v: bigint) => new BN(v.toString());
    if (encryptedWinnerMasks.length !== 9) {
      throw new Error('Expected 9 encrypted winner masks');
    }
    const masks = encryptedWinnerMasks.map((m) => Array.from(m));
    const builder = (this.pokerProgram.methods as any)
      .computePots(
        offsetBn,
        masks,
        Array.from(encryptionPubkey),
        toU128(nonce),
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        gameState: this.derivePDA(gameId, 'game_state'),
        sealedShowdownCoefficients: this.deriveSealedShowdownCoeffsPDA(submitter),
        tableState,
        ...this.arciumQueueAccounts(offsetBn, 'computePots'),
      })
      .preInstructions([
        web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ]);
    await arciumQueueGate.run('high', () =>
      this.payComputationFromFloat(offsetBn, () =>
      withArciumMempoolRetry(
        () => timed('tx:queue_compute_pots', async () => {
          await this.rpcWithMxeLut(builder);
        }),
        { retries: 8, delayMs: 750 },
      ),
      ),
    );
    this.noteComputation(offsetBn);
  }
}
