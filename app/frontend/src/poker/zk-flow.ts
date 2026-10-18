import { Game } from '@poker-src/poker-game';
import { Player } from '@poker-src/poker-player';
import type { PublicKey } from '@poker-src/zk-casino';
import { verifyCircuit } from '../zk';
import { preloadCircuits } from './browser-circuits';

export interface ZkFlowState {
  game: Game;
  player: Player;
}

export async function createZkFlow(): Promise<ZkFlowState> {
  const circuits = await preloadCircuits();
  const game = new Game();
  await game.init();
  const player = new Player(circuits);
  await player.init();
  return { game, player };
}

export async function runRegistration(state: ZkFlowState): Promise<{ publicKey: PublicKey }> {
  state.player.generateKey();
  const { proof, publicSignals } = await state.player.registerProve();
  const valid = await verifyCircuit('register_main', proof, publicSignals);
  if (!valid) {
    throw new Error('Registration proof verification failed');
  }
  state.game.addPlayer(proof, publicSignals, { verified: true });
  return { publicKey: state.player.publicKey };
}

export async function runShuffleStep(state: ZkFlowState): Promise<{
  permutationHash: string;
  publicSignals: string[];
}> {
  if (state.game.phase === 'Registration' && state.game.nPlayers >= 1) {
    state.game.start();
  }
  if (state.game.phase !== 'Shuffle') {
    throw new Error(`Expected Shuffle phase, got ${state.game.phase}`);
  }

  const { proof, publicSignals, deck, permutationHash } = await state.player.shuffleProve(
    state.game.deck,
    state.game.publicKeys,
  );
  const valid = await verifyCircuit('shuffle_1_deck_52_main', proof, publicSignals);
  if (!valid) {
    throw new Error('Shuffle proof verification failed');
  }

  state.game.shuffle(proof, publicSignals, {
    publicKey: state.player.publicKey,
    deck,
    permutationHash,
  }, { verified: true });

  return { permutationHash: permutationHash.toString(), publicSignals };
}
