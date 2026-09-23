import './helpers/require-player-ffi';
import { MAX_PLAYERS, MAX_BETS, type RouletteBet, type RouletteVariant } from '../src/roulette';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';
import { Game } from '../src/roulette-game';
import { Player, loadRouletteCircuits, type RouletteCircuits } from '../src/roulette-player';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';

function showdownVkPath(variant: RouletteVariant) {
  return path.join(
    __dirname,
    `../zkey/roulette_showdown_${variant}_hashout_main_verification_key.json`,
  );
}

/** Sample bets: straight-up (incl. mod≥6) + even-money red (valid EU/US). */
function sampleBets(playerIndex: number): RouletteBet[] {
  return [
    [0, (playerIndex * 7 + 17) % 37], // straight-up
    [10, playerIndex % 2], // red/black
  ];
}

async function register(
  nActualPlayers: number,
  circuits: RouletteCircuits,
  game: Game,
  variant: RouletteVariant,
) {
  const players: Player[] = [];

  for (let p = 0; p < nActualPlayers; p++) {
    const player = new Player(circuits, variant);
    await player.init();
    player.generateKey();

    console.time(`Register Prove ${p}`);
    const { proof, publicSignals } = await player.registerProve();
    console.timeEnd(`Register Prove ${p}`);

    console.time(`Game Add Player ${p}`);
    game.addPlayer(proof, publicSignals);
    console.timeEnd(`Game Add Player ${p}`);

    players.push(player);
  }

  return players;
}

async function shuffle(game: Game, players: Player[]) {
  for (let p = 0; p < game.nPlayers; p++) {
    console.time(`Shuffle Prove ${p}`);
    const { proof, publicSignals, deck: outputDeck, permutationHash } =
      await players[p]!.shuffleProve(game.deck, game.publicKeys);
    console.timeEnd(`Shuffle Prove ${p}`);

    console.time(`Game verify shuffle ${p}`);
    game.shuffle(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      deck: outputDeck,
      permutationHash,
    });
    console.timeEnd(`Game verify shuffle ${p}`);

    if (p + 1 < game.nPlayers) {
      console.time(`  Preload Shuffle ${p + 1}`);
      players[p + 1]!.preloadShuffle(game.deck, game.publicKeys);
      console.timeEnd(`  Preload Shuffle ${p + 1}`);
    }
  }
}

async function bet(
  game: Game,
  players: Player[],
  nActualPlayers: number,
  betsPerPlayer: RouletteBet[][],
) {
  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    const player = players[p]!;
    const bets = betsPerPlayer[p]!;
    console.time(`Bet Prove ${p}`);
    const { proof, publicSignals, encryptedBets, nActualBets } =
      await player.betProve(game.housePublicKey, bets);
    console.timeEnd(`Bet Prove ${p}`);
    console.time(`Game Bet ${p}`);
    game.bet(proof, publicSignals, {
      publicKey: player.publicKey,
      encryptedBets,
      nActualBets,
    });
    console.timeEnd(`Game Bet ${p}`);
  }
}

async function share(
  game: Game,
  players: Player[],
  nActualPlayers: number,
) {
  for (let p = 0; p < nActualPlayers; p++) {
    const player = players[p]!;

    console.time(`Share Prove ${p}`);
    const { proof, publicSignals, ciphertexts } =
      await player.shareProve(
        game.finalShuffledDeck,
        game.publicKeysShare(p),
        nActualPlayers,
      );
    console.timeEnd(`Share Prove ${p}`);

    console.time(`Game Share ${p}`);
    game.share(proof, publicSignals, {
      publicKey: player.publicKey,
      ciphertexts,
    });
    console.timeEnd(`Game Share ${p}`);
  }
}

