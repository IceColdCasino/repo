import type { Ciphertext } from '../zk-casino';
import { RescueCipher, x25519, deserializeLE, serializeLE } from '@arcium-hq/client';
import type { TableEncryptionKey } from '../bet-encryption';
import { sumPoseidon4Groups } from '../poseidon4';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
import { hashDeck900 } from '../hash-coeffs';
import { partialRowForRecipient, usedCardIndices } from '../backend/card-layout';

/** Casino share: War=11×4, Baccarat=11×6, Roulette=11×1 (recipient-major). */
export const CASINO_N_OTHERS = 11;
/** Blackjack `ShareHashOut(8,16)`: 7 others × 16 cards. */
export const BLACKJACK_N_OTHERS = 7;
export const BLACKJACK_CHUNK_CARDS = 16;

/**
 * Card-major row width. Must match on-chain `VERIFY_CHUNK_LEN`.
 * One row = 36 BN254 limbs (9 recipients × 4).
 */
export const VERIFY_CHUNK_LEN = 36;
/**
 * Limbs per reveal job and per share-verify job. Must match on-chain
 * `VERIFY_FOLD_LEN`. Each job is one Poseidon(4) so the MXE can run the
 * chunks in parallel.
 */
export const VERIFY_FOLD_LEN = 4;
export const VERIFY_NUM_CHUNKS = 900 / VERIFY_CHUNK_LEN; // 25
export const CARD_PARTIAL_STRIDE = 36;
export const N_OTHERS = 9;
export const N_CARDS = 25;
export const LIMBS_PER_PARTIAL = 4;

export type EncryptedStagingRow = {
  cardIndex: number;
  startIndex: number;
  ciphertexts: Uint8Array[];
};

export type RecipientMajorVerifyChunk = {
  startIndex: number;
  limbCount: number;
};

export type EncryptedRecipientMajorRow = RecipientMajorVerifyChunk & {
  ciphertexts: Uint8Array[];
};

/** Big-endian 32-byte encoding of a BN254 field element (matches Arcis byte layout). */
export function bn254ToCommitmentBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/**
 * Flatten share ciphertexts to 900 BN254 values.
 * Layout: [nOthers≤9][nCards][4] — each slot is a partial sealed (re-encrypted)
 * to one other player, matching Poker.computeShareOutputHash / Circom Share.
 */
export function flattenShareCiphertexts(ciphertexts: Ciphertext[][]): bigint[] {
  const values: bigint[] = [];
  for (const playerCiphertexts of ciphertexts) {
    for (const ct of playerCiphertexts) {
      values.push(...ct);
    }
  }
  if (values.length !== 900) {
    throw new Error(`Expected 900 BN254 share values, got ${values.length}`);
  }
  return values;
}

/**
 * Transpose recipient-major `[r][c][4]` (r*100 + c*4 + k) to card-major
 * `[c][r][4]` (c*36 + r*4 + k) for per-card Arcis verify/reveal chunks.
 */
export function toCardMajorShareValues(recipientMajor: bigint[]): bigint[] {
  if (recipientMajor.length !== 900) {
    throw new Error(`Expected 900 values, got ${recipientMajor.length}`);
  }
  const out = new Array<bigint>(900);
  for (let r = 0; r < N_OTHERS; r++) {
    for (let c = 0; c < N_CARDS; c++) {
      for (let k = 0; k < LIMBS_PER_PARTIAL; k++) {
        out[c * CARD_PARTIAL_STRIDE + r * LIMBS_PER_PARTIAL + k] =
          recipientMajor[r * (N_CARDS * LIMBS_PER_PARTIAL) + c * LIMBS_PER_PARTIAL + k]!;
      }
    }
  }
  return out;
}

/**
 * Build the 2-player reveal row from both sharers.
 *
 * Each destination section is owned by its recipient:
 * `[card][recipient][other-sharer][4 limbs]`. For two players this places
 * player 0's section at limbs 0..3 and player 1's at limbs 4..7.
 */
