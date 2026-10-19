import { Program, type AnchorProvider, web3, BN } from '@coral-xyz/anchor';
import { Game } from '../poker-game';
import { encryptBetPayload, type TableEncryptionKey } from '../bet-encryption';
import { ArciumMPCHelper } from '../arcium/mpc';
import { ArciumPollingHelper } from '../arcium/polling';
import {
  PokerRoomLifecycle,
  WarRoomLifecycle,
  BaccaratRoomLifecycle,
  BlackjackRoomLifecycle,
  RouletteRoomLifecycle,
  CrapsRoomLifecycle,
  KenoRoomLifecycle,
  SlotsRoomLifecycle,
  BingoRoomLifecycle,
} from './room/game-room-lifecycle';
import { WHITELIST_ADMIN, loadWhitelistAdminProvider } from './admin-provider';
import { OnchainRoomLifecycle } from './room/onchain-room-lifecycle';
import {
  RENT_VAULT_DATA_LEN,
  clusterRentLamportsPerByte,
  drawStagedRent,
  recaptureRentVault,
  rentVaultFor,
  rentVaultPda,
  settleRentVault,
  stagePlayerRent,
} from './rent-vault';
import { takeDevnetPlayers } from './devnet-players';
import { ensureSeatSol, fundSol, isLocalCluster, rentExemptLamports, seatFloorLamports } from './fund-sol';
import {
  DEALER_POOL_DATA,
  PENDING_DEPOSIT_DATA,
  POOL_STAKE_DATA,
  PROTOCOL_TREASURY_DATA,
  ROOM_DATA,
  ROOM_WALLET_DATA,
  SPL_MINT_DATA,
  SPL_TOKEN_ACCOUNT_DATA,
  TABLE_DATA,
  ROOM_SESSION_DATA,
  ROOM_SESSION_LOCK_DATA,
  TABLE_ESCROW_DATA,
  WHITELIST_DATA,
  operatorTableLamports,
  seatTableLamports,
} from './table-float';
import { KENO_REVEAL_IN_FLIGHT } from '../arcium/heap';
import { shuffleCallerInputs } from './shuffle-account';
import { KeypairWallet } from './keypair-wallet';
import { GameKind, maxTableSeats, reservedHouseSeat } from '../game-config';

type BettingPhase = 'PreFlop' | 'Flop' | 'Turn' | 'River';

const BETTING_PHASES: Record<BettingPhase, number> = {
  PreFlop: 1,
  Flop: 2,
  Turn: 3,
  River: 4,
};

const ACTION_MAP: Record<string, number> = {
  fold: 0, check: 1, call: 2, bet: 3, raise: 4, 'all-in': 5,
};

/** Pull one account's rent from `owner`'s float onto the key that will open it. */
async function drawTableAccount(
  provider: AnchorProvider,
  owner: web3.Keypair | undefined,
  destination: web3.PublicKey,
  dataLen: number,
  rate: number,
): Promise<void> {
  if (!owner) return;
  await drawStagedRent(
    provider,
    owner.publicKey,
    destination,
    rentExemptLamports(dataLen, rate),
    owner,
  );
}

export interface EncryptedBettingTable {
  room: PokerRoomLifecycle;
  tableId: bigint;
  players: web3.Keypair[];
  gameId: Uint8Array;
  gameState: web3.PublicKey;
  tableState: web3.PublicKey;
}

export interface CasinoEncryptedTable {
  room:
    | WarRoomLifecycle
    | BaccaratRoomLifecycle
    | BlackjackRoomLifecycle
    | RouletteRoomLifecycle
    | CrapsRoomLifecycle
    | KenoRoomLifecycle
    | SlotsRoomLifecycle
    | BingoRoomLifecycle
    | PokerRoomLifecycle;
  tableId: bigint;
  players: web3.Keypair[];
  gameId: Uint8Array;
  gameState: web3.PublicKey;
  tableState: web3.PublicKey;
  roomId: Uint8Array;
  gameKind: GameKind;
}

const ADMIN_CUSHION = 1_500_000_000;
const NEXT_TABLE_RESERVE = 3_000_000_000;

