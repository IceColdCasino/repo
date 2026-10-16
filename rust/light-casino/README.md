# light-casino

Pinocchio program that verifies Groth16 proofs and can CPI the receipt into
the casino program.

- **Program:** `programs/light-casino/` — address
  `CasinodrqvrdEqRYCMFfWGqQ1aD9mCcGDoWRQNPkWVtc`.
- **Proofs:** register, shuffle, share, showdown, and the per-game action or
  bet circuits. Verifying keys are under
  `programs/light-casino/src/verifying_keys/<game>/`.
- **Light Protocol:** compressed accounts for shuffle and share artifacts.
  The system programs loaded at localnet genesis are separate from this
  program.

Casino owns the chips. This program owns the proof. How a verified showdown
becomes a poker pot payout or a dealer-pool settlement is in
[docs/on-chain.md](../../docs/on-chain.md).

```bash
./scripts/build.sh
```

The build writes a throwaway keypair. Deploy fetches the vanity keypair from
1Password.
