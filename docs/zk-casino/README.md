# ZK Casino

> **Copyright © 2026 Barrett Harber. All rights reserved.**
>
> The Circom circuits in `circuits/` and this documentation are covered by
> USPTO patent application **19/811,546** (patent pending), as listed in the
> header of every `.circom` file. No license is granted. Reproduction,
> modification, distribution, or commercial use of the circuits or this
> documentation is prohibited without written permission.

This folder documents the **Groth16 / Circom** mental-poker stack only. It does
not describe Arcium MPC, Solana programs, or the native app. Those layers
consume the same hashes and proofs; they are not part of these circuits.

Every game is a parameterized instance of one protocol:

1. **Register** a BabyJubJub ElGamal key.
2. **Shuffle** an encrypted shoe (cards, dice, reels, or balls).
3. **Share** threshold partial decryptions, sealed to every other player.
4. **Showdown** reconstruct plaintext, evaluate the game, and commit a
   polynomial hash of the result.

What changes per game is the **shoe layout**, the **number of revealed
outcomes**, and the **evaluation / bet circuits**. The encryption is the same.

| Game | Doc |
|------|-----|
| Texas Hold'em | [poker.md](./poker.md) |
| Blackjack | [blackjack.md](./blackjack.md) |
| Baccarat | [baccarat.md](./baccarat.md) |
| Casino War | [war.md](./war.md) |
| Roulette (EU 37 / US 38) | [roulette.md](./roulette.md) |
| Craps | [craps.md](./craps.md) |
| Keno | [keno.md](./keno.md) |
| Slots (3-reel / 5-reel) | [slots.md](./slots.md) |
| Bingo (75 / 90) | [bingo.md](./bingo.md) |

---

## How the patent applies (USPTO 19/811,546)

This repository is a reduction to practice of USPTO application **19/811,546**.
What follows is taken from the claims and the specification. Paragraph cites
use the specification’s `[00xx]` numbering. This section is an implementation
map, not a substitute for the claims or the specification, and not a legal
opinion.

The specification describes one protocol. A plaintext may be a card, a pocket,
a die, a reel stop, or any other admissible integer ([0218]–[0219]). **Every
game in this folder is that protocol.** What changes is the shoe and the
evaluation function ([0230]).

### What the invention does

Remote parties need a jointly randomized, jointly encrypted set of values;
later they must recover *some* of those values, prove a determination from
them, and never publish the values ([0002]–[0007]). A dealer that holds every
face is trusted for both fairness and secrecy. The invention removes that
party.

The method is four phases ([0061]–[0065], FIG. 2). Each phase is a
zero-knowledge circuit. Private witness shared across phases is pinned by a
cryptographic commitment (the commitment-threaded mechanism, [0068]–[0071],
FIG. 3; claim 5), not by dumping the witness on the public tape.

```text
210  Registration                 each party proves pk = sk · G
220  Permutation and re-encryption  permute + re-encrypt under Σ pk
230  Partial sealing              seal a first- or second-state payload to every other key
240  Recovery and evaluation      unseal, aggregate, recover, evaluate
```

Phases 210–230 do not depend on later bets ([0067]). Wager amounts sit in the
off-circuit interval 260 ([0066]); the circuits attest encryption, permutation,
sealing, recovery, and selection.

### The claimed mechanism (same in every game)

The claims have three method independents and two statutory twins of the
genus:

| Claim | Role | Spec / figures | This code |
|-------|------|----------------|-----------|
| **1** | Genus | [0009]; every phase that contributes at every position | Shared templates below |
| **7** | Sealing (Phase 230) | [0013], [0107]–[0144]; FIGS. 5–8 | `share.circom`, `poker_share.circom`, `*_share_hashout_main` |
| **11** | Recovery and evaluation (Phase 240) | [0014], [0145]–[0180]; FIGS. 9–13 | `partials.circom`, `showdown.circom`, every game evaluator |
| **19** | CRM of claim 1 | [0011] | Same circuits, as stored instructions |
| **20** | System of claim 1 | [0012] | Prover device + those circuits |

At every ciphertext position the prover, in-circuit ([0009], claim 1):

1. Reconstructs a commitment over the shoe ciphertexts, the registered keys,
   and the designation, and constrains it to a public first commitment
   (Poseidon `hash`).
