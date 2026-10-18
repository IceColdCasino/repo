import { Program, type AnchorProvider, web3 } from '@coral-xyz/anchor';
import { mapPool, withRetry } from '../arcium/verify-chunk-parallel';
import { fieldToBytesBE } from '../groth16-convert';
import { prependVault } from './rent-vault';
import {
  LIGHT_INDEXER_URL,
  LIGHT_PROVER_URL,
  isLightIndexerUp,
  isLightSystemProgramOnChain,
  lightStackStatus,
  lightIndexerUrl,
  lightProverUrl,
} from './light-config';

export {
  LIGHT_RPC_URL,
  LIGHT_PROVER_URL,
  LIGHT_INDEXER_URL,
  lightStackStatus,
  isLightIndexerUp,
  isLightSystemProgramOnChain,
  lightRpcUrl,
  lightIndexerUrl,
  lightProverUrl,
} from './light-config';

const USED_PERM_SEED = Buffer.from('used_perm');
const BET_COMMIT_SEED = Buffer.from('bet_commit');

export type UsedPermutationProof = {
  validityProof: any;
  addressTreeInfo: any;
  outputMerkleTreeIndex: number;
  remainingAccounts: { pubkey: web3.PublicKey; isSigner: boolean; isWritable: boolean }[];
  /** When true, Light CPI should run; when false, Arcium-only E2E skip path. */
  lightAvailable: boolean;
};

/**
 * Probe Light indexer (+ optional on-chain system program).
 * Arcium-only E2E localnet does not run Light — returns false.
 *
 * Env:
 * - `LIGHT_E2E=0` — force skip
 * - `LIGHT_E2E=1` — require indexer (and prefer on-chain system program)
 */
export async function isLightAvailable(
  indexerUrl: string = lightIndexerUrl(),
  timeoutMs = 1_500,
): Promise<boolean> {
  if (process.env.LIGHT_E2E === '0') return false;
  const indexerUp = await isLightIndexerUp(indexerUrl, timeoutMs);
  if (!indexerUp) return false;
  // Sidecars alone are not enough for CPI — system program must be genesis-loaded.
  // When LIGHT_E2E=1 we still report available if indexer is up so callers can
  // surface a clearer on-chain failure; auto-detect requires both.
  if (process.env.LIGHT_E2E === '1') return true;
  return isLightSystemProgramOnChain();
}

/**
 * Light Protocol helpers for compressed-account CPI (revealed partials + used permutations).
 */
export class LightProtocolStorageHelper {
  constructor(
    private lightPokerProgram: Program,
    private provider: AnchorProvider,
  ) {}

