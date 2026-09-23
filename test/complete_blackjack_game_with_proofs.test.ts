import './helpers/require-player-ffi';
import { MAX_SEATS, MAX_SHARE_CARDS, shareChunksForSeats } from '../src/blackjack';
import { Game } from '../src/blackjack-game';
import { Player, loadBlackjackCircuits, type BlackjackCircuits, type ShareOutput } from '../src/blackjack-player';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';

const actionVkPath = path.join(
  __dirname,
  '../zkey/blackjack_action_hashout_main_verification_key.json',
);
const showdownVkPath = path.join(
  __dirname,
  '../zkey/blackjack_showdown_hashout_main_verification_key.json',
);

async function register(nActualPlayers: number, circuits: BlackjackCircuits, game: Game) {
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
  const shareDeck = game.shareCiphertextCards;
  expect(shareDeck.length).toBe(MAX_SHARE_CARDS);

  for (let chunk = 0; chunk < game.nShareChunks; chunk++) {
    for (let p = 0; p < nActualPlayers; p++) {
      const player = players[p]!;

      // Preload next player's witness for this chunk
      if (p + 1 < nActualPlayers) {
        player.preloadShareChunk(shareDeck, game.publicKeysShare(p), chunk, nActualPlayers);
      }

      console.time(`Chunk ${chunk} Prove ${p}`);
      const { proof, publicSignals, ciphertexts } = await player.shareProveChunk(
        shareDeck,
        game.publicKeysShare(p),
        chunk,
        nActualPlayers,
      );
      console.timeEnd(`Chunk ${chunk} Prove ${p}`);

      console.time(`Chunk ${chunk} Verify ${p}`);
      game.shareChunk(proof, publicSignals, {
        publicKey: player.publicKey,
        ciphertexts,
      });
      console.timeEnd(`Chunk ${chunk} Verify ${p}`);
    }
  }

  expect(game.phase).toBe('Showdown');
}

async function shareWithPerPlayerIsolatedChunks(game: Game, players: Player[], nActualPlayers: number) {
  const shareDeck = game.shareCiphertextCards;
  expect(shareDeck.length).toBe(MAX_SHARE_CARDS);

  const nChunks = game.nShareChunks;
  const perPlayerResults: ShareOutput[][] = [];
  for (let p = 0; p < nActualPlayers; p++) {
    const player = players[p]!;
    console.time(`Player ${p} parallel ${nChunks}-chunk share proofs`);
    perPlayerResults[p] = await Promise.all(
      Array.from({ length: nChunks }, (_, chunkIndex) =>
        player.shareProveChunk(shareDeck, game.publicKeysShare(p), chunkIndex, nActualPlayers),
      ),
    );
    console.timeEnd(`Player ${p} parallel ${nChunks}-chunk share proofs`);
  }

  for (let chunk = 0; chunk < nChunks; chunk++) {
    for (let p = 0; p < nActualPlayers; p++) {
      const result = perPlayerResults[p]![chunk]!;
      console.time(`Chunk ${chunk} Verify ${p}`);
      game.shareChunk(result.proof, result.publicSignals, {
        publicKey: players[p]!.publicKey,
        ciphertexts: result.ciphertexts,
      });
      console.timeEnd(`Chunk ${chunk} Verify ${p}`);
    }
  }

  expect(game.phase).toBe('Showdown');
}

async function actionCheckOnePlayer(game: Game, players: Player[]) {
  const player = players[0]!;
  const sourceIndices = [0, 1];

  // Status coeff is host-sealed. The action circuit forces the ace coeff to 0
  // for a non-dealer.
  player.setSealedCoefficients([1n, 0n]);
  console.time('Action Prove 0');
  const { proof, publicSignals, status, actionHash } = await player.actionProve(
    game.publicKeys,
    game.shareCiphertextCards,
    game.getCiphertextPartialsForPlayer(0),
    sourceIndices,
    true,
  );
  console.timeEnd('Action Prove 0');

  expect(verify(proof, publicSignals, actionVkPath)).toBe(true);
  expect(BigInt(publicSignals[0]!)).toBe(actionHash);
  expect([0, 1, 2, 3]).toContain(status);
}

function buildSevenPlayerDeal() {
  return {
    playerHands: Array.from({ length: 7 }, (_, player) => ({
      player,
      hand: 0,
      shareSlots: [player * 2, player * 2 + 1],
    })),
    dealerShareSlots: [14, 15],
  };
}

