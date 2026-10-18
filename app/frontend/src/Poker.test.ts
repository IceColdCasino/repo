/// <reference types="vitest/globals" />
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Poker from './Poker.svelte';
import { saveBackendKind } from './backend';
import { resetAvatarAssignmentsForTests } from './poker/smoking-punks';

export const TEST_PUBLIC_KEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuQosm7ee';

const mockClient = {
  createGame: vi.fn(async () => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [],
    pots: [],
  })),
  getDefaultGame: vi.fn(async () => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [],
    pots: [],
  })),
  subscribeGame: vi.fn(() => () => {}),
  joinGame: vi.fn(async (_gameId: string, seat: number, publicKey: string) => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [{
      seat,
      name: '7xKX…7ee',
      publicKey,
      chips: '0',
      bet: '0',
      folded: false,
      active: false,
    }],
    pots: [],
  })),
  standUp: vi.fn(async () => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [],
    pots: [],
  })),
  addChips: vi.fn(async () => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [{
      seat: 0,
      name: '7xKX…7ee',
      publicKey: TEST_PUBLIC_KEY,
      chips: '1000',
      bet: '0',
      folded: false,
      active: false,
    }],
    pots: [],
  })),
  startHand: vi.fn(async () => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'PreFlop',
    dealerSeat: 0,
    smallBlindSeat: 0,
    bigBlindSeat: 1,
    smallBlind: '1',
    currentBet: '2',
    currentPlayerSeat: 1,
    bettingRoundOpen: true,
    seats: [
      { seat: 0, name: 'AbCd…wxyz', publicKey: 'AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd', chips: '499', bet: '1', folded: false, active: false },
      { seat: 1, name: '7xKX…7ee', publicKey: TEST_PUBLIC_KEY, chips: '998', bet: '2', folded: false, active: true },
    ],
    pots: [{ amount: '3', lastBet: '2' }],
    holeCards: { 0: [0, 13], 1: [26, 39] },
    boardCards: [1, 2, 3, 4, 5],
  })),
  getGame: vi.fn(),
  registerHandKey: vi.fn(),
  submitShuffle: vi.fn(),
  submitShare: vi.fn(),
  placeBet: vi.fn(),
  advanceStreet: vi.fn(),
  resetTable: vi.fn(async () => ({
    gameId: 'local-table',
    backend: 'local',
    phase: 'lobby',
    dealerSeat: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    smallBlind: '1',
    currentBet: '0',
    currentPlayerSeat: null,
    currentPlayerIndex: null,
    bettingRoundOpen: false,
    seats: [],
    pots: [],
  })),
};

vi.mock('./backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backend')>();
  return {
    ...actual,
    createClient: vi.fn(() => mockClient),
  };
});

vi.mock('./identity', () => ({
  getActivePublicKey: vi.fn(() => TEST_PUBLIC_KEY),
  getOrCreateLocalPublicKey: vi.fn(() => TEST_PUBLIC_KEY),
  createNewLocalWallet: vi.fn(() => 'NewWallet111111111111111111111111111'),
  getWalletPublicKey: vi.fn(() => null),
  shortPublicKey: (key: string) => (key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key),
  resetLocalPublicKeyCacheForTests: vi.fn(),
}));

vi.mock('./zk', () => ({
  pingZkRuntime: vi.fn(async () => ({ ok: true, kind: 'native-bridge', detail: 'zero-native' })),
  waitForNativeBridge: vi.fn(async () => ({ ok: true, kind: 'native-bridge', detail: 'zero-native' })),
  tryRefreshNativeBridge: vi.fn(async () => ({ ok: true, kind: 'native-bridge', detail: 'zero-native' })),
  nativeBridgeStartupTimeoutMs: vi.fn(() => 15_000),
}));

vi.mock('./poker/zk-hand-flow', () => ({
  createFreshZkHandFlow: vi.fn(),
  isHandFlowPhase: vi.fn(() => false),
  isMyShowdownTurn: vi.fn(() => false),
  isMyZkTurn: vi.fn(() => false),
  isZkHandPhase: vi.fn(() => false),
  maybeAdvanceZkHand: vi.fn(async () => null),
}));

vi.mock('./poker/zk-flow', () => ({
  createZkFlow: vi.fn(),
  runRegistration: vi.fn(),
  runShuffleStep: vi.fn(),
}));

vi.mock('./solana/hash-receipt', () => ({
  buildShuffleReceiptPayload: vi.fn(),
}));

vi.mock('./solana/zk-client', () => ({
  submitInputHashReceipt: vi.fn(),
}));

