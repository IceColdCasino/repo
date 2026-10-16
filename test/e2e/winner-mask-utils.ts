/**
 * Test helpers for winner masks. Production hash lives in
 * `src/showdown-sealed-coeffs.ts`; mocks stay here.
 */
import { RescueCipher, getMXEPublicKey, x25519 } from '@arcium-hq/client';
import { randomBytes } from 'crypto';
import { type AnchorProvider } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

export {
  computeWinnerMaskHash,
  hashToBytes,
  encodeWinnerMask,
  createWinnerMasks,
} from '../../src/showdown-sealed-coeffs';

/**
 * Encrypt winner masks using the Arcium MPC encryption scheme (ephemeral key).
 */
export async function encryptWinnerMasks(
  winnerMasks: bigint[],
  provider: AnchorProvider,
  programId: PublicKey,
): Promise<{
  ciphertexts: Uint8Array[];
  encryptionPubkey: Uint8Array;
  nonce: bigint;
}> {
  if (winnerMasks.length !== 9) {
    throw new Error('Expected 9 winner masks');
  }

  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programId);

  const privateKey = x25519.utils.randomSecretKey();
  const ephemeralPublicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  const nonceBytes = randomBytes(16);
  const encrypted = cipher.encrypt(winnerMasks, nonceBytes);
  const ciphertexts = encrypted.map((ct) =>
    ct instanceof Uint8Array ? ct : new Uint8Array(ct),
  );
  const nonce = BigInt('0x' + Buffer.from(nonceBytes).reverse().toString('hex'));

  return {
    ciphertexts,
    encryptionPubkey: ephemeralPublicKey,
    nonce,
  };
}

async function getMXEPublicKeyWithRetry(
  provider: AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 10,
  retryDelayMs: number = 500,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

/** Deterministic test sealed coeffs (not HASH_COEFFS_900). */
export function mockSealedCoefficients(seed = 42n): bigint[] {
  return Array.from({ length: 9 }, (_, i) => seed + BigInt(i) * 0x1111_1111_1111_1111n + 1n);
}