/** Put the whitelist admin back above 1 SOL from the fee payer. */
async function fundAdminCushion(provider: AnchorProvider): Promise<void> {
  const admin = WHITELIST_ADMIN;
  const adminBal = await provider.connection.getBalance(admin, 'confirmed');
  const short = ADMIN_CUSHION - adminBal;
  if (short <= 0) return;
  const payerBal = await provider.connection.getBalance(provider.wallet.publicKey, 'confirmed');
  const send = Math.min(short, payerBal - NEXT_TABLE_RESERVE);
  if (send <= 0) {
    console.warn(`[rent] admin is ${adminBal} lamports and the payer cannot top it up`);
    return;
  }
  const latest = await provider.connection.getLatestBlockhash('confirmed');
  const tx = new web3.Transaction({
    feePayer: provider.wallet.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(web3.SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: admin,
    lamports: send,
  }));
  const signed = await provider.wallet.signTransaction(tx);
  const signature = await provider.connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: 'confirmed',
  });
  const confirmation = await provider.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`admin cushion failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  console.log(`[rent] restored ${send} lamports to the whitelist admin`);
}

async function returnLamports(
  provider: AnchorProvider,
  from: web3.Keypair,
  to: web3.PublicKey,
  lamports: number,
): Promise<void> {
  const latest = await provider.connection.getLatestBlockhash('confirmed');
  const tx = new web3.Transaction({
    feePayer: provider.wallet.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(web3.SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: to,
    lamports,
  }));
  tx.partialSign(from);
  const signed = await provider.wallet.signTransaction(tx);
  const signature = await provider.connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: 'confirmed',
  });
  const confirmation = await provider.connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );
  if (confirmation.value.err) {
    throw new Error(`return lamports failed: ${JSON.stringify(confirmation.value.err)}`);
  }
}

function sessionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

/**
 * End the devnet table and return its float to the fee payer.
 * Localnet leaves the session in place. Call this after the hand timer stops.
 */
export async function releaseDevnetSession(args: {
  provider: AnchorProvider;
  room: OnchainRoomLifecycle;
  tableId: bigint;
  gameId: Uint8Array;
  players: web3.Keypair[];
  refundSeatRent?: () => Promise<void>;
  reclaimComputations?: () => Promise<void>;
  closeLightSession?: (dest: web3.PublicKey) => Promise<void>;
}): Promise<void> {
  if (isLocalCluster(args.provider.connection.rpcEndpoint)) return;
  const note = async (label: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      console.warn(`[rent] ${label}: ${sessionError(err)}`);
    }
  };
  await note('refund seat rent', async () => {
    if (args.refundSeatRent) await args.refundSeatRent();
  });
  await note('reclaim computations', async () => {
    if (args.reclaimComputations) await args.reclaimComputations();
  });

  try {
  const admin = await loadWhitelistAdminProvider(args.provider.connection, undefined, 20_000_000);
  await note('end hand', () => args.room.endHand(args.tableId, admin));

  const rate = await clusterRentLamportsPerByte(args.provider.connection);
  const keep = rentExemptLamports(RENT_VAULT_DATA_LEN, rate);
  const payer = args.provider.wallet.publicKey;
  let returned = 0;
  for (const player of args.players) {
    const vault = rentVaultFor(player.publicKey) ?? rentVaultPda(args.room.roomId, player.publicKey);
    const info = await args.provider.connection.getAccountInfo(vault, 'confirmed');
    if (!info || info.lamports === 0) continue;
    const surplus = Math.max(0, info.lamports - keep);
    if (surplus > 0) {
      try {
        await recaptureRentVault(args.provider, admin, vault, player.publicKey, keep);
        returned += surplus;
      } catch (err) {
        console.warn(`[rent] seat ${player.publicKey.toBase58()}: ${sessionError(err)}`);
        continue;
      }
    }
    const before = await args.provider.connection.getBalance(player.publicKey, 'confirmed');
    let satOut = false;
    await note(`sit out ${player.publicKey.toBase58()}`, async () => {
      await args.room.sitOut(args.tableId, player);
      satOut = true;
    });
    if (!satOut) continue;
    const after = await args.provider.connection.getBalance(player.publicKey, 'confirmed');
    const dust = after - before;
    if (dust > 0) {
      await note(`return seat rent ${player.publicKey.toBase58()}`, async () => {
        await returnLamports(args.provider, player, payer, dust);
        returned += dust;
      });
    }
  }

  const operatorVault = rentVaultFor(payer) ?? rentVaultPda(args.room.roomId, payer);
  const operatorInfo = await args.provider.connection.getAccountInfo(operatorVault, 'confirmed');
  if (operatorInfo && operatorInfo.lamports > 0) {
    try {
      await settleRentVault(args.provider, admin, operatorVault, payer);
      returned += operatorInfo.lamports;
    } catch (err) {
      console.warn(`[rent] operator vault: ${sessionError(err)}`);
    }
  }

  let mint: web3.PublicKey | null = null;
  await note('read mint', async () => {
    mint = await args.room.roomMint();
  });
  await note('close session', () => args.room.closeSession(
    args.tableId,
    args.gameId,
    args.players.map((player) => player.publicKey),
    payer,
  ));
  if (mint) {
    const chipMint = mint;
    await note('reclaim chips', async () => {
      returned += await args.room.reclaimChips(chipMint, args.players, payer);
    });
  }
  if (args.closeLightSession) {
    const before = await args.provider.connection.getBalance(payer, 'confirmed');
    await note('close light session', () => args.closeLightSession!(payer));
    const after = await args.provider.connection.getBalance(payer, 'confirmed');
    if (after > before) returned += after - before;
  }
  console.log(`[rent] reclaimed ${returned} lamports to ${payer.toBase58()}`);
  } catch (err) {
    console.warn(`[rent] reclaim: ${sessionError(err)}`);
  }
  await note('admin cushion', () => fundAdminCushion(args.provider));
}

/**
 * Sets up room + 2 distinct seated wallets + `start_hand` so `submit_bet`
 * (validate_bet) can run. Call after `initialize_game` when the hand also
 * needs ZK fields, or alone for betting-only circuit tests.
 */
export async function setupEncryptedBettingTable(
  pokerProgram: Program,
  provider: AnchorProvider,
  gameId: Uint8Array,
  opts?: { numPlayers?: number; buyIn?: bigint; onStaged?: () => Promise<void> },
): Promise<EncryptedBettingTable> {
  const numPlayers = opts?.numPlayers ?? 2;
  const buyIn = opts?.buyIn ?? 1_000n;
  const tableSeats = maxTableSeats(GameKind.Poker);
  if (numPlayers < 2 || numPlayers > tableSeats) {
    throw new Error(`numPlayers must be 2..${tableSeats}, got ${numPlayers}`);
  }

  const adminProvider = await loadWhitelistAdminProvider(provider.connection);
  const room = new PokerRoomLifecycle(pokerProgram, provider);
  const rate = await clusterRentLamportsPerByte(provider.connection);
  const pokerCaller = shuffleCallerInputs(0, 1, 0);
  const pokerFloor = seatFloorLamports(pokerCaller);
  const authorityKp = (provider.wallet as { payer?: web3.Keypair }).payer;
  const assigned = takeDevnetPlayers(numPlayers);
  const players: web3.Keypair[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const kp = assigned ? assigned[i]! : web3.Keypair.generate();
    if (assigned) await ensureSeatSol(provider, kp.publicKey, pokerFloor);
    else await fundSol(provider, kp.publicKey, pokerFloor);
    players.push(kp);
  }
  const operatorExtra = operatorTableLamports(
    tableSeats,
    { housePool: false, pokerBetting: true, operatorSeat: false },
    rate,
  );
  for (const kp of players) {
    await stagePlayerRent(
      provider,
      adminProvider,
      room.roomId,
      kp.publicKey,
      pokerCaller,
      seatTableLamports(rate, { tokenAccount: false, pendingDeposit: false }),
    );
  }
  if (authorityKp) {
    await stagePlayerRent(provider, adminProvider, room.roomId, authorityKp.publicKey, pokerCaller, operatorExtra);
  }
  if (opts?.onStaged) await opts.onStaged();

  await drawTableAccount(provider, authorityKp, provider.wallet.publicKey, SPL_MINT_DATA, rate);
  const mint = await room.createSplMint();
  await drawTableAccount(provider, authorityKp, adminProvider.wallet.publicKey, ROOM_DATA, rate);
  await drawTableAccount(provider, authorityKp, adminProvider.wallet.publicKey, SPL_TOKEN_ACCOUNT_DATA, rate);
  await room.createRoom(mint, adminProvider, room.defaultSmallBlind());

  let fundedOnChain = false;
  let faucetOpen = buyIn > 0n;
  for (const [index, kp] of players.entries()) {
    await drawTableAccount(provider, kp, adminProvider.wallet.publicKey, WHITELIST_DATA, rate);
    await room.addToWhitelist(kp.publicKey, adminProvider);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, ROOM_WALLET_DATA, rate);
    await room.initRoomWallet(kp);
    // Faucet → personal escrow (requires deployed faucet_credit_personal). Soft-escrow
    // dual-client E2E seeds MPC stacks via LocalnetTableSession.escrow instead.
    if (faucetOpen) {
      try {
        await room.faucetCreditPersonal(kp, buyIn);
        fundedOnChain = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (index === 0) {
          console.warn(
            `[betting] on-chain faucet unavailable (${msg.split('\n')[0]}); ` +
              'seating with zero table escrow — soft seat stacks seed validate_bet',
          );
        }
        fundedOnChain = false;
        faucetOpen = false;
      }
    }
  }

  await drawTableAccount(provider, authorityKp, adminProvider.wallet.publicKey, TABLE_DATA, rate);
  const { tableId, tableState } = await room.createTable(adminProvider);
  for (let i = 0; i < numPlayers; i++) {
    const kp = players[i]!;
    await drawTableAccount(provider, kp, provider.wallet.publicKey, TABLE_ESCROW_DATA, rate);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, ROOM_SESSION_DATA, rate);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, ROOM_SESSION_LOCK_DATA, rate);
    await room.sitAtTable(tableId, i, fundedOnChain ? buyIn : 0n, kp);
    if (fundedOnChain && buyIn > 0n) {
      await room.transferPersonalToSeat(tableId, buyIn, kp);
    }
  }

  const starter = players[0];
  if (!starter) throw new Error('start_hand needs a seated whitelisted player');
  const gameState = await room.startHand(tableId, gameId, starter);

  // Reorder keypairs to match on-chain hand_seat_order (SB=0, BB=1, …).
  const table = await room.fetchTable(tableId);
  const ordered: web3.Keypair[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const seat = Number(table.handSeatOrder[i]);
    const pk = table.seats[seat].toString();
    const kp = players.find((p) => p.publicKey.toBase58() === pk);
    if (!kp) throw new Error(`No keypair for hand seat ${seat}`);
    ordered.push(kp);
  }

  return {
    room,
    tableId,
    players: ordered,
    gameId,
    gameState,
    tableState,
  };
}

/**
 * Casino room + seated wallets + dealer pool + `start_hand`.
 * `onStaged` runs after the floats are deposited and before any table account
 * is opened, which is where `initializeGames` draws its rent.
 *
 * Funds seats via SPL deposit → encrypted room credit → `lock_table_buyin`.
 * House games stake the dealer pool so `settle_casino_hand` can pay wins.
 * Bingo does not: the prize is the card buy-ins.
 */
export async function setupCasinoEncryptedTable(
  pokerProgram: Program,
  provider: AnchorProvider,
  gameId: Uint8Array,
  opts: {
    gameKind: GameKind;
    numPlayers?: number;
    buyIn?: bigint;
    dealerPoolStake?: bigint;
    shoeDecks?: number;
    rouletteVariant?: number;
    /** Runs after every seat's float is deposited and before accounts are opened. */
    onStaged?: () => Promise<void>;
  },
): Promise<CasinoEncryptedTable> {
  const numPlayers = opts.numPlayers ?? 2;
  const buyIn = opts.buyIn ?? 10_000n;
  const playerPot = opts.gameKind === GameKind.Bingo;
  // Roulette worst-case at default max_bet=100 × 2 seats × Σmult(108) = 21_600.
  // BJ at bet_unit=100 × 4 × 3 × 2 seats = 2_400. Head-to-head = bet×seats.
  const dealerPoolStake = playerPot ? 0n : (opts.dealerPoolStake ?? 250_000n);
  const shoeDecks = opts.shoeDecks
    ?? (opts.gameKind === GameKind.Poker
      ? 1
      : opts.gameKind === GameKind.Roulette
        || opts.gameKind === GameKind.Craps
        || opts.gameKind === GameKind.Keno
        || opts.gameKind === GameKind.Slots
        || opts.gameKind === GameKind.Bingo
        ? 0
        : 6);
  const rouletteVariant = opts.rouletteVariant
    ?? (opts.gameKind === GameKind.Roulette
      ? 37
      : opts.gameKind === GameKind.Slots
        ? 3
        : opts.gameKind === GameKind.Bingo
          ? 75
          : 0);
  const tableSeats = maxTableSeats(opts.gameKind);
  if (numPlayers < 2 || numPlayers > tableSeats) {
    throw new Error(`numPlayers must be 2..${tableSeats}, got ${numPlayers}`);
  }
  if (
    opts.gameKind !== GameKind.War
    && opts.gameKind !== GameKind.Baccarat
    && opts.gameKind !== GameKind.Blackjack
    && opts.gameKind !== GameKind.Roulette
    && opts.gameKind !== GameKind.Craps
    && opts.gameKind !== GameKind.Keno
    && opts.gameKind !== GameKind.Slots
    && opts.gameKind !== GameKind.Bingo
  ) {
    throw new Error(`setupCasinoEncryptedTable unsupported kind ${opts.gameKind}`);
  }

  const adminProvider = await loadWhitelistAdminProvider(provider.connection);
  const room =
    opts.gameKind === GameKind.War
      ? new WarRoomLifecycle(pokerProgram, provider)
      : opts.gameKind === GameKind.Baccarat
        ? new BaccaratRoomLifecycle(pokerProgram, provider)
        : opts.gameKind === GameKind.Roulette
          ? new RouletteRoomLifecycle(pokerProgram, provider)
          : opts.gameKind === GameKind.Craps
            ? new CrapsRoomLifecycle(pokerProgram, provider)
            : opts.gameKind === GameKind.Keno
              ? new KenoRoomLifecycle(pokerProgram, provider)
              : opts.gameKind === GameKind.Slots
                ? new SlotsRoomLifecycle(pokerProgram, provider)
                : opts.gameKind === GameKind.Bingo
                  ? new BingoRoomLifecycle(pokerProgram, provider)
                  : new BlackjackRoomLifecycle(pokerProgram, provider);

  const rate = await clusterRentLamportsPerByte(provider.connection);
  const callerInputs = shuffleCallerInputs(opts.gameKind, shoeDecks, rouletteVariant);
  const computationSlots = opts.gameKind === GameKind.Keno
    ? KENO_REVEAL_IN_FLIGHT
    : undefined;
  const seatFloor = seatFloorLamports(callerInputs);
  const authorityKp = (provider.wallet as { payer?: web3.Keypair }).payer;
  const assignedPlayers = takeDevnetPlayers(numPlayers);
  const players: web3.Keypair[] = [];
  while (players.length < numPlayers) {
    const kp = assignedPlayers
      ? assignedPlayers[players.length]!
      : web3.Keypair.generate();
    if (assignedPlayers) await ensureSeatSol(provider, kp.publicKey, seatFloor);
    else await fundSol(provider, kp.publicKey, seatFloor);
    players.push(kp);
  }
  // The last player is the house and sits in the reserved house seat.
  // The operator whitelists that address and does not sit.
  const house = playerPot ? null : players[numPlayers - 1]!;
  const operatorExtra = operatorTableLamports(
    tableSeats,
    { housePool: !playerPot, pokerBetting: false, operatorSeat: false },
    rate,
  );
  const seatExtra = seatTableLamports(rate);
  for (const kp of players) {
    await stagePlayerRent(
      provider,
      adminProvider,
      room.roomId,
      kp.publicKey,
      callerInputs,
      seatExtra,
      computationSlots,
    );
  }
  if (authorityKp) {
    await stagePlayerRent(
      provider,
      adminProvider,
      room.roomId,
      authorityKp.publicKey,
      callerInputs,
      operatorExtra,
      computationSlots,
    );
  }
  if (opts.onStaged) await opts.onStaged();

  await drawTableAccount(provider, authorityKp, provider.wallet.publicKey, SPL_MINT_DATA, rate);
  const mint = await room.createSplMint();
  await drawTableAccount(provider, authorityKp, adminProvider.wallet.publicKey, ROOM_DATA, rate);
  await drawTableAccount(provider, authorityKp, adminProvider.wallet.publicKey, SPL_TOKEN_ACCOUNT_DATA, rate);
  await room.createRoom(mint, adminProvider, room.defaultSmallBlind());

  try {
    await room.initWalletCompDefs();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[casino-table] initWalletCompDefs: ${msg.split('\n')[0]}`);
  }

  // Each seat's whitelist, wallet, and token account are paid from that seat's float.
  // Wide offset space — Arcis mempool PDAs persist for the localnet lifetime.
  let offset = 10_000 + Math.floor(Math.random() * 1_000_000);
  for (const kp of players) {
    const credit = house && kp.publicKey.equals(house.publicKey)
      ? buyIn + dealerPoolStake + 10_000n
      : buyIn;
    await drawTableAccount(provider, kp, adminProvider.wallet.publicKey, WHITELIST_DATA, rate);
    await room.addToWhitelist(kp.publicKey, adminProvider);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, ROOM_WALLET_DATA, rate);
    await room.initRoomWallet(kp);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, SPL_TOKEN_ACCOUNT_DATA, rate);
    const ata = await room.createPlayerTokenAccount(mint, kp.publicKey);
    await room.mintTokens(mint, ata, credit);
    await drawTableAccount(provider, kp, kp.publicKey, PENDING_DEPOSIT_DATA, rate);
    await room.depositSpl(credit, ata, kp);
    await room.requestCreditRoomBalance(credit, offset++, kp);
    await room.waitForRoomWalletCredited(kp.publicKey);
  }
  await drawTableAccount(provider, authorityKp, adminProvider.wallet.publicKey, TABLE_DATA, rate);
  const { tableId, tableState } = await room.createTable(
    adminProvider,
    opts.gameKind,
    shoeDecks,
    rouletteVariant,
  );
  if (!playerPot) {
    await drawTableAccount(provider, authorityKp, provider.wallet.publicKey, DEALER_POOL_DATA, rate);
    await room.initDealerPool(tableId, opts.gameKind);
    await drawTableAccount(provider, authorityKp, provider.wallet.publicKey, PROTOCOL_TREASURY_DATA, rate);
    await room.initProtocolTreasury();
    await drawTableAccount(provider, authorityKp, provider.wallet.publicKey, POOL_STAKE_DATA, rate);
    if (!house) throw new Error('dealer pool stake needs a whitelisted house seat');
    await room.initPoolStake(tableId, house.publicKey);
  }

  // Enc-lock seat bankroll before staking the dealer pool so the plaintext
  // mirror still covers buy-in (stake callback does not debit balance_u64).
  const housePhysical = reservedHouseSeat(opts.gameKind);
  for (let i = 0; i < numPlayers; i++) {
    const kp = players[i]!;
    const physical = housePhysical !== null && i === numPlayers - 1 ? housePhysical : i;
    await drawTableAccount(provider, kp, provider.wallet.publicKey, TABLE_ESCROW_DATA, rate);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, ROOM_SESSION_DATA, rate);
    await drawTableAccount(provider, kp, provider.wallet.publicKey, ROOM_SESSION_LOCK_DATA, rate);
    await room.sitAtTable(tableId, physical, buyIn, kp);
    const wallet = await room.fetchRoomWallet(kp.publicKey);
    const personal = BigInt((wallet.balanceU64 ?? wallet.balance_u64 ?? 0).toString());
    if (personal < buyIn) {
      throw new Error(
        `[casino-table] seat ${i} room wallet balance ${personal} < buyIn ${buyIn}`,
      );
    }
    await room.lockTableBuyin(tableId, buyIn, offset++, kp);
    await room.waitForTableBuyinLocked(tableId, kp.publicKey);
  }

  if (!playerPot) {
    const poolBefore = await room.fetchDealerPool(tableId);
    const poolNonceBefore = BigInt((poolBefore.nonce ?? 0).toString());
    if (!house) throw new Error('dealer pool stake needs a whitelisted house seat');
    await room.stakeDealerPool(tableId, dealerPoolStake, offset++, house);
    await room.waitForDealerPoolStaked(tableId, poolNonceBefore);
  }

  const starter = players[0];
  if (!starter) throw new Error('start_hand needs a seated whitelisted player');
  const gameState = await room.startHand(tableId, gameId, starter);
  // The operator whitelists seats and does not sit, so the in-hand mark is
  // each seated player, including the house on the last seat.
  for (const kp of players) await room.markInHand(tableId, kp);

  const table = await room.fetchTable(tableId);
  const ordered: web3.Keypair[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const seat = Number(table.handSeatOrder[i]);
    const pk = table.seats[seat].toString();
    const kp = players.find((p) => p.publicKey.toBase58() === pk);
    if (!kp) throw new Error(`No keypair for hand seat ${seat}`);
    ordered.push(kp);
  }

  return {
    room,
    tableId,
    players: ordered,
    gameId,
    gameState,
    tableState,
    roomId: room.roomId,
    gameKind: opts.gameKind,
  };
}