// One player + the dealer: a single player submits one showdown proof for their
// own hand plus the dealer's hand.
async function showdown(game: Game, players: Player[]) {
  const ciphertextCards = game.shareCiphertextCards;
  const player = players[0]!;
  const decrypted = player.decryptShareCards(
    ciphertextCards,
    game.getCiphertextPartialsForPlayer(0),
  );

  const handLayout = player.buildHandLayoutFromShareSlots(decrypted, {
    playerHands: [
      { player: 0, hand: 0, shareSlots: [0, 1] },
    ],
    dealerShareSlots: [2, 3],
  });

  player.setSealedCoefficients(hostShowdownCoefficients(1));
  console.time('Showdown Prove 0');
  const { proof, publicSignals, publicKey, outcomesHash } = await player.showdownProve(
    game.publicKeys,
    ciphertextCards,
    game.getCiphertextPartialsForPlayer(0),
    handLayout,
  );
  console.timeEnd('Showdown Prove 0');

  console.time('Game Verify Showdown 0');
  const result = game.verifyShowdown(proof, publicSignals, {
    publicKey,
    outcomesHash,
    handLayout,
    handIndex: 0,
  });
  console.timeEnd('Game Verify Showdown 0');
  expect(result).toBe(outcomesHash);
  expect(verify(proof, publicSignals, showdownVkPath)).toBe(true);
}

async function showdownSevenPlayers(game: Game, players: Player[]) {
  const ciphertextCards = game.shareCiphertextCards;
  const decrypted = players[0]!.decryptShareCards(
    ciphertextCards,
    game.getCiphertextPartialsForPlayer(0),
  );
  const handLayout = players[0]!.buildHandLayoutFromShareSlots(decrypted, buildSevenPlayerDeal());

  console.time('Parallel 7-player showdown proofs');
  const proved = await Promise.all(Array.from({ length: 7 }, (_, p) => {
    players[p]!.setSealedCoefficients(hostShowdownCoefficients(1));
    return players[p]!.showdownProve(
      game.publicKeys,
      ciphertextCards,
      game.getCiphertextPartialsForPlayer(p),
      handLayout,
      0,
    );
  }));
  console.timeEnd('Parallel 7-player showdown proofs');

  for (let p = 0; p < 7; p++) {
    const { proof, publicSignals, publicKey, outcomesHash, handIndex } = proved[p]!;
    if (p === 0) {
      console.time('Game Verify Showdown 0');
      const result = game.verifyShowdown(proof, publicSignals, {
        publicKey,
        outcomesHash,
        handLayout,
        handIndex,
      });
      console.timeEnd('Game Verify Showdown 0');
      expect(result).toBe(outcomesHash);
    } else {
      expect(verify(proof, publicSignals, showdownVkPath)).toBe(true);
    }
  }
}

let circuits: BlackjackCircuits;

beforeAll(async () => {
  circuits = await loadBlackjackCircuits();
});

async function runGame(nActualPlayers: number) {
  const game = new Game();
  await game.init();

  expect(game.phase).toBe('Registration');

  const players = await register(nActualPlayers, circuits, game);

  expect(game.nPlayers).toBe(nActualPlayers);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_SEATS);
  expect(game.nShareChunks).toBe(shareChunksForSeats(nActualPlayers));
  expect(game.phase).toBe('Shuffle');

  await shuffle(game, players);
  expect(game.phase).toBe('Share');

  await share(game, players, nActualPlayers);
  await actionCheckOnePlayer(game, players);
  await showdown(game, players);

  expect(game.phase).toBe('Complete');
}

async function runEightSeatGame() {
  const game = new Game();
  await game.init();

  const players = await register(MAX_SEATS, circuits, game);
  expect(game.nPlayers).toBe(MAX_SEATS);
  game.start();
  expect(game.publicKeys.length).toBe(MAX_SEATS);
  expect(game.phase).toBe('Shuffle');

  await shuffle(game, players);
  expect(game.phase).toBe('Share');

  await shareWithPerPlayerIsolatedChunks(game, players, MAX_SEATS);
  await showdownSevenPlayers(game, players);

  expect(game.phase).toBe('Complete');
}

const runSlowEightSeatBlackjack = process.env.RUN_SLOW_BLACKJACK_8P === '1' ? it : it.skip;

describe('Complete Blackjack Game with Proofs', () => {
  it('1 player + dealer (2 seats)', async () => {
    await runGame(2);
  }, 600_000);

  it('2 players + dealer (3 seats)', async () => {
    await runGame(3);
  }, 900_000);

  it('3 players + dealer (4 seats)', async () => {
    await runGame(4);
  }, 1_200_000);

  runSlowEightSeatBlackjack('7 players + dealer: isolated 5-chunk shares, 7 showdowns', async () => {
    await runEightSeatGame();
  }, 2_700_000);
});