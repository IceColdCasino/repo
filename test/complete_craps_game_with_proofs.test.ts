import './helpers/require-player-ffi';
import { MAX_PLAYERS, type CrapsBet } from '../src/craps';
import { Game } from '../src/craps-game';
import { Player, loadCrapsCircuits, type CrapsCircuits } from '../src/craps-player';
import { CrapsBetType, CRAPS_SHOWDOWN_TERMS } from '../src/craps-eval';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';

const showdownVkPath = path.join(
  __dirname,
  '../zkey/craps_showdown_hashout_main_verification_key.json',
);

function sampleBets(playerIndex: number): CrapsBet[] {
  return [
    [CrapsBetType.Pass, 0],
    [CrapsBetType.Field, 0],
    [CrapsBetType.Proposition, playerIndex % 7],
  ];
}

async function register(nActualPlayers: number, circuits: CrapsCircuits, game: Game) {
  const players: Player[] = [];
  for (let p = 0; p < nActualPlayers; p++) {
    const player = new Player(circuits);
    await player.init();
    player.generateKey();
    const { proof, publicSignals } = await player.registerProve();
    game.addPlayer(proof, publicSignals);
    players.push(player);
  }
  return players;
}

async function bet(game: Game, players: Player[], nActualPlayers: number, betsPerPlayer: CrapsBet[][]) {
  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    const { proof, publicSignals, encryptedBets, nActualBets } =
      await players[p]!.betProve(game.housePublicKey, betsPerPlayer[p]!);
    game.bet(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      encryptedBets,
      nActualBets,
    });
  }
}

async function shuffle(game: Game, players: Player[]) {
  for (let p = 0; p < game.nPlayers; p++) {
    const { proof, publicSignals, dice } = await players[p]!.shuffleProve(game.dice, game.publicKeys);
    game.shuffle(proof, publicSignals, { publicKey: players[p]!.publicKey, dice });
    if (p + 1 < game.nPlayers) {
      players[p + 1]!.preloadShuffle(game.dice, game.publicKeys);
    }
  }
}

async function share(game: Game, players: Player[], nActualPlayers: number) {
  for (let p = 0; p < nActualPlayers; p++) {
    const { proof, publicSignals, ciphertexts } = await players[p]!.shareProve(
      game.finalShuffledDeck,
      game.publicKeysShare(p),
      nActualPlayers,
    );
    game.share(proof, publicSignals, { publicKey: players[p]!.publicKey, ciphertexts });
  }
}

async function showdown(
  game: Game,
  players: Player[],
  nActualPlayers: number,
  betsPerPlayer: CrapsBet[][],
) {
  let expectedDice: string | undefined;
  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    players[p]!.setSealedCoefficients(hostShowdownCoefficients(CRAPS_SHOWDOWN_TERMS));
    const { proof, publicSignals, plaintextDice, results } = await players[p]!.showdownProve(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
      game.getEncryptedBetsForPlayer(p),
      betsPerPlayer[p]!,
      game.getNActualBetsForPlayer(p),
      game.tablePhase,
      game.tablePoint,
    );
    expect(results.length).toBe(CRAPS_SHOWDOWN_TERMS);
    if (expectedDice === undefined) {
      expectedDice = plaintextDice.join(',');
      const result = game.verifyShowdown(proof, publicSignals, { publicKey: players[p]!.publicKey });
      expect(result).toBe(BigInt(publicSignals[0]!));
    } else {
      expect(plaintextDice.join(',')).toBe(expectedDice);
      expect(verify(proof, publicSignals, showdownVkPath)).toBe(true);
    }
  }
}

let circuits: CrapsCircuits;

beforeAll(async () => {
  circuits = await loadCrapsCircuits();
});

async function runGame(nActualPlayers: number) {
  const game = new Game(0, 0, 0);
  await game.init();
  expect(game.phase).toBe('Registration');

  const players = await register(nActualPlayers, circuits, game);
  const betsPerPlayer = Array.from({ length: nActualPlayers }, (_, i) =>
    game.isDealer(i) ? [] : sampleBets(i),
  );

  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_PLAYERS);
  expect(game.phase).toBe('Shuffle');

  players[0]!.preloadShuffle(game.dice, game.publicKeys);
  await shuffle(game, players);
  expect(game.phase).toBe('Share');

  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadBet(game.housePublicKey, betsPerPlayer[p]!);
  }
  await bet(game, players, nActualPlayers, betsPerPlayer);

  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadShare(game.finalShuffledDeck, game.publicKeysShare(p), nActualPlayers);
  }
  await share(game, players, nActualPlayers);
  expect(game.phase).toBe('Showdown');

  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    players[p]!.preloadShowdown(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
      game.getEncryptedBetsForPlayer(p),
      betsPerPlayer[p]!,
      game.getNActualBetsForPlayer(p),
      game.tablePhase,
      game.tablePoint,
    );
  }
  await showdown(game, players, nActualPlayers, betsPerPlayer);
  expect(game.phase).toBe('Complete');
}

test('Complete Craps Game with 2 players (bet after shuffle, before reveal)', async () => {
  await runGame(2);
}, 300_000);
