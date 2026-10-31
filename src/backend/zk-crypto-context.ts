import { MAX_PLAYERS, Poker } from '../poker';
import { padPublicKeysForShare } from '../share-common';
import { verifyCircuit } from '../zk-verify';
import type { Ciphertext, PublicKey } from '../zk-casino';
import {
  dealCardCount,
  holePlayerIndexForCard,
  isBoardCard,
  isHoleCard,
  partialRowForRecipient,
  publicDealCardIndices,
  shareCardMask,
} from './card-layout';
import { TOTAL_CARDS } from '../poker-game';
import { randomBytes } from 'crypto';
import {
  ciphertextMatrixToJson,
  publicKeyToStrings,
  type ZkCryptoSnapshot,
  type ZkRevealSnapshot,
  type ZkRevealedPartialEntry,
  type ZkShowdownMaterials,
  type ZkShowdownRequest,
} from './zk-serialize';

const IDENTITY_POINT = [0n, 1n] as PublicKey;

/**
 * Opaque evidence that a showdown proof bound to the current ZK hand verified.
 * It deliberately contains no decrypted winner information.
 */
export interface VerifiedShowdownReceipt {
  playerIndex: number;
  generation: bigint;
  circuitVersion: number;
  outputHash: bigint;
  /** Reserved for Task 7's sealed-coefficient binding. */
  coefficientCommitment: bigint;
}

export function potMasksFromFolded(foldedMask: number, handNumPlayers: number): bigint[] {
  let mask = 0n;
  for (let playerIndex = 0; playerIndex < handNumPlayers; playerIndex += 1) {
    if ((foldedMask & (1 << playerIndex)) === 0) {
      mask |= 1n << BigInt(playerIndex);
    }
  }
  return [mask, ...new Array(MAX_PLAYERS - 2).fill(0n)];
}

export class ZkCryptoContext {
  readonly handNumPlayers: number;
  readonly #players: PublicKey[];
  readonly #padding: Ciphertext[];
  readonly #partials: Array<Ciphertext[][] | null>;
  readonly #finalDeck: Ciphertext[];
  readonly #poker: Poker;
  readonly #revealedCardIndices = new Set<number>();
  #allPartialsPublic = false;
  #shareComplete = false;
  #holePartialsUnlocked = false;
  #lastNewlyRevealed: number[] = [];
  #hostCoefficients: bigint[] | undefined;

  constructor(
    poker: Poker,
    handNumPlayers: number,
    players: PublicKey[],
    padding: Ciphertext[],
    partials: Array<Ciphertext[][] | null>,
    finalDeck: Ciphertext[],
  ) {
    this.#poker = poker;
    this.handNumPlayers = handNumPlayers;
    this.#players = players;
    this.#padding = padding;
    this.#partials = partials;
    this.#finalDeck = finalDeck;
  }

  paddedPublicKeys(): PublicKey[] {
    return padPublicKeysForShare(this.#players);
  }

  getCiphertextPartialsForPlayer(playerIndex: number): Ciphertext[][] {
    const ciphertextPartials: Ciphertext[][] = [];
    const padding = this.#padding[playerIndex]!;
    const dealCards = dealCardCount(this.handNumPlayers);
    const cardMask = shareCardMask(this.handNumPlayers);

    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      if (i === playerIndex) {
        continue;
      }

      if (i >= this.handNumPlayers) {
        ciphertextPartials.push(new Array(TOTAL_CARDS).fill(padding));
        continue;
      }

      if (!this.#partials[i]) {
        throw new Error(`Player ${i} has not shared partials`);
      }

      const index = i > playerIndex ? playerIndex : playerIndex - 1;
      const partials = this.#partials[i]![index];
      if (!partials) {
        throw new Error(`Player ${i} has not shared partials for player ${playerIndex}`);
      }

      ciphertextPartials.push(
        partials.map((ct, cardIndex) =>
          cardIndex < dealCards && ((cardMask >> BigInt(cardIndex)) & 1n) === 0n
            ? padding
            : ct,
        ),
      );
    }

    return ciphertextPartials;
  }

