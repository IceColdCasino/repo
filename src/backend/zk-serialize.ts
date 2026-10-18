import type { Ciphertext, PublicKey } from '../zk-casino';
import type { Groth16Proof, PublicSignals } from 'snarkjs';

export type ZkHandPhase = 'Register' | 'Shuffle' | 'Share';

export function publicKeyToStrings(key: PublicKey): [string, string] {
  return [key[0].toString(), key[1].toString()];
}

export function publicKeyFromStrings(key: [string, string]): PublicKey {
  return [BigInt(key[0]), BigInt(key[1])] as PublicKey;
}

export function ciphertextToJson(ciphertext: Ciphertext): string[] {
  return ciphertext.map((value) => value.toString());
}

export function ciphertextFromJson(values: string[]): Ciphertext {
  if (values.length !== 4) {
    throw new Error('Expected ciphertext with 4 coordinates');
  }
  return values.map((value) => BigInt(value)) as Ciphertext;
}

export function ciphertextMatrixFromJson(values: string[][][]): Ciphertext[][] {
  return values.map((row) => row.map((cell) => ciphertextFromJson(cell)));
}

export interface ZkRegisterRequest {
  seat: number;
  proof: Groth16Proof;
  publicSignals: string[];
}

export interface ZkShuffleRequest {
  seat: number;
  proof: Groth16Proof;
  publicSignals: string[];
}

export interface ZkShareRequest {
  seat: number;
  proof: Groth16Proof;
  publicSignals: string[];
  /** [otherPlayerIndex][cardIndex][4] — private partial ciphertexts for hashout verification. */
  ciphertexts: string[][][];
}

export interface ZkShowdownRequest {
  seat: number;
  proof: Groth16Proof;
  publicSignals: string[];
  /** Public Poseidon binding for the private Arcis-sealed coefficients. */
  coefficientCommitment?: string;
  /**
   * Prover-private pot winner masks (bit i = playerIndex). Required for local
   * Bun settlement after Groth16 verify (no Arcis compute_pots on this path).
   */
  winnerMasks?: string[];
}

export interface ZkShowdownMaterials {
  playerIndex: number;
  potMasks: string[];
  finalDeck: string[][];
  /** [otherPlayerIndex][cardIndex][4] partial ciphertexts for this player. */
  ciphertextPartials: string[][][];
  elGamalPublicKeys: Array<[string, string]>;
  sealedCoefficients?: string[];
  /** True once `ShowdownMaterialCommitment.complete` is on-chain for this player. */
  materialComplete?: boolean;
}

export interface ZkRevealedPartialEntry {
  cardIndex: number;
  fromPlayerIndex: number;
  toPlayerIndex: number;
  ciphertext: string[];
}

export interface ZkRevealSnapshot {
  revealedCardIndices: number[];
  /** Indices made public in the latest snapshot update. */
  newlyRevealed: number[];
  allPartialsPublic: boolean;
  /** True once every player has shared partials (before pre-flop betting). */
  shareComplete: boolean;
  /** True once pre-flop betting finished — own-hole partials become fetchable. */
  holePartialsUnlocked?: boolean;
  entries: ZkRevealedPartialEntry[];
}

export interface ZkCryptoSnapshot {
  handNumPlayers: number;
  elGamalPublicKeys: Array<[string, string]>;
  finalDeck: string[][];
  dealCardCount: number;
}

export interface ZkShowdownSnapshot {
  requested: boolean;
  requiredCount: number;
  /** Seated players; any one may submit the single required showdown proof. */
  eligibleSeats: number[];
  /** Optional hint for which eligible seat may submit next (not enforced server-side). */
  submitterSeat: number | null;
  submittedCount: number;
  submittedSeats: number[];
  outputHash: string | null;
  /** Poker `showdown_finalized` — proof accepted; settle/Complete may still be pending. */
  finalizedOnChain?: boolean;
}

export function ciphertextMatrixToJson(values: Ciphertext[][]): string[][][] {
  return values.map((row) => row.map((cell) => ciphertextToJson(cell)));
}

export interface ZkHandSnapshot {
  phase: ZkHandPhase | null;
  shuffleOrder: number[];
  shuffleStep: number;
  currentShufflerIndex: number | null;
  currentShufflerSeat: number | null;
  registeredCount: number;
  shuffledCount: number;
  sharedCount: number;
  requiredShares: number;
  /** True when player i has submitted share partials for this hand. */
  hasSharedPartial?: boolean[];
  registerRequested: boolean;
  shuffleRequested: boolean;
  shareRequested: boolean;
  shareComplete: boolean;
  dealCardCount: number;
  /** ElGamal public keys indexed by hand player index (0 = SB). */
  elGamalPublicKeys: Array<[string, string] | null>;
  cardsDealtFaceDown: boolean;
  /** Current 52-card deck ciphertexts during shuffle/share (4 coords per card). */
  currentDeck: string[][] | null;
  /** First TOTAL_CARDS of the final shuffled deck — use for share proofs (matches server validation). */
  shareDeck?: string[][] | null;
}

export const EMPTY_ZK_HAND_SNAPSHOT: ZkHandSnapshot = {
  phase: null,
  shuffleOrder: [],
  shuffleStep: 0,
  currentShufflerIndex: null,
  currentShufflerSeat: null,
  registeredCount: 0,
  shuffledCount: 0,
  sharedCount: 0,
  requiredShares: 0,
  registerRequested: false,
  shuffleRequested: false,
  shareRequested: false,
  shareComplete: false,
  dealCardCount: 0,
  elGamalPublicKeys: [],
  cardsDealtFaceDown: false,
  currentDeck: null,
};