const mockFetchServerHealth = vi.fn(async () => ({ ok: true, bootId: 'boot-1' }));
const mockIsServerConnected = vi.fn(async () => true);
const mockStartLocalServer = vi.fn(async () => ({ ok: true, spawned: true, port: 3847 }));
const mockWaitForServerConnection = vi.fn(async () => ({ ok: true, bootId: 'boot-1' }));
const mockFetchChainWorkerHealth = vi.fn(async () => ({
  ok: true,
  worker: true,
  localnetReady: true,
  sessionReady: true,
}));
const mockStartChainWorker = vi.fn(async () => ({ ok: true, spawned: true, port: 3850 }));
const mockWaitForChainWorker = vi.fn(async () => ({
  ok: true,
  worker: true,
  localnetReady: true,
  sessionReady: true,
}));

vi.mock('./server', () => ({
  DEFAULT_SERVER_URL: 'http://127.0.0.1:3847',
  DEFAULT_CHAIN_WORKER_URL: 'http://127.0.0.1:3850',
  fetchServerHealth: (...args: unknown[]) => mockFetchServerHealth(...args),
  isServerConnected: (...args: unknown[]) => mockIsServerConnected(...args),
  startLocalServer: (...args: unknown[]) => mockStartLocalServer(...args),
  waitForServerConnection: (...args: unknown[]) => mockWaitForServerConnection(...args),
  fetchChainWorkerHealth: (...args: unknown[]) => mockFetchChainWorkerHealth(...args),
  startChainWorker: (...args: unknown[]) => mockStartChainWorker(...args),
  waitForChainWorker: (...args: unknown[]) => mockWaitForChainWorker(...args),
  hasNativeServerLauncher: vi.fn(() => false),
  hasNativeChainWorkerLauncher: vi.fn(() => false),
  isIosNativeShell: vi.fn(() => false),
  isNativeDesktopShell: vi.fn(() => false),
  noteNativePlatform: vi.fn(),
  nativeShellLikely: vi.fn(() => false),
  loadApiBase: vi.fn(() => null),
  saveApiBase: vi.fn(),
  resolveApiBase: vi.fn(() => 'http://127.0.0.1:3847'),
  resolveChainWorkerUrl: vi.fn(() => 'http://127.0.0.1:3850'),
}));

