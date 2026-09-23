/**
 * Native Zig player via `window.zero.invoke('player')`.
 * One command. Keygen, decrypt, and Groth16 stay in Zig — not circomlibjs / bun:ffi.
 */
import type { Ciphertext, PlayerKey, PrivateKey, PublicKey } from './zk-casino';

type ZeroInvoke = {
  invoke: <T>(command: string, payload?: unknown) => Promise<T>;
};

function zero(): ZeroInvoke | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const win = globalThis as { window?: { zero?: ZeroInvoke } };
  return win.window?.zero ?? (globalThis as { zero?: ZeroInvoke }).zero;
}

export function hasPlayerBridge(): boolean {
  return typeof zero()?.invoke === 'function';
}

function asPrivateKey(n: bigint): PrivateKey {
  return n as PrivateKey;
}

function asPublicKey(xy: [bigint, bigint]): PublicKey {
  return xy as PublicKey;
}

function asCiphertext(ct: [bigint, bigint, bigint, bigint]): Ciphertext {
  return ct as Ciphertext;
}

function dec(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function decPair(value: unknown): [bigint, bigint] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('expected [x, y] decimal pair');
  }
  return [dec(value[0] as string), dec(value[1] as string)];
}

function decCt(value: unknown): Ciphertext {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('expected 4-limb ciphertext');
  }
  return asCiphertext([
    dec(value[0] as string),
    dec(value[1] as string),
    dec(value[2] as string),
    dec(value[3] as string),
  ]);
}

function encFr(value: bigint | number | string): string {
  return typeof value === 'string' ? value : value.toString();
}

function encPoint(point: readonly [bigint, bigint] | PublicKey): [string, string] {
  return [encFr(point[0]!), encFr(point[1]!)];
}

function encCt(ct: Ciphertext): [string, string, string, string] {
  return [encFr(ct[0]), encFr(ct[1]), encFr(ct[2]), encFr(ct[3])];
}

type PlayerResult = Record<string, unknown> & { ok?: boolean; error?: string };

export type PlayerInvoke = (payload: Record<string, unknown>) => PlayerResult | Promise<PlayerResult>;

export type ShuffleExtras = {
  reels?: Ciphertext[][];
};

export type ShareExtras = {
  coinBet?: number;
};

export type ShowdownBridgeInput = {
  publicKeys: PublicKey[];
  cards: Ciphertext[];
  partials: Ciphertext[][];
  privateKey?: PrivateKey | bigint;
  prove?: boolean;
  coefficients?: bigint[];
  potMasks?: bigint[];
  playerIndex?: number;
  ciphertextBets?: Ciphertext[];
  bets?: Array<readonly [number, number]>;
  nActualBets?: number;
  spots?: number[];
  cells?: number[];
  ciphertextCardCells?: Ciphertext[];
  nCalled?: number;
  patternId?: number;
  phase?: number;
  point?: number;
  ciphertextBet?: Ciphertext;
  coinBet?: number;
  plaintextCards?: Array<bigint | number>;
  playerCardCount?: number;
  dealerCardCount?: number;
};

export type ShowdownBridgeResult = {
  proof?: object;
  publicSignals?: string[];
  publicKey: PublicKey;
  winnerMasks?: bigint[];
  coefficientCommitment?: bigint;
  winner?: bigint;
  plaintextCards?: bigint[];
  matches?: number;
};

