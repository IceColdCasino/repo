import type { BabyJub, Point } from 'circomlibjs';
import assert from 'node:assert';
import { HandEvaluator, type EvaluatedHand } from './hand-eval';
import { casinoShareStreets } from './casino-calc';
import {
  type Ciphertext,
  type PlaintextCard,
  type PrivateKey,
  type PublicKey,
} from './zk-casino';

export type { Ciphertext, CompressedCiphertext, PlayerKey, PlaintextCard, PrivateKey, PublicKey } from './zk-casino';
import { ZkCrypto } from './zk-crypto-base';
import { GameKind } from './game-config';
import { casinoDeck } from './casino-calc';
import { packPokerWinnerMasks, showdownTwoCoeffHash } from './showdown-sealed-coeffs';
import {
  hashPublicKeys10,
  SHARE_OTHER_SLOTS,
  SHARE_PLAYER_SLOTS,
} from './share-common';

export const MAX_PLAYERS = 10;
/** Hole pair per seat, then flop, turn, and river. */
export const POKER_STREET_COUNT = 13;
/** Final share hash and the share input hash. Street hashes are not proof outputs. */
export const POKER_SHARE_PUBLIC_SIGNALS = 2;

export type PokerShareCommitment = {
  finalHash: bigint;
  streets: bigint[];
};

/** Cards covered by street 0..9 (seat holes), 10 flop, 11 turn, 12 river. */
export function pokerStreetCards(street: number): number[] {
  if (street >= 0 && street < MAX_PLAYERS) return [street * 2, street * 2 + 1];
  if (street === 10) return [20, 21, 22];
  if (street === 11) return [23];
  if (street === 12) return [24];
  throw new Error(`poker street ${street} is out of range`);
}

export function pokerStreetName(street: number): string {
  if (street >= 0 && street < MAX_PLAYERS) return `hole ${street}`;
  if (street === 10) return 'flop';
  if (street === 11) return 'turn';
  if (street === 12) return 'river';
  throw new Error(`poker street ${street} is out of range`);
}

export interface ShowdownHashInput {
  potMasks: bigint[];
  publicKeys: bigint[][];
  playerIndex: bigint;
  ciphertextCards: bigint[][];
  ciphertextPartials: bigint[][][];
  sealCommitment: bigint;
}

export class Poker extends ZkCrypto {
  protected override calcKind = GameKind.Poker;

  protected override onCryptoReady(_babyjub: BabyJub): void {
    this.initialDeckCards = casinoDeck(this.calcKind, 52);
  }

  override generateShufflePermutation(numCards: number = 52): bigint[] {
    return super.generateShufflePermutation(numCards);
  }

  override generateShuffleRandomness(NUM_CARDS: number = 52) {
    return super.generateShuffleRandomness(NUM_CARDS);
  }

  override shareHash(ciphertext: Ciphertext[], publicKey: PublicKey, publicKeys: PublicKey[]): bigint;
  override shareHash(
    ciphertext: Ciphertext[],
    cardMask: bigint,
    publicKey: PublicKey,
    otherPublicKeys: PublicKey[],
  ): bigint;
  override shareHash(
    ciphertext: Ciphertext[],
    publicKeyOrMask: PublicKey | bigint,
    publicKeysOrKey: PublicKey[] | PublicKey,
    otherPublicKeys?: PublicKey[],
  ): bigint {
    if (typeof publicKeyOrMask !== 'bigint') {
      throw new Error('poker shareHash requires a card mask');
    }

    const cardMask = publicKeyOrMask;
    const publicKey = publicKeysOrKey as PublicKey;
    const recipients = otherPublicKeys as PublicKey[];
    if (recipients.length !== SHARE_OTHER_SLOTS) {
      throw new Error(
        `shareHash expects ${SHARE_OTHER_SLOTS} recipient keys (${SHARE_PLAYER_SLOTS}-player circuit), got ${recipients.length}`,
      );
    }

    return this.calcFr('shareHash', {
      deck: ciphertext,
      cardMask,
      publicKey,
      publicKeys: recipients,
    });
  }