export function toTwoPlayerRecipientCardMajorShareValues(
  sharesBySharer: Ciphertext[][][],
): bigint[] {
  if (sharesBySharer.length !== 2) {
    throw new Error(`Expected shares for 2 sharers, got ${sharesBySharer.length}`);
  }
  const out = Array<bigint>(N_CARDS * CARD_PARTIAL_STRIDE).fill(0n);
  for (let recipient = 0; recipient < 2; recipient++) {
    const sharer = 1 - recipient;
    const sharerRows = sharesBySharer[sharer];
    if (!sharerRows || sharerRows.length !== N_OTHERS) {
      throw new Error(`Missing fixed-width share rows for sharer ${sharer}`);
    }
    // shareOthersForPlayer removes the sharer's own key. With two players the
    // other active recipient is always row zero.
    const recipientRow = sharerRows[0]!;
    for (let card = 0; card < N_CARDS; card++) {
      const partial = recipientRow[card];
      if (!partial || partial.length !== LIMBS_PER_PARTIAL) {
        throw new Error(`Missing share sharer=${sharer} recipient=${recipient} card=${card}`);
      }
      const dest = card * CARD_PARTIAL_STRIDE + recipient * LIMBS_PER_PARTIAL;
      for (let limb = 0; limb < LIMBS_PER_PARTIAL; limb++) {
        out[dest + limb] = partial[limb]!;
      }
    }
  }
  return out;
}

/**
 * Build one recipient's 36-limb card rows for an N-player reveal.
 *
 * A 10-player row is completely occupied by the nine other sharers, so unlike
 * the compact two-player fixture, different recipients cannot coexist in one
 * row. Callers overwrite the requested card rows before revealing to a new
 * recipient.
 */
export function toRecipientCardMajorShareValues(
  sharesBySharer: Ciphertext[][][],
  nActualPlayers: number,
  recipient: number,
): bigint[] {
  if (!Number.isInteger(nActualPlayers) || nActualPlayers < 2 || nActualPlayers > 10) {
    throw new Error(`nActualPlayers must be 2..10, got ${nActualPlayers}`);
  }
  if (sharesBySharer.length !== nActualPlayers) {
    throw new Error(`Expected shares for ${nActualPlayers} sharers, got ${sharesBySharer.length}`);
  }
  if (!Number.isInteger(recipient) || recipient < 0 || recipient >= nActualPlayers) {
    throw new Error(`recipient must be in 0..${nActualPlayers - 1}, got ${recipient}`);
  }

  const out = Array<bigint>(N_CARDS * CARD_PARTIAL_STRIDE).fill(0n);
  for (let sharer = 0; sharer < nActualPlayers; sharer++) {
    if (sharer === recipient) continue;
    const sourceRow = partialRowForRecipient(sharer, recipient);
    const recipientRow = sharesBySharer[sharer]?.[sourceRow];
    if (!recipientRow || recipientRow.length !== N_CARDS) {
      throw new Error(`Missing share row sharer=${sharer} recipient=${recipient}`);
    }
    const destinationSharer = sharer < recipient ? sharer : sharer - 1;
    for (let card = 0; card < N_CARDS; card++) {
      const partial = recipientRow[card];
      if (!partial || partial.length !== LIMBS_PER_PARTIAL) {
        throw new Error(`Missing share sharer=${sharer} recipient=${recipient} card=${card}`);
      }
      const dest =
        card * CARD_PARTIAL_STRIDE + destinationSharer * LIMBS_PER_PARTIAL;
      for (let limb = 0; limb < LIMBS_PER_PARTIAL; limb++) {
        out[dest + limb] = partial[limb]!;
      }
    }
  }
  return out;
}

/** Convert 900 BN254 values to 32-byte big-endian commitments. */
export function shareValuesToCommitments(values: bigint[]): Uint8Array[] {
  if (values.length !== 900) {
    throw new Error(`Expected 900 values, got ${values.length}`);
  }
  return values.map(bn254ToCommitmentBytes);
}

/** Inverse of flattenShareCiphertexts — 900 limbs → `[9][25][4]`. */
export function unflattenShareCiphertexts(values: bigint[]): Ciphertext[][] {
  if (values.length !== 900) {
    throw new Error(`Expected 900 values, got ${values.length}`);
  }
  const out: Ciphertext[][] = [];
  let i = 0;
  for (let r = 0; r < N_OTHERS; r++) {
    const row: Ciphertext[] = [];
    for (let c = 0; c < N_CARDS; c++) {
      row.push([
        values[i]!,
        values[i + 1]!,
        values[i + 2]!,
        values[i + 3]!,
      ] as Ciphertext);
      i += LIMBS_PER_PARTIAL;
    }
    out.push(row);
  }
  return out;
}