  /**
   * Derive the global Light address seed material for a permutation hash.
   * On-chain: `derive_address([b"used_perm", permutation_hash], ...)`.
   */
  /**
   * Light address seeds for a split-game bet commitment.
   * On-chain: `derive_address([b"bet_commit", game_id, player_index], ...)`.
   */
  static betCommitSeedParts(gameId: Uint8Array, playerIndex: number): Buffer[] {
    if (gameId.length !== 32) {
      throw new Error(`gameId must be 32 bytes, got ${gameId.length}`);
    }
    if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex > 255) {
      throw new Error(`playerIndex must be a byte, got ${playerIndex}`);
    }
    return [BET_COMMIT_SEED, Buffer.from(gameId), Buffer.from([playerIndex])];
  }

  static usedPermSeedParts(permutationHash: Uint8Array | number[]): Buffer[] {
    const hash =
      permutationHash instanceof Uint8Array
        ? Buffer.from(permutationHash)
        : Buffer.from(permutationHash);
    if (hash.length !== 32) {
      throw new Error(`permutationHash must be 32 bytes, got ${hash.length}`);
    }
    return [USED_PERM_SEED, hash];
  }

  private static hashToBytes(permutationHash: Uint8Array | bigint | number[]): Uint8Array {
    if (typeof permutationHash === 'bigint') {
      return Uint8Array.from(fieldToBytesBE(permutationHash));
    }
    if (Array.isArray(permutationHash)) {
      return Uint8Array.from(permutationHash);
    }
    return permutationHash;
  }

  /**
   * Build Light validity-proof args for registering a new used permutation.
   *
   * - When Light indexer/prover are up (`LIGHT_E2E=1` or auto-detect): real
   *   `getValidityProofV0` + packed tree remaining accounts.
   * - Otherwise: placeholder args with `lightAvailable: false` so
   *   `verify_shuffle_staged` (testing feature) skips the Light CPI.
   */
  async proveNewUsedPermutation(
    permutationHash: Uint8Array | bigint | number[],
  ): Promise<UsedPermutationProof> {
    const hashBytes = LightProtocolStorageHelper.hashToBytes(permutationHash);
    LightProtocolStorageHelper.usedPermSeedParts(hashBytes);

    const lightUp =
      process.env.LIGHT_E2E === '1' || (await isLightAvailable());

    if (!lightUp) {
      const { placeholderValidityProof } = await import('@lightprotocol/stateless.js');
      return {
        validityProof: placeholderValidityProof(),
        // Zeroed PackedAddressTreeInfo — unused when Light CPI is skipped.
        addressTreeInfo: {
          rootIndex: 0,
          addressMerkleTreePubkeyIndex: 0,
          addressQueuePubkeyIndex: 0,
        },
        outputMerkleTreeIndex: 0,
        remainingAccounts: [],
        lightAvailable: false,
      };
    }

    return this.proveNewAddressLive(
      LightProtocolStorageHelper.usedPermSeedParts(hashBytes),
    );
  }

  /**
   * Address proof for `bet_commit || game_id || player_index`.
   * When Light is down, returns a placeholder so a testing build can still
   * close the staging PDA and refund its rent.
   */
  async proveBetCommitment(
    gameId: Uint8Array,
    playerIndex: number,
  ): Promise<UsedPermutationProof> {
    const seeds = LightProtocolStorageHelper.betCommitSeedParts(gameId, playerIndex);
    const lightUp =
      process.env.LIGHT_E2E === '1' || (await isLightAvailable());
    if (!lightUp) {
      const { placeholderValidityProof } = await import('@lightprotocol/stateless.js');
      return {
        validityProof: placeholderValidityProof(),
        addressTreeInfo: {
          rootIndex: 0,
          addressMerkleTreePubkeyIndex: 0,
          addressQueuePubkeyIndex: 0,
        },
        outputMerkleTreeIndex: 0,
        remainingAccounts: [],
        lightAvailable: false,
      };
    }
    return this.proveNewAddressLive(seeds);
  }

  /**
   * Write the bet hash into a Light compressed account and close `bet_inputs`,
   * returning that account's rent to the seat.
   */
  async closeBetPublicInputs(
    gameId: Uint8Array,
    playerIndex: number,
    accounts: {
      gameState: web3.PublicKey;
      playerState: web3.PublicKey;
      betPublicInputs: web3.PublicKey;
      rouletteBetCommitment: web3.PublicKey;
    },
    authority?: web3.Keypair,
  ): Promise<void> {
    const addressProof = await this.proveBetCommitment(gameId, playerIndex);
    const signer = authority?.publicKey ?? this.provider.wallet.publicKey;
    const builder = (this.lightPokerProgram.methods as any)
      .closeBetPublicInputs(
        addressProof.validityProof,
        addressProof.addressTreeInfo,
        addressProof.outputMerkleTreeIndex,
      )
      .accounts({
        signer,
        gameState: accounts.gameState,
        playerState: accounts.playerState,
        betPublicInputs: accounts.betPublicInputs,
        rouletteBetCommitment: accounts.rouletteBetCommitment,
      })
      .remainingAccounts(prependVault(signer, addressProof.remainingAccounts))
      .preInstructions([
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ]);
    if (authority && !authority.publicKey.equals(this.provider.wallet.publicKey)) {
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

  /** Real Light path — requires indexer + prover + genesis-loaded Light programs. */
  private async proveNewAddressLive(seedParts: Buffer[]): Promise<UsedPermutationProof> {
    // On-chain light-casino uses address::v1::derive_address (program-id hashed).
    // Force V1 client helpers so seeds match the program.
    if (!process.env.LIGHT_PROTOCOL_VERSION) {
      process.env.LIGHT_PROTOCOL_VERSION = 'V1';
    }

    const {
      bn,
      createRpc,
      defaultTestStateTreeAccounts,
      deriveAddress,
      deriveAddressSeed,
      deriveAddressSeedLegacy,
      deriveAddressLegacy,
      getLightSystemAccountMetasLegacy,
      placeholderValidityProof,
    } = await import('@lightprotocol/stateless.js');

    void placeholderValidityProof; // available if live path falls back

    // PackedAccounts helpers live in the TS Light examples; fall back carefully.
    let PackedAccounts: any;
    let SystemAccountMetaConfig: any;
    try {
      const mod = await import('@lightprotocol/stateless.js');
      PackedAccounts = (mod as any).PackedAccounts;
      SystemAccountMetaConfig = (mod as any).SystemAccountMetaConfig;
    } catch {
      /* optional */
    }

    // createRpc(endpoint, compressionApi/indexer, proverUrl)
    const rpc = createRpc(
      this.provider.connection.rpcEndpoint,
      lightIndexerUrl(),
      lightProverUrl(),
      { commitment: 'confirmed' },
    );

    const { merkleTree, addressTree, addressQueue } = defaultTestStateTreeAccounts();
    // Prefer explicit legacy (V1) helpers when present; else rely on LIGHT_PROTOCOL_VERSION=V1.
    const seed =
      typeof deriveAddressSeedLegacy === 'function'
        ? deriveAddressSeedLegacy(seedParts, this.lightPokerProgram.programId)
        : deriveAddressSeed(seedParts, this.lightPokerProgram.programId);
    const address =
      typeof deriveAddressLegacy === 'function'
        ? deriveAddressLegacy(seed, addressTree)
        : deriveAddress(seed, addressTree);

    if (!PackedAccounts || !SystemAccountMetaConfig) {
      // SDK without PackedAccounts — still return a real proof if possible.
      const proofRpcResult = await rpc.getValidityProofV0(
        [],
        [{ tree: addressTree, queue: addressQueue, address: bn(address.toBytes()) }],
      );
      return {
        validityProof: { 0: proofRpcResult.compressedProof },
        addressTreeInfo: {
          rootIndex: proofRpcResult.rootIndices[0],
          addressMerkleTreePubkeyIndex: 0,
          addressQueuePubkeyIndex: 1,
        },
        outputMerkleTreeIndex: 2,
        remainingAccounts: [
          { pubkey: addressTree, isSigner: false, isWritable: true },
          { pubkey: addressQueue, isSigner: false, isWritable: true },
          { pubkey: merkleTree, isSigner: false, isWritable: true },
        ],
        lightAvailable: true,
      };
    }

    const proofRpcResult = await rpc.getValidityProofV0(
      [],
      [{ tree: addressTree, queue: addressQueue, address: bn(address.toBytes()) }],
    );
    const systemAccountConfig = SystemAccountMetaConfig.new(this.lightPokerProgram.programId);
    // light-casino uses light-sdk 0.13's V1 CpiAccounts layout. stateless.js 0.23
    // is built with V2 as its default, so newWithSystemAccounts() omits the V1
    // noop + invoking-program metas and shifts every packed tree index.
    const accountMetas = getLightSystemAccountMetasLegacy(systemAccountConfig);
    const treeAccounts: web3.PublicKey[] = [];
    const insertOrGet = (pubkey: web3.PublicKey): number => {
      const existing = treeAccounts.findIndex((tree) => tree.equals(pubkey));
      if (existing >= 0) return existing;
      treeAccounts.push(pubkey);
      accountMetas.push({ pubkey, isSigner: false, isWritable: true });
      // Packed tree indices are relative to the tree-account tail, not the
      // complete remaining-accounts array.
      return treeAccounts.length - 1;
    };
    const addressMerkleTreePubkeyIndex = insertOrGet(addressTree);
    const addressQueuePubkeyIndex = insertOrGet(addressQueue);
    const packedAddressMerkleContext = {
      rootIndex: proofRpcResult.rootIndices[0],
      addressMerkleTreePubkeyIndex,
      addressQueuePubkeyIndex,
    };
    const outputMerkleTreeIndex = insertOrGet(merkleTree);

    return {
      validityProof: { 0: proofRpcResult.compressedProof },
      addressTreeInfo: packedAddressMerkleContext,
      outputMerkleTreeIndex,
      remainingAccounts: accountMetas,
      lightAvailable: true,
    };
  }

  async createRevealedPartials(
    gameId: Uint8Array,
    recipientIndex: number,
    chunkIndex: number,
    startIndex: number,
    count: number,
    commitments: Uint8Array[],
    recipient: web3.Keypair,
  ): Promise<void> {
    if (count < 1 || count > 8 || commitments.length !== count) {
      throw new Error('Revealed partial count must match 1..8 commitments');
    }
    const padded = [...commitments];
    while (padded.length < 8) padded.push(new Uint8Array(32).fill(0));

    // Arcium-only localnet has no Light indexer. Showdown binds casino
    // RevealedCard PDAs; compressed persistence is optional.
    if (!(await isLightAvailable())) {
      if (process.env.LIGHT_E2E === '1') {
        throw new Error('Light indexer is not reachable for revealed partial persistence');
      }
      return;
    }

    const gamePubkey = new web3.PublicKey(gameId);
    const chunkBytes = Buffer.alloc(2);
    chunkBytes.writeUInt16LE(chunkIndex);
    const addressProof = await this.proveNewAddressLive([
      Buffer.from('revealed'),
      gamePubkey.toBuffer(),
      Buffer.from([recipientIndex]),
      recipient.publicKey.toBuffer(),
      chunkBytes,
    ]);

    await (this.lightPokerProgram.methods as any)
      .createRevealedPartials(
        addressProof.validityProof,
        addressProof.addressTreeInfo,
        addressProof.outputMerkleTreeIndex,
        gamePubkey,
        recipientIndex,
        chunkIndex,
        startIndex,
        count,
        ...padded.map((c) => Array.from(c) as [number]),
      )
      .accounts({ signer: recipient.publicKey })
      .remainingAccounts(addressProof.remainingAccounts)
      .preInstructions([
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ])
      .signers([recipient])
      .rpc();
  }

  /**
   * Persist one chunk of roulette encrypted bet limbs (`LIGHT_KIND_ROULETTE_BETS = 6`).
   * Seeds: `["artifact", gameId, kind, ownerPlayerIndex, chunkIndexLe]`.
   */
  async storeRouletteBetChunk(
    gameId: Uint8Array,
    playerIndex: number,
    chunkIndex: number,
    startIndex: number,
    count: number,
    commitments: Uint8Array[],
    accounts: {
      gameState: web3.PublicKey;
      playerState: web3.PublicKey;
      sharePublicInputs: web3.PublicKey;
      rouletteBetCommitment: web3.PublicKey;
    },
    authority?: web3.Keypair,
  ): Promise<void> {
    if (count < 1 || count > 8 || commitments.length !== count) {
      throw new Error('Roulette bet chunk count must match 1..8 commitments');
    }
    const padded = [...commitments];
    while (padded.length < 8) padded.push(new Uint8Array(32).fill(0));

    const lightUp =
      process.env.LIGHT_E2E === '1' || (await isLightAvailable());
    if (!lightUp) {
      throw new Error('Light indexer is not reachable for roulette bet persistence');
    }

    const kind = 6; // LIGHT_KIND_ROULETTE_BETS
    const chunkBytes = Buffer.alloc(2);
    chunkBytes.writeUInt16LE(chunkIndex);
    const addressProof = await this.proveNewAddressLive([
      Buffer.from('artifact'),
      Buffer.from(gameId),
      Buffer.from([kind]),
      Buffer.from([playerIndex]),
      chunkBytes,
    ]);

    const signer = authority?.publicKey ?? this.provider.wallet.publicKey;
    const builder = (this.lightPokerProgram.methods as any)
      .storeRouletteBets(
        addressProof.validityProof,
        addressProof.addressTreeInfo,
        addressProof.outputMerkleTreeIndex,
        chunkIndex,
        startIndex,
        count,
        ...padded.map((c) => Array.from(c) as [number]),
      )
      .accounts({
        signer,
        gameState: accounts.gameState,
        playerState: accounts.playerState,
        sharePublicInputs: accounts.sharePublicInputs,
        rouletteBetCommitment: accounts.rouletteBetCommitment,
      })
      .remainingAccounts(addressProof.remainingAccounts)
      .preInstructions([
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ]);
    if (authority && !authority.publicKey.equals(this.provider.wallet.publicKey)) {
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

  /**
   * After Groth16, persist the verified deck limbs in Light compressed accounts.
   * Eight limbs per account. Seeds: `artifact || gameId || kind 2 || player || chunk`.
   * The permutation digest already lives in the used-permutation account.
   */
  async storeVerifiedShuffleDeck(
    gameId: Uint8Array,
    playerIndex: number,
    fields: Uint8Array[],
    authority?: web3.Keypair,
  ): Promise<void> {
    if (fields.length === 0) return;
    const lightUp = process.env.LIGHT_E2E === '1' || (await isLightAvailable());
    if (!lightUp) return;
    const kind = 2;
    const starts: number[] = [];
    for (let start = 0; start < fields.length; start += 8) starts.push(start);
    await mapPool(starts, 4, async (start) => {
      await withRetry(async () => {
        try {
          const slice = fields.slice(start, start + 8);
          const padded = [...slice];
          while (padded.length < 8) padded.push(new Uint8Array(32));
          const chunkIndex = start / 8;
          const chunkBytes = Buffer.alloc(2);
          chunkBytes.writeUInt16LE(chunkIndex);
          const addressProof = await this.proveNewAddressLive([
            Buffer.from('artifact'),
            Buffer.from(gameId),
            Buffer.from([kind]),
            Buffer.from([playerIndex]),
            chunkBytes,
          ]);
          const signer = authority?.publicKey ?? this.provider.wallet.publicKey;
          const builder = (this.lightPokerProgram.methods as any)
            .storeArtifactChunk(
              addressProof.validityProof,
              addressProof.addressTreeInfo,
              addressProof.outputMerkleTreeIndex,
              new web3.PublicKey(gameId),
              kind,
              playerIndex,
              chunkIndex,
              start,
              slice.length,
              ...padded.map((limb) => Array.from(limb)),
            )
            .accounts({ signer })
            .remainingAccounts(addressProof.remainingAccounts)
            .preInstructions([
              web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
            ]);
          if (authority && !authority.publicKey.equals(this.provider.wallet.publicKey)) {
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
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          // A timed-out confirm still inserts the address. The retry's new-address
          // proof then fails because that chunk is already stored.
          if (message.includes('already exists')) return;
          throw error;
        }
      }, { retries: 5, delayMs: 200 });
    });
  }
}
