import { Circuit } from './circuit';
import { clearSharedZkeyBytes } from './zkey-cache';

export interface Circuits {
  register: Circuit;
  shuffle: Circuit;
  share: Circuit;
  showdown: Circuit;
}

class CircuitManager {
  static #instance: CircuitManager | null = null;
  #circuits: Circuits | null = null;
  #loading: Promise<void> | null = null;

  static async getInstance(): Promise<CircuitManager> {
    if (!CircuitManager.#instance) {
      CircuitManager.#instance = new CircuitManager();
      await CircuitManager.#instance.loadAll();
    }
    return CircuitManager.#instance;
  }

  private async loadAll(): Promise<void> {
    if (this.#loading) {
      await this.#loading;
      return;
    }

    this.#loading = (async () => {
      const [
        register,
        shuffle,
        share,
        showdown,
      ] = await Promise.all([
        'register_main',
        'shuffle_1_deck_52_main',
        'poker_share_hashout_main',
        'poker_showdown_hashout_main',
      ].map(async name => {
        const circuit = new Circuit(name);
        await circuit.load();
        return circuit;
      }));

      this.#circuits = {
        register: register!,
        shuffle: shuffle!,
        share: share!,
        showdown: showdown!,
      };
    })();

    await this.#loading;
  }

  get circuits(): Circuits {
    if (!this.#circuits) {
      throw new Error('Circuits not loaded. Call getInstance() first.');
    }
    return this.#circuits;
  }
}

export async function preloadCircuits(): Promise<Circuits> {
  const manager = await CircuitManager.getInstance();
  return manager.circuits;
}

/** Drop cached native provers between heavy ZK phases (share/showdown). */
export function releaseLoadedProvers(circuits: Circuits): void {
  for (const circuit of Object.values(circuits)) {
    circuit.releaseProver();
  }
  clearSharedZkeyBytes();
}