function pushFolds(
  chunks: RecipientMajorVerifyChunk[],
  startIndex: number,
  limbCount: number,
): void {
  if (limbCount % VERIFY_FOLD_LEN !== 0) {
    throw new Error(`limbCount ${limbCount} must be a multiple of ${VERIFY_FOLD_LEN}`);
  }
  let offset = 0;
  while (offset < limbCount) {
    chunks.push({ startIndex: startIndex + offset, limbCount: VERIFY_FOLD_LEN });
    offset += VERIFY_FOLD_LEN;
  }
}

/**
 * Absolute recipient-major share folds. Coefficients are addressed as
 * Each Arcis job decrypts 4 limbs. Two-player holes are
 * `{0..16}` and community is `{80..100}`. Ten-player rows are 100 contiguous limbs.
 */
export function recipientMajorVerifyChunks(nActualPlayers: number): RecipientMajorVerifyChunk[] {
  if (!Number.isInteger(nActualPlayers) || nActualPlayers < 2 || nActualPlayers > 10) {
    throw new Error(`nActualPlayers must be 2..10, got ${nActualPlayers}`);
  }
  const chunks: RecipientMajorVerifyChunk[] = [];
  if (nActualPlayers === 10) {
    for (let r = 0; r < N_OTHERS; r++) {
      const rowStart = r * N_CARDS * LIMBS_PER_PARTIAL;
      pushFolds(chunks, rowStart, 100);
    }
    return chunks;
  }
  const holeLimbCount = 2 * nActualPlayers * LIMBS_PER_PARTIAL;
  for (let r = 0; r < nActualPlayers - 1; r++) {
    const rowStart = r * N_CARDS * LIMBS_PER_PARTIAL;
    pushFolds(chunks, rowStart, holeLimbCount);
    pushFolds(chunks, rowStart + 20 * LIMBS_PER_PARTIAL, 5 * LIMBS_PER_PARTIAL);
  }
  return chunks;
}

/**
 * Rescue-encrypt recipient-major share chunks for the per-player share staging
 * PDA. Each row is one Rescue batch of 4 limbs under
 * `nonce = base + startIndex`.
 */