export class OnchainBettingManager {
  private arcium: ArciumMPCHelper;
  private polling: ArciumPollingHelper;
  private table?: EncryptedBettingTable;

  constructor(
    private pokerProgram: Program,
    private provider: AnchorProvider,
    private game: Game,
    private tableKey?: TableEncryptionKey,
  ) {
    this.arcium = new ArciumMPCHelper(pokerProgram, provider);
    this.polling = new ArciumPollingHelper(provider);
  }

  /** Attach room/table context required by on-chain `submit_bet`. */
  bindTable(table: EncryptedBettingTable): void {
    this.table = table;
  }

  /** Release builds accept only the whitelist admin. Localnet testing builds accept any signer. */
  private async bettingRoundAuthority(): Promise<web3.Keypair> {
    if (isLocalCluster(this.provider.connection.rpcEndpoint)) {
      const kp = (this.provider.wallet as { payer?: web3.Keypair }).payer;
      if (!kp) throw new Error('provider wallet has no keypair');
      return kp;
    }
    const admin = await loadWhitelistAdminProvider(this.provider.connection);
    return (admin.wallet as KeypairWallet).payer;
  }

  startBettingRound(phase: BettingPhase) {
    try {
      this.game.startBettingRound(phase);
    } catch {
      // Isolated circuit tests may not have a fully initialized off-chain Game.
    }
  }