2. Verifies `sk` corresponds to the prover’s `pk`.
3. Computes a **contribution** — here the ElGamal partial `sk · c0`.
4. Produces a **derived value** from that contribution.
5. **Imposes an arithmetic relation** whose operand is the designation
   **state**. Satisfaction forces **correspondence** between derived value and
   a **reference value** in the **first state**, and **non-correspondence** in
   the **second state**.

Contribution, derived value, and reference value are group elements and remain
**private witnesses**. The genus and recovery independents emit **commitments**
as the public signals (not faces).

A **designation** is a field element whose bits encode a first or second state
for a (ciphertext position, public key) pair (claim 3; `cardMask`,
`potMasks`). It is not a different circuit.

| State | Sealing — claim 7 | Recovery — claim 11 |
|-------|-------------------|---------------------|
| **First** | Payload = derived value (`sk · c0`). Relation forces payload / reference correspondence. | Recovered point must equal `P(plaintext)` (claim 13). |
| **Second** | Payload = **non-contributing value** (BabyJub identity `(0,1)`). Relation forces non-correspondence. | Identity padding from registration. That plaintext is not recovered. |

Claim 7, at **every** position regardless of state ([0116], [0013]): muxes
derived vs identity (claim 10; FIG. 7), then **encrypts the same payload under
every further public key** (targeted encryptions; FIG. 8). Claim 10 requires
one designation field applied identically to all further keys — that is
`cardMask`, not a per-recipient mask.

Claim 11 **unseals** inbound targeted encryptions, **aggregates** the prover’s
contribution with every payload under the group operation (claim 12: same
number of additions whether the payload is a real share or identity), and
takes the derived value as the recovered point `c1 − Σ partials` ([0157],
[0165]; FIG. 12). Recovery of a face needs a contribution from **every** key
in the aggregate (claims 6 and 11).

Two properties every independent recites, and these circuits implement:

- **One compiled committee.** Circuits are compiled at a fixed maximum `n`
  (ten seats in the poker mains). The same proving-key derivation serves
  instances with fewer seated keys; unseated slots are identity padding
  ([0054], [0229], claim 1 wherein). That is why share/showdown templates
  stay `n = 10` and unused inbound slots are registration padding.
- **Invariant constraint system.** Size, structure, number of constraints, and
  the count of positions at which those constraints run do **not** change with
  how many keys are live or how many positions are in the first state. A mask
  bit is a witness. Every position always contributes, muxes, seals or
  aggregates.

### Dependents on this code

| Claims | What they add | This code |
|--------|---------------|-----------|
| 2, 9 | ElGamal; contribution = `sk · c0` | `elgamal.circom` `PartialDecrypt` |
| 3 | Designation bits tied to (position, key) | `cardMask` / `potMasks` via `Num2Bits` |
| 4 | First circuit emits the commitment; second reconstructs and equals it | Poseidon `hash` public input; host or a dedicated hash circuit rebuilds the same tree ([0069]–[0070], FIGS. 5 and 9) |
| 5 | Composition tree over shared private witness; no shared element is a public signal | Same Poseidon trees in share and showdown |
| 6 | n-of-n under the aggregate key | Shoe encrypted under `Σ pk` |
| 8 | Prover-first public-key index | Share `HashMain` prepends the prover’s `pk` |
| 10 | Identity mux; identical payload to every further key; one designation field | `poker_share.circom` `Mux2` between `[0,1]` and `sk · c0` |
| 12 | Chain the same group add for real share or identity | `partials.circom` aggregation |
| 13 | Reference = injective `P(v) = (v+1) · G` | `deck.circom` `BabyPbk(v+1)` ([0159]) |
| 14 | Common positions forced first-state; slot positions follow the key’s bit | Board / dealer / wheel / draw vs holes |
| 15 | Product of coordinate equality indicators equals the state | `IsEqual` on `(x,y)` then `eqX * eqY === bit` |
| 16 | Each designation is a **pool**; evaluate; emit an indicator; result stays private | `potMasks` → `winnerMasks` (or a poly digest of them) |
| 17 | Rank + ordered tie-breakers; greatest tuple in the pool | `poker_compare_hands` (FIG. 13) |
| 18 | Nested pools: strictly decreasing occupancy; zero propagates | Side-pot cardinality in poker showdown ([0212]–[0216]) |