export type PlayerSession = {
  invoke: PlayerInvoke;
  close: () => void;
  ping: () => Promise<{ ok: boolean; backend?: string; game?: string }>;
  key: (privateKey?: PrivateKey | bigint) => Promise<{ key: PlayerKey; padding: Ciphertext }>;
  register: (privateKey?: PrivateKey | bigint) => Promise<{
    proof: object;
    publicSignals: string[];
    key: PlayerKey;
    padding: Ciphertext;
  }>;
  shuffle: (
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    privateKey?: PrivateKey | bigint,
    extras?: ShuffleExtras,
  ) => Promise<{
    proof: object;
    publicSignals: string[];
    deck: Ciphertext[];
    permutationHash: bigint;
    dice?: Ciphertext[][];
    reels?: Ciphertext[][];
  }>;
  share: (
    deck: Ciphertext[],
    publicKeys: PublicKey[],
    nActualPlayers: number,
    privateKey?: PrivateKey | bigint,
    extras?: ShareExtras,
  ) => Promise<{
    proof: object;
    publicSignals: string[];
    ciphertexts: Ciphertext[][];
    coinBet?: number;
  }>;
  showdown: (input: ShowdownBridgeInput) => Promise<ShowdownBridgeResult>;
  decrypt: (
    cards: Ciphertext[],
    partials?: Ciphertext[][],
    privateKey?: PrivateKey | bigint,
  ) => Promise<number[]>;
  bet: (input: {
    house: PublicKey;
    bets?: Array<readonly [number, number]>;
    spots?: number[];
    privateKey?: PrivateKey | bigint;
  }) => Promise<{
    proof: object;
    publicSignals: string[];
    nActualBets: number;
  }>;
  action: (input: {
    publicKeys: PublicKey[];
    cards: Ciphertext[];
    partials: Ciphertext[][];
    sourceIndices: number[];
    cardCount?: number;
    canSplit?: boolean;
    hitSoft17?: boolean;
    isDealer?: boolean;
    coefficients?: bigint[];
    privateKey?: PrivateKey | bigint;
  }) => Promise<{
    proof: object;
    publicSignals: string[];
    status: number;
    publicKey: PublicKey;
  }>;
  card: (cells: number[], privateKey?: PrivateKey | bigint) => Promise<{
    proof: object;
    publicSignals: string[];
  }>;
};

function unwrapResult(result: PlayerResult): PlayerResult {
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    throw new Error(result.error);
  }
  if (result?.ok === false) {
    throw new Error('player failed');
  }
  return result;
}

async function playerWith(invoke: PlayerInvoke, payload: Record<string, unknown>): Promise<PlayerResult> {
  return unwrapResult(await invoke(payload));
}

function playerSyncWith(invoke: PlayerInvoke, payload: Record<string, unknown>): PlayerResult {
  const result = invoke(payload);
  if (result instanceof Promise) {
    throw new Error('Use the async player method — this backend is not synchronous');
  }
  return unwrapResult(result);
}

async function player(payload: Record<string, unknown>): Promise<PlayerResult> {
  const invoke = zero()?.invoke;
  if (!invoke) {
    throw new Error('player bridge is not available');
  }
  return playerWith((body) => invoke('player', body), payload);
}