  showdownHash(hashInput: ShowdownHashInput) {  
    const {
      potMasks,
      publicKeys,
      playerIndex,
      ciphertextCards,
      ciphertextPartials,
    } = hashInput;
    const nPlayers = publicKeys.length;
    const nPots = nPlayers - 1;
    const nTotalCards = nPlayers * 2 + 5;
    const nOthers = nPlayers - 1;
  
    assert(potMasks.length === nPots, `Expected ${nPots} pot masks, got ${potMasks.length}`);
    assert(publicKeys.length === nPlayers, `Expected ${nPlayers} public keys, got ${publicKeys.length}`);
    assert(publicKeys.every(pk => pk.length === 2), 'Each public key must be [x, y]');
    assert(ciphertextCards.length === nTotalCards, `Expected ${nTotalCards} ciphertext cards, got ${ciphertextCards.length}`);
    assert(ciphertextCards.every(c => c.length === 4), 'Each ciphertext must be [c0.x, c0.y, c1.x, c1.y]');
    assert(ciphertextPartials.length === nOthers, `Expected ${nOthers} ciphertext partial arrays, got ${ciphertextPartials.length}`);
    assert(ciphertextPartials.every(cp => cp.length === nTotalCards), `Each partial array must have ${nTotalCards} cards`);
    assert(ciphertextPartials.every(cp => cp.every(c => c.length === 4)), 'Each partial ciphertext must be [c0.x, c0.y, c1.x, c1.y]');
  
    return this.calcFr('showdownHash', {
      sealCommitment: hashInput.sealCommitment,
      potMasks,
      publicKeys,
      playerIndex,
      cards: ciphertextCards,
      partials: ciphertextPartials,
    });
  }

  override shuffle(
    deck: Ciphertext[], 
    publicKeys: PublicKey[],
    permutationMatrix: bigint[],
    randomness?: bigint[],
  ) {
    return super.shuffle(deck, publicKeys, permutationMatrix, randomness, 52);
  }

  encryptPartial(plaintextCiphertext: Ciphertext, recipientPk: PublicKey, randomness: bigint): Ciphertext {
    const babyjub = this.babyjub;

    const c0 = babyjub.mulPointEscalar(babyjub.Base8, randomness);

    const pk = recipientPk.map(p => babyjub.F.e(p)) as Point;
    const rPk = babyjub.mulPointEscalar(pk, randomness);

    const pt = plaintextCiphertext.slice(2, 4).map(p => babyjub.F.e(p)) as Point;
    const c1 = babyjub.addPoint(pt, rPk);

    return [...c0, ...c1].map(c => babyjub.F.toObject(c)) as Ciphertext;
  }

  // Verify that a decrypted point matches an expected card value
  verifyDecryption(decrypted: PlaintextCard, cardValue: number): boolean {
    const babyjub = this.babyjub;
    
    const expected = babyjub.mulPointEscalar(babyjub.Base8, BigInt(cardValue + 1));
    const decryptedPoint = decrypted.map(p => babyjub.F.e(p)) as Point;
    
    return babyjub.F.eq(decryptedPoint[0], expected[0]) && 
           babyjub.F.eq(decryptedPoint[1], expected[1]);
  }

  compareHands(potMasks: bigint[], plaintextCards: bigint[]) {
    const handEvaluator = new HandEvaluator();

    return potMasks.map(potMask => {
      if (potMask < 1n) {
        return 0n;
      }

      const hands: EvaluatedHand[] = [];

      for (let p = 0; p < MAX_PLAYERS; p++) {
        if (potMask & (1n << BigInt(p))) {
          const playerHand = [
            ...plaintextCards.slice(p * 2, p * 2 + 2),
            ...plaintextCards.slice(20),
          ];
          const evaluatedHand = handEvaluator.evaluateHand(playerHand);
          hands.push(evaluatedHand);
        } else {
          hands.push(new Array(7).fill(0) as EvaluatedHand);
        }
      }

      const winnerMask = handEvaluator.compareAllHands(hands);
      return winnerMask;
    });
  }

  computeRegisterOutputHash(publicKey: PublicKey, padding: Ciphertext): bigint {
    return this.poseidon([...publicKey, ...padding]);
  }

  computeShuffleOutputHash(outputDeck: Ciphertext[], permutationHash: bigint): bigint {
    return this.poseidon([this.deckHash(outputDeck), permutationHash]);
  }

  /**
   * Street hashes are derived from the partials: one per hole pair, then flop, turn, and river.
   * The final hash is Poseidon(Poseidon of the 10 hole hashes, Poseidon of flop, turn, and river).
   */
  shareCommitments(ciphertexts: Ciphertext[][], nActualPlayers: number): PokerShareCommitment {
    const values = this.flattenShareValues(ciphertexts);
    if (values.length !== 900) {
      throw new Error(
        `Expected 900 BN254 values for share partials hash (9 players × 25 cards × 4 values), got ${values.length}`
      );
    }
    return casinoShareStreets(this.calcKind, { ciphertexts, nActualPlayers }, this.calcVariant);
  }