describe('Poker backend selector UI', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetAvatarAssignmentsForTests();
    saveBackendKind('local');
    vi.clearAllMocks();
    mockFetchServerHealth.mockResolvedValue({ ok: true, bootId: 'boot-1' });
    mockIsServerConnected.mockResolvedValue(true);
    mockStartLocalServer.mockResolvedValue({ ok: true, spawned: true, port: 3847 });
    mockWaitForServerConnection.mockResolvedValue({ ok: true, bootId: 'boot-1' });
    mockFetchChainWorkerHealth.mockResolvedValue({
      ok: true,
      worker: true,
      localnetReady: true,
      sessionReady: true,
    });
    mockStartChainWorker.mockResolvedValue({ ok: true, spawned: true, port: 3850 });
    mockWaitForChainWorker.mockResolvedValue({
      ok: true,
      worker: true,
      localnetReady: true,
      sessionReady: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders backend selector defaulting to local server', () => {
    render(Poker);
    const select = screen.getByTestId('backend-select') as HTMLSelectElement;
    expect(select.value).toBe('local');
  });

  it('renders a game-kind selector defaulting to poker', () => {
    render(Poker);
    const select = screen.getByTestId('game-kind-select') as HTMLSelectElement;
    expect(select.value).toBe('poker');
    expect(document.querySelector('[data-testid="poker-table"]')?.getAttribute('data-game-kind')).toBe('poker');
  });

  it('switches to a 12-seat War rail and a roulette felt', async () => {
    const user = userEvent.setup();
    render(Poker);
    await user.selectOptions(screen.getByTestId('game-kind-select'), 'war');
    expect(document.querySelector('[data-testid="poker-table"]')?.getAttribute('data-game-kind')).toBe('war');
    expect(document.querySelectorAll('#seats circle').length).toBeGreaterThanOrEqual(12);

    await user.selectOptions(screen.getByTestId('game-kind-select'), 'roulette');
    expect(screen.getByTestId('roulette-board')).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('game-kind-select'), 'blackjack');
    expect(document.querySelector('[data-testid="poker-table"]')?.getAttribute('data-game-kind')).toBe('blackjack');
    expect(document.querySelectorAll('#seats > g').length).toBe(8);
  });

  it('switches backend when user selects Solana option', async () => {
    const user = userEvent.setup();
    render(Poker);

    await user.selectOptions(screen.getByTestId('backend-select'), 'solana');

    expect((screen.getByTestId('backend-select') as HTMLSelectElement).value).toBe('solana');
    expect(localStorage.getItem('poker-backend')).toBe('solana');
  });

  it('switches backend when user selects devnet', async () => {
    const user = userEvent.setup();
    render(Poker);

    await user.selectOptions(screen.getByTestId('backend-select'), 'devnet');

    expect((screen.getByTestId('backend-select') as HTMLSelectElement).value).toBe('devnet');
    expect(localStorage.getItem('poker-backend')).toBe('devnet');
    expect(screen.getByRole('option', { name: 'Solana + Arcium devnet' })).toBeInTheDocument();
  });

  it('shows seat dropdown and player public key on local backend', async () => {
    render(Poker);
    await waitFor(() => expect(screen.getByTestId('seat-select')).toBeInTheDocument());
    const options = screen.getByTestId('seat-select').querySelectorAll('option');
    expect(options).toHaveLength(11);
    expect(screen.getByTestId('player-public-key')).toBeInTheDocument();
    expect(document.querySelector('#seats circle')).toBeTruthy();
  });

  it('shows remote seated players when the table stream updates', async () => {
    let onSnapshot: ((snapshot: import('./backend').GameSnapshot) => void) | null = null;
    mockClient.subscribeGame.mockImplementation((_gameId, listener) => {
      onSnapshot = listener;
      return () => {
        onSnapshot = null;
      };
    });

    render(Poker);
    await waitFor(() => expect(mockClient.getDefaultGame).toHaveBeenCalled());

    onSnapshot!({
      gameId: 'local-table',
      backend: 'local',
      phase: 'lobby',
      dealerSeat: -1,
      smallBlindSeat: -1,
      bigBlindSeat: -1,
      smallBlind: '1',
      currentBet: '0',
      currentPlayerSeat: null,
      currentPlayerIndex: null,
      bettingRoundOpen: false,
      seats: [{
        seat: 4,
        name: '1111…1112',
        publicKey: '11111111111111111111111111111112',
        chips: '2500',
        bet: '0',
        folded: false,
        active: false,
      }],
      pots: [],
    });

    await waitFor(() =>
      expect(document.querySelector('[data-testid="seat-avatar-4"]')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('seat-wallet-4')).toHaveTextContent('1111…1112'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('seat-chips-4')).toHaveTextContent('2,500 chips'),
    );
  });

  it('sits after selecting a seat and clicking Sit', async () => {
    const user = userEvent.setup();
    render(Poker);

    await waitFor(() => expect(screen.getByTestId('seat-select')).not.toBeDisabled());
    expect(screen.getByTestId('sit-down')).toBeDisabled();
    await waitFor(() => expect(mockClient.getDefaultGame).toHaveBeenCalled());
    await user.selectOptions(screen.getByTestId('seat-select'), '1');
    expect(mockClient.joinGame).not.toHaveBeenCalled();
    expect(screen.getByTestId('sit-down')).not.toBeDisabled();

    await user.click(screen.getByTestId('sit-down'));

    await waitFor(() =>
      expect(mockClient.joinGame).toHaveBeenCalledWith('local-table', 1, TEST_PUBLIC_KEY),
    );
    expect(screen.queryByTestId('seat-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sit-down')).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-testid="seat-avatar-1"]')).toBeTruthy());
    expect(screen.getByTestId('stand-up')).toBeInTheDocument();

    await user.click(screen.getByTestId('stand-up'));
    await waitFor(() =>
      expect(mockClient.standUp).toHaveBeenCalledWith('local-table', TEST_PUBLIC_KEY),
    );
    await waitFor(() => expect(screen.getByTestId('seat-select')).toBeInTheDocument());

    await user.selectOptions(screen.getByTestId('seat-select'), '1');
    await user.click(screen.getByTestId('sit-down'));
    await waitFor(() => expect(mockClient.joinGame).toHaveBeenCalledTimes(2));

    await user.click(screen.getByTestId('start-hand'));
    await waitFor(() => expect(mockClient.startHand).toHaveBeenCalledWith('local-table', { gameKind: 'poker' }));
  });

  it('hides stand up during an active hand', async () => {
    mockClient.joinGame.mockResolvedValueOnce({
      gameId: 'local-table',
      backend: 'local',
      phase: 'PreFlop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      smallBlind: '1',
      currentBet: '2',
      currentPlayerSeat: 0,
      bettingRoundOpen: true,
      seats: [{
        seat: 1,
        name: '7xKX…7ee',
        publicKey: TEST_PUBLIC_KEY,
        chips: '998',
        bet: '2',
        folded: false,
        active: true,
      }],
      pots: [{ amount: '3', lastBet: '2' }],
    });

    const user = userEvent.setup();
    render(Poker);

    await waitFor(() => expect(screen.getByTestId('seat-select')).not.toBeDisabled());
    await user.selectOptions(screen.getByTestId('seat-select'), '1');
    await user.click(screen.getByTestId('sit-down'));
    await waitFor(() => expect(screen.queryByTestId('stand-up')).not.toBeInTheDocument());
    expect(screen.queryByTestId('seat-select')).not.toBeInTheDocument();
  });

  it('keeps seating controls when Solana backend selected', async () => {
    const user = userEvent.setup();
    render(Poker);

    await user.selectOptions(screen.getByTestId('backend-select'), 'solana');

    await waitFor(() => expect(screen.getByTestId('seat-select')).toBeInTheDocument());
    expect(screen.getByTestId('sit-down')).toBeInTheDocument();
  });

  it('submits raise amount from form input', async () => {
    mockClient.placeBet.mockResolvedValueOnce({
      gameId: 'local-table',
      backend: 'local',
      phase: 'PreFlop',
      dealerSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      smallBlind: '1',
      currentBet: '6',
      currentPlayerSeat: 1,
      bettingRoundOpen: true,
      seats: [],
      pots: [{ amount: '9', lastBet: '6' }],
    });

    const user = userEvent.setup();
    render(Poker);

    await waitFor(() => expect(screen.getByTestId('seat-select')).not.toBeDisabled());
    await user.selectOptions(screen.getByTestId('seat-select'), '1');
    await user.click(screen.getByTestId('sit-down'));
    await waitFor(() => expect(mockClient.joinGame).toHaveBeenCalled());

    await user.click(screen.getByTestId('start-hand'));
    await waitFor(() => expect(mockClient.startHand).toHaveBeenCalledWith('local-table', { gameKind: 'poker' }));

    const raiseInput = screen.getByTestId('raise-amount');
    await waitFor(() => expect(raiseInput).not.toBeDisabled());
    await user.click(raiseInput);
    await user.keyboard('{Control>}a{/Control}50');
    await user.click(screen.getByTestId('raise-submit'));

    await waitFor(() =>
      expect(mockClient.placeBet).toHaveBeenCalledWith('local-table', 1, 'raise', '50'),
    );
  });

  it('adds chips via add-chips control', async () => {
    const user = userEvent.setup();
    render(Poker);

    await waitFor(() => expect(screen.getByTestId('seat-select')).not.toBeDisabled());
    await user.selectOptions(screen.getByTestId('seat-select'), '1');
    await user.click(screen.getByTestId('sit-down'));
    await waitFor(() => expect(mockClient.joinGame).toHaveBeenCalled());

    const amountInput = screen.getByTestId('add-chips-amount') as HTMLInputElement;
    expect(amountInput.value).toBe('1000');

    await user.click(screen.getByTestId('add-chips-submit'));
    await waitFor(() =>
      expect(mockClient.addChips).toHaveBeenCalledWith('local-table', 1, '1000'),
    );
  });

  it('shows server connection status and connect button when disconnected', async () => {
    mockFetchServerHealth.mockResolvedValue(null);
    mockIsServerConnected.mockResolvedValue(false);

    render(Poker);

    await waitFor(() =>
      expect(screen.getByTestId('server-status').textContent).toMatch(/not connected/i),
    );
    expect(screen.getByTestId('connect-server')).toBeInTheDocument();
  });

  it('connects to the local server on first button click', async () => {
    let allowConnect = false;
    mockFetchServerHealth.mockImplementation(async () => (
      allowConnect ? { ok: true, bootId: 'boot-1' } : null
    ));
    mockIsServerConnected.mockResolvedValue(false);

    const user = userEvent.setup();
    render(Poker);

    await waitFor(() => expect(screen.getByTestId('connect-server')).toBeInTheDocument());
    allowConnect = true;
    await user.click(screen.getByTestId('connect-server'));

    await waitFor(() => expect(mockClient.getDefaultGame).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('server-status').textContent).toMatch(/connected/i),
    );
    expect(screen.queryByTestId('connect-server')).not.toBeInTheDocument();
  });

  it('resets the local table when dev tools are enabled', async () => {
    const user = userEvent.setup();
    render(Poker);

    await waitFor(() => expect(screen.getByTestId('reset-server-table')).toBeInTheDocument());
    await user.click(screen.getByTestId('reset-server-table'));

    await waitFor(() => expect(mockClient.resetTable).toHaveBeenCalled());
  });

  it('does not launch a host process from the app when the server is down', async () => {
    mockFetchServerHealth.mockResolvedValue(null);

    render(Poker);

    await waitFor(() =>
      expect(screen.getByTestId('server-status').textContent).toMatch(/not connected/i),
    );
    expect(mockStartLocalServer).not.toHaveBeenCalled();
  });
});
