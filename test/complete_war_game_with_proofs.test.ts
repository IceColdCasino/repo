import './helpers/require-player-ffi';
import { MAX_PLAYERS } from '../src/war';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';
import { Game } from '../src/war-game';
import { Player, loadWarCircuits, type WarCircuits } from '../src/war-player';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';

const showdownVkPath = path.join(
  __dirname,
  '../zkey/war_showdown_hashout_main_verification_key.json',
);

async function register(nActualPlayers: number, circuits: WarCircuits, game: Game) {
  const players: Player[] = [];

  for (let p = 0; p < nActualPlayers; p++) {
    const player = new Player(circuits);
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

async function share(game: Game, players: Player[], nActualPlayers: number) {
  for (let p = 0; p < nActualPlayers; p++) {
    const player = players[p]!;

    console.time(`Share Prove ${p}`);
    const { proof, publicSignals, ciphertexts } = await player.shareProve(
      game.finalShuffledDeck,
      game.publicKeysShare(p),
      nActualPlayers,
    );
    console.timeEnd(`Share Prove ${p}`);

    console.time(`Game Share ${p}`);
    game.share(proof, publicSignals, { publicKey: player.publicKey, ciphertexts });
    console.timeEnd(`Game Share ${p}`);
  }
}

async function showdown(game: Game, players: Player[], nActualPlayers: number) {
  let expectedWinner: bigint | undefined;

  for (let p = 0; p < nActualPlayers; p++) {
    const player = players[p]!;

    player.setSealedCoefficients(hostShowdownCoefficients(1));
    console.time(`Showdown Prove ${p}`);
    const { proof, publicSignals, publicKey, winner } = await player.showdownProve(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
    );
    console.timeEnd(`Showdown Prove ${p}`);

    if (expectedWinner === undefined) {
      expectedWinner = winner;

      console.time(`Game Verify Showdown ${p}`);
      const result = game.verifyShowdown(proof, publicSignals, { publicKey });
      console.timeEnd(`Game Verify Showdown ${p}`);
      expect(result).toBe(BigInt(publicSignals[0]!));
    } else {
      expect(winner).toBe(expectedWinner);
      expect(verify(proof, publicSignals, showdownVkPath)).toBe(true);
    }
  }
}

let circuits: WarCircuits;

beforeAll(async () => {
  circuits = await loadWarCircuits();
});

async function runGame(nActualPlayers: number) {
  const game = new Game();
  await game.init();

  expect(game.phase).toBe('Registration');

  const players = await register(nActualPlayers, circuits, game);

  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_PLAYERS);
  expect(game.phase).toBe('Shuffle');

  console.time('Preload shuffle 0');
  players[0]!.preloadShuffle(game.deck, game.publicKeys);
  console.timeEnd('Preload shuffle 0');

  await shuffle(game, players);

  expect(game.phase).toBe('Share');

  console.time('Preload all share');
  for (let p = 0; p < nActualPlayers; p++) {
    console.time(`  Preload Share ${p}`);
    players[p]!.preloadShare(game.finalShuffledDeck, game.publicKeysShare(p), nActualPlayers);
    console.timeEnd(`  Preload Share ${p}`);
  }
  console.timeEnd('Preload all share');

  await share(game, players, nActualPlayers);

  expect(game.phase).toBe('Showdown');

  console.time('Preload all showdown');
  for (let p = 0; p < nActualPlayers; p++) {
    console.time(`  Preload Showdown ${p}`);
    players[p]!.preloadShowdown(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
    );
    console.timeEnd(`  Preload Showdown ${p}`);
  }
  console.timeEnd('Preload all showdown');

  await showdown(game, players, nActualPlayers);

  expect(game.phase).toBe('Complete');
}

test('Complete War Game with 2 players', async () => {
  await runGame(2);
}, 600_000);

test('Complete War Game with 3 players', async () => {
  await runGame(3);
}, 600_000);

test('Complete War Game with 10 players', async () => {
  await runGame(10);
}, 1_200_000);

test('Complete War Game with 12 players', async () => {
  await runGame(12);
}, 1_800_000);

test('War multi-seat player and dealer pools settle proportionally', async () => {
  const game = new Game();
  await game.init();

  const players = await register(4, circuits, game);
  game.start(
    { playerSeats: [0, 2], dealerSeats: [1, 3] },
    [{ seatIndex: 0, stake: 10n }, { seatIndex: 2, stake: 20n }],
    [{ seatIndex: 1, stake: 1n }, { seatIndex: 3, stake: 2n }],
  );

  expect(game.seatPools).toEqual({ playerSeats: [0, 2], dealerSeats: [1, 3] });

  players[0]!.preloadShuffle(game.deck, game.publicKeys);
  await shuffle(game, players);
  for (let p = 0; p < 4; p++) {
    players[p]!.preloadShare(game.finalShuffledDeck, game.publicKeysShare(p), 4);
  }
  await share(game, players, 4);
  for (let p = 0; p < 4; p++) {
    players[p]!.preloadShowdown(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
    );
  }
  await showdown(game, players, 4);

  const nets = game.settleHand(0);
  expect(nets.get(0)).toBe(10n);
  expect(nets.get(2)).toBe(20n);
  expect(nets.get(1)).toBe(-10n);
  expect(nets.get(3)).toBe(-20n);
}, 900_000);