  revealCardIndices(cardIndices: number[]): number[] {
    if (this.#allPartialsPublic) {
      return [];
    }
    const newly: number[] = [];
    for (const cardIndex of cardIndices) {
      if (cardIndex < 0 || cardIndex >= dealCardCount(this.handNumPlayers)) {
        throw new Error(`Invalid card index ${cardIndex}`);
      }
      if (!this.#revealedCardIndices.has(cardIndex)) {
        this.#revealedCardIndices.add(cardIndex);
        newly.push(cardIndex);
      }
    }
    this.#lastNewlyRevealed = newly;
    return newly;
  }

  revealAllPartials(opts?: { foldedMask?: number; showOnFoldMask?: number }): number[] {
    // Only dealt / in-play slots that are still revealable (exclude mucked folds).
    return this.revealCardIndices(
      publicDealCardIndices(
        this.handNumPlayers,
        opts?.foldedMask ?? 0,
        opts?.showOnFoldMask ?? 0,
      ),
    );
  }

  markAllPartialsPublic(opts?: { foldedMask?: number; showOnFoldMask?: number }): void {
    this.revealAllPartials(opts);
    this.#allPartialsPublic = true;
    this.#lastNewlyRevealed = [...this.#revealedCardIndices];
  }

  markShareComplete(): void {
    this.#shareComplete = true;
  }

  isShareComplete(): boolean {
    return this.#shareComplete;
  }

  markHolePartialsUnlocked(): void {
    this.#holePartialsUnlocked = true;
  }

  isHolePartialsUnlocked(): boolean {
    return this.#holePartialsUnlocked;
  }

  isCardPartialVisibleToViewer(cardIndex: number, viewerPlayerIndex: number): boolean {
    if (this.#allPartialsPublic) {
      // Showdown/Complete: publicized in-play cards only (mucked folds stay down).
      return this.#revealedCardIndices.has(cardIndex);
    }
    if (
      this.#holePartialsUnlocked
      && this.#shareComplete
      && isHoleCard(cardIndex, this.handNumPlayers)
    ) {
      const owner = holePlayerIndexForCard(cardIndex, this.handNumPlayers);
      return owner === viewerPlayerIndex;
    }
    if (this.#revealedCardIndices.has(cardIndex) && isBoardCard(cardIndex, this.handNumPlayers)) {
      return true;
    }
    return false;
  }

  visibleCardIndicesForViewer(viewerPlayerIndex: number): number[] {
    const indices: number[] = [];
    for (let cardIndex = 0; cardIndex < dealCardCount(this.handNumPlayers); cardIndex += 1) {
      if (this.isCardPartialVisibleToViewer(cardIndex, viewerPlayerIndex)) {
        indices.push(cardIndex);
      }
    }
    return indices;
  }

  consumeLastNewlyRevealed(): number[] {
    const next = this.#lastNewlyRevealed;
    this.#lastNewlyRevealed = [];
    return next;
  }

  /** Cards whose partials are legal to broadcast (board + unlocked holes + showdown). */
  broadcastVisibleCardIndices(): number[] {
    const indices: number[] = [];
    const n = dealCardCount(this.handNumPlayers);
    for (let cardIndex = 0; cardIndex < n; cardIndex += 1) {
      if (this.#allPartialsPublic) {
        if (this.#revealedCardIndices.has(cardIndex)) {
          indices.push(cardIndex);
        }
        continue;
      }
      if (this.#revealedCardIndices.has(cardIndex) && isBoardCard(cardIndex, this.handNumPlayers)) {
        indices.push(cardIndex);
        continue;
      }
      if (
        this.#holePartialsUnlocked
        && this.#shareComplete
        && isHoleCard(cardIndex, this.handNumPlayers)
      ) {
        indices.push(cardIndex);
      }
    }
    return indices;
  }

  buildRevealEntries(cardIndices: number[]): ZkRevealedPartialEntry[] {
    const entries: ZkRevealedPartialEntry[] = [];
    for (const cardIndex of cardIndices) {
      for (let sharer = 0; sharer < this.handNumPlayers; sharer += 1) {
        const matrix = this.#partials[sharer];
        if (!matrix) {
          continue;
        }
        for (let recipient = 0; recipient < this.handNumPlayers; recipient += 1) {
          if (recipient === sharer) {
            continue;
          }
          const row = partialRowForRecipient(sharer, recipient);
          const cell = matrix[row]![cardIndex]!;
          entries.push({
            cardIndex,
            fromPlayerIndex: sharer,
            toPlayerIndex: recipient,
            ciphertext: cell.map((value) => value.toString()),
          });
        }
      }
    }
    return entries;
  }

