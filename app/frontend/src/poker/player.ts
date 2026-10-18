interface BabyJubKeyPair {
  sk: bigint;
  pk: [bigint, bigint];
}

export class Player {
  #name: string;
  #keyPair: CryptoKeyPair | null = null;
  #babyJubKeyPair: BabyJubKeyPair | null = null;
  #chips: number = 0;

  constructor(name: string, keyPair?: CryptoKeyPair) {
    this.#name = name;

    if (keyPair) {
      this.#keyPair = keyPair;
    }
  }

  get name() {
    return this.#name;
  }

  get publicKey() {
    return this.#keyPair?.publicKey as Readonly<CryptoKey> | undefined;
  }

  async generateKey() {
    if (!this.#keyPair) {
      this.#keyPair = await globalThis.crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveKey'],
      ) as CryptoKeyPair;
    }

    return this.#keyPair.publicKey;
  }

  async generateBabyJubKey() {
    if (!this.#babyJubKeyPair) {
      const { buildBabyjub } = await import('circomlibjs');
      const babyjub = await buildBabyjub();
      const sk = babyjub.F.toObject(babyjub.F.random());
      const pkPoint = babyjub.mulPointEscalar(babyjub.Base8, sk);
      const pk: [bigint, bigint] = [
        babyjub.F.toObject(pkPoint[0]) as bigint,
        babyjub.F.toObject(pkPoint[1]) as bigint,
      ];
      this.#babyJubKeyPair = { sk, pk };
    }

    return this.#babyJubKeyPair;
  }

  get babyJubKeyPair() {
    return this.#babyJubKeyPair;
  }

  get babyJubPublicKey() {
    return this.#babyJubKeyPair?.pk;
  }

  addChips(amount: number) {
    if (amount <= 0 || !Number.isInteger(amount)) {
      throw new Error('Invalid chip amount');
    }

    this.#chips += amount;

    return amount;
  }

  get chips() {
    return this.#chips as Readonly<number>;
  }

  placeBet(amount: number) {
    if (amount < 0) {
      throw new Error('Bet amount cannot be negative');
    }
  
    if (this.#chips < amount) {
      throw new Error('Insufficient chips to place bet');
    }

    this.#chips -= amount;

    return amount;
  }
}
