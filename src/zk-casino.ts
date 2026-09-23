export type Ciphertext = [bigint, bigint, bigint, bigint] & { __brand: 'Ciphertext' }; // [c0[0], c0[1], c1[0], c1[1]]
export type CompressedCiphertext = { x0: bigint; x1: bigint; selector: bigint };
export type PrivateKey = bigint & { __brand: 'SecretKey' };
export type PublicKey = [bigint, bigint] & { __brand: 'PublicKey' };
export type PlaintextCard = [bigint, bigint] & { __brand: 'PlaintextCard' };
export type Delta = [bigint, bigint] & { __brand: 'Delta' };

export interface PlayerKey {
  privateKey: PrivateKey;  // Single secret key per player
  publicKey: PublicKey;  // pk = sk * G
}