export function createPlayerSession(invoke: PlayerInvoke, close: () => void = () => {}): PlayerSession {
  const call = (payload: Record<string, unknown>) => playerWith(invoke, payload);
  return {
    invoke,
    close,
    ping: async () => {
      const result = await call({ op: 'ping' });
      return {
        ok: result.ok === true,
        backend: typeof result.backend === 'string' ? result.backend : undefined,
        game: typeof result.game === 'string' ? result.game : undefined,
      };
    },
    key: async (privateKey?: PrivateKey | bigint) => parseKey(await call({
      op: 'key',
      ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
    })),
    register: async (privateKey?: PrivateKey | bigint) => {
      const result = await call({
        op: 'register',
        ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
      });
      return { ...parseProof(result), ...parseKey(result) };
    },
    shuffle: async (deck, publicKeys, privateKey, extras) => {
      const result = await call({
        op: 'shuffle',
        ...(extras?.reels
          ? { reels: extras.reels.map((row) => row.map(encCt)) }
          : { deck: deck.map(encCt) }),
        publicKeys: publicKeys.map(encPoint),
        ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
      });
      return {
        ...parseProof(result),
        deck: result.deck ? (result.deck as unknown[]).map(decCt) : [],
        permutationHash: result.permutationHash !== undefined ? dec(result.permutationHash as string) : 0n,
        ...(result.dice ? { dice: decCtGrid(result.dice) } : {}),
        ...(result.reels ? { reels: decCtGrid(result.reels) } : {}),
      };
    },
    share: async (deck, publicKeys, nActualPlayers, privateKey, extras) => {
      const result = await call({
        op: 'share',
        deck: deck.map(encCt),
        publicKeys: publicKeys.map(encPoint),
        nActualPlayers: encFr(nActualPlayers),
        ...(extras?.coinBet !== undefined ? { coinBet: encFr(extras.coinBet) } : {}),
        ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
      });
      return {
        ...parseProof(result),
        ciphertexts: decCtGrid(result.ciphertexts),
        ...(result.coinBet !== undefined ? { coinBet: Number(dec(result.coinBet as string)) } : {}),
      };
    },
    showdown: async (input) => {
      const result = await call({
        op: 'showdown',
        publicKeys: input.publicKeys.map(encPoint),
        cards: input.cards.map(encCt),
        partials: input.partials.map((row) => row.map(encCt)),
        prove: input.prove !== false,
        ...(input.potMasks ? { potMasks: input.potMasks.map(encFr) } : {}),
        ...(input.playerIndex !== undefined ? { playerIndex: encFr(input.playerIndex) } : {}),
        ...(input.coefficients ? { coefficients: input.coefficients.map(encFr) } : {}),
        ...(input.privateKey !== undefined ? { privateKey: encFr(input.privateKey) } : {}),
        ...(input.ciphertextBets ? { ciphertextBets: input.ciphertextBets.map(encCt) } : {}),
        ...(input.bets ? { bets: input.bets.map((b) => [encFr(b[0]), encFr(b[1])]) } : {}),
        ...(input.nActualBets !== undefined ? { nActualBets: encFr(input.nActualBets) } : {}),
        ...(input.spots ? { spots: input.spots.map(encFr) } : {}),
        ...(input.cells ? { cells: input.cells.map(encFr) } : {}),
        ...(input.ciphertextCardCells ? { ciphertextCardCells: input.ciphertextCardCells.map(encCt) } : {}),
        ...(input.nCalled !== undefined ? { nCalled: encFr(input.nCalled) } : {}),
        ...(input.patternId !== undefined ? { patternId: encFr(input.patternId) } : {}),
        ...(input.phase !== undefined ? { phase: encFr(input.phase) } : {}),
        ...(input.point !== undefined ? { point: encFr(input.point) } : {}),
        ...(input.ciphertextBet ? { ciphertextBet: encCt(input.ciphertextBet) } : {}),
        ...(input.coinBet !== undefined ? { coinBet: encFr(input.coinBet) } : {}),
        ...(input.plaintextCards ? { plaintextCards: input.plaintextCards.map(encFr) } : {}),
        ...(input.playerCardCount !== undefined ? { playerCardCount: encFr(input.playerCardCount) } : {}),
        ...(input.dealerCardCount !== undefined ? { dealerCardCount: encFr(input.dealerCardCount) } : {}),
      });
      const proved = input.prove !== false ? parseProof(result) : {};
      return {
        ...proved,
        publicKey: asPublicKey(decPair(result.publicKey)),
        ...(result.winnerMasks ? { winnerMasks: (result.winnerMasks as string[]).map(dec) } : {}),
        ...(result.coefficientCommitment !== undefined
          ? { coefficientCommitment: dec(result.coefficientCommitment as string) }
          : {}),
        ...(result.winner !== undefined ? { winner: dec(result.winner as string) } : {}),
        ...(result.plaintextCards ? { plaintextCards: (result.plaintextCards as string[]).map(dec) } : {}),
        ...(result.matches !== undefined ? { matches: Number(dec(result.matches as string)) } : {}),
      };
    },
    decrypt: async (cards, partials, privateKey) => {
      const result = await call({
        op: 'decrypt',
        cards: cards.map(encCt),
        ...(partials ? { partials: partials.map((row) => row.map(encCt)) } : {}),
        ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
      });
      return (result.cardIndices as string[]).map((value) => Number(dec(value)));
    },
    bet: async (input) => {
      const result = await call({
        op: 'bet',
        house: encPoint(input.house),
        ...(input.bets ? { bets: input.bets.map((b) => [encFr(b[0]), encFr(b[1])]) } : {}),
        ...(input.spots ? { spots: input.spots.map(encFr) } : {}),
        ...(input.privateKey !== undefined ? { privateKey: encFr(input.privateKey) } : {}),
      });
      return {
        ...parseProof(result),
        nActualBets: Number(dec(result.nActualBets as string)),
      };
    },
    action: async (input) => {
      const result = await call({
        op: 'action',
        publicKeys: input.publicKeys.map(encPoint),
        cards: input.cards.map(encCt),
        partials: input.partials.map((row) => row.map(encCt)),
        sourceIndices: input.sourceIndices.map(encFr),
        ...(input.cardCount !== undefined ? { cardCount: encFr(input.cardCount) } : {}),
        ...(input.canSplit !== undefined ? { canSplit: input.canSplit } : {}),
        ...(input.hitSoft17 !== undefined ? { hitSoft17: input.hitSoft17 } : {}),
        ...(input.isDealer !== undefined ? { isDealer: input.isDealer } : {}),
        ...(input.coefficients ? { coefficients: input.coefficients.map(encFr) } : {}),
        ...(input.privateKey !== undefined ? { privateKey: encFr(input.privateKey) } : {}),
      });
      return {
        ...parseProof(result),
        status: Number(dec(result.status as string)),
        publicKey: asPublicKey(decPair(result.publicKey)),
      };
    },
    card: async (cells, privateKey) => {
      const result = await call({
        op: 'card',
        cells: cells.map(encFr),
        ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
      });
      return parseProof(result);
    },
  };
}