  encryptedBettingPda(gameId: Uint8Array): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('encrypted_betting'), Buffer.from(gameId)],
      this.pokerProgram.programId,
    )[0];
  }

  async ensureBettingAccounts(gameId: Uint8Array, numPlayers: number): Promise<void> {
    const gameState = this.gameStatePDA(gameId);
    await (this.pokerProgram.methods as any)
      .initEncryptedGameBetting()
      .accounts({
        payer: this.provider.wallet.publicKey,
        gameState,
        encryptedGameBetting: this.encryptedBettingPda(gameId),
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc()
      .catch(() => {});
    await (this.pokerProgram.methods as any)
      .initBetActionLog()
      .accounts({
        payer: this.provider.wallet.publicKey,
        gameState,
        betActionLog: web3.PublicKey.findProgramAddressSync(
          [Buffer.from('bet_action_log'), Buffer.from(gameId)],
          this.pokerProgram.programId,
        )[0],
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc()
      .catch(() => {});

    for (let p = 0; p < numPlayers; p++) {
      await this.arcium.initPlayerGameEscrow(gameId, p).catch(() => {});
      // Isolated betting tests: PlayerState without Groth16 register.
      await (this.pokerProgram.methods as any)
        .initPlayerState(p)
        .accounts({
          payer: this.provider.wallet.publicKey,
          gameState,
          playerState: this.playerStatePDA(gameId, p),
          systemProgram: web3.SystemProgram.programId,
        })
        .rpc()
        .catch(() => {});
    }
  }

  async startOnchainBettingRound(
    gameId: Uint8Array,
    phase: BettingPhase,
    smallBlind = 0n,
    bigBlind = 0n,
  ): Promise<void> {
    const gameState = this.gameStatePDA(gameId);
    const encryptedBetting = this.encryptedBettingPda(gameId);

    if (smallBlind > 0n || bigBlind > 0n) {
      // Anchor Option accounts still require the key — pass PDA (must exist).
      await (this.pokerProgram.methods as any)
        .collectBlinds(new BN(smallBlind.toString()), new BN(bigBlind.toString()))
        .accountsPartial({
          authority: this.provider.wallet.publicKey,
          gameState,
          encryptedGameBetting: encryptedBetting,
        })
        .rpc();
    }

    if (phase !== 'PreFlop') {
      // Streets advance only via Enc bet callbacks — do not force-select phase.
      throw new Error(
        `startOnchainBettingRound: only PreFlop may be opened on-chain (got ${phase}); ` +
          'later streets advance via validate_bet callbacks',
      );
    }
    const authority = await this.bettingRoundAuthority();
    await (this.pokerProgram.methods as any)
      .openPreflop()
      .accounts({
        authority: authority.publicKey,
        gameState,
      })
      .signers(authority.publicKey.equals(this.provider.wallet.publicKey) ? [] : [authority])
      .rpc();
    this.startBettingRound(phase);
  }

  async placeBet(
    gameId: Uint8Array,
    playerIndex: number,
    action: string,
    amount: bigint,
    offset: number | BN,
    ctx?: {
      playerBalance: bigint;
      playerCurrentBet: bigint;
      currentBet: bigint;
      lastAggressorAmount: bigint;
      showOnFold?: boolean;
    },
  ): Promise<void> {
    const table = this.table;
    if (!table) {
      throw new Error(
        'OnchainBettingManager.bindTable() required before placeBet — '
        + 'submit_bet needs table_state + whitelist + player signer',
      );
    }
    if (!this.tableKey) {
      throw new Error('tableKey required for encrypted validate_bet payloads');
    }

    const actionCode = ACTION_MAP[action];
    if (actionCode === undefined) throw new Error(`Unknown action: ${action}`);

    const player = table.players[playerIndex];
    if (!player) throw new Error(`No keypair for playerIndex ${playerIndex}`);

    const enc = await encryptBetPayload(this.tableKey, this.provider, this.pokerProgram.programId, {
      playerBalance: ctx?.playerBalance ?? 1000n,
      playerCurrentBet: ctx?.playerCurrentBet ?? 0n,
      action: BigInt(actionCode),
      actionAmount: amount,
      currentBet: ctx?.currentBet ?? 0n,
      lastAggressorAmount: ctx?.lastAggressorAmount ?? 0n,
    });
    const [
      encryptedPlayerBalance,
      encryptedPlayerCurrentBet,
      encryptedAction,
      encryptedAmount,
      encryptedCurrentBet,
      encryptedLastAggressorAmount,
    ] = enc.ciphertexts;

    const offsetBn = typeof offset === 'number' ? new BN(offset) : offset;
    const toArr = (b: Uint8Array) => Array.from(b);
    const showOnFold = ctx?.showOnFold === true && action === 'fold';

    await this.arcium.payComputationFromFloat(offsetBn, () =>
      (this.pokerProgram.methods as any)
      .submitBet(
        actionCode,
        toArr(encryptedAction!),
        toArr(encryptedAmount!),
        toArr(encryptedPlayerBalance!),
        toArr(encryptedPlayerCurrentBet!),
        toArr(encryptedCurrentBet!),
        toArr(encryptedLastAggressorAmount!),
        toArr(enc.encryptionPubkey),
        new BN(enc.nonce.toString()),
        offsetBn,
        showOnFold,
      )
      .accountsPartial({
        payer: this.provider.wallet.publicKey,
        player: player.publicKey,
        whitelistEntry: table.room.whitelistPDA(player.publicKey),
        gameState: this.gameStatePDA(gameId),
        tableState: table.tableState,
        playerState: this.playerStatePDA(gameId, playerIndex),
        tableEscrow: table.room.tableEscrowPDA(player.publicKey, table.tableId),
        ...this.arcium.arciumQueueAccounts(offsetBn, 'validateBet'),
      })
      .preInstructions([
        web3.ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .signers([player])
      .rpc(),
    );
    this.arcium.noteComputation(offsetBn);

    if (action === 'fold') {
      try { this.game.playerFold(playerIndex); } catch { /* off-chain optional */ }
    } else {
      try { this.game.playerBet(playerIndex, amount); } catch { /* off-chain optional */ }
    }
  }

  /**
   * Wait until validate_bet callback applied.
   *
   * Pass `before` captured immediately **before** `placeBet` — after a heads-up
   * completing call the street may close with the same `current_player` (SB acts
   * first on the next street).
   */
  async waitForTurnAdvance(
    gameId: Uint8Array,
    fromPlayer: number,
    timeoutMs = 120_000,
    before?: { bettingPhase: number; foldedMask: number },
  ): Promise<any> {
    const gameStatePda = this.gameStatePDA(gameId);
    const snapshot = before
      ?? await (this.pokerProgram.account as any).gameState.fetch(gameStatePda);
    const beforeBp = before?.bettingPhase ?? Number(snapshot.bettingPhase);
    const beforeFolded = before?.foldedMask ?? Number(snapshot.foldedMask);

    const advanced = await this.polling.waitForCallback(
      gameStatePda,
      async (pda) => (this.pokerProgram.account as any).gameState.fetch(pda),
      (state: any) => {
        const nextBp = Number(state.bettingPhase);
        const nextPlayer = Number(state.currentPlayer);
        const nextFolded = Number(state.foldedMask);
        return nextBp !== beforeBp
          || nextPlayer !== fromPlayer
          || nextFolded !== beforeFolded;
      },
      { timeout: timeoutMs, interval: 2000 },
    );
    await this.arcium.reclaimFinalizedComputations();
    return advanced;
  }

  private gameStatePDA(gameId: Uint8Array): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('game_state'), Buffer.from(gameId)],
      this.pokerProgram.programId,
    )[0];
  }

  private playerStatePDA(gameId: Uint8Array, playerIndex: number): web3.PublicKey {
    return web3.PublicKey.findProgramAddressSync(
      [Buffer.from('player'), Buffer.from(gameId), Buffer.from([playerIndex])],
      this.pokerProgram.programId,
    )[0];
  }
}
