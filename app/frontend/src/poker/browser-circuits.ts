import { BridgeCircuit } from '../zk/bridge-circuit';

export interface Circuits {
  register: BridgeCircuit;
  shuffle: BridgeCircuit;
  share: BridgeCircuit;
  showdown: BridgeCircuit;
}

export async function preloadCircuits(): Promise<Circuits> {
  return {
    register: new BridgeCircuit('register_main'),
    shuffle: new BridgeCircuit('shuffle_1_deck_52_main'),
    share: new BridgeCircuit('poker_share_hashout_main'),
    showdown: new BridgeCircuit('poker_showdown_hashout_main'),
  };
}
