import { RescueCipher, getMXEPublicKey, x25519, deserializeLE, serializeLE } from '@arcium-hq/client';
import { PublicKey } from '@solana/web3.js';
import type { AnchorProvider } from '@coral-xyz/anchor';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export interface TableEncryptionKey {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  nonceBase: bigint;
}

/**
 * Random per-hand X25519 key material (CSPRNG). Prefer purpose-bound keys via
 * `src/mpc-key-store.ts` for Protocol V2 production paths.
 */
export function generateTableEncryptionKey(): TableEncryptionKey {
  const privateKey = x25519.utils.randomSecretKey();
  return {
    publicKey: x25519.getPublicKey(privateKey),
    privateKey,
    nonceBase: deserializeLE(randomBytes(16)),
  };
}

async function getMXEPublicKeyWithRetry(
  provider: AnchorProvider,
  programId: PublicKey,
  maxRetries = 10,
  retryDelayMs = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch {
      // retry
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

function sharedCipher(tableKey: TableEncryptionKey, mxePublicKey: Uint8Array) {
  const sharedSecret = x25519.getSharedSecret(tableKey.privateKey, mxePublicKey);
  return new RescueCipher(sharedSecret);
}

export async function encryptBetFields(
  tableKey: TableEncryptionKey,
  provider: AnchorProvider,
  programId: PublicKey,
  fields: bigint[],
): Promise<{ ciphertexts: Uint8Array[]; encryptionPubkey: Uint8Array; nonce: bigint }> {
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programId);
  const nonce = deserializeLE(randomBytes(16));
  const nonceBytes = serializeLE(nonce, 16);
  const cipher = sharedCipher(tableKey, mxePublicKey);
  // Each circuit `Enc<Shared, _>` is an independent ciphertext under the same
  // pubkey+nonce. Do NOT batch-encrypt — Rescue CTR would advance the nonce
  // per element and only the first field would decrypt correctly on-chain.
  const ciphertexts = fields.map((field) => {
    const enc = cipher.encrypt([field], nonceBytes)[0]!;
    return enc instanceof Uint8Array ? enc : new Uint8Array(enc as ArrayLike<number>);
  });
  return { ciphertexts, encryptionPubkey: tableKey.publicKey, nonce };
}

/** Encrypt fields under an existing nonce. Each field is its own ciphertext. */
export async function encryptBetFieldsAtNonce(
  tableKey: TableEncryptionKey,
  provider: AnchorProvider,
  programId: PublicKey,
  fields: bigint[],
  nonce: bigint,
): Promise<Uint8Array[]> {
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programId);
  const nonceBytes = serializeLE(nonce, 16);
  const cipher = sharedCipher(tableKey, mxePublicKey);
  return fields.map((field) => {
    const enc = cipher.encrypt([field], nonceBytes)[0]!;
    return enc instanceof Uint8Array ? enc : new Uint8Array(enc as ArrayLike<number>);
  });
}

export async function encryptBetAmount(
  tableKey: TableEncryptionKey,
  provider: AnchorProvider,
  programId: PublicKey,
  amount: bigint,
) {
  return encryptBetFields(tableKey, provider, programId, [amount]);
}

export async function encryptBetPayload(
  tableKey: TableEncryptionKey,
  provider: AnchorProvider,
  programId: PublicKey,
  payload: {
    playerBalance: bigint;
    playerCurrentBet: bigint;
    action: bigint;
    actionAmount: bigint;
    currentBet: bigint;
    lastAggressorAmount: bigint;
  },
) {
  return encryptBetFields(tableKey, provider, programId, [
    payload.playerBalance,
    payload.playerCurrentBet,
    payload.action,
    payload.actionAmount,
    payload.currentBet,
    payload.lastAggressorAmount,
  ]);
}

export function decryptBetLogEntry(
  tableKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  amountCiphertext: Uint8Array,
  nonce: bigint,
): bigint {
  const nonceBytes = serializeLE(nonce, 16);
  const cipher = sharedCipher(tableKey, mxePublicKey);
  const [amount] = cipher.decrypt([Array.from(amountCiphertext)], nonceBytes);
  return amount!;
}