export function encryptRecipientMajorRowsForStaging(
  tableKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  recipientMajorValues: bigint[],
  nActualPlayers: number,
): { rows: EncryptedRecipientMajorRow[]; nonce: bigint; arcisHash: bigint } {
  if (recipientMajorValues.length !== 900) {
    throw new Error(`Expected 900 values, got ${recipientMajorValues.length}`);
  }
  const sharedSecret = x25519.getSharedSecret(tableKey.privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  let baseNonce = deserializeLE(randomBytes(16));
  const maxBase = (1n << 128n) - 900n;
  if (baseNonce >= maxBase) baseNonce %= maxBase;

  const rows = recipientMajorVerifyChunks(nActualPlayers).map(
    ({ startIndex, limbCount }): EncryptedRecipientMajorRow => {
      const plaintexts = Array.from(
        { length: limbCount },
        (_, j) => recipientMajorValues[startIndex + j]!,
      );
      const enc = cipher.encrypt(
        plaintexts,
        serializeLE(baseNonce + BigInt(startIndex), 16),
      );
      return {
        startIndex,
        limbCount,
        ciphertexts: enc.map((ct) =>
          ct instanceof Uint8Array ? ct : new Uint8Array(ct as ArrayLike<number>)
        ),
      };
    },
  );
  // Share Arcis decrypts each batch and reveals a zero contribution.
  return { rows, nonce: baseNonce, arcisHash: 0n };
}

/**
 * Rescue-encrypt 900 plaintext commitments for DeckStaging.
 *
 * Arcis decrypts `VERIFY_FOLD_LEN` (4) ciphertexts per call with
 * `chunk_nonce = base_nonce + slice_start`. A card row is nine of those batches.
 */
export function encryptCommitmentsForStaging(
  tableKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  commitments: Uint8Array[],
  nActualPlayers = 10,
): { ciphertexts: Uint8Array[]; nonce: bigint; expectedHash: bigint } {
  const { rows, nonce, expectedHash } = encryptCommitmentRowsForStaging(
    tableKey,
    mxePublicKey,
    commitments,
    Array.from({ length: N_CARDS }, (_, cardIndex) => cardIndex),
    nActualPlayers,
  );
  return {
    ciphertexts: rows.flatMap((row) => row.ciphertexts),
    nonce,
    expectedHash,
  };
}

/**
 * Rescue-encrypt only selected card rows while preserving absolute 900-limb
 * offsets and nonces. The expected hash still covers every active shared-card
 * row for the hand; sparse staging does not weaken the verification target.
 */
export function encryptCommitmentRowsForStaging(
  tableKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  commitments: Uint8Array[],
  cardIndices: number[],
  nActualPlayers = 10,
  /** When set (e.g. derived tableKey.nonceBase), peers can re-derive without disk. */
  fixedBaseNonce?: bigint,
): { rows: EncryptedStagingRow[]; nonce: bigint; expectedHash: bigint } {
  if (commitments.length !== 900) {
    throw new Error(`Expected 900 commitments, got ${commitments.length}`);
  }
  const uniqueCards = [...new Set(cardIndices)];
  if (
    uniqueCards.length !== cardIndices.length
    || uniqueCards.some((cardIndex) => !Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= N_CARDS)
  ) {
    throw new Error(`cardIndices must contain unique integers in 0..${N_CARDS - 1}`);
  }
  const expectedHash = hashDeck900(commitments, nActualPlayers);
  const sharedSecret = x25519.getSharedSecret(tableKey.privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);

  let baseNonce = fixedBaseNonce ?? deserializeLE(randomBytes(16));
  const maxBase = (1n << 128n) - 900n;
  if (baseNonce >= maxBase) baseNonce %= maxBase;

  // Each 4-limb slice is its own Rescue CTR batch (`base_nonce + slice_start`).
  const grouped: bigint[][] = [];
  const rows = uniqueCards.map((cardIndex): EncryptedStagingRow => {
    const startIndex = cardIndex * VERIFY_CHUNK_LEN;
    const ciphertexts: Uint8Array[] = [];
    for (let offset = 0; offset < VERIFY_CHUNK_LEN; offset += VERIFY_FOLD_LEN) {
      const plaintexts = commitments
        .slice(startIndex + offset, startIndex + offset + VERIFY_FOLD_LEN)
        .map((commitment) => {
          let value = 0n;
          for (let i = 0; i < 32; i++) value = (value << 8n) + BigInt(commitment[i]!);
          return value;
        });
      grouped.push(plaintexts);
      const nb = serializeLE(baseNonce + BigInt(startIndex + offset), 16);
      const enc = cipher.encrypt(plaintexts, nb);
      for (const ct of enc) {
        ciphertexts.push(ct instanceof Uint8Array ? ct : new Uint8Array(ct as ArrayLike<number>));
      }
    }
    return { cardIndex, startIndex, ciphertexts };
  });

  return { rows, nonce: baseNonce, expectedHash, arcisHash: poseidonSum(grouped) };
}

/** Wrapping sum of Poseidon(4) over the 4-limb groups inside these plaintexts. */
function poseidonSum(plaintexts: readonly (readonly bigint[])[]): bigint {
  const groups: bigint[][] = [];
  for (const row of plaintexts) {
    for (let j = 0; j < row.length; j += 4) {
      groups.push(row.slice(j, j + 4));
    }
  }
  return sumPoseidon4Groups(groups);
}

export function splitHashHalves(hash: bigint): { low: bigint; high: bigint } {
  return {
    low: hash & ((1n << 128n) - 1n),
    high: hash >> 128n,
  };
}

/** Fold start indices for used cards only (holes + board), 4 limbs each. */
export function verifyChunkStarts(nActualPlayers = 10): number[] {
  const active = (nActualPlayers - 1) * LIMBS_PER_PARTIAL;
  const starts: number[] = [];
  for (const card of usedCardIndices(nActualPlayers)) {
    const row = card * VERIFY_CHUNK_LEN;
    for (let offset = 0; offset < active; offset += VERIFY_FOLD_LEN) {
      starts.push(row + offset);
    }
  }
  return starts;
}

/**
 * Flatten casino share ciphertexts: `[nOthersMax][nCards][4]` → contiguous limbs.
 * War=176, Baccarat=264, Roulette=44.
 */
export function flattenCasinoShareCiphertexts(
  ciphertexts: Ciphertext[][],
  nCards: number,
  nOthersMax = CASINO_N_OTHERS,
): bigint[] {
  const expected = nOthersMax * nCards * LIMBS_PER_PARTIAL;
  const values: bigint[] = [];
  for (const playerCiphertexts of ciphertexts) {
    for (const ct of playerCiphertexts) {
      values.push(...ct);
    }
  }
  if (values.length !== expected) {
    throw new Error(
      `Expected ${expected} casino share limbs (others=${nOthersMax} cards=${nCards}), got ${values.length}`,
    );
  }
  return values;
}

/** Contiguous Arcis folds from offset 0 (matches `share_verify_limb_count_for_cards`). */
export function contiguousShareVerifyChunks(
  nActualPlayers: number,
  nCards: number,
): RecipientMajorVerifyChunk[] {
  if (!Number.isInteger(nActualPlayers) || nActualPlayers < 2 || nActualPlayers > 12) {
    throw new Error(`nActualPlayers must be 2..12, got ${nActualPlayers}`);
  }
  if (!Number.isInteger(nCards) || nCards < 1) {
    throw new Error(`nCards must be >= 1, got ${nCards}`);
  }
  const target = (nActualPlayers - 1) * nCards * LIMBS_PER_PARTIAL;
  if (target > 900) {
    throw new Error(`active limb count ${target} exceeds staging capacity 900`);
  }
  const chunks: RecipientMajorVerifyChunk[] = [];
  pushFolds(chunks, 0, target);
  return chunks;
}

/**
 * Rescue-encrypt contiguous casino share limbs into 4-limb Arcis batches.
 * Values are padded to 900 for the staging PDA. Arcis decrypts the active
 * batches; it does not hash them.
 */
export function encryptContiguousShareForStaging(
  tableKey: TableEncryptionKey,
  mxePublicKey: Uint8Array,
  recipientMajorValues: bigint[],
  nActualPlayers: number,
  nCards: number,
  nOthersMax = CASINO_N_OTHERS,
): { rows: EncryptedRecipientMajorRow[]; nonce: bigint; arcisHash: bigint } {
  const expectedLen = nOthersMax * nCards * LIMBS_PER_PARTIAL;
  if (recipientMajorValues.length !== expectedLen) {
    throw new Error(
      `Expected ${expectedLen} casino share values, got ${recipientMajorValues.length}`,
    );
  }
  const sharedSecret = x25519.getSharedSecret(tableKey.privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  let baseNonce = deserializeLE(randomBytes(16));
  const maxBase = (1n << 128n) - 900n;
  if (baseNonce >= maxBase) baseNonce %= maxBase;

  const padded = Array<bigint>(900).fill(0n);
  for (let i = 0; i < recipientMajorValues.length; i++) {
    padded[i] = recipientMajorValues[i]!;
  }

  const rows = contiguousShareVerifyChunks(nActualPlayers, nCards).map(
    ({ startIndex, limbCount }): EncryptedRecipientMajorRow => {
      const plaintexts = Array.from(
        { length: limbCount },
        (_, j) => padded[startIndex + j]!,
      );
      const enc = cipher.encrypt(
        plaintexts,
        serializeLE(baseNonce + BigInt(startIndex), 16),
      );
      return {
        startIndex,
        limbCount,
        ciphertexts: enc.map((ct) =>
          ct instanceof Uint8Array ? ct : new Uint8Array(ct as ArrayLike<number>),
        ),
      };
    },
  );
  return { rows, nonce: baseNonce, arcisHash: 0n };
}

/**
 * 2-player casino card-major reveal rows in the 900-limb staging buffer.
 * Layout matches poker reveal (`card * 36 + recipient * 4`); only `nCards` rows
 * are populated (war=4, baccarat=6, roulette=1).
 */
export function toTwoPlayerCasinoCardMajorShareValues(
  sharesBySharer: Ciphertext[][][],
  nCards: number,
  nOthersMax = CASINO_N_OTHERS,
): bigint[] {
  if (sharesBySharer.length !== 2) {
    throw new Error(`Expected shares for 2 sharers, got ${sharesBySharer.length}`);
  }
  const out = Array<bigint>(N_CARDS * CARD_PARTIAL_STRIDE).fill(0n);
  for (let recipient = 0; recipient < 2; recipient++) {
    const sharer = 1 - recipient;
    const sharerRows = sharesBySharer[sharer];
    if (!sharerRows || sharerRows.length !== nOthersMax) {
      throw new Error(
        `Missing casino share rows for sharer ${sharer} (expected ${nOthersMax})`,
      );
    }
    const recipientRow = sharerRows[0]!;
    if (!recipientRow || recipientRow.length !== nCards) {
      throw new Error(
        `Missing casino share cards sharer=${sharer} (expected ${nCards})`,
      );
    }
    for (let card = 0; card < nCards; card++) {
      const partial = recipientRow[card]!;
      const dest = card * CARD_PARTIAL_STRIDE + recipient * LIMBS_PER_PARTIAL;
      for (let limb = 0; limb < LIMBS_PER_PARTIAL; limb++) {
        out[dest + limb] = partial[limb]!;
      }
    }
  }
  return out;
}
