import { x25519, deserializeLE } from '@arcium-hq/client';

export type MpcKeyPurpose = 'bet' | 'share' | 'reveal' | 'showdown';

export const MPC_KEY_PURPOSE_CODE: Record<MpcKeyPurpose, number> = {
  bet: 0,
  share: 1,
  reveal: 2,
  showdown: 3,
};

export interface MpcKeyRecord {
  gameIdHex: string;
  playerIndex: number;
  purpose: MpcKeyPurpose;
  generation: bigint;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  nonceBase: bigint;
}

export interface MpcKeyStore {
  create(
    gameId: Uint8Array,
    playerIndex: number,
    purpose: MpcKeyPurpose,
  ): Promise<MpcKeyRecord>;
  get(
    gameId: Uint8Array,
    playerIndex: number,
    purpose: MpcKeyPurpose,
    generation: bigint,
  ): Promise<MpcKeyRecord | null>;
  deleteHand(gameId: Uint8Array): Promise<void>;
}

function gameIdHex(gameId: Uint8Array): string {
  if (gameId.length !== 32) {
    throw new Error(`gameId must be 32 bytes, got ${gameId.length}`);
  }
  return Buffer.from(gameId).toString('hex');
}

function recordKey(
  gameIdHexValue: string,
  playerIndex: number,
  purpose: MpcKeyPurpose,
  generation: bigint,
): string {
  return `${gameIdHexValue}:${playerIndex}:${purpose}:${generation.toString()}`;
}

function randomNonceBase(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return deserializeLE(bytes);
}

/** In-memory store for tests and process-local gameplay. */
export class InMemoryMpcKeyStore implements MpcKeyStore {
  readonly #records = new Map<string, MpcKeyRecord>();
  readonly #generations = new Map<string, bigint>();

  async create(
    gameId: Uint8Array,
    playerIndex: number,
    purpose: MpcKeyPurpose,
  ): Promise<MpcKeyRecord> {
    if (playerIndex < 0 || playerIndex > 255) {
      throw new Error(`invalid playerIndex ${playerIndex}`);
    }
    const hex = gameIdHex(gameId);
    const genKey = `${hex}:${playerIndex}:${purpose}`;
    const previous = this.#generations.get(genKey) ?? -1n;
    const generation = previous + 1n;
    this.#generations.set(genKey, generation);

    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    if (publicKey.every((b) => b === 0)) {
      throw new Error('rejected all-zero MPC public key');
    }

    const record: MpcKeyRecord = {
      gameIdHex: hex,
      playerIndex,
      purpose,
      generation,
      publicKey,
      privateKey,
      nonceBase: randomNonceBase(),
    };
    this.#records.set(recordKey(hex, playerIndex, purpose, generation), record);
    return {
      ...record,
      publicKey: new Uint8Array(record.publicKey),
      privateKey: new Uint8Array(record.privateKey),
    };
  }

  async get(
    gameId: Uint8Array,
    playerIndex: number,
    purpose: MpcKeyPurpose,
    generation: bigint,
  ): Promise<MpcKeyRecord | null> {
    const hex = gameIdHex(gameId);
    const found = this.#records.get(recordKey(hex, playerIndex, purpose, generation));
    if (!found) return null;
    return {
      ...found,
      publicKey: new Uint8Array(found.publicKey),
      privateKey: new Uint8Array(found.privateKey),
    };
  }

  async deleteHand(gameId: Uint8Array): Promise<void> {
    const hex = gameIdHex(gameId);
    for (const key of [...this.#records.keys()]) {
      if (key.startsWith(`${hex}:`)) this.#records.delete(key);
    }
    for (const key of [...this.#generations.keys()]) {
      if (key.startsWith(`${hex}:`)) this.#generations.delete(key);
    }
  }
}

/** Convert a store record into the legacy TableEncryptionKey shape used by Rescue helpers. */
export function tableKeyFromRecord(record: MpcKeyRecord): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  nonceBase: bigint;
} {
  return {
    publicKey: new Uint8Array(record.publicKey),
    privateKey: new Uint8Array(record.privateKey),
    nonceBase: record.nonceBase,
  };
}
