# Vault float

> **Copyright © 2026 Barrett Harber. All rights reserved.**
> USPTO patent application **19/811,546** (patent pending).

Account rent is the cluster rate times data bytes plus the 128-byte overhead:

```
rent lamports = lamports_per_byte × (data bytes + 128)
```

`lamports_per_byte` is the rent sysvar. It was 5,080 on the devnet hands below.
Call `(data bytes + 128)` the rent bytes. The vault account itself is 73 data
bytes, 201 rent bytes, 1,021,080 lamports at 5,080. That rent stays in the
account. The whitelist admin pays it when the vault is created.

The hand float covers every account the hand opens at once. The shuffle buffer
stays open while share staging is allocated, a proof receipt sits beside them,
each shuffle chunk has its own lane account, and each in-flight Arcium
computation has an 8,000,000-lamport budget. `rentVaultFloat` in
`src/chain/rent-vault.ts` is that sum. The computation budget is a fixed
lamport ceiling and does not scale with the rent rate.

```
hand float =
    rent(max(shuffle layout, 10240))
  + rent(29920)
  + rent(85)
  + chunks × (rent(653) + 10000)
  + 8000000 × computation slots
```

`chunks` is `ceil(caller inputs / 16)`. Computation slots are 8, and 20 for
keno. 29,920 is `SEAT_SHARE_STAGING_BYTES`. 85 is the proof receipt. 653 is
one shuffle-lane account (77-byte header, 16 fields, a 64-byte MSM partial).
The 10,000 is that lane’s signature budget. A layout under 10,240 is still
allocated at the CPI cap.

Caller inputs are `cards × 4 + 1`. The shuffle layout is
`shuffleInputsAccountSize` in `src/chain/shuffle-account.ts`: header 53, then
`32 × caller inputs`, a 64-byte prepared G1, a 2-byte count, the fill and
prepare masks, and 64 bytes per prepare chunk of 16 inputs.

The share size below is the live span at that game’s max seats:
`(seats − 1) × dealt cards × 4` limbs, 32 bytes each. The float reserves
29,920 data bytes for that account on every game. War and baccarat count the
house inside their 12 seats. Blackjack is 8 seats and one 16-card chunk.
Poker is 10 seats and 25 cards. Slots is the house and one player. Bingo
stages 5 balls at a time.

## Share buffer

| Game | Seats | Dealt | Limbs | Data bytes | Rent bytes |
|------|------:|------:|------:|-----------:|-----------:|
| Poker | 10 | 25 | 900 | 28,800 | 28,928 |
| Keno | 12 | 20 | 880 | 28,160 | 28,288 |
| Blackjack | 8 | 16 | 448 | 14,336 | 14,464 |
| Baccarat | 12 | 6 | 264 | 10,240 | 10,368 |
| Bingo | 12 | 5 | 220 | 10,240 | 10,368 |
| War | 12 | 4 | 176 | 10,240 | 10,368 |
| Craps | 12 | 2 | 88 | 10,240 | 10,368 |
| Roulette | 12 | 1 | 44 | 10,240 | 10,368 |
| Slots, 5 reels | 2 | 5 | 20 | 10,240 | 10,368 |
| Slots, 3 reels | 2 | 3 | 12 | 10,240 | 10,368 |

Baccarat’s live span is 8,448 bytes, bingo 7,040, war 5,632, craps 2,816,
roulette 1,408, 5-reel slots 640, and 3-reel slots 384. Each is created at
the 10,240-byte floor.

## Shuffle buffer

| Shoe | Cards | Caller inputs | Layout bytes | Data bytes | Rent bytes |
|------|------:|--------------:|-------------:|-----------:|-----------:|
| 8-deck blackjack, war, baccarat | 416 | 1,665 | 60,342 | 60,342 | 60,470 |
| 6-deck blackjack, war, baccarat | 312 | 1,249 | 45,310 | 45,310 | 45,438 |
| Slots, 5 reels | 110 | 441 | 16,083 | 16,083 | 16,211 |
| Bingo, 90 | 90 | 361 | 13,192 | 13,192 | 13,320 |
| Keno | 80 | 321 | 11,779 | 11,779 | 11,907 |
| Bingo, 75 | 75 | 301 | 11,008 | 11,008 | 11,136 |
| 1-deck poker, blackjack, war, baccarat | 52 | 209 | 7,732 | 10,240 | 10,368 |
| Slots, 3 reels | 66 | 265 | 9,724 | 10,240 | 10,368 |
| Roulette, 38 | 38 | 153 | 5,677 | 10,240 | 10,368 |
| Roulette, 37 | 37 | 149 | 5,548 | 10,240 | 10,368 |
| Craps | 12 | 49 | 1,951 | 10,240 | 10,368 |

## Staged on the measured hands

Each vault deposit below is the hand float plus the accounts that vault opens
for the table. The fee payer deposits it. The figures are the devnet ledger
for one finished 2-player hand, and they match `rentVaultFloat` plus
`seatTableLamports` or `operatorTableLamports` at 5,080 lamports per byte.

Baccarat, blackjack, and war used a 6-deck shoe. Bingo used 75 balls, roulette
37 pockets, and slots 3 reels. Keno staged 20 computation slots
(160,000,000 lamports). Every other game staged 8 (64,000,000).

A seat vault adds the whitelist entry (72), room wallet (184), and table
escrow (177). A casino seat also adds its token account (165) and pending
deposit (80), which is 6,695,440 lamports. Poker omits those two, which is
4,150,360 lamports.

