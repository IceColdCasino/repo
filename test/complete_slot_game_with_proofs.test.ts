import './helpers/require-player-ffi';
import { type SlotVariant } from '../src/slot';
import { hostShowdownCoefficients } from './helpers/host-showdown-coefficients';
import { Game } from '../src/slot-game';
import { Player, loadSlotCircuits, type SlotCircuits } from '../src/slot-player';
import { verify } from '../src/rapidsnark-ffi';
import path from 'path';

function showdownVkPath(variant: SlotVariant) {
  return path.join(
    __dirname,
    `../zkey/slot_showdown_${variant}_reel_hashout_main_verification_key.json`,
  );
}

async function register(circuits: SlotCircuits, game: Game, variant: SlotVariant) {
  const players: Player[] = [];
  for (let p = 0; p < 2; p++) {
    const player = new Player(circuits, variant);
    await player.init();
    player.generateKey();
    const { proof, publicSignals } = await player.registerProve();
    game.addPlayer(proof, publicSignals);
    players.push(player);
  }
  return players;
}

async function shuffle(game: Game, players: Player[]) {
  for (let p = 0; p < game.nPlayers; p++) {
    const { proof, publicSignals, reels, permutationHash } =
      await players[p]!.shuffleProve(game.reels, game.publicKeys);
    game.shuffle(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      reels,
      permutationHash,
    });
    if (p + 1 < game.nPlayers) {
      players[p + 1]!.preloadShuffle(game.reels, game.publicKeys);
    }
  }
}

async function share(game: Game, players: Player[], coinBets: number[]) {
  for (let p = 0; p < 2; p++) {
    const { proof, publicSignals, ciphertexts, encryptedBets, coinBet } =
      await players[p]!.shareProve(
        game.finalShuffledDeck,
        game.publicKeysShare(p),
        coinBets[p]!,
      );
    game.share(proof, publicSignals, {
      publicKey: players[p]!.publicKey,
      ciphertexts,
      encryptedBets,
      coinBet,
    });
  }
}

async function showdown(game: Game, players: Player[], variant: SlotVariant) {
  const bettor = game.isDealer(0) ? 1 : 0;
  players[bettor]!.setSealedCoefficients(hostShowdownCoefficients(1));
  const { proof, publicSignals, plaintextCenters } = await players[bettor]!.showdownProve(
    game.publicKeys,
    game.finalShuffledDeck,
    game.getCiphertextPartialsForPlayer(bettor),
    game.getEncryptedBetForPlayer(bettor),
    game.getCoinBetForPlayer(bettor),
  );
  expect(plaintextCenters.length).toBe(game.variant);
  const result = game.verifyShowdown(proof, publicSignals, {
    publicKey: players[bettor]!.publicKey,
  });
  expect(result).toBe(BigInt(publicSignals[0]!));
  expect(verify(proof, publicSignals, showdownVkPath(variant))).toBe(true);
}

const circuitsByVariant: Partial<Record<SlotVariant, SlotCircuits>> = {};

async function circuitsFor(variant: SlotVariant): Promise<SlotCircuits> {
  if (!circuitsByVariant[variant]) {
    circuitsByVariant[variant] = await loadSlotCircuits(variant);
  }
  return circuitsByVariant[variant]!;
}

async function runGame(variant: SlotVariant) {
  const circuits = await circuitsFor(variant);
  const game = new Game(variant, 0);
  await game.init();
  expect(game.phase).toBe('Registration');

  const players = await register(circuits, game, variant);
  // House (seat 0) still shares a dummy circuit coin; economic coinBet is 0.
  const coinBets = [1, 3];
  game.start();
  expect(game.nPlayers).toBe(2);
  expect(game.isDealer(0)).toBe(true);
  expect(game.phase).toBe('Shuffle');

  players[0]!.preloadShuffle(game.reels, game.publicKeys);
  await shuffle(game, players);
  expect(game.phase).toBe('Share');

  for (let p = 0; p < 2; p++) {
    players[p]!.preloadShare(game.finalShuffledDeck, game.publicKeysShare(p), coinBets[p]!);
  }
  await share(game, players, coinBets);
  expect(game.phase).toBe('Showdown');
  expect(game.getCoinBetForPlayer(0)).toBe(0);
  expect(game.getCoinBetForPlayer(1)).toBe(3);

  const bettor = 1;
  players[bettor]!.preloadShowdown(
    game.publicKeys,
    game.finalShuffledDeck,
    game.getCiphertextPartialsForPlayer(bettor),
    game.getEncryptedBetForPlayer(bettor),
    game.getCoinBetForPlayer(bettor),
  );
  await showdown(game, players, variant);
  expect(game.phase).toBe('Complete');
}

test('Complete 3-reel Slots Game with 2 players', async () => {
  await runGame(3);
}, 300_000);

test('Complete 5-reel Slots Game with 2 players', async () => {
  await runGame(5);
}, 400_000);
