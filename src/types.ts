import type { ZkHandSnapshot, ZkCryptoSnapshot, ZkRevealSnapshot, ZkShowdownSnapshot } from './zk-serialize';
import type { HandResultSnapshot } from './hand-result';
import type { BackendGameKind } from './game-kind';

export type BackendKind = 'local' | 'solana';

export type BettingPhase =
  | 'lobby'
  | 'Register'
  | 'Shuffle'
  | 'Share'
  | 'PreFlop'
  | 'Flop'
  | 'Turn'
  | 'River'
  | 'Showdown'
  | 'Complete';

export type BetAction = 'fold' | 'check' | 'call' | 'raise';

export interface SeatSnapshot {
  seat: number;
  name: string;
  publicKey: string;
  /** Hand player index from registration order; differs from table seat number. */
  playerIndex?: number;
  /** Seat escrow stack (chips usable for betting at this table). */
  chips: string;
  /** Personal room escrow (not at risk until transferred to seat). */
  personalEscrow?: string;
  /** Alias of seat stack for escrow-aware UIs. */
  seatEscrow?: string;
  /** True while a hand is in progress — seat funds locked to pot flow. */
  seatLocked?: boolean;
  bet: string;
  folded: boolean;
  active: boolean;
}

export interface PotSnapshot {
  amount: string;
  lastBet: string;
}

export interface GameSnapshot {
  gameId: string;
  backend: BackendKind;
  phase: BettingPhase;
  dealerSeat: number;
  /** Extra dealer buttons (War / Baccarat / Roulette / multi-dealer BJ). */
  dealerSeats?: number[];
  /** Table game — poker streets vs casino settlement. */
  gameKind?: BackendGameKind;
  /** Visible roulette chips: type/modifier match `src/roulette.ts` PackBet. */
  rouletteBets?: Array<{ type: number; modifier: number; seat: number; amount?: string }>;
  smallBlindSeat: number;
  bigBlindSeat: number;
  smallBlind: string;
  currentBet: string;
  currentPlayerSeat: number | null;
  /** Hand player index (0..n-1) for the current actor; differs from table seat number. */
  currentPlayerIndex: number | null;
  bettingRoundOpen: boolean;
  /** Present during a hand: table seats in clockwise action order from dealer. */
  actionOrder?: number[];
  /** Present during a hand: table seat → registration player index. */
  playerIndexBySeat?: Record<number, number>;
  handNumber?: number;
  seats: SeatSnapshot[];
  pots: PotSnapshot[];
  /** Hole cards by seat index (0–9). Present once a hand is dealt. */
  holeCards?: Record<number, [number, number]>;
  /** Five board card indices; reveal count follows betting phase. */
  boardCards?: number[];
  /** ZK mental-poker hand lifecycle (register → shuffle → share). */
  zk?: ZkHandSnapshot;
  /** Frozen ElGamal deck state after share completes (through showdown). */
  zkCrypto?: ZkCryptoSnapshot;
  /** Showdown proof collection status. */
  zkShowdown?: ZkShowdownSnapshot;
  /** Progressive public partial reveals as board cards open. */
  zkReveal?: ZkRevealSnapshot;
  /** Summary of the last completed hand (present while phase is Complete). */
  handResult?: HandResultSnapshot;
  /** Winner layout shown during Showdown before chips are paid out. */
  pendingHandResult?: HandResultSnapshot;
  /** E2E visual tests: deal index → shuffled card value (0–51). */
  e2eDealValues?: Record<number, number>;
  /** Share complete and holes unlocked, waiting for hole acks (E2E / mock setups only). */
  holesViewPending?: boolean;
  /**
   * Solana path: how bets are validated.
   * `arcium-mpc` = Rescue encrypt + validate_bet_v2 (default).
   * `soft` = in-memory only when ALLOW_SOFT_BETTING=1.
   */
  bettingMode?: 'arcium-mpc' | 'soft';
  /** Solana: true once at least one bet went through Arcium validate_bet_v2 this hand. */
  mpcBettingUsed?: boolean;
  /** Minimum total bet level to raise (acting player). */
  minRaiseTo?: string;
  /** Additional chips to add for a minimum legal raise (acting player). */
  minRaiseAdd?: string;
}

export interface CreateGameRequest {
  smallBlind?: string;
  gameKind?: BackendGameKind | string;
  shoeDecks?: number;
  rouletteVariant?: number;
}

export interface StartHandRequest {
  gameKind?: BackendGameKind | string;
}

export interface JoinGameRequest {
  seat: number;
  publicKey: string;
  chips?: string;
}

export interface BetRequest {
  seat: number;
  action: BetAction;
  amount?: string;
}

export interface AddChipsRequest {
  seat: number;
  amount: string;
}

export interface StandUpRequest {
  publicKey: string;
}

export interface GameBackend {
  readonly kind: BackendKind;
  createGame(request?: CreateGameRequest): Promise<GameSnapshot>;
  getDefaultGame?(): Promise<GameSnapshot>;
  resetTable?(): Promise<GameSnapshot>;
  subscribe?(gameId: string, listener: (snapshot: GameSnapshot) => void): () => void;
  joinGame(gameId: string, request: JoinGameRequest): Promise<GameSnapshot>;
  standUp(gameId: string, request: StandUpRequest): Promise<GameSnapshot>;
  addChips(gameId: string, request: AddChipsRequest): Promise<GameSnapshot>;
  startHand(gameId: string, request?: StartHandRequest): Promise<GameSnapshot>;
  registerHandKey(
    gameId: string,
    request: import('./zk-serialize').ZkRegisterRequest,
  ): Promise<GameSnapshot>;
  submitShuffle(
    gameId: string,
    request: import('./zk-serialize').ZkShuffleRequest,
  ): Promise<GameSnapshot>;
  submitShare(
    gameId: string,
    request: import('./zk-serialize').ZkShareRequest,
  ): Promise<GameSnapshot>;
  getShowdownMaterials(
    gameId: string,
    seat: number,
  ): Promise<import('./zk-serialize').ZkShowdownMaterials>;
  getRevealedPartials(
    gameId: string,
    seat: number,
  ): Promise<import('./zk-serialize').ZkRevealSnapshot>;
  submitShowdown(
    gameId: string,
    request: import('./zk-serialize').ZkShowdownRequest,
  ): Promise<GameSnapshot>;
  getGame(gameId: string): Promise<GameSnapshot>;
  placeBet(gameId: string, request: BetRequest): Promise<GameSnapshot>;
  acknowledgeHoleCards(gameId: string, seat: number): Promise<GameSnapshot>;
  advanceStreet(gameId: string): Promise<GameSnapshot>;
}
