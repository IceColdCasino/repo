import './helpers/require-player-ffi';
import { expect, test } from 'bun:test';
import { Game } from '../src/bingo-game';
import { Player, loadBingoCircuits, type BingoCircuits } from '../src/bingo-player';
import { sampleBingo75Card, sampleBingo90Card } from '../src/bingo-eval';
import { MAX_PLAYERS, type BingoVariant } from '../src/bingo';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';

function showdownVkPath(variant: BingoVariant) {
  return path.join(__dirname, `../zkey/bingo_showdown_${variant}_hashout_main_verification_key.json`);
}

async function register(nActualPlayers: number, circuits: BingoCircuits, game: Game, variant: BingoVariant) {
  const players: Player[] = [];
  for (let p = 0; p < nActualPlayers; p++) {
    const player = new Player(circuits, variant);
    await player.init();
    player.generateKey();
    const { proof, publicSignals } = await player.registerProve();
    game.addPlayer(proof, publicSignals);
    players.push(player);
  }
  return players;
}

async function commitCards(game: Game, players: Player[], cards: number[][]) {
  for (let p = 0; p < players.length; p++) {
    const { proof, publicSignals, encryptedCells, plaintextCells } =
      await players[p]!.cardProve(cards[p]!);
    game.cardCommit(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      encryptedCells,
      plaintextCells,
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

async function shareChunk(game: Game, players: Player[], nActualPlayers: number, chunkIndex: number) {
  const chunk = game.chunkDeck(chunkIndex);
  for (let p = 0; p < nActualPlayers; p++) {
    const { proof, publicSignals, ciphertexts } = await players[p]!.shareProve(
      chunk,
      game.publicKeysShare(p),
      nActualPlayers,
    );
    game.share(proof, publicSignals, { publicKey: players[p]!.publicKey, ciphertexts }, chunkIndex);
  }
}

async function showdown(game: Game, players: Player[], nActualPlayers: number, cards: number[][]) {
  let expectedBalls: string | undefined;
  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.setSealedCoefficients(hostShowdownCoefficients(players[p]!.variant === 90 ? 3 : 1));
    const { proof, publicSignals, plaintextBalls } = await players[p]!.showdownProve(
      game.publicKeys,
      game.showdownCiphertextCards(),
      game.getCiphertextPartialsForPlayer(p),
      game.getEncryptedCardForPlayer(p),
      cards[p]!,
      game.nCalled,
      game.patternId,
    );
    if (expectedBalls === undefined) {
      expectedBalls = plaintextBalls.join(',');
      const result = game.verifyShowdown(proof, publicSignals, { publicKey: players[p]!.publicKey });
      expect(result).toBe(BigInt(publicSignals[0]!));
    } else {
      expect(plaintextBalls.join(',')).toBe(expectedBalls);
      expect(verify(proof, publicSignals, showdownVkPath(game.variant))).toBe(true);
    }
  }
}

async function runGame(variant: BingoVariant, nActualPlayers: number) {
  const circuits = await loadBingoCircuits(variant);
  const game = new Game(variant);
  await game.init();
  expect(game.phase).toBe('Registration');

  const players = await register(nActualPlayers, circuits, game, variant);
  const cards = Array.from({ length: nActualPlayers }, (_, i) =>
    variant === 75 ? sampleBingo75Card(i) : sampleBingo90Card(i),
  );

  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_PLAYERS);

  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadCard(cards[p]!);
  }
  await commitCards(game, players, cards);

  players[0]!.preloadShuffle(game.deck, game.publicKeys);
  await shuffle(game, players);
  expect(game.phase).toBe('Share');

  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadShare(game.chunkDeck(0), game.publicKeysShare(p), nActualPlayers);
  }
  await shareChunk(game, players, nActualPlayers, 0);
  expect(game.phase).toBe('Showdown');
  expect(game.nCalled).toBe(5);

  for (let p = 0; p < nActualPlayers; p++) {
    players[p]!.preloadShowdown(
      game.publicKeys,
      game.showdownCiphertextCards(),
      game.getCiphertextPartialsForPlayer(p),
      game.getEncryptedCardForPlayer(p),
      cards[p]!,
      game.nCalled,
      game.patternId,
    );
  }
  await showdown(game, players, nActualPlayers, cards);
  expect(game.phase).toBe('Complete');
}

test('Complete 75-ball Bingo with 2 players (card commit after register, 5-ball share)', async () => {
  await runGame(75, 2);
}, 900_000);

test('Complete 90-ball Bingo with 2 players (card commit after register, 5-ball share)', async () => {
  await runGame(90, 2);
}, 900_000);
