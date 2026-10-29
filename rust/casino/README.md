# casino

Anchor program for rooms, tables, encrypted wallets, poker pots, and the
dealer pool.

- **Program:** `programs/casino/` — declared address
  `4nPbWQkPAnSWMnSCAsuNicCGA86zrQKjzkZX7JFWRREY`.
- **Arcis:** `encrypted-ixs/` — confidential chip transitions. The function
  name is the computation name the program queues.
- **Docs:** [docs/casino.md](../../docs/casino.md) is the account and
  instruction map. [docs/arcium.md](../../docs/arcium.md) is the cluster.
  [docs/on-chain.md](../../docs/on-chain.md) is the pot versus dealer-pool
  split.

Poker settles from the pots players committed. Bingo settles from the card
buy-ins. Every other `GameKind`, including keno, pays winners from that
table’s dealer pool.

`scripts/fetch-program-keypairs.sh` still fetches
`CasinoXME8X5fZzMrcKT3Tu551ZaRxWofiEUWiVK2VFv`. That pubkey is not the
`declare_id!` of this crate. A local build writes a throwaway keypair so CI
can compile. The binary’s declared id stays `4nPbWQ…`.
