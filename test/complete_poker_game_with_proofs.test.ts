import './helpers/require-player-ffi';
import { MAX_PLAYERS } from '../src/poker';
import { Game } from '../src/poker-game';
import { Player } from '../src/poker-player';
import { preloadCircuits, type Circuits } from '../src/circuit-manager';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';

async function register(nActualPlayers: number, circuits: Circuits, game: Game) {
  const players: Player[] = [];

  for (let p = 0; p < nActualPlayers; p++) {
    const player = new Player(circuits);
    await player.init();
    player.generateKey();

    console.time(`Register Prove ${p}`);
    const { proof, publicSignals, publicKey, padding } = await player.registerProve();
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
    console.time(`Shuffle Add Randomness Prove ${p}`);
    const { proof, publicSignals, deck: outputDeck, permutationHash } = await players[p]!.shuffleProve(game.deck, game.publicKeys);
    console.timeEnd(`Shuffle Add Randomness Prove ${p}`);

    console.time(`Game verify shuffle ${p}`);
    game.shuffle(proof, publicSignals, { publicKey: players[p]!.publicKey, deck: outputDeck, permutationHash } );
    console.timeEnd(`Game verify shuffle ${p}`);

    // Preload next player's shuffle witness (deck is now updated)
    if (p + 1 < game.nPlayers) {
      console.time(`  Preload Shuffle ${p + 1}`);
      players[p + 1]!.preloadShuffle(game.deck, game.publicKeys);
      console.timeEnd(`  Preload Shuffle ${p + 1}`);
    }
  }
}

async function share(game: Game, players: Player[], toFold: (p: number) => boolean = (p: number) => false) {
  for (let p = 0; p < game.nPlayers; p++) {
    const player = players[p]!;

    console.time(`Share Partials Prove ${p}`);
    const { proof, publicSignals, ciphertexts } = await player.shareProve(
      game.finalShuffledDeck,
      game.publicKeysShare(p),
      game.nPlayers,
    );
    console.timeEnd(`Share Partials Prove ${p}`);

    console.time(`Game Share Partials ${p}`);
    if (toFold(p)) {
      game.fold(proof, publicSignals, { publicKey: player.publicKey, ciphertexts });
    } else {
      game.share(proof, publicSignals, { publicKey: player.publicKey, ciphertexts });
    }
    console.timeEnd(`Game Share Partials ${p}`);
  }
}

async function showdown(game: Game, players: Player[]) {
  let lastResult;
  for (let p = 0; p < game.nPlayers; p++) {
    const player = players[p]!;
    
    player.setSealedCoefficients(hostShowdownCoefficients(MAX_PLAYERS - 1));
    console.time(`Showdown Prove ${p}`);
    const { proof, publicSignals, publicKey, winnerMasks, coefficientCommitment } = await player.showdownProve(
      p,
      game.publicKeys,
      game.potMasks,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p)
    );
    console.timeEnd(`Showdown Prove ${p}`);
    
    console.time(`Game Verify Showdown ${p}`);
    const result = game.verifyShowdown(proof, publicSignals, { winnerMasks, publicKey, coefficientCommitment });
    console.timeEnd(`Game Verify Showdown ${p}`);
    
    if (lastResult) {
      expect(result).toEqual(lastResult);
    }

    lastResult = result;
  }
}

let circuits: Circuits;

beforeAll(async () => {
  circuits = await preloadCircuits();
});

async function runGame(nActualPlayers = 2, toFold: (p: number) => boolean = () => false) {
  const circuits = await preloadCircuits();
  const game = new Game();
  await game.init();

  expect(game.phase).toBe('Registration');

  const players = await register(nActualPlayers, circuits, game);
  
  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_PLAYERS);
  expect(game.phase).toBe('Shuffle');

  // Preload first player's shuffle witness before shuffle phase.
  // Subsequent players' decks depend on previous shuffles.
  console.time('Preload shuffle 0');
  players[0]!.preloadShuffle(game.deck, game.publicKeys);
  console.timeEnd('Preload shuffle 0');

  await shuffle(game, players);

  expect(game.phase).toBe('Share');

  // Preload all share partials witnesses in parallel before share partials phase
  console.time('Preload all share partials');
  for (let p = 0; p < nActualPlayers; p++) {
    console.time(`  Preload Share Partials ${p}`);
    players[p]!.preloadShare(game.finalShuffledDeck, game.publicKeysShare(p), nActualPlayers);
    console.timeEnd(`  Preload Share Partials ${p}`);
  }
  console.timeEnd('Preload all share partials');

  await share(game, players, toFold);

  expect(game.phase).toBe('Evaluation');

  // Preload all decrypt-compare witnesses in parallel before decrypt phase
  console.time('Preload all showdown');
  for (let p = 0; p < nActualPlayers; p++) {
    if (!toFold(p)) {
      console.time(`  Preload showdown ${p}`);
      players[p]!.preloadShowdown(
        p,
        game.publicKeys,
        game.potMasks,
        game.finalShuffledDeck,
        game.getCiphertextPartialsForPlayer(p)
      );
      console.timeEnd(`  Preload showdown ${p}`);
    }
  }
  console.timeEnd('Preload all showdown');

  await showdown(game, players);

  expect(game.phase).toBe('Complete');
}

test('Complete Game with 2 players', async () => {
  await runGame();
}, 600_000);

test('Complete Game with 3 players, 1 folds', async () => {
  await runGame(3, p => p === 0);
}, 600_000);

test('Complete Game with 10 players, 5 fold', async () => {
  await runGame(10, p => p % 2 === 0);
}, 900_000);

test('Complete Game with 10 players', async () => {
  await runGame(10);
}, 900_000);