  partialsForViewer(viewerPlayerIndex: number): ZkRevealSnapshot {
    const visibleIndices = this.visibleCardIndicesForViewer(viewerPlayerIndex);
    return {
      revealedCardIndices: [...this.#revealedCardIndices].sort((a, b) => a - b),
      newlyRevealed: [],
      allPartialsPublic: this.#allPartialsPublic,
      shareComplete: this.#shareComplete,
      holePartialsUnlocked: this.#holePartialsUnlocked,
      entries: this.buildRevealEntries(visibleIndices),
    };
  }

  toRevealSnapshot(): ZkRevealSnapshot {
    // Do not consume newlyRevealed — toSnapshot() is called for SSE and GET.
    // Consuming here dropped street/showdown reveals for every later subscriber.
    return {
      revealedCardIndices: [...this.#revealedCardIndices].sort((a, b) => a - b),
      newlyRevealed: [...this.#lastNewlyRevealed],
      allPartialsPublic: this.#allPartialsPublic,
      shareComplete: this.#shareComplete,
      holePartialsUnlocked: this.#holePartialsUnlocked,
      entries: this.buildRevealEntries(this.broadcastVisibleCardIndices()),
    };
  }

  verifyShowdown(
    playerIndex: number,
    foldedMask: number,
    request: ZkShowdownRequest,
  ): VerifiedShowdownReceipt {
    const publicKeys = this.paddedPublicKeys();
    const potMasks = potMasksFromFolded(foldedMask, this.handNumPlayers);
    const publicKey = this.#players[playerIndex]!;

    const hashInput = {
      potMasks,
      publicKeys,
      playerIndex: BigInt(playerIndex),
      publicKey,
      ciphertextCards: this.#finalDeck,
      ciphertextPartials: this.getCiphertextPartialsForPlayer(playerIndex),
      // The local backend still records a placeholder commitment on the receipt.
      sealCommitment: 0n,
    };

    const expectedInputHash = this.#poker.showdownHash(hashInput);
    const [outputHash, inputHash] = request.publicSignals.map((value) => BigInt(value));
    if (outputHash === undefined || inputHash === undefined) {
      throw new Error('Showdown public signals missing');
    }

    if (inputHash !== expectedInputHash) {
      throw new Error('Showdown input hash mismatch');
    }

    if (!verifyCircuit('poker_showdown_hashout_main', request.proof, request.publicSignals)) {
      throw new Error('Invalid showdown proof');
    }

    return {
      playerIndex,
      // The local backend has no authenticated on-chain generation yet.
      generation: 0n,
      circuitVersion: 2,
      outputHash,
      coefficientCommitment: 0n,
    };
  }

  private hostCoefficients(): bigint[] {
    if (!this.#hostCoefficients) {
      const out: bigint[] = [];
      while (out.length < MAX_PLAYERS - 1) {
        const bytes = randomBytes(16);
        let value = 0n;
        for (const byte of bytes) {
          value = (value << 8n) | BigInt(byte);
        }
        if (value !== 0n) {
          out.push(value);
        }
      }
      this.#hostCoefficients = out;
    }
    return this.#hostCoefficients;
  }

  materialsForPlayer(playerIndex: number, foldedMask: number): ZkShowdownMaterials {
    const dealCards = dealCardCount(this.handNumPlayers);
    return {
      playerIndex,
      potMasks: potMasksFromFolded(foldedMask, this.handNumPlayers).map((value) => value.toString()),
      finalDeck: this.#finalDeck
        .slice(0, dealCards)
        .map((card) => card.map((coord) => coord.toString())),
      ciphertextPartials: ciphertextMatrixToJson(
        this.getCiphertextPartialsForPlayer(playerIndex)
          .map((row) => row.slice(0, dealCards)),
      ),
      elGamalPublicKeys: this.#players.map((key) => publicKeyToStrings(key)),
      sealedCoefficients: this.hostCoefficients().map((value) => value.toString()),
    };
  }

  toSnapshot(): ZkCryptoSnapshot {
    return {
      handNumPlayers: this.handNumPlayers,
      elGamalPublicKeys: this.#players.map((key) => publicKeyToStrings(key)),
      finalDeck: this.#finalDeck.map((card) => card.map((coord) => coord.toString())),
      dealCardCount: dealCardCount(this.handNumPlayers),
    };
  }
}