  computeShareOutputHash(ciphertexts: Ciphertext[][], nActualPlayers: number): bigint {
    return this.shareCommitments(ciphertexts, nActualPlayers).finalHash;
  }

  parseSharePublicSignals(publicSignals: Array<bigint | string>): { finalHash: bigint; inputHash: bigint } {
    const signals = publicSignals.map(s => BigInt(s));
    if (signals.length !== POKER_SHARE_PUBLIC_SIGNALS) {
      throw new Error(
        `poker share proof has ${signals.length} public signals, expected ${POKER_SHARE_PUBLIC_SIGNALS}`,
      );
    }
    return {
      finalHash: signals[0]!,
      inputHash: signals[1]!,
    };
  }

  override share(
    ciphertext: Ciphertext[],
    publicKeys: PublicKey[],
    privateKey: PrivateKey,
    cardRandomness: bigint[][],
  ): Ciphertext[][];
  override share(
    ciphertext: Ciphertext[],
    cardMask: bigint,
    publicKeys: PublicKey[],
    privateKey: PrivateKey,
    randomness: bigint[][],
  ): Ciphertext[][];
  override share(
    ciphertext: Ciphertext[],
    publicKeysOrMask: PublicKey[] | bigint,
    privateKeyOrKeys: PrivateKey | PublicKey[],
    randomnessOrKey: bigint[][] | PrivateKey,
    randomness?: bigint[][],
  ): Ciphertext[][] {
    if (typeof publicKeysOrMask !== 'bigint') {
      return super.share(
        ciphertext,
        publicKeysOrMask,
        privateKeyOrKeys as PrivateKey,
        randomnessOrKey as bigint[][],
      );
    }

    const cardMask = publicKeysOrMask;
    const publicKeys = privateKeyOrKeys as PublicKey[];
    const privateKey = randomnessOrKey as PrivateKey;
    const cardRandomness = randomness as bigint[][];
    const partials = ciphertext.map(c => this.createPartialDecryption(privateKey, c));
    return publicKeys.map((publicKey, recipient) =>
      partials.map((partial, card) => {
        const masked = ((cardMask >> BigInt(card)) & 1n) === 0n;
        return this.reencryptPartialForRecipient(
          partial,
          publicKey,
          cardRandomness[recipient]![card],
          masked,
        );
      }),
    );
  }

  computeShowdownOutputHash(winnerMasks: bigint[], coefficients: readonly bigint[]): bigint {
    return showdownTwoCoeffHash(packPokerWinnerMasks(winnerMasks), coefficients);
  }

  override decryptCards(
    privateKey: PrivateKey,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    label?: string,
  ): bigint[];
  override decryptCards(
    privateKey: PrivateKey,
    potMask: bigint,
    ciphertextCards: Ciphertext[],
    ciphertextPartials: Ciphertext[][],
    dealerSk?: bigint[],
  ): bigint[];
  override decryptCards(
    privateKey: PrivateKey,
    cardsOrMask: Ciphertext[] | bigint,
    partialsOrCards: Ciphertext[][] | Ciphertext[],
    labelOrPartials?: string | Ciphertext[][],
    dealerSk?: bigint[],
  ): bigint[] {
    if (typeof cardsOrMask !== 'bigint') {
      return super.decryptCards(
        privateKey,
        cardsOrMask,
        partialsOrCards as Ciphertext[][],
        typeof labelOrPartials === 'string' ? labelOrPartials : 'card',
      );
    }

    const potMask = cardsOrMask;
    const ciphertextCards = partialsOrCards as Ciphertext[];
    const ciphertextPartials = labelOrPartials as Ciphertext[][];
    return ciphertextCards.map(
      (encryptedCard, cardIndex) => {
        const p = Math.floor(cardIndex / 2);

        if (p < MAX_PLAYERS && ((potMask >> BigInt(p)) & 1n) === 0n) {
          return 0n;
        }

        const cardPartials = ciphertextPartials.map((pt) => pt[cardIndex]!);
        const index = this.decryptFromPartials(
          privateKey,
          encryptedCard,
          cardPartials,
        );
        void dealerSk;

        if (index < 0) {
          console.error(JSON.stringify({
            player: p,
          }, null, '  '));
          throw new Error('Unable to find card index');
        }

        return BigInt(index);
      }
    );
  }
}