The operator is not a seat. That vault adds the mint (82), room (152), room
token account (165), table (495), casino game state (1,020), light game state
(139), and an empty CPI authority. Each seat up to the game’s maximum adds a
player-game escrow (178), a light player state (269), and a casino player
state (235). A house game also adds the dealer pool (190), protocol treasury
(88), and pool stake (128). Poker adds encrypted betting (728) and the bet
action log (6,200). The maximum is 12 seats for baccarat, war, roulette,
craps, keno, and bingo, 8 for blackjack, 10 for poker, and 2 for slots.

| Game | Hand float | Seat accounts | Seat vault | Operator accounts | Operator vault |
|------|----------:|--------------:|-----------:|------------------:|---------------:|
| Baccarat | 762,771,840 | 6,695,440 | 769,467,280 | 83,977,480 | 846,749,320 |
| War | 762,771,840 | 6,695,440 | 769,467,280 | 83,977,480 | 846,749,320 |
| Blackjack | 762,771,840 | 6,695,440 | 769,467,280 | 62,316,360 | 825,088,200 |
| Keno | 457,740,520 | 6,695,440 | 464,435,960 | 83,977,480 | 541,718,000 |
| Bingo | 349,868,880 | 6,695,440 | 356,564,320 | 79,964,280 | 429,833,160 |
| Slots, 3 reels | 338,012,480 | 6,695,440 | 344,707,920 | 29,824,680 | 367,837,160 |
| Poker | 326,080,040 | 4,150,360 | 330,230,400 | 105,628,440 | 431,708,480 |
| Roulette, 37 | 310,170,120 | 6,695,440 | 316,865,560 | 83,977,480 | 394,147,600 |
| Craps | 286,305,240 | 6,695,440 | 293,000,680 | 83,977,480 | 370,282,720 |

The house vault uses the same hand float and the same seat-account rent as the
bettor. Poker and bingo have two bettors and no house vault.

## When lamports per byte changes

`recalculateAndRecaptureFloat` reads the sysvar and recomputes
`vaultKeepLamports`: the vault’s own rent plus `rentVaultFloat` at that rate,
with the computation budget left at 8,000,000 lamports per slot. Surplus above
that keep goes back to the fee payer. A vault already at or under the keep is
left alone, including one whose float is sitting in an open shuffle or share
buffer. `recapture_rent_vault` still refuses to leave the vault below the
sysvar minimum for its 73 data bytes.

## Measured hand spend

These lamports are the hand-cost ledger at the end of the hand, before the
session close. Drawn is staged float that was not back in the vault yet. Seat
fees are the airdrop minus the ending wallet, so a negative fee is a wallet
that finished above the airdrop. Net is drawn plus fees. Operator fees are the
fee payer’s drop minus every vault deposit. The admin drop is the same on
every game: three vault-account rents plus three 5,000-lamport signatures,
3,078,240 lamports.

Baccarat, bingo, craps, poker, roulette, slots, and war were measured on
15 Oct 2026. Keno and blackjack were measured again on 16 Oct 2026. The
blackjack shoe took extra hits, so that hand’s fees are higher than a hand
that stands.

| Game | Bettor drawn | Bettor fees | Bettor net | Other drawn | Other fees | Other net | Other seat |
|------|-------------:|------------:|-----------:|------------:|-----------:|----------:|------------|
| Baccarat | 7,725,440 | −914,615 | 6,810,825 | 12,485,400 | −939,241 | 11,546,159 | House |
| Bingo | 7,085,440 | 3,218,557 | 10,303,997 | 7,085,440 | 257,664 | 7,343,104 | Second player |
| Blackjack | 7,965,440 | 3,646,345 | 11,611,785 | 12,725,400 | 4,180,972 | 16,906,372 | House |
| Craps | 6,735,440 | 278,517 | 7,013,957 | 11,495,400 | −959,241 | 10,536,159 | House |
| Keno | 6,905,440 | 358,517 | 7,263,957 | 11,665,400 | −959,241 | 10,706,159 | House |
| Poker | 5,040,360 | 96,545 | 5,136,905 | 5,040,360 | 111,545 | 5,151,905 | Second player |
| Roulette | 6,795,440 | 278,517 | 7,073,957 | 11,555,400 | −959,241 | 10,596,159 | House |
| Slots | 6,865,440 | 152,825 | 7,018,265 | 11,625,400 | 148,199 | 11,773,599 | House |
| War | 7,485,440 | −919,615 | 6,565,825 | 12,245,400 | −944,241 | 11,301,159 | House |

| Game | Operator drawn | Operator fees | Admin | Returned after close |
|------|---------------:|--------------:|------:|---------------------:|
| Baccarat | 25,267,920 | 46,974,584 | 3,078,240 | 2,344,619,720 |
| Bingo | 17,439,640 | 39,335,321 | 3,078,240 | 1,120,840,800 |
| Blackjack | 42,463,720 | 77,930,388 | 3,078,240 | 2,332,023,920 |
| Craps | 25,267,920 | 16,423,780 | 3,078,240 | 918,307,360 |
| Keno | 25,267,920 | 154,192,398 | 3,078,240 | 1,432,273,200 |
| Poker | 57,277,000 | 2,190,373 | 3,078,240 | 1,029,226,160 |
| Roulette | 25,267,920 | 8,758,579 | 3,078,240 | 989,782,000 |
| Slots | 25,267,920 | 24,063,981 | 3,078,240 | 1,020,123,720 |
| War | 28,956,000 | 31,674,182 | 3,078,240 | 2,341,411,640 |

Session close returned the last column to the fee payer. That return is the
float still held in accounts when the hand-cost line was written.