Registration (210) and permutation/re-encryption (220) are supporting
embodiments ([0075]–[0101], FIG. 4): `register_main`, `shuffle.circom` and
the `shuffle_*_main` shoe sizes. Re-encryption randomness is constrained
nonzero ([0094]–[0095]).

### Hashout (preferred publication)

Claim 1 and claim 11 emit commitments, not faces. Claim 7 may emit targeted
encryptions as public signals; claim 16 may emit per-pool indicators. The
preferred embodiment in this repo is **polynomial hashout** ([0139]–[0144],
[0182]–[0183], [0225], [0238]):

| Digest | Role |
|--------|------|
| **Input (Poseidon)** | Public `hash`. Binds ciphertexts, keys, designation, inbound seals. |
| **Output (polynomial)** | Public `out = Σ fold(limb[i]) · coeff[i]`. Sealed-payload limbs (Phase 230) or `(indicator+1) · coeff` (Phase 240). |

Fold is `ExtractAndCombine` and is **not** injective; collision resistance is
the coefficients ([0141]). Inactive committee limbs are identity padding so
absolute coefficient indices stay fixed ([0143]) — the same compiled-`n`
rule as claim 1. Non-hashout mains that publish raw seals or winner bits
remain inside the disclosure ([0137], [0222]).

MPC-assisted release ([0234]–[0238]) is the Arcis path: stage seals, release
on a game-stage condition, sample Phase 240 coefficients, settle from the
digest without publishing indicators.

### One protocol; games are parameters

[0230]: what distinguishes one card game from another is only

- cardinality **N** of the plaintext set,
- number of ciphertext positions,
- which positions are **slot-associated** vs **common**,
- how many **pools**,
- the **evaluation function** and selection criterion.

[0218] states that function need not be a ranking, a game, or a comparison —
only a deterministic function of recovered values whose output can designate
slots or a computed quantity. [0219] states the values need not be cards.

| Game | Specification | N / opened | Evaluation (claims 11 / 16) |
|------|------------|------------|-----------------------------|
| Poker | Preferred evaluation ([0184]–[0216]); claims 17–18 | 52 / 25 | Hand-category tuple; `winnerMasks` per pool |
| War | Two-slot comparison ([0218], [0231]) | 52 / 4 | Rank compare; war pair on tie |
| Baccarat | Common-hand comparison ([0220]) | 52×{1,6,8} / 6 | Tableau; Player / Banker / tie |
| Blackjack | Reference-hand ([0221]); action-dependent shoe ([0231]–[0232]) | 52×{1,6,8} / ≤24 used | Player vs dealer; `blackjack_action` is the [0232] action circuit |
| Roulette | Values need not be cards ([0219]) | 37 or 38 / 1 | Encrypted bets + payout table |
| Craps | Same genus; two common faces | 12 / 2 | Come-out / point + table bets |
| Keno | Same genus; draw from an 80-set | 80 / 20 | Encrypted spots; hit count |
| Slots | Same genus; reel stops | 22×{3,5} / 1 per reel | Window + paytable |
| Bingo | Same genus; called balls + card | 75 or 90 / called prefix | Pattern / completion index |

A game that always opens every dealt slot is still claims 7 / 11: the
designation is first-state at those positions. Second-state is how a player
mucks, how unused shoe slots stay closed, and how unseated seats stay
padding ([0111]–[0115], [0181]) — one refusal primitive, not a second
protocol.

The game pages below document only that interface (shoe, opened indices,
evaluator). They are not a different invention.

---

## Legal

Every Circom source file begins with:

```text
Copyright 2026 by Barrett Harber. All rights reserved.

Patent Pending USPTO Application Number 19/811,546
```

That notice applies to:

- All templates and mains under `circuits/`
- The Groth16 proving keys derived from those circuits
- This documentation of the protocol and game-specific evaluation logic

