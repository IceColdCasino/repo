# casino

Anchor program for rooms, tables, encrypted wallets, poker pots, and the
dealer pool.

- **Program:** `programs/casino/` — address
  `CasinoXME8X5fZzMrcKT3Tu551ZaRxWofiEUWiVK2VFv`.
- **Arcis:** `encrypted-ixs/` — confidential chip transitions
  (`validate_bet`, `settle_all_seats`, `stake_dealer_pool`,
  `settle_casino_hand`, and the wallet credits). The function name is the
  computation name the program queues.

Poker settles from the pots players committed. Bingo settles from the card
buy-ins. Every other `GameKind`, including keno, pays winners from that
table’s dealer pool. The full account and instruction map is
[docs/on-chain.md](../../docs/on-chain.md).

Builds write a throwaway keypair so CI can compile without secrets. Deploy
fetches the vanity keypair from 1Password.