function decCtGrid(value: unknown): Ciphertext[][] {
  if (!Array.isArray(value)) {
    throw new Error('expected ciphertext grid');
  }
  return value.map((row) => (row as unknown[]).map(decCt));
}

export function openWindowSession(): PlayerSession {
  const invoke = zero()?.invoke;
  if (!invoke) {
    throw new Error('player bridge is not available');
  }
  return createPlayerSession((payload) => invoke('player', payload));
}

export function showdownPreviewSync(
  session: PlayerSession,
  input: {
    publicKeys: PublicKey[];
    potMasks: bigint[];
    playerIndex: number;
    cards: Ciphertext[];
    partials: Ciphertext[][];
    privateKey?: PrivateKey | bigint;
  },
): bigint[] {
  const result = playerSyncWith(session.invoke, {
    op: 'showdown',
    publicKeys: input.publicKeys.map(encPoint),
    potMasks: input.potMasks.map(encFr),
    playerIndex: encFr(input.playerIndex),
    cards: input.cards.map(encCt),
    partials: input.partials.map((row) => row.map(encCt)),
    prove: false,
    ...(input.privateKey !== undefined ? { privateKey: encFr(input.privateKey) } : {}),
  });
  return (result.winnerMasks as string[]).map(dec);
}

function fieldToDecimalString(value: unknown, path: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid field element at ${path}: ${value}`);
    }
    return trimmed;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    throw new Error(
      `Field element at ${path} lost precision (got JS number ${value}).`,
    );
  }
  throw new Error(`Invalid field element type at ${path}: ${typeof value}`);
}

function parseProof(result: PlayerResult): { proof: object; publicSignals: string[] } {
  if (typeof result.proofJson !== 'string' || typeof result.publicSignalsJson !== 'string') {
    throw new Error('player result missing proofJson/publicSignalsJson');
  }
  const proof = JSON.parse(result.proofJson) as Record<string, unknown>;
  const signals = JSON.parse(result.publicSignalsJson) as unknown[];
  return {
    proof: {
      pi_a: (proof.pi_a as unknown[]).map((limb, i) => fieldToDecimalString(limb, `pi_a[${i}]`)),
      pi_b: (proof.pi_b as unknown[][]).map((coord, i) =>
        coord.map((limb, j) => fieldToDecimalString(limb, `pi_b[${i}][${j}]`)),
      ),
      pi_c: (proof.pi_c as unknown[]).map((limb, i) => fieldToDecimalString(limb, `pi_c[${i}]`)),
      protocol: typeof proof.protocol === 'string' ? proof.protocol : 'groth16',
      ...(typeof proof.curve === 'string' ? { curve: proof.curve } : {}),
    },
    publicSignals: signals.map((value, i) => fieldToDecimalString(value, `publicSignals[${i}]`)),
  };
}

function parseKey(result: PlayerResult): { key: PlayerKey; padding: Ciphertext } {
  return {
    key: {
      privateKey: asPrivateKey(dec(result.privateKey as string)),
      publicKey: asPublicKey(decPair(result.publicKey)),
    },
    padding: decCt(result.padding),
  };
}

export async function pingPlayerBridge(): Promise<{ ok: boolean; backend?: string }> {
  const result = await player({ op: 'ping' });
  return {
    ok: result.ok === true,
    backend: typeof result.backend === 'string' ? result.backend : undefined,
  };
}

export async function key(privateKey?: PrivateKey | bigint): Promise<{
  key: PlayerKey;
  padding: Ciphertext;
}> {
  return parseKey(await player({
    op: 'key',
    ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
  }));
}

export async function register(privateKey?: PrivateKey | bigint): Promise<{
  proof: object;
  publicSignals: string[];
  key: PlayerKey;
  padding: Ciphertext;
}> {
  const result = await player({
    op: 'register',
    ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
  });
  return {
    ...parseProof(result),
    ...parseKey(result),
  };
}

export async function shuffle(
  deck: Ciphertext[],
  publicKeys: PublicKey[],
  privateKey?: PrivateKey | bigint,
): Promise<{
  proof: object;
  publicSignals: string[];
  deck: Ciphertext[];
  permutationHash: bigint;
}> {
  const result = await player({
    op: 'shuffle',
    deck: deck.map(encCt),
    publicKeys: publicKeys.map(encPoint),
    ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
  });
  return {
    ...parseProof(result),
    deck: (result.deck as unknown[]).map(decCt),
    permutationHash: dec(result.permutationHash as string),
  };
}

export async function share(
  deck: Ciphertext[],
  publicKeys: PublicKey[],
  nActualPlayers: number,
  privateKey?: PrivateKey | bigint,
): Promise<{
  proof: object;
  publicSignals: string[];
  ciphertexts: Ciphertext[][];
}> {
  const result = await player({
    op: 'share',
    deck: deck.map(encCt),
    publicKeys: publicKeys.map(encPoint),
    nActualPlayers: encFr(nActualPlayers),
    ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
  });
  return {
    ...parseProof(result),
    ciphertexts: (result.ciphertexts as unknown[][]).map((row) => row.map(decCt)),
  };
}

export async function showdown(input: {
  publicKeys: PublicKey[];
  potMasks: bigint[];
  playerIndex: number;
  cards: Ciphertext[];
  partials: Ciphertext[][];
  coefficients?: bigint[];
  privateKey?: PrivateKey | bigint;
  prove?: boolean;
}): Promise<{
  proof?: object;
  publicSignals?: string[];
  winnerMasks: bigint[];
  coefficientCommitment: bigint;
  publicKey: PublicKey;
}> {
  const result = await player({
    op: 'showdown',
    publicKeys: input.publicKeys.map(encPoint),
    potMasks: input.potMasks.map(encFr),
    playerIndex: encFr(input.playerIndex),
    cards: input.cards.map(encCt),
    partials: input.partials.map((row) => row.map(encCt)),
    prove: input.prove !== false,
    ...(input.coefficients ? { coefficients: input.coefficients.map(encFr) } : {}),
    ...(input.privateKey !== undefined ? { privateKey: encFr(input.privateKey) } : {}),
  });
  const proved = input.prove !== false ? parseProof(result) : {};
  return {
    ...proved,
    winnerMasks: (result.winnerMasks as string[]).map(dec),
    coefficientCommitment: dec(result.coefficientCommitment as string),
    publicKey: asPublicKey(decPair(result.publicKey)),
  };
}

export async function decrypt(
  cards: Ciphertext[],
  partials?: Ciphertext[][],
  privateKey?: PrivateKey | bigint,
): Promise<number[]> {
  const result = await player({
    op: 'decrypt',
    cards: cards.map(encCt),
    ...(partials ? { partials: partials.map((row) => row.map(encCt)) } : {}),
    ...(privateKey !== undefined ? { privateKey: encFr(privateKey) } : {}),
  });
  return (result.cardIndices as string[]).map((value) => Number(dec(value)));
}

/** @deprecated use `decrypt` */
export async function decryptDeal(
  privateKey: PrivateKey | bigint,
  cards: Ciphertext[],
  partials: Ciphertext[][],
): Promise<number[]> {
  return decrypt(cards, partials, privateKey);
}