The work is **copyrighted with all rights reserved**. The invention is
**patent pending**. Presence of source in this repository is not an open-source
grant, a patent license, or permission to implement the protocol elsewhere.
How the claims and the specification map onto these circuits is in
[How the patent applies](#how-the-patent-applies-uspto-19811546) above.

---

## How encryption works

The stack is **threshold ElGamal mental poker on BabyJubJub** (`circuits/elgamal.circom`).
Nothing in the shoe is ever a plaintext field element on the public tape until
every registered player has contributed a partial.

### Encoding a face

A shoe index `v` (card, pocket, die face, reel stop, or ball) is mapped to a
curve point:

```text
P(v) = (v + 1) · Base8
```

`InstantiateDeck` (`circuits/deck.circom`) range-checks `v` and recomputes
`BabyPbk(v + 1)` so a later decrypt must match a legal encoding, not an
arbitrary point.

### ElGamal under a public key

For randomness `r ≠ 0` and recipient public key `pk = sk · G`:

```text
c0 = r · G
c1 = P + r · pk
ciphertext = [c0.x, c0.y, c1.x, c1.y]
```

Decrypt is `P = c1 − sk · c0`. `AddRandomness` re-randomizes an existing
ciphertext under the same key (used by shuffle). `VerifyKey` proves
`pk = sk · G`.

### Aggregate key (the shoe)

Each player registers `pk_i`. The **aggregate public key** is the BabyJub sum
of all `pk_i`. The shoe is encrypted under that sum. Recovering a face requires
**every** secret key:

```text
P = c1 − (sk_0 + sk_1 + … + sk_{n-1}) · c0
  = c1 − Σ (sk_i · c0)
```

No single player, house, or operator can open a card alone.

### Register

`Register` (`circuits/register.circom`) proves knowledge of `sk` for `pk` and
emits a deterministic padding ciphertext (`Encrypt(identity, pk, r=1)`). That
padding is later used as ElGamal entropy for unused player slots.

### Shuffle

`Shuffle` (`circuits/shuffle.circom`) takes the current encrypted shoe and a
secret permutation matrix. It:

1. Poseidon-binds the input deck and aggregate key.
2. Applies a permutation of ciphertexts.
3. Re-randomizes each ciphertext under the aggregate key (`AddRandomness`).
4. Poseidon-binds the output deck.

The permutation is private. The public statement is “this output deck is a
re-encryption of a permutation of the input deck under the same key.”

Game-specific **mains** only change shoe size (see the table below). The
template is shared.

### Share (threshold partials)

`Share` (`circuits/share.circom`) is the core privacy step after the last
shuffle.

For each shoe index the prover:

1. Computes their **partial** `sk · c0` (`PartialDecrypt`).
2. **Re-encrypts that partial to every other player** under that player’s
   individual `pk_j` (not the aggregate key).

Public outputs are those sealed ciphertexts. The proving player never publishes
`sk · c0` in the clear. Each recipient can later decrypt only the partials
sealed to them.

`ShareHashOut` folds the sealed matrix through `PolynomialHash` so the Groth16
public output is a compact commitment, not a huge ciphertext array.

### Showdown (open + evaluate)

A showdown circuit:

1. Checks a Poseidon **input hash** over keys, remaining shoe ciphertexts, and
   sealed partials (game-specific extras: pot masks, encrypted bets, phase).
2. Decrypts partials sealed to the prover.
3. Builds the prover’s own partials from the shoe `c0`s.
4. Aggregates `Σ sk_i · c0` and subtracts from `c1` (`partials.circom`).
5. Checks decrypted points equal `P(plaintext)`.
6. Runs the **game evaluator**.
7. Emits a **polynomial output hash** of the result vector
   (`ShowdownPolynomialHash` / `ExtractAndCombine`).

The Groth16 verifier sees only the input hash, the output hash, and the proof.
Faces, bets, and winner bits stay off the public tape except as bound by those
hashes.

### Two hashes

| Hash | Where | Role |
|------|--------|------|
| **Input (Poseidon)** | Register / shuffle / share / showdown | Binds private witness to a public commitment so a proof cannot be replayed against a different deck, key set, or bet vector. |
| **Output (polynomial)** | Share and showdown `*_hashout_main` | `h = Σ fold(limb[i]) · HASH_COEFFS_900[i]`. `fold` is `ExtractAndCombine`: `low128 + 2 · reverse(high126)` after `Num2Bits_strict`. Fold is **not injective**; collision resistance comes from the random coefficients, not from fold. |

`HASH_COEFFS_900` are deterministic ChaCha20 bytes from seed `[0; 32]`. Circom,
TypeScript, and (outside this doc) Arcis must use the same fold and coefficients.

---

## Common ZK modules

These files are shared. Game docs do not re-list them unless a game wraps them.

| File | Role |
|------|------|
| `elgamal.circom` | Encrypt, decrypt, partial decrypt, re-randomize, aggregate `pk`, verify key |
| `register.circom` / `register_main.circom` | Key registration |
| `shuffle.circom` + `shuffle_*_main.circom` | Parameterized shuffle mains |
| `share.circom` | Threshold partials + poly-hash wrapper |
| `showdown.circom` | Shared Poseidon bind, deck verify, poly-hash of results |
| `partials.circom` | Decrypt / create / aggregate partials |
| `deck.circom` | `P(v) = BabyPbk(v+1)` with range check |
| `hash.circom` | Poseidon over ciphertext arrays and public-key lists |
| `polynomial_hash.circom` | `ExtractAndCombine` + 900-term poly hash |
| `helpers.circom` | Comparisons and enabled constraints |
| `bet.circom` | Packed `type \|\| modifier` bet encoding used by roulette (and helpers) |
| `card_rank.circom` | Rank extraction for shoe cards (war, poker helpers) |

Every player still runs **register → shuffle → share** with these primitives.
Only the shoe dimensions and the post-share circuits change.

---

## What is unique in ZK per game

The unique work is always: **how the opened values are interpreted**, and
**what extra private state is hashed in**.

| Game | Shoe (shuffle main) | Opened values | Unique ZK | Public result (poly-hashed) |
|------|---------------------|---------------|---------------|-----------------------------|
| Poker | 52 cards, 1 deck | 25 (20 holes + 5 board) | Hand eval, compare, pot-mask showdown | 9 winner-mask limbs |
| Blackjack | 52 × {1,6,8} decks | Up to 24 used slots | Ace/soft totals, H17/S17, hit/stand/split **action** circuit | 1 settlement limb |
| Baccarat | 52 × {1,6,8} decks | 6 (P2, B2, P3, B3) | Tableau third-card rules, mod-10 | 0 player / 1 banker / 2 tie |
| War | 52 × {1,6,8} decks | 4 (two ups + war pair) | Rank compare + war tie-break | 0 player / 1 dealer / 2 tie |
| Roulette | 37 or 38 pockets | 1 winning pocket | Encrypted bets + EU/US payout table | 12 bet-code limbs |
| Craps | 2 dice × 6 faces | 2 die faces | Come-out / point, encrypted table bets | 12 bet codes + action + point |
| Keno | 80 numbers | 20 drawn | Encrypted spot ticket + hit count | 1 hit-count limb |
| Slots | 3 or 5 reels × 22 stops | 1 center stop / reel | Strip windows, paytable, coin bet | 1 award limb |
| Bingo | 75 or 90 balls | Called balls | Encrypted card, pattern, completion index | 1 limb (75) or 3 (90) |

House / dealer seats (must shuffle, do not place an economic player bet) are a
**table-layout** concern, not a different encryption scheme: blackjack,
roulette, craps, keno, and slots.

---

## Shared pipeline (all games)

```text
Register          pk_i = sk_i · G
    │
    ▼
Shuffle × N       permute + re-encrypt under Σ pk
    │
    ▼
Share             seal sk_i · c0 to every other pk_j
    │
    ▼
(optional game    blackjack action; roulette/craps/keno/slots/bingo bet commit
 circuits)
    │
    ▼
Showdown          aggregate partials → faces → evaluate → poly-hash
```

Shuffle mains (same `Shuffle` template):

| Main | Used by |
|------|---------|
| `shuffle_1_deck_52_main` | Poker; baccarat / blackjack / war (1-deck shoe) |
| `shuffle_6_deck_52_main` | Baccarat / blackjack / war (6-deck shoe) |
| `shuffle_8_deck_52_main` | Baccarat / blackjack / war (8-deck shoe) |
| `shuffle_1_deck_37_main` | Roulette EU |
| `shuffle_1_deck_38_main` | Roulette US |
| `shuffle_2_dice_6_main` | Craps |
| `shuffle_1_deck_80_main` | Keno |
| `shuffle_3_reel_22_main` / `shuffle_5_reel_22_main` | Slots |
| `shuffle_1_deck_75_main` / `shuffle_1_deck_90_main` | Bingo |

Share and showdown mains are usually `*_share_hashout_main` and
`*_showdown_hashout_main` so the Groth16 public signal is the polynomial hash.

---

## Circuit sources

All files live in `circuits/`. Compile and trusted-setup with `./calc.sh <main>`
from the repository root (see `AGENTS.md`). Generated `.r1cs`, `.wasm`, and
`.zkey` artifacts are not source and are not committed.