async function showdown(
  game: Game,
  players: Player[],
  nActualPlayers: number,
  betsPerPlayer: RouletteBet[][],
  variant: RouletteVariant,
) {
  let expectedCard: bigint | undefined;

  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    const player = players[p]!;
    const bets = betsPerPlayer[p]!;
    const ciphertextBets = game.getEncryptedBetsForPlayer(p);
    const nActualBets = game.getNActualBetsForPlayer(p);

    player.setSealedCoefficients(hostShowdownCoefficients(MAX_BETS));
    console.time(`Showdown Prove ${p}`);
    const { proof, publicSignals, publicKey, plaintextCard, payouts } =
      await player.showdownProve(
        game.publicKeys,
        game.finalShuffledDeck,
        game.getCiphertextPartialsForPlayer(p),
        ciphertextBets,
        bets,
        nActualBets,
      );
    console.timeEnd(`Showdown Prove ${p}`);

    expect(payouts.length).toBe(12);

    if (expectedCard === undefined) {
      expectedCard = plaintextCard;

      console.time(`Game Verify Showdown ${p}`);
      const result = game.verifyShowdown(proof, publicSignals, { publicKey });
      console.timeEnd(`Game Verify Showdown ${p}`);
      expect(result).toBe(BigInt(publicSignals[0]!));
    } else {
      expect(plaintextCard).toBe(expectedCard);
      expect(verify(proof, publicSignals, showdownVkPath(variant))).toBe(true);
    }
  }
}

const circuitsByVariant: Partial<Record<RouletteVariant, RouletteCircuits>> = {};

async function circuitsFor(variant: RouletteVariant): Promise<RouletteCircuits> {
  if (!circuitsByVariant[variant]) {
    circuitsByVariant[variant] = await loadRouletteCircuits(variant);
  }
  return circuitsByVariant[variant]!;
}

async function runGame(nActualPlayers: number, variant: RouletteVariant) {
  const circuits = await circuitsFor(variant);
  const game = new Game(variant);
  await game.init();

  expect(game.phase).toBe('Registration');
  expect(game.deckSize).toBe(variant);

  const players = await register(nActualPlayers, circuits, game, variant);
  // House (default seat 0) never submits a bet proof.
  const betsPerPlayer = Array.from({ length: nActualPlayers }, (_, i) =>
    game.isDealer(i) ? [] : sampleBets(i),
  );

  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_PLAYERS);
  expect(game.phase).toBe('Shuffle');

  console.time('Preload shuffle 0');
  players[0]!.preloadShuffle(game.deck, game.publicKeys);
  console.timeEnd('Preload shuffle 0');

  await shuffle(game, players);

  expect(game.phase).toBe('Share');

  console.time('Preload all bets');
  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadBet(game.housePublicKey, betsPerPlayer[p]!);
  }
  console.timeEnd('Preload all bets');
  await bet(game, players, nActualPlayers, betsPerPlayer);

  console.time('Preload all share');
  for (let p = 0; p < nActualPlayers; p++) {
    console.time(`  Preload Share ${p}`);
    players[p]!.preloadShare(
      game.finalShuffledDeck,
      game.publicKeysShare(p),
      nActualPlayers,
    );
    console.timeEnd(`  Preload Share ${p}`);
  }
  console.timeEnd('Preload all share');

  await share(game, players, nActualPlayers);

  expect(game.phase).toBe('Showdown');

  console.time('Preload all showdown');
  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    console.time(`  Preload Showdown ${p}`);
    players[p]!.preloadShowdown(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
      game.getEncryptedBetsForPlayer(p),
      betsPerPlayer[p]!,
      game.getNActualBetsForPlayer(p),
    );
    console.timeEnd(`  Preload Showdown ${p}`);
  }
  console.timeEnd('Preload all showdown');

  await showdown(game, players, nActualPlayers, betsPerPlayer, variant);

  expect(game.phase).toBe('Complete');
}

test('Complete Roulette EU (37) Game with 2 players', async () => {
  await runGame(2, 37);
}, 300_000);

test('Complete Roulette US (38) Game with 2 players', async () => {
  await runGame(2, 38);
}, 300_000);

test('Complete Roulette EU (37) Game with 3 players', async () => {
  await runGame(3, 37);
}, 600_000);
