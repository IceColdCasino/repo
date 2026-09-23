import type { BabyJub, Point, Poseidon } from 'circomlibjs';
import type { PlayerEngine } from './player-ffi';
import {
  type Ciphertext,
  type PlayerKey,
  type PlaintextCard,
  type Delta,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';
import { hashFlatValues, hashRowValues } from './poseidon-chunk';
import { hashPublicKeys12, padPublicKeysForShuffle } from './shuffle-common';
import { casinoDecrypt, casinoFr } from './casino-calc';

export const SHARE_PUBLIC_SIGNAL_COUNT = 2;

export function parseSharePublicSignals(publicSignals: string[]): {
  outHash: bigint;
  inputHash: bigint;
} {
  const signals = publicSignals.map(s => BigInt(s));
  if (signals.length !== SHARE_PUBLIC_SIGNAL_COUNT) {
    throw new Error(
      `Expected ${SHARE_PUBLIC_SIGNAL_COUNT} share public signals, got ${signals.length}`,
    );
  }
  return { outHash: signals[0]!, inputHash: signals[1]! };
}

export function parseBetPublicSignals(
  publicSignals: string[],
  recipients: number,
  maxBets: number,
): { encryptedBets: Ciphertext[][]; inputHash: bigint } {
  const expected = 1 + recipients * maxBets * 4;
  const signals = publicSignals.map(s => BigInt(s));
  if (signals.length !== expected) {
    throw new Error(`Expected ${expected} bet public signals, got ${signals.length}`);
  }
  const encryptedBets: Ciphertext[][] = [];
  let offset = 0;
  for (let p = 0; p < recipients; p++) {
    const playerBets: Ciphertext[] = [];
    for (let b = 0; b < maxBets; b++) {
      playerBets.push(signals.slice(offset, offset + 4) as Ciphertext);
      offset += 4;
    }
    encryptedBets.push(playerBets);
  }
  return { encryptedBets, inputHash: signals[offset]! };
}

/**
 * Shared BabyJub / Poseidon / ElGamal primitives used by every table game.
 * Game-specific hash bindings and evaluators stay on the subclass.
 */
export abstract class ZkCrypto {
  protected babyjubInst: BabyJub | undefined;
  protected poseidonInst: Poseidon | undefined;
  protected initialDeckCards: Ciphertext[] = [];
  protected playerEngine: PlayerEngine | undefined;
  /** libzkcasino GameKind. Subclasses set this before init(). */
  protected calcKind = 0;
  protected calcVariant = 0;

  protected calcFr(fn: string, fields: Record<string, unknown>): bigint {
    return casinoFr(this.calcKind, fn, fields, this.calcVariant);
  }

  async init(): Promise<void> {
    const { PlayerEngine } = await import('./player-ffi');
    const engine = this.playerEngine = new PlayerEngine();
    const babyjub = this.babyjubInst = engine.asBabyJub();
    this.poseidonInst = engine.asPoseidon();
    this.onCryptoReady(babyjub);
  }

  protected abstract onCryptoReady(babyjub: BabyJub): void;

  protected identityCiphertext(babyjub: BabyJub, scalar: number): Ciphertext {
    const cardPoint = babyjub.mulPointEscalar(babyjub.Base8, BigInt(scalar));
    return [
      0n,
      1n,
      babyjub.F.toObject(cardPoint[0]),
      babyjub.F.toObject(cardPoint[1]),
    ] as Ciphertext;
  }

  protected fillIdentityCards(babyjub: BabyJub, n: number, dest: Ciphertext[] = this.initialDeckCards): Ciphertext[] {
    dest.length = 0;
    for (let i = 0; i < n; i++) {
      dest.push(this.identityCiphertext(babyjub, i + 1));
    }
    return dest;
  }

  protected fillRepeatedRankShoe(babyjub: BabyJub, decks: number, ranks = 52): void {
    this.initialDeckCards = [];
    for (let d = 0; d < decks; d++) {
      for (let i = 0; i < ranks; i++) {
        this.initialDeckCards.push(this.identityCiphertext(babyjub, i + 1));
      }
    }
  }

  get babyjub(): BabyJub {
    if (!this.babyjubInst) throw new Error('Must call init() first');
    return this.babyjubInst;
  }

  poseidon(inputs: bigint[]): bigint {
    if (!this.poseidonInst) throw new Error('Must call init() first');
    return this.poseidonInst.F.toObject(this.poseidonInst(inputs));
  }

  generatePlayerKey(): PlayerKey {
    const babyjub = this.babyjub;
    const MIN_KEY = 1024n;
    const MAX_KEY = babyjub.subOrder - 1n;
    let privateKey = this.getRandom() as PrivateKey;
    while (privateKey <= MIN_KEY || privateKey > MAX_KEY) {
      privateKey = this.getRandom() as PrivateKey;
    }
    const pkPoint = babyjub.mulPointEscalar(babyjub.Base8, privateKey) as Point;
    const publicKey = pkPoint.map(p => babyjub.F.toObject(p)) as PublicKey;
    return { privateKey, publicKey };
  }

  aggregatePublicKeys(publicKeys: PublicKey[]): PublicKey {
    const babyjub = this.babyjub;
    const pkAgg = publicKeys.reduce((acc: Point, publicKey: PublicKey) => {
      const pk = publicKey.map(p => babyjub.F.e(p)) as Point;
      return babyjub.addPoint(acc, pk);
    }, [babyjub.F.e(0n), babyjub.F.e(1n)] as Point);
    return pkAgg.map(p => babyjub.F.toObject(p)) as PublicKey;
  }

  get initialDeck(): Ciphertext[] {
    return [...this.initialDeckCards];
  }

  generateShufflePermutation(numCards: number): bigint[] {
    if (!this.playerEngine) throw new Error('Must call init() first');
    return this.playerEngine.generateShufflePermutation(numCards);
  }

  getRandom(max?: number): bigint {
    if (max != null) {
      const r = this.babyjub.F.toObject(this.babyjub.F.random());
      return r & ((1n << BigInt(max)) - 1n);
    }
    if (!this.playerEngine) throw new Error('Must call init() first');
    return this.playerEngine.scalar253();
  }

  protected bits2num(bits: bigint[]): bigint {
    return bits.reduce((acc, val) => acc * 2n + val, 0n);
  }

  hashCiphertexts(ciphertext: Ciphertext[]): bigint {
    return hashFlatValues(ciphertext.flat(2), (inputs) => this.poseidon(inputs));
  }

  deckHash(deck: Ciphertext[]): bigint {
    return this.hashCiphertexts(deck);
  }

  shareHash(ciphertext: Ciphertext[], publicKey: PublicKey, publicKeys: PublicKey[]): bigint {
    return this.calcFr('shareHash', {
      deck: ciphertext,
      publicKey,
      publicKeys,
    });
  }

  hashPermutationMatrix(permutationMatrix: bigint[], matrixSize: number): bigint {
    const rowValues: bigint[] = [];
    for (let i = 0; i < matrixSize; i++) {
      const row = permutationMatrix.slice(i * matrixSize, (i + 1) * matrixSize);
      rowValues.push(this.bits2num(row));
    }
    return hashRowValues(rowValues, (inputs) => this.poseidon(inputs));
  }

  shuffleHash(deck: Ciphertext[], publicKeys: PublicKey[]): bigint {
    return this.calcFr('shuffleHash', { deck, publicKeys });
  }

  shuffle(
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
    matrixSize: number = deck.length,
  ): { ciphertexts: Ciphertext[]; permutationHash: bigint } {
    const babyjub = this.babyjub;
    const n = deck.length;
    const pkAgg = this.aggregatePublicKeys(publicKeys);
    const permutedDeck: Ciphertext[] = new Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (permutationMatrix[i * n + j] === 1n) {
          permutedDeck[i] = deck[j]!;
          break;
        }
      }
    }
    const ciphertexts = permutedDeck.map((card, i) => {
      const r = randomness ? randomness[i]! : this.getRandom();
      const c0 = card.slice(0, 2).map(p => babyjub.F.e(p)) as Point;
      const c1 = card.slice(2, 4).map(p => babyjub.F.e(p)) as Point;
      const newC0 = babyjub.addPoint(c0, babyjub.mulPointEscalar(babyjub.Base8, r));
      const pkAggPoint = pkAgg.map(p => babyjub.F.e(p)) as Point;
      const newC1 = babyjub.addPoint(c1, babyjub.mulPointEscalar(pkAggPoint, r));
      return [...newC0, ...newC1].map(p => babyjub.F.toObject(p)) as Ciphertext;
    });
    return {
      ciphertexts,
      permutationHash: this.hashPermutationMatrix(permutationMatrix, matrixSize),
    };
  }

  generateShuffleRandomness(numCards: number): bigint[] {
    const randomness: bigint[] = [];
    for (let i = 0; i < numCards; i++) {
      let r = this.getRandom();
      while (r === 0n) r = this.getRandom();
      randomness.push(r);
    }
    return randomness;
  }

  createPartialDecryption(privateKey: PrivateKey, ciphertext: Ciphertext): Delta {
    const babyjub = this.babyjub;
    const c0 = ciphertext.slice(0, 2).map(p => babyjub.F.e(p)) as Point;
    return babyjub.mulPointEscalar(c0, privateKey).map(p => babyjub.F.toObject(p)) as Delta;
  }

  reencryptPartialForRecipient(
    partial: Delta,
    recipientPk: PublicKey,
    randomness: bigint = this.getRandom(),
    useIdentityPoint: boolean = false,
  ): Ciphertext {
    const babyjub = this.babyjub;
    const c0 = babyjub.mulPointEscalar(babyjub.Base8, randomness);
    const d_i = (useIdentityPoint ? [0, 1] : partial).map(p => babyjub.F.e(p)) as Point;
    const pkRecipient = recipientPk.map(p => babyjub.F.e(p)) as Point;
    const c1 = babyjub.addPoint(d_i, babyjub.mulPointEscalar(pkRecipient, randomness));
    return [...c0, ...c1].map(c => babyjub.F.toObject(c)) as Ciphertext;
  }

  getPadding(recipientPk: PublicKey): Ciphertext {
    return this.reencryptPartialForRecipient([0n, 1n] as Delta, recipientPk, 1n);
  }

  encrypt(plaintext: PlaintextCard, publicKey: PublicKey, randomness: bigint): Ciphertext {
    const babyjub = this.babyjub;
    const c0 = babyjub.mulPointEscalar(babyjub.Base8, randomness);
    const pk = publicKey.map(p => babyjub.F.e(p)) as Point;
    const rPk = babyjub.mulPointEscalar(pk, randomness);
    const pt = plaintext.map(p => babyjub.F.e(p)) as Point;
    const c1 = babyjub.addPoint(pt, rPk);
    return [...c0, ...c1].map(c => babyjub.F.toObject(c)) as Ciphertext;
  }

  encryptScalar(value: number, publicKey: PublicKey, randomness: bigint): Ciphertext {
    const point = this.babyjub.mulPointEscalar(this.babyjub.Base8, BigInt(value) + 1n);
    const plaintext = point.map(p => this.babyjub.F.toObject(p)) as PlaintextCard;
    return this.encrypt(plaintext, publicKey, randomness);
  }

  decryptReencryptedPartial(encryptedPartial: Ciphertext, recipientSk: PrivateKey): Delta {
    const babyjub = this.babyjub;
    const c0 = encryptedPartial.slice(0, 2).map(p => babyjub.F.e(p)) as Point;
    const c1 = encryptedPartial.slice(2, 4).map(p => babyjub.F.e(p)) as Point;
    const skC0: Point = babyjub.mulPointEscalar(c0, recipientSk);
    const negSkC0 = [babyjub.F.neg(skC0[0]), skC0[1]] as Point;
    return babyjub.addPoint(c1, negSkC0).map(p => babyjub.F.toObject(p)) as Delta;
  }

  protected get plaintextCatalog(): Ciphertext[] {
    return this.initialDeckCards;
  }

  decryptFromPartials(
    privateKey: PrivateKey,
    ciphertext: Ciphertext,
    receivedEncryptedPartials: Ciphertext[],
  ): number {
    const decryptedPartials = receivedEncryptedPartials
      .map(encryptedPartial => this.decryptReencryptedPartial(encryptedPartial, privateKey));
    decryptedPartials.push(this.createPartialDecryption(privateKey, ciphertext));
    const sumD = decryptedPartials.reduce(
      (acc, val) => this.babyjub.addPoint(acc, val.map(p => this.babyjub.F.e(p)) as Point),
      [0n, 1n].map(p => this.babyjub.F.e(p)) as Point,
    ).map(p => this.babyjub.F.toObject(p)) as Delta;
    return this.decryptCard(ciphertext, sumD);
  }

  decryptCard(ciphertext: Ciphertext, aggregatedPartial: Delta): number {
    const babyjub = this.babyjub;
    const c1 = ciphertext.slice(2).map(p => babyjub.F.e(p)) as Point;
    const sumD = aggregatedPartial.map(p => babyjub.F.e(p)) as Point;
    const negSumD: Point = [babyjub.F.neg(sumD[0]), sumD[1]];
    const m = babyjub.addPoint(c1, negSumD).map(p => babyjub.F.toObject(p)) as PlaintextCard;
    return this.plaintextCatalog.findIndex(val => val[2] === m[0] && val[3] === m[1]);
  }

  share(
    ciphertext: Ciphertext[],
    publicKeys: PublicKey[],
    privateKey: PrivateKey,
    cardRandomness: bigint[][],
  ): Ciphertext[][] {
    const partials = ciphertext.map(c => this.createPartialDecryption(privateKey, c));
    return publicKeys.map((publicKey, p) =>
      partials.map((partial, c) =>
        this.reencryptPartialForRecipient(partial, publicKey, cardRandomness[p]![c]),
      ),
    );
  }

  flattenShareValues(ciphertexts: Ciphertext[][]): bigint[] {
    const values: bigint[] = [];
    for (const playerCiphertexts of ciphertexts) {
      for (const ct of playerCiphertexts) {
        values.push(...ct);
      }
    }
    return values;
  }

  decryptCards(
    privateKey: PrivateKey,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    _label = 'card',
  ): bigint[] {
    return casinoDecrypt(
      this.calcKind,
      privateKey,
      ciphertextCards,
      ciphertextPartials,
      this.calcVariant,
    );
  }
}
