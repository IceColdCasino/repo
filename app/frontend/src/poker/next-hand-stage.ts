/**
 * Proofs prepared during showdown and reused on the next hand.
 * Register is reused when the key and player count are unchanged.
 * Shuffle and share are reused only when the deck and keys match.
 */

type LimbCard = ReadonlyArray<bigint>;
type Pub = readonly [bigint, bigint];

export type StagedShuffle = {
  playerIndex: number;
  deckMix: string;
  keysMix: string;
  proof: object;
  publicSignals: string[];
  shuffledDeck: string[][];
};

export type StagedShare = {
  playerIndex: number;
  deckMix: string;
  keysMix: string;
  playerCount: number;
  proof: object;
  publicSignals: string[];
  ciphertexts: LimbCard[][];
};

type CachedRegister = {
  playerCount: number;
  publicKey: string;
  proof: object;
  publicSignals: string[];
};

let cachedRegister: CachedRegister | null = null;
const stagedShuffles = new Map<number, StagedShuffle>();
const stagedShares = new Map<number, StagedShare>();
let stageFlight: Promise<void> | null = null;

export function publicKeyId(key: Pub): string {
  return `${key[0].toString()}:${key[1].toString()}`;
}

export function mixLimbs(cards: ReadonlyArray<LimbCard>): string {
  let mix = 2166136261n;
  const mask = (1n << 64n) - 1n;
  for (const card of cards) {
    for (const limb of card) {
      mix = ((mix ^ limb) * 16777619n) & mask;
    }
  }
  return `${cards.length}:${mix}`;
}

export function mixKeys(keys: ReadonlyArray<Pub>): string {
  let mix = 2166136261n;
  const mask = (1n << 64n) - 1n;
  for (const key of keys) {
    mix = ((mix ^ key[0] ^ key[1]) * 16777619n) & mask;
  }
  return `${keys.length}:${mix}`;
}

export function rememberRegisterProof(
  playerCount: number,
  publicKey: Pub,
  proof: object,
  publicSignals: string[],
): void {
  if (playerCount < 2) return;
  cachedRegister = {
    playerCount,
    publicKey: publicKeyId(publicKey),
    proof,
    publicSignals,
  };
}

export function reusableRegisterProof(
  playerCount: number,
  publicKey: Pub,
): { proof: object; publicSignals: string[] } | null {
  if (
    !cachedRegister
    || cachedRegister.playerCount !== playerCount
    || cachedRegister.publicKey !== publicKeyId(publicKey)
  ) {
    return null;
  }
  return {
    proof: cachedRegister.proof,
    publicSignals: cachedRegister.publicSignals,
  };
}

export function rememberStagedShuffle(staged: StagedShuffle): void {
  stagedShuffles.set(staged.playerIndex, staged);
}

export function hasStagedShuffle(playerIndex: number): boolean {
  return stagedShuffles.has(playerIndex);
}

export function stagedShuffleDeck(playerIndex: number): string[][] | null {
  return stagedShuffles.get(playerIndex)?.shuffledDeck ?? null;
}

export function rememberStagedShare(staged: StagedShare): void {
  stagedShares.set(staged.playerIndex, staged);
}

export function hasStagedShare(playerIndex: number): boolean {
  return stagedShares.has(playerIndex);
}

export function noteStageFlight(flight: Promise<void> | null): void {
  stageFlight = flight;
}

export function currentStageFlight(): Promise<void> | null {
  return stageFlight;
}

async function waitForStage(): Promise<void> {
  const flight = stageFlight;
  if (!flight) return;
  await Promise.race([
    flight.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
}

export async function takeStagedShuffle(
  playerIndex: number,
  deck: ReadonlyArray<LimbCard>,
  publicKeys: ReadonlyArray<Pub>,
): Promise<StagedShuffle | null> {
  await waitForStage();
  const staged = stagedShuffles.get(playerIndex);
  if (!staged) return null;
  if (staged.deckMix !== mixLimbs(deck) || staged.keysMix !== mixKeys(publicKeys)) {
    return null;
  }
  stagedShuffles.delete(playerIndex);
  return staged;
}

export async function takeStagedShare(
  playerIndex: number,
  deck: ReadonlyArray<LimbCard>,
  publicKeys: ReadonlyArray<Pub>,
  playerCount: number,
): Promise<StagedShare | null> {
  await waitForStage();
  const staged = stagedShares.get(playerIndex);
  if (!staged) return null;
  if (
    staged.playerCount !== playerCount
    || staged.deckMix !== mixLimbs(deck)
    || staged.keysMix !== mixKeys(publicKeys)
  ) {
    return null;
  }
  stagedShares.delete(playerIndex);
  return staged;
}

/** Test hook. */
export function resetNextHandStage(): void {
  cachedRegister = null;
  stagedShuffles.clear();
  stagedShares.clear();
  stageFlight = null;
}
