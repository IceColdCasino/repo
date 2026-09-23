import './helpers/require-player-ffi';
import { MAX_PLAYERS } from '../src/keno';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';
import { Game } from '../src/keno-game';
import { Player, loadKenoCircuits, type KenoCircuits } from '../src/keno-player';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';

const showdownVkPath = path.join(
  __dirname,
  '../zkey/keno_showdown_hashout_main_verification_key.json',
);

function sampleTicket(playerIndex: number): number[] {
  return [1 + playerIndex, 7, 19, 33, 44, 56, 68];
}

async function register(nActualPlayers: number, circuits: KenoCircuits, game: Game) {
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

async function bet(game: Game, players: Player[], nActualPlayers: number, tickets: number[][]) {
  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    const { proof, publicSignals, encryptedBets, nActualBets } =
      await players[p]!.betProve(game.housePublicKey, tickets[p]!);
    game.bet(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      encryptedBets,
      nActualBets,
    });
  }
}

async function shuffle(game: Game, players: Player[]) {
  for (let p = 0; p < game.nPlayers; p++) {
    const { proof, publicSignals, deck, permutationHash } =
      await players[p]!.shuffleProve(game.deck, game.publicKeys);
    game.shuffle(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      deck,
      permutationHash,
    });
    if (p + 1 < game.nPlayers) {
      players[p + 1]!.preloadShuffle(game.deck, game.publicKeys);
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
  tickets: number[][],
) {
  let expectedDraw: string | undefined;
  for (let p = 0; p < nActualPlayers; p++) {
    if (game.isDealer(p)) continue;
    players[p]!.setSealedCoefficients(hostShowdownCoefficients(1));
    const { proof, publicSignals, plaintextDraw } = await players[p]!.showdownProve(
      game.publicKeys,
      game.finalShuffledDeck,
      game.getCiphertextPartialsForPlayer(p),
      game.getEncryptedBetsForPlayer(p),
      tickets[p]!,
      game.getNActualBetsForPlayer(p),
    );
    if (expectedDraw === undefined) {
      expectedDraw = plaintextDraw.join(',');
      const result = game.verifyShowdown(proof, publicSignals, { publicKey: players[p]!.publicKey });
      expect(result).toBe(BigInt(publicSignals[0]!));
    } else {
      expect(plaintextDraw.join(',')).toBe(expectedDraw);
      expect(verify(proof, publicSignals, showdownVkPath)).toBe(true);
    }
  }
}

let circuits: KenoCircuits;

beforeAll(async () => {
  circuits = await loadKenoCircuits();
});

async function runGame(nActualPlayers: number) {
  const game = new Game(0);
  await game.init();
  expect(game.phase).toBe('Registration');

  const players = await register(nActualPlayers, circuits, game);
  const tickets = Array.from({ length: nActualPlayers }, (_, i) =>
    game.isDealer(i) ? [] : sampleTicket(i),
  );

  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_PLAYERS);

  players[0]!.preloadShuffle(game.deck, game.publicKeys);
  await shuffle(game, players);
  expect(game.phase).toBe('Share');

  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadBet(game.housePublicKey, tickets[p]!);
  }
  await bet(game, players, nActualPlayers, tickets);

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
      tickets[p]!,
      game.getNActualBetsForPlayer(p),
    );
  }
  await showdown(game, players, nActualPlayers, tickets);
  expect(game.phase).toBe('Complete');
}

test('Complete Keno Game with 2 players (bet after shuffle, before reveal)', async () => {
  await runGame(2);
}, 600_000);
