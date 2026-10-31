module

public import ZkCasino.Evaluation.Polynomial

/-
Integer semantics of each showdown evaluator and of the two results it feeds
to `ShowdownPolynomialHash`.

Decryption, the Poseidon input hash, and the seal-commitment check are the
circuit's binding constraints: they force the opened cards and the
coefficients. What they do not choose is the game result. These theorems are
that result, and the equality `out = (result₀ + 1) · c₀ + (result₁ + 1) · c₁`.
-/

namespace ZkCasino.Evaluation

public section

def cardRank (card : Nat) : Nat := card % 13

def cardSuit (card : Nat) : Nat := card / 13

theorem cardRank_lt (card : Nat) : cardRank card < 13 := Nat.mod_lt _ (by decide)

theorem cardRank_of_shoe (card : Nat) (_h : card < 52) : cardRank card = card % 13 := by
  simp [cardRank]

/-! ## War -/

def warCompare (player dealer : Nat) : Nat :=
  if dealer < player then 0 else if player < dealer then 1 else 2

def warWinner (cards : List Nat) : Nat :=
  match cards with
  | [c0, c1, c2, c3] =>
    let p := cardRank c0
    let d := cardRank c1
    if p = d then warCompare (cardRank c2) (cardRank c3) else warCompare p d
  | _ => 0

theorem war_player_wins_upcard (c0 c1 c2 c3 : Nat) (h : cardRank c1 < cardRank c0) :
    warWinner [c0, c1, c2, c3] = 0 := by
  have hne : cardRank c0 ≠ cardRank c1 := Nat.ne_of_gt h
  simp [warWinner, warCompare, hne, h]

theorem war_dealer_wins_upcard (c0 c1 c2 c3 : Nat) (h : cardRank c0 < cardRank c1) :
    warWinner [c0, c1, c2, c3] = 1 := by
  have hne : cardRank c0 ≠ cardRank c1 := Nat.ne_of_lt h
  have hnot : ¬ cardRank c1 < cardRank c0 := Nat.not_lt_of_gt h
  simp only [warWinner, warCompare, hne, hnot, h]
  rfl

theorem war_tie_uses_downcards (c0 c1 c2 c3 : Nat) (h : cardRank c0 = cardRank c1) :
    warWinner [c0, c1, c2, c3] = warCompare (cardRank c2) (cardRank c3) := by
  simp [warWinner, h]

theorem war_code (cards : List Nat) :
    warWinner cards = 0 ∨ warWinner cards = 1 ∨ warWinner cards = 2 := by
  unfold warWinner
  split
  · simp only [warCompare]
    split <;> split <;> try split
    all_goals
      first
        | exact Or.inl rfl
        | exact Or.inr (Or.inl rfl)
        | exact Or.inr (Or.inr rfl)
  · exact Or.inl rfl

theorem war_showdown (cards : List Nat) (c0 c1 : Nat) :
    polynomialHash [warWinner cards, 0] [c0, c1] = (warWinner cards + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Baccarat -/

def baccaratPip (card : Nat) : Nat :=
  match cardRank card with
  | 0 => 2 | 1 => 3 | 2 => 4 | 3 => 5 | 4 => 6 | 5 => 7 | 6 => 8 | 7 => 9
  | 12 => 1
  | _ => 0

def mod10Sum (a b : Nat) : Nat :=
  let s := a + b
  if s < 10 then s else s - 10

theorem mod10Sum_eq (a b : Nat) (ha : a < 10) (hb : b < 10) :
    mod10Sum a b = (a + b) % 10 := by
  have hsum : a + b < 20 := by omega
  by_cases hlt : a + b < 10
  · simp [mod10Sum, hlt, Nat.mod_eq_of_lt hlt]
  · have h10 : 10 ≤ a + b := by omega
    have hdiv : (a + b) / 10 = 1 := by omega
    simp [mod10Sum, hlt]
    have := Nat.mod_add_div (a + b) 10
    omega

def bankerDraws (banker playerThird : Nat) : Bool :=
  if banker ≤ 2 then true
  else if banker = 3 then playerThird ≠ 8
  else if banker = 4 then 2 ≤ playerThird ∧ playerThird ≤ 7
  else if banker = 5 then 4 ≤ playerThird ∧ playerThird ≤ 7
  else if banker = 6 then 6 ≤ playerThird ∧ playerThird ≤ 7
  else false

/-- 0 player, 1 banker, 2 tie. Banker wins a strict greater total. -/
def cmpTotals (player banker : Nat) : Nat :=
  if banker > player then 1 else if player = banker then 2 else 0

theorem cmpTotals_spec (player banker : Nat) :
    (banker > player → cmpTotals player banker = 1) ∧
    (player = banker → cmpTotals player banker = 2) ∧
    (player > banker → cmpTotals player banker = 0) := by
  constructor
  · intro h
    simp [cmpTotals, h]
  · constructor
    · intro h
      have hnot : ¬ banker > player := by omega
      simp [cmpTotals, h, hnot]
    · intro h
      have hnot : ¬ banker > player := by omega
      have hne : player ≠ banker := by omega
      simp [cmpTotals, hnot, hne]

structure Baccarat where
  playerDraws : Bool
  bankerDraws : Bool
  playerFinal : Nat
  bankerFinal : Nat
  winner : Nat

def baccarat (cards : List Nat) : Baccarat :=
  match cards with
  | [c0, c1, c2, c3, c4, c5] =>
    let p2 := mod10Sum (baccaratPip c0) (baccaratPip c1)
    let b2 := mod10Sum (baccaratPip c2) (baccaratPip c3)
    let natural := 8 ≤ p2 ∨ 8 ≤ b2
    let pDraw := !natural && p2 ≤ 5
    let bDraw :=
      if natural then false
      else if pDraw then bankerDraws b2 (baccaratPip c4)
      else b2 ≤ 5
    let bankerThird := if pDraw then baccaratPip c5 else baccaratPip c4
    let pFinal := if natural then p2 else if pDraw then mod10Sum p2 (baccaratPip c4) else p2
    let bFinal := if natural then b2 else if bDraw then mod10Sum b2 bankerThird else b2
    let winner := cmpTotals pFinal bFinal
    { playerDraws := pDraw, bankerDraws := bDraw, playerFinal := pFinal, bankerFinal := bFinal,
      winner }
  | _ => { playerDraws := false, bankerDraws := false, playerFinal := 0, bankerFinal := 0, winner := 0 }

theorem baccarat_natural_stands (c0 c1 c2 c3 c4 c5 : Nat)
    (h : 8 ≤ mod10Sum (baccaratPip c0) (baccaratPip c1) ∨
      8 ≤ mod10Sum (baccaratPip c2) (baccaratPip c3)) :
    let hand := baccarat [c0, c1, c2, c3, c4, c5]
    hand.playerDraws = false ∧ hand.bankerDraws = false ∧
      hand.playerFinal = mod10Sum (baccaratPip c0) (baccaratPip c1) ∧
      hand.bankerFinal = mod10Sum (baccaratPip c2) (baccaratPip c3) := by
  simp [baccarat, h]

theorem baccarat_player_draws (c0 c1 c2 c3 c4 c5 : Nat)
    (hn : ¬ (8 ≤ mod10Sum (baccaratPip c0) (baccaratPip c1) ∨
      8 ≤ mod10Sum (baccaratPip c2) (baccaratPip c3)))
    (hp : mod10Sum (baccaratPip c0) (baccaratPip c1) ≤ 5) :
    (baccarat [c0, c1, c2, c3, c4, c5]).playerDraws = true := by
  simp [baccarat, hn, hp]

theorem baccarat_winner_cmp (c0 c1 c2 c3 c4 c5 : Nat) :
    let hand := baccarat [c0, c1, c2, c3, c4, c5]
    (hand.bankerFinal > hand.playerFinal → hand.winner = 1) ∧
    (hand.playerFinal = hand.bankerFinal → hand.winner = 2) ∧
    (hand.playerFinal > hand.bankerFinal → hand.winner = 0) := by
  simp only [baccarat]
  exact cmpTotals_spec _ _

theorem banker_draws_to_two (banker third : Nat) (h : banker ≤ 2) :
    bankerDraws banker third = true := by
  simp [bankerDraws, h]

theorem banker_three_stands_on_eight : bankerDraws 3 8 = false := by
  decide

theorem banker_three_otherwise (third : Nat) (h : third ≠ 8) : bankerDraws 3 third = true := by
  simp [bankerDraws, h]

theorem banker_stands_on_seven (third : Nat) : bankerDraws 7 third = false := by
  simp [bankerDraws]

theorem baccarat_showdown (cards : List Nat) (c0 c1 : Nat) :
    polynomialHash [(baccarat cards).winner, 0] [c0, c1] =
      ((baccarat cards).winner + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Blackjack -/

def bjHard (rank : Nat) : Nat :=
  if rank = 12 then 1 else if rank > 7 then 10 else rank + 2

def bjIsAce (rank : Nat) : Bool := rank = 12

def handValue (cards : List Nat) (count : Nat) : Nat × Bool × Bool :=
  let active := cards.take count
  let hard := (active.map fun c => bjHard (cardRank c)).sum
  let aces := (active.map fun c => if bjIsAce (cardRank c) then 1 else 0).sum
  let softOk := 0 < aces ∧ hard + 10 ≤ 21
  let best := if softOk then hard + 10 else hard
  let bust := 21 < best
  let blackjack := count = 2 ∧ best = 21 ∧ !bust
  (best, bust, blackjack)

/-- Nested mux from `CompareHandToDealer`. 0 lose, 1 push, 2 win, 3 player natural. -/
def bjSettle (playerBust dealerBust playerBJ dealerBJ playerGt playerEq : Bool) : Nat :=
  let selDealerBust := dealerBust && !playerBust
  let selBothBJ := playerBJ && dealerBJ && !playerBust && !dealerBust
  let selPlayerBJ := playerBJ && !dealerBJ && !playerBust && !dealerBust
  let valueOk := !playerBust && !dealerBust && !playerBJ && !dealerBJ
  let m1 := if selDealerBust then 2 else 0
  let m2 := if selBothBJ then 1 else m1
  let m3 := if selPlayerBJ then 3 else m2
  let m4 := if valueOk && playerGt then 2 else m3
  let m5 := if valueOk && playerEq then 1 else m4
  if playerBust then 0 else m5

theorem bj_player_bust (dB pBJ dBJ pGt pEq : Bool) :
    bjSettle true dB pBJ dBJ pGt pEq = 0 := by
  simp [bjSettle]

theorem bj_both_natural (pGt pEq : Bool) :
    bjSettle false false true true pGt pEq = 1 := by
  simp [bjSettle]

theorem bj_player_natural (pGt pEq : Bool) :
    bjSettle false false true false pGt pEq = 3 := by
  simp [bjSettle]

theorem bj_dealer_bust (pGt pEq : Bool) :
    bjSettle false true false false pGt pEq = 2 := by
  simp [bjSettle]

theorem bj_higher :
    bjSettle false false false false true false = 2 := by
  simp [bjSettle]

theorem bj_push :
    bjSettle false false false false false true = 1 := by
  simp [bjSettle]

theorem bj_lower :
    bjSettle false false false false false false = 0 := by
  simp [bjSettle]

def blackjackResult (player dealer : List Nat) (playerCount dealerCount : Nat) : Nat :=
  let p := handValue player playerCount
  let d := handValue dealer dealerCount
  bjSettle p.2.1 d.2.1 p.2.2 d.2.2 (decide (d.1 < p.1)) (decide (p.1 = d.1))

theorem handValue_uses_soft (cards : List Nat) (count : Nat)
    (hace : 0 < ((cards.take count).map fun c => if bjIsAce (cardRank c) then (1 : Nat) else 0).sum)
    (hsoft : ((cards.take count).map fun c => bjHard (cardRank c)).sum + 10 ≤ 21) :
    (handValue cards count).1 =
      ((cards.take count).map fun c => bjHard (cardRank c)).sum + 10 := by
  unfold handValue
  have hok :
      0 < ((cards.take count).map fun c => if bjIsAce (cardRank c) then (1 : Nat) else 0).sum ∧
        ((cards.take count).map fun c => bjHard (cardRank c)).sum + 10 ≤ 21 :=
    ⟨hace, hsoft⟩
  simp only [hok]
  simp

theorem soft_ace_is_eleven : (handValue [12] 1).1 = 11 := by
  decide

theorem soft_busts_back_to_hard : (handValue [12, 12, 12, 12, 8] 5).1 = 14 := by
  decide

theorem blackjack_natural_pays_three :
    blackjackResult [12, 11] [0] 2 1 = 3 := by
  decide

theorem blackjack_higher_total_wins :
    blackjackResult [10] [0] 1 1 = 2 := by
  decide

theorem blackjack_bust_loses (player dealer : List Nat) (playerCount dealerCount : Nat)
    (h : (handValue player playerCount).2.1 = true) :
    blackjackResult player dealer playerCount dealerCount = 0 := by
  simp [blackjackResult, h, bjSettle]

theorem blackjack_showdown (player dealer : List Nat) (playerCount dealerCount c0 c1 : Nat) :
    polynomialHash [blackjackResult player dealer playerCount dealerCount, 0] [c0, c1] =
      (blackjackResult player dealer playerCount dealerCount + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Keno -/

/-- Pair count, as in `Evaluate`: each of the first `nActual` spots adds one per matching draw cell. -/
def kenoHits (draw bets : List Nat) (nActual : Nat) : Nat :=
  ((bets.take nActual).map fun bet => draw.count bet).sum

theorem map_count_sum_le (draw bets : List Nat) :
    (bets.map fun bet => draw.count bet).sum ≤ bets.length * draw.length := by
  induction bets with
  | nil => simp
  | cons b bs ih =>
    simp only [List.map_cons, List.sum_cons, List.length_cons]
    have hb : draw.count b ≤ draw.length := List.count_le_length
    have hsum : draw.count b + (bs.map fun bet => draw.count bet).sum ≤
        draw.length + bs.length * draw.length := Nat.add_le_add hb ih
    have hmul : draw.length + bs.length * draw.length = (bs.length + 1) * draw.length := by
      rw [Nat.succ_mul, Nat.add_comm]
    omega

theorem kenoHits_le (draw bets : List Nat) (nActual : Nat) :
    kenoHits draw bets nActual ≤ min nActual bets.length * draw.length := by
  unfold kenoHits
  simpa [List.length_take] using map_count_sum_le draw (bets.take nActual)

theorem keno_all_miss (draw bets : List Nat) (nActual : Nat)
    (h : ∀ bet ∈ bets.take nActual, bet ∉ draw) :
    kenoHits draw bets nActual = 0 := by
  unfold kenoHits
  suffices ∀ xs : List Nat, (∀ bet ∈ xs, bet ∉ draw) → (xs.map fun bet => draw.count bet).sum = 0 from
    this (bets.take nActual) h
  intro xs hxs
  induction xs with
  | nil => simp
  | cons b bs ih =>
    have hb : b ∉ draw := hxs b (by simp)
    have htail := ih fun bet hm => hxs bet (List.mem_cons_of_mem _ hm)
    simp [List.count_eq_zero_of_not_mem hb, htail]

theorem keno_showdown (draw bets : List Nat) (nActual c0 c1 : Nat) :
    polynomialHash [kenoHits draw bets nActual, 0] [c0, c1] =
      (kenoHits draw bets nActual + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Craps roll -/

def crapsTotal (d0 d1 : Nat) : Nat := d0 + d1 + 2

inductive CrapsAction where
  | natural | craps | point | pass | sevenOut | reroll
  deriving DecidableEq, Repr

def crapsRoll (d0 d1 phase point : Nat) : Nat × Nat :=
  let total := crapsTotal d0 d1
  let comeOut := phase = 0
  let action :=
    if comeOut && (total = 7 ∨ total = 11) then 0
    else if comeOut && (total = 2 ∨ total = 3 ∨ total = 12) then 1
    else if comeOut && (total = 4 ∨ total = 5 ∨ total = 6 ∨ total = 8 ∨ total = 9 ∨ total = 10) then 2
    else if phase = 1 && total = point then 3
    else if phase = 1 && total = 7 then 4
    else if phase = 1 then 5
    else 0
  let pointOut :=
    if comeOut && (total = 4 ∨ total = 5 ∨ total = 6 ∨ total = 8 ∨ total = 9 ∨ total = 10) then total
    else if phase = 1 then point
    else 0
  (action, pointOut)

def crapsTableTerm (action pointOut : Nat) : Nat := action + pointOut * 6

theorem craps_comeout_natural (d0 d1 point : Nat)
    (h : crapsTotal d0 d1 = 7 ∨ crapsTotal d0 d1 = 11) :
    (crapsRoll d0 d1 0 point).1 = 0 := by
  simp [crapsRoll, h]

theorem craps_comeout_craps (d0 d1 point : Nat)
    (h : crapsTotal d0 d1 = 2 ∨ crapsTotal d0 d1 = 3 ∨ crapsTotal d0 d1 = 12) :
    (crapsRoll d0 d1 0 point).1 = 1 ∧ (crapsRoll d0 d1 0 point).2 = 0 := by
  rcases h with h | h | h <;> simp [crapsRoll, h]

theorem craps_comeout_point (d0 d1 point : Nat) (t : Nat)
    (ht : crapsTotal d0 d1 = t)
    (h : t = 4 ∨ t = 5 ∨ t = 6 ∨ t = 8 ∨ t = 9 ∨ t = 10) :
    (crapsRoll d0 d1 0 point).1 = 2 ∧ (crapsRoll d0 d1 0 point).2 = t := by
  rcases h with h | h | h | h | h | h <;> simp [crapsRoll, ht, h]

theorem craps_point_made (d0 d1 point : Nat) (h : crapsTotal d0 d1 = point) (hp : point ≠ 7) :
    (crapsRoll d0 d1 1 point).1 = 3 := by
  simp [crapsRoll, h, hp]

theorem craps_seven_out (d0 d1 point : Nat) (h : crapsTotal d0 d1 = 7) (hp : point ≠ 7) :
    (crapsRoll d0 d1 1 point).1 = 4 := by
  have hne : 7 ≠ point := Ne.symm hp
  simp [crapsRoll, h, hne]

/-- Pass line. `31` is the 1:1 win code; `0` loses; `1` keeps. -/
def passLine (phase total point : Nat) : Nat :=
  let comeOut := phase = 0
  let hit := (comeOut && (total = 7 ∨ total = 11)) || (phase = 1 && total = point)
  let lose := (comeOut && (total = 2 ∨ total = 3 ∨ total = 12)) || (phase = 1 && total = 7)
  if hit then 31 else if lose then 0 else 1

theorem pass_comeout_natural (total point : Nat) (h : total = 7 ∨ total = 11) :
    passLine 0 total point = 31 := by
  rcases h with rfl | rfl <;> simp [passLine]

theorem pass_comeout_craps (total point : Nat) (h : total = 2 ∨ total = 3 ∨ total = 12) :
    passLine 0 total point = 0 := by
  rcases h with rfl | rfl | rfl <;> simp [passLine]

/-- Don't pass: come-out 2 or 3 wins, 7 or 11 loses, 12 pushes. Point: 7 wins, the point loses. -/
def dontPass (phase total point : Nat) : Nat :=
  let comeOut := phase = 0
  let hit := (comeOut && (total = 2 ∨ total = 3)) || (phase = 1 && total = 7)
  let lose := (comeOut && (total = 7 ∨ total = 11)) || (phase = 1 && total = point)
  if hit then 31 else if lose then 0 else 1

theorem dontPass_twelve_pushes (point : Nat) : dontPass 0 12 point = 1 := by
  simp [dontPass]

theorem dontPass_comeout_craps (total point : Nat) (h : total = 2 ∨ total = 3) :
    dontPass 0 total point = 31 := by
  rcases h with rfl | rfl <;> simp [dontPass]

def crapsShowdown (betCodes : List Nat) (action pointOut c0 c1 : Nat) : Nat :=
  polynomialHash [packRadix 1024 betCodes, crapsTableTerm action pointOut] [c0, c1]

theorem craps_showdown (betCodes : List Nat) (action pointOut c0 c1 : Nat) :
    crapsShowdown betCodes action pointOut c0 c1 =
      (packRadix 1024 betCodes + 1) * c0 + (crapsTableTerm action pointOut + 1) * c1 := by
  simp [crapsShowdown, polynomialHash_two]

/-! ## Roulette -/

def redPockets : List Nat :=
  [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]

def splitPockets (m : Nat) : Nat × Nat :=
  if m < 24 then
    let j := m % 12
    let r := m / 12
    (3 * j + 1 + r, 3 * j + 2 + r)
  else
    let t := m - 24
    let j := t % 11
    let r := t / 11
    (3 * j + 1 + r, 3 * j + 4 + r)

def cornerPockets (m : Nat) : List Nat :=
  let j := m % 11
  let r := m / 11
  [3 * j + 1 + r, 3 * j + 2 + r, 3 * j + 4 + r, 3 * j + 5 + r]

def inRange (winner lo hi : Nat) : Bool := lo ≤ winner && winner ≤ hi

def roulettePayout (us : Bool) (type modifier winner : Nat) : Nat :=
  match type with
  | 0 => if modifier = winner then 35 else 0
  | 1 => if us && (winner = 0 || winner = 37) then 17 else 0
  | 2 =>
    let (lo, hi) := splitPockets modifier
    if modifier < 57 && (winner = lo || winner = hi) then 17 else 0
  | 3 => if modifier ≤ 11 && inRange winner (3 * modifier + 1) (3 * modifier + 3) then 11 else 0
  | 4 => if modifier ≤ 21 && (cornerPockets modifier).contains winner then 8 else 0
  | 5 =>
    if us then if winner = 0 || winner = 37 || winner = 1 || winner = 2 || winner = 3 then 6 else 0
    else if winner ≤ 3 then 8 else 0
  | 6 => if modifier ≤ 10 && inRange winner (3 * modifier + 1) (3 * modifier + 6) then 5 else 0
  | 7 =>
    let col := if winner = 0 then 99 else (winner - 1) % 3
    if modifier ≤ 2 && winner ≠ 0 && winner ≠ 37 && col = modifier then 2 else 0
  | 8 => if modifier ≤ 2 && inRange winner (12 * modifier + 1) (12 * modifier + 12) then 2 else 0
  | 9 =>
    if winner = 0 || winner = 37 then 0
    else if modifier = 0 && winner % 2 = 0 then 1
    else if modifier = 1 && winner % 2 = 1 then 1 else 0
  | 10 =>
    if winner = 0 || winner = 37 then 0
    else if modifier = 0 && redPockets.contains winner then 1
    else if modifier = 1 && !redPockets.contains winner && 1 ≤ winner && winner ≤ 36 then 1 else 0
  | 11 =>
    if modifier = 0 && inRange winner 1 18 then 1
    else if modifier = 1 && inRange winner 19 36 then 1 else 0
  | _ => 0

theorem roulette_straight (modifier : Nat) :
    roulettePayout false 0 modifier modifier = 35 := by
  simp [roulettePayout]

theorem roulette_even_loses_on_zero :
    roulettePayout false 9 0 0 = 0 ∧ roulettePayout true 9 0 37 = 0 := by
  simp [roulettePayout]

theorem roulette_red_loses_on_zero :
    roulettePayout false 10 0 0 = 0 ∧ roulettePayout true 10 0 37 = 0 := by
  simp [roulettePayout]

private theorem nat_ite_lt {c : Prop} [Decidable c] {a b n : Nat} (ha : a < n) (hb : b < n) :
    (if c then a else b) < n := by
  split <;> assumption

theorem roulettePayout_lt (us : Bool) (type modifier winner : Nat) :
    roulettePayout us type modifier winner < 36 := by
  unfold roulettePayout splitPockets cornerPockets inRange
  split
  all_goals (try dsimp)
  all_goals (repeat (first | refine nat_ite_lt (by decide) (by decide) | split | decide))

def roulettePacked (us : Bool) (bets : List (Nat × Nat)) (nActual winner : Nat) : Nat :=
  packRadix 36 <| bets.zipIdx.map fun (bet, i) =>
    if i < nActual then roulettePayout us bet.1 bet.2 winner else 0

theorem roulette_digits_lt (us : Bool) (bets : List (Nat × Nat)) (nActual winner : Nat) :
    ∀ x ∈ bets.zipIdx.map fun (bet, i) =>
      if i < nActual then roulettePayout us bet.1 bet.2 winner else 0, x < 36 := by
  intro x hx
  simp only [List.mem_map] at hx
  rcases hx with ⟨_, _, rfl⟩
  split
  · exact roulettePayout_lt _ _ _ _
  · decide

theorem roulette_showdown (us : Bool) (bets : List (Nat × Nat)) (nActual winner c0 c1 : Nat) :
    polynomialHash [roulettePacked us bets nActual winner, 0] [c0, c1] =
      (roulettePacked us bets nActual winner + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

theorem roulette_is_payouts (us : Bool) (bets : List (Nat × Nat)) (nActual winner : Nat) :
    unpackRadix bets.length 36 (roulettePacked us bets nActual winner) =
      bets.zipIdx.map fun (bet, i) =>
        if i < nActual then roulettePayout us bet.1 bet.2 winner else 0 := by
  unfold roulettePacked
  have hlen :
      (bets.zipIdx.map fun (bet, i) =>
        if i < nActual then roulettePayout us bet.1 bet.2 winner else 0).length =
        bets.length := by
    simp
  rw [← hlen]
  exact unpack_pack 36 (by decide) _ (roulette_digits_lt us bets nActual winner)

/-! ## Slots -/

def threeReelPay (coin combo : Nat) : Nat :=
  let table : List (List Nat) := [
    [500, 1000, 6000], [200, 400, 600], [75, 150, 225], [40, 80, 120],
    [20, 40, 60], [10, 20, 30], [5, 10, 15]]
  if coin = 1 || coin = 2 || coin = 3 then
    if h : combo < table.length then (table[combo]'h)[coin - 1]?.getD 0 else 0
  else 0

def symbolOrWild (wild symbol target : Bool) : Bool := wild || (!wild && symbol && target)

def asSymbol (s target : Nat) : Bool := decide (s = 7) || decide (s = target)

/-- Priority matches `EvaluateThreeReel`: double 7, single 7, any 7, then bars. Wild is 7. -/
def threeReelCombo (a b c : Nat) : Option Nat :=
  let three (t : Nat) := asSymbol a t && asSymbol b t && asSymbol c t
  let seven (s : Nat) := decide (s = 7) || decide (s = 5) || decide (s = 6)
  let bar (s : Nat) := decide (s = 7) || decide (s = 2) || decide (s = 3) || decide (s = 4)
  if three 6 then some 0
  else if three 5 then some 1
  else if seven a && seven b && seven c then some 2
  else if three 4 then some 3
  else if three 3 then some 4
  else if three 2 then some 5
  else if bar a && bar b && bar c then some 6
  else none

def threeReelPayout (symbols : List Nat) (coin : Nat) : Nat :=
  match symbols with
  | [a, b, c] =>
    match threeReelCombo a b c with
    | some combo => threeReelPay coin combo
    | none => 0
  | _ => 0

theorem threeReel_double7 (coin : Nat) :
    threeReelPayout [6, 6, 6] coin = threeReelPay coin 0 := by
  simp [threeReelPayout, threeReelCombo, asSymbol]

theorem threeReel_wild_substitutes (coin : Nat) :
    threeReelPayout [7, 6, 6] coin = threeReelPay coin 0 := by
  simp [threeReelPayout, threeReelCombo, asSymbol]

def fiveReelPay (symbol count : Nat) : Nat :=
  let row : List (List Nat) := [
    [5, 10, 25], [5, 10, 25], [7, 15, 40], [8, 20, 50],
    [10, 25, 60], [25, 60, 120], [50, 200, 250]]
  if h : symbol < row.length then
    if count = 3 then (row[symbol]'h)[0]!
    else if count = 4 then (row[symbol]'h)[1]!
    else if count = 5 then (row[symbol]'h)[2]!
    else 0
  else 0

def starburstLines : List (List Nat) := [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0]]

def expandReel (reel : List Nat) (middle : Bool) : List Nat :=
  if middle && reel.any (· = 7) then [7, 7, 7] else reel

theorem expand_middle_wild (a b c : Nat) :
    expandReel [a, b, c] true = if a = 7 ∨ b = 7 ∨ c = 7 then [7, 7, 7] else [a, b, c] := by
  simp [expandReel, List.any]

def fiveReelPayout (linePays : List Nat) (coin : Nat) : Nat := linePays.sum * coin

theorem fiveReel_scales (linePays : List Nat) (coin : Nat) :
    fiveReelPayout linePays coin = linePays.sum * coin := by rfl

theorem three_reel_showdown (symbols : List Nat) (coin c0 c1 : Nat) :
    polynomialHash [threeReelPayout symbols coin, 0] [c0, c1] =
      (threeReelPayout symbols coin + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

def paySymbol : List Nat → Nat
  | s :: _ => if s = 7 then 6 else s
  | [] => 0

def symbolMatches (symbol i s : Nat) : Bool :=
  decide ((i = 1 ∨ i = 2 ∨ i = 3) ∧ s = 7) || decide (s = symbol)

def runLength (symbol : Nat) : List Nat → Nat → Nat
  | [], _ => 0
  | s :: ss, i =>
    if symbolMatches symbol i s then 1 + runLength symbol ss (i + 1) else 0

/-- Leading run. Reels 0 and 4 match the left symbol only; reels 1–3 also match a wild. -/
def countFromLeft (symbols : List Nat) : Nat :=
  runLength (paySymbol symbols) symbols 0

def lineAward (symbols : List Nat) : Nat :=
  max (fiveReelPay (paySymbol symbols) (countFromLeft symbols))
    (fiveReelPay (paySymbol symbols.reverse) (countFromLeft symbols.reverse))

def expandWindow (reels : List (List Nat)) : List (List Nat) :=
  reels.zipIdx.map fun (reel, i) => expandReel reel (decide (i = 1 ∨ i = 2 ∨ i = 3))

def lineSymbols (window : List (List Nat)) (line : List Nat) : List Nat :=
  (line.zip window).map fun (row, reel) => reel.getD row 0

def fiveReelAward (reels : List (List Nat)) (coin : Nat) : Nat :=
  let window := expandWindow reels
  (starburstLines.map fun line => lineAward (lineSymbols window line)).sum * coin

theorem five_of_a_kind : countFromLeft [1, 1, 1, 1, 1] = 5 := by
  decide

theorem five_of_a_kind_pays : lineAward [1, 1, 1, 1, 1] = 25 := by
  native_decide

theorem run_stops_at_mismatch : countFromLeft [1, 1, 2, 1, 1] = 2 := by
  decide

theorem middle_wild_substitutes : countFromLeft [1, 7, 1, 2, 3] = 3 := by
  decide

theorem left_wild_pays_as_bar : paySymbol [7, 0, 0, 0, 0] = 6 := by
  decide

theorem both_ways_takes_the_longer :
    lineAward [2, 2, 1, 1, 1] = 5 := by
  native_decide

theorem five_reel_full_board :
    fiveReelAward [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]] 1 = 250 := by
  native_decide

theorem five_reel_showdown (reels : List (List Nat)) (coin c0 c1 : Nat) :
    polynomialHash [fiveReelAward reels coin, 0] [c0, c1] =
      (fiveReelAward reels coin + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Bingo -/

def packBingo (won : Bool) (index : Nat) : Nat := (if won then 1 else 0) * 256 + index

theorem packBingo_won (index : Nat) : packBingo true index = 256 + index := by
  simp [packBingo]

theorem packBingo_lost (index : Nat) : packBingo false index = index := by
  simp [packBingo]

def firstCompletion (hits : List Bool) : Nat :=
  match hits.findIdx? id with
  | some i => i + 1
  | none => 0

theorem firstCompletion_zero (hits : List Bool) (h : ∀ b ∈ hits, b = false) :
    firstCompletion hits = 0 := by
  unfold firstCompletion
  cases hfind : hits.findIdx? id with
  | none => rfl
  | some i =>
    rcases List.findIdx?_eq_some_iff_getElem.mp hfind with ⟨hi, hb, _⟩
    have hf := h hits[i] (List.getElem_mem hi)
    simp [id, hf] at hb

theorem firstCompletion_least (hits : List Bool) (i : Nat) (hi : i < hits.length)
    (hb : hits[i] = true) (hearlier : ∀ j, j < i → hits[j]? = some false) :
    firstCompletion hits = i + 1 := by
  unfold firstCompletion
  have hfind : hits.findIdx? id = some i := by
    rw [List.findIdx?_eq_some_iff_getElem]
    refine ⟨hi, by simpa [id] using hb, ?_⟩
    intro j hj
    have hfalse := hearlier j hj
    rw [List.getElem?_eq_some_iff] at hfalse
    rcases hfalse with ⟨_, hjval⟩
    simpa [id, hjval]
  simp [hfind]

def bingo90Packed (one two house : Nat × Bool) : Nat :=
  packBingo one.2 one.1 + packBingo two.2 two.1 * 512 + packBingo house.2 house.1 * 262144

theorem bingo90_showdown (one two house : Nat × Bool) (c0 c1 : Nat) :
    polynomialHash [bingo90Packed one two house, 0] [c0, c1] =
      (bingo90Packed one two house + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

theorem bingo75_showdown (won : Bool) (index c0 c1 : Nat) :
    polynomialHash [packBingo won index, 0] [c0, c1] =
      (packBingo won index + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Poker -/

def rankCount (cards : List Nat) (r : Nat) : Nat := (cards.map cardRank).count r

def kindsAtLeast (cards : List Nat) (k : Nat) : List Nat :=
  ((List.range 13).filter fun r => k ≤ rankCount cards r).mergeSort (· ≥ ·)

def isFlush5 (cards : List Nat) : Bool :=
  match cards with
  | c :: cs => cs.all (fun d => cardSuit d = cardSuit c) && cards.length = 5
  | [] => false

def straightHigh : List Nat → Option Nat
  | [a, b, c, d, e] =>
    if [a, b, c, d, e] = [0, 1, 2, 3, 12] then some 3
    else if b = a + 1 ∧ c = b + 1 ∧ d = c + 1 ∧ e = d + 1 then some e
    else none
  | _ => none

def sortedRanks (cards : List Nat) : List Nat :=
  ((cards.map cardRank).eraseDups).mergeSort (· ≤ ·)

def pack6 (cat k0 k1 k2 k3 k4 k5 : Nat) : Nat :=
  (((((cat * 16 + k0) * 16 + k1) * 16 + k2) * 16 + k3) * 16 + k4) * 16 + k5

def score5 (cards : List Nat) : Nat :=
  if cards.length ≠ 5 then 0 else
  let flush := isFlush5 cards
  let straight := straightHigh (sortedRanks cards)
  let quads := kindsAtLeast cards 4
  let trips := kindsAtLeast cards 3
  let pairs := kindsAtLeast cards 2
  let kick := ((List.range 13).filter fun r => 0 < rankCount cards r).mergeSort (· ≥ ·)
  match straight with
  | some high =>
    if flush then pack6 9 high 0 0 0 0 0
    else pack6 5 high 0 0 0 0 0
  | none =>
    match quads with
    | q :: _ =>
      let kicker := (kick.filter (· ≠ q)).head?.getD 0
      pack6 8 q kicker 0 0 0 0
    | [] =>
      match trips with
      | t :: _ =>
        match pairs.filter (· ≠ t) with
        | p :: _ => pack6 7 t p 0 0 0 0
        | [] =>
          let ks := (kick.filter (· ≠ t))
          pack6 4 t (ks.head?.getD 0) (ks.getD 1 0) 0 0 0
      | [] =>
        if flush then
          let ks := kick
          pack6 6 (ks.head?.getD 0) (ks.getD 1 0) (ks.getD 2 0) (ks.getD 3 0) (ks.getD 4 0) 0
        else
          match pairs with
          | p1 :: p2 :: _ =>
            let k := (kick.filter fun r => r ≠ p1 && r ≠ p2).head?.getD 0
            pack6 3 (max p1 p2) (min p1 p2) k 0 0 0
          | p :: _ =>
            let ks := kick.filter (· ≠ p)
            pack6 2 p (ks.head?.getD 0) (ks.getD 1 0) (ks.getD 2 0) 0 0
          | [] =>
            pack6 1 (kick.head?.getD 0) (kick.getD 1 0) (kick.getD 2 0)
              (kick.getD 3 0) (kick.getD 4 0) 0

def kickerBound (k0 k1 k2 k3 k4 k5 : Nat) : Prop :=
  k0 < 16 ∧ k1 < 16 ∧ k2 < 16 ∧ k3 < 16 ∧ k4 < 16 ∧ k5 < 16

theorem pack6_tail_lt (k0 k1 k2 k3 k4 k5 : Nat) (h : kickerBound k0 k1 k2 k3 k4 k5) :
    (((((k0 * 16 + k1) * 16 + k2) * 16 + k3) * 16 + k4) * 16 + k5) < 16 ^ 6 := by
  rcases h with ⟨h0, h1, h2, h3, h4, h5⟩
  have h16 : 16 ^ 6 = 16777216 := by decide
  have : (((((k0 * 16 + k1) * 16 + k2) * 16 + k3) * 16 + k4) * 16 + k5) ≤
      (((((15 * 16 + 15) * 16 + 15) * 16 + 15) * 16 + 15) * 16 + 15) := by
    omega
  omega

theorem higher_category_wins (c1 c2 k0 k1 k2 k3 k4 k5 m0 m1 m2 m3 m4 m5 : Nat)
    (hc : c2 < c1) (hc1 : c1 < 16)
    (hk : kickerBound k0 k1 k2 k3 k4 k5) (hm : kickerBound m0 m1 m2 m3 m4 m5) :
    pack6 c2 m0 m1 m2 m3 m4 m5 < pack6 c1 k0 k1 k2 k3 k4 k5 := by
  unfold pack6
  have htail := pack6_tail_lt m0 m1 m2 m3 m4 m5 hm
  have hlo : (((((m0 * 16 + m1) * 16 + m2) * 16 + m3) * 16 + m4) * 16 + m5) ≤ 16 ^ 6 - 1 := by
    omega
  have : c2 + 1 ≤ c1 := Nat.succ_le_of_lt hc
  omega

def combinations : Nat → List Nat → List (List Nat)
  | 0, _ => [[]]
  | _, [] => []
  | n + 1, x :: xs => (combinations n xs).map (fun ys => x :: ys) ++ combinations (n + 1) xs

def bestHand (cards : List Nat) : Nat :=
  ((combinations 5 cards).map score5).foldl max 0

def seatScore (hole : Nat × Nat) (board : List Nat) : Nat :=
  bestHand (hole.1 :: hole.2 :: board)

def potStep (m : Nat) (sp : Nat × Bool) : Nat :=
  if sp.2 && m < sp.1 then sp.1 else m

/-- Best five-card score among seats marked in the pot. Empty pot scores 0. -/
def potBest (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool) : Nat :=
  ((holes.map fun hole => seatScore hole board).zip inPot).foldl potStep 0

theorem potStep_ge (m : Nat) (sp : Nat × Bool) : m ≤ potStep m sp := by
  cases sp with
  | mk s p =>
    cases p
    · simp [potStep]
    · unfold potStep
      simp
      by_cases hlt : m < s
      · simpa [hlt] using Nat.le_of_lt hlt
      · simp [hlt]

theorem foldl_potStep_ge (acc : Nat) (pairs : List (Nat × Bool)) :
    acc ≤ pairs.foldl potStep acc := by
  induction pairs generalizing acc with
  | nil => simp
  | cons p ps ih =>
    simp only [List.foldl_cons]
    exact Nat.le_trans (potStep_ge acc p) (ih _)

theorem mem_le_potFold (acc : Nat) (pairs : List (Nat × Bool))
    {s : Nat} {p : Bool} (hm : (s, p) ∈ pairs) (hp : p = true) :
    s ≤ pairs.foldl potStep acc := by
  induction pairs generalizing acc with
  | nil => cases hm
  | cons hd tl ih =>
    simp only [List.foldl_cons]
    cases hm with
    | head =>
      have hstep : s ≤ potStep acc (s, p) := by
        unfold potStep
        simp [hp]
        by_cases hlt : acc < s
        · simp [hlt]
        · simpa [hlt] using Nat.le_of_not_lt hlt
      exact Nat.le_trans hstep (foldl_potStep_ge _ _)
    | tail _ htl =>
      exact ih _ htl

theorem foldl_potStep_le (acc : Nat) (pairs : List (Nat × Bool)) (bound : Nat)
    (hacc : acc ≤ bound)
    (hsel : ∀ s p, (s, p) ∈ pairs → p = true → s ≤ bound) :
    pairs.foldl potStep acc ≤ bound := by
  induction pairs generalizing acc with
  | nil => simpa using hacc
  | cons hd tl ih =>
    simp only [List.foldl_cons]
    refine ih _ ?_ ?_
    · cases hd with
      | mk s p =>
        unfold potStep
        cases p
        · simpa using hacc
        · have hs : s ≤ bound := hsel s true (List.Mem.head tl) rfl
          simp
          by_cases hlt : acc < s
          · simpa [hlt] using hs
          · simpa [hlt] using hacc
    · intro s p hm hp
      exact hsel s p (List.Mem.tail hd hm) hp

def pokerDigits (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool) : List Nat :=
  let scores := holes.map fun hole => seatScore hole board
  let active := inPot.any id
  let best := potBest holes board inPot
  (scores.zip inPot).map fun (s, p) => if active && p && s = best then 1 else 0

def pokerMask (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool) : Nat :=
  packRadix 2 (pokerDigits holes board inPot)

theorem any_of_true (inPot : List Bool) (i : Nat) (h : inPot[i]? = some true) :
    inPot.any id = true := by
  induction inPot generalizing i with
  | nil => simp at h
  | cons b bs ih =>
    cases i with
    | zero =>
      simp at h
      simp [h]
    | succ i =>
      simp only [List.getElem?_cons_succ] at h
      simp [ih i h]

theorem potBest_ge_seat (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool)
    (i : Nat) (hi : i < holes.length) (hlen : inPot.length = holes.length)
    (hp : inPot[i]? = some true) :
    seatScore holes[i] board ≤ potBest holes board inPot := by
  have hiz : i < ((holes.map fun hole => seatScore hole board).zip inPot).length := by
    simp [List.length_zip, List.length_map, hlen, hi]
  have heq : ((holes.map fun hole => seatScore hole board).zip inPot)[i] =
      (seatScore holes[i] board, true) := by
    rcases List.getElem?_eq_some_iff.mp hp with ⟨_, hval⟩
    simp [List.getElem_zip, List.getElem_map, hi, hlen, hval]
  have hmem : (seatScore holes[i] board, true) ∈
      (holes.map fun hole => seatScore hole board).zip inPot := by
    have := List.getElem_mem hiz
    simpa [heq] using this
  exact mem_le_potFold 0 _ hmem rfl

theorem zip_seat (board : List Nat) (holes : List (Nat × Nat)) (inPot : List Bool)
    {s : Nat} {p : Bool}
    (hm : (s, p) ∈ (holes.map fun hole => seatScore hole board).zip inPot) (hp : p = true) :
    ∃ j, ∃ hj : j < holes.length, inPot[j]? = some true ∧ s = seatScore holes[j] board := by
  induction holes generalizing inPot with
  | nil => simp at hm
  | cons hole rest ih =>
    cases inPot with
    | nil => simp at hm
    | cons b bs =>
      simp only [List.map_cons, List.zip_cons_cons, List.mem_cons] at hm
      rcases hm with heq | hm
      · cases heq
        exact ⟨0, by simp, by simp [hp], rfl⟩
      · rcases ih bs hm with ⟨j, hj, hin, hs⟩
        refine ⟨j + 1, Nat.succ_lt_succ hj, ?_, ?_⟩
        · simpa [List.getElem?_cons_succ] using hin
        · rw [List.getElem_cons_succ]
          exact hs

theorem potBest_le_of_best (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool)
    (bound : Nat)
    (hsel : ∀ (j : Nat) (hj : j < holes.length),
      inPot[j]? = some true → seatScore (holes[j]'hj) board ≤ bound) :
    potBest holes board inPot ≤ bound := by
  unfold potBest
  refine foldl_potStep_le 0 _ bound (Nat.zero_le _) ?_
  intro s p hm hp
  rcases zip_seat board holes inPot hm hp with ⟨j, hj, hin, hs⟩
  have hscore : seatScore (holes[j]'hj) board ≤ bound := hsel j hj hin
  have hs' : s = seatScore (holes[j]'hj) board := hs
  rw [hs']
  exact hscore

/--
A seat's winner bit is 1 exactly when the pot is nonempty, the seat is in the
pot, and that seat's best five-card hand equals the best hand in the pot.
Tied best hands all win. Seats out of the pot do not.
-/
theorem poker_best_hands_win (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool)
    (i : Nat) (hi : i < holes.length) (hlen : inPot.length = holes.length) :
    (pokerDigits holes board inPot)[i]? = some 1 ↔
      inPot[i]? = some true ∧
      seatScore holes[i] board = potBest holes board inPot ∧
      inPot.any id = true := by
  have hlenD : i < (pokerDigits holes board inPot).length := by
    unfold pokerDigits
    simp [List.length_map, List.length_zip, hlen, Nat.min_self, hi]
  rw [getElem?_pos (pokerDigits holes board inPot) i hlenD]
  unfold pokerDigits at hlenD ⊢
  simp only [List.getElem_map, List.getElem_zip, List.getElem_map, hi, hlen]
  have hin : inPot[i]'(by omega) = true ↔ inPot[i]? = some true := by
    rw [getElem?_pos inPot i (by omega : i < inPot.length)]
    simp
  constructor
  · intro hbit
    generalize hcond : (inPot.any id && inPot[i] &&
      decide (seatScore holes[i] board = potBest holes board inPot)) = c
    cases c
    · simp [hcond] at hbit
    · simp only [Bool.and_eq_true, decide_eq_true_eq] at hcond
      rcases hcond with ⟨⟨ha, hp⟩, hs⟩
      exact ⟨hin.mp hp, hs, ha⟩
  · intro ⟨hp, hs, ha⟩
    have hp' : inPot[i]'(by omega) = true := hin.mpr hp
    simp [ha, hp', hs]

theorem poker_winner_has_best_hand (holes : List (Nat × Nat)) (board : List Nat)
    (inPot : List Bool) (i : Nat) (hi : i < holes.length) (hlen : inPot.length = holes.length)
    (hw : (pokerDigits holes board inPot)[i]? = some 1) (j : Nat) (hj : j < holes.length)
    (hp : inPot[j]? = some true) :
    seatScore holes[j] board ≤ seatScore holes[i] board := by
  have hwin := (poker_best_hands_win holes board inPot i hi hlen).mp hw
  have hge := potBest_ge_seat holes board inPot j hj hlen hp
  omega

theorem poker_maximal_hand_wins (holes : List (Nat × Nat)) (board : List Nat)
    (inPot : List Bool) (i : Nat) (hi : i < holes.length) (hlen : inPot.length = holes.length)
    (hp : inPot[i]? = some true)
    (hbest : ∀ (j : Nat) (hj : j < holes.length), inPot[j]? = some true →
      seatScore (holes[j]'hj) board ≤ seatScore holes[i] board) :
    (pokerDigits holes board inPot)[i]? = some 1 := by
  have hle : potBest holes board inPot ≤ seatScore holes[i] board :=
    potBest_le_of_best holes board inPot _ hbest
  have hge : seatScore holes[i] board ≤ potBest holes board inPot :=
    potBest_ge_seat holes board inPot i hi hlen hp
  have heq : seatScore holes[i] board = potBest holes board inPot := by omega
  exact (poker_best_hands_win holes board inPot i hi hlen).mpr ⟨hp, heq, any_of_true inPot i hp⟩

theorem poker_empty_pot (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool)
    (hlen : inPot.length = holes.length) (h : inPot.all (· = false) = true) :
    pokerDigits holes board inPot = List.replicate holes.length 0 := by
  have hactive : inPot.any id = false := by
    clear hlen holes board
    induction inPot with
    | nil => simp
    | cons b bs ih =>
      simp only [List.all_cons, Bool.and_eq_true, decide_eq_true_eq] at h
      simp [h.1, ih h.2]
  unfold pokerDigits
  simp only [hactive, Bool.false_and]
  rw [List.map_const']
  simp [List.length_zip, List.length_map, hlen, Nat.min_self]

def pokerPacked (masks : List Nat) : Nat := packRadix 1024 masks

theorem poker_masks_roundtrip (masks : List Nat) (h : ∀ m ∈ masks, m < 1024) :
    unpackRadix masks.length 1024 (pokerPacked masks) = masks :=
  unpack_pack 1024 (by decide) masks h

theorem poker_showdown (masks : List Nat) (c0 c1 : Nat) :
    polynomialHash [pokerPacked masks, 0] [c0, c1] = (pokerPacked masks + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

theorem poker_pot_showdown (holes : List (Nat × Nat)) (board : List Nat) (inPot : List Bool)
    (c0 c1 : Nat) :
    polynomialHash [pokerMask holes board inPot, 0] [c0, c1] =
      (pokerMask holes board inPot + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-- Nine 10-bit pot masks, each below 1024, pack below `2^90`, so the hash does not wrap the scalar. -/
theorem poker_pots_below_scalar (masks : List Nat) (c0 c1 : Nat)
    (hlen : masks.length ≤ 9) (hm : ∀ m ∈ masks, m < 1024)
    (hc0 : c0 < 2 ^ 128) (hc1 : c1 < 2 ^ 128) :
    polynomialHash [packRadix 1024 masks, 0] [c0, c1] < 2 ^ 253 := by
  have hpack : packRadix 1024 masks < 1024 ^ masks.length :=
    packRadix_lt_pow 1024 (by decide) masks hm
  have hpow : 1024 ^ masks.length ≤ 1024 ^ 9 := Nat.pow_le_pow_right (by decide) hlen
  have h1024 : 1024 ^ 9 = 2 ^ 90 := by
    have : (1024 : Nat) = 2 ^ 10 := by decide
    rw [this, ← Nat.pow_mul]
  have hlt : packRadix 1024 masks < 2 ^ 90 := by
    rw [← h1024]
    exact Nat.lt_of_lt_of_le hpack hpow
  have hr0 : packRadix 1024 masks + 1 ≤ 2 ^ 90 := Nat.succ_le_of_lt hlt
  have hr1 : 0 + 1 ≤ 2 ^ 90 := by decide
  exact polynomialHash_below_scalar _ _ _ _ 90 hr0 hr1 hc0 hc1 (by decide)

theorem wheel_straight_flush_beats_four_aces :
    score5 [0, 1, 2, 3, 12] > score5 [12, 25, 38, 51, 11] := by
  native_decide

theorem straight_flush_beats_quads :
    pack6 9 12 0 0 0 0 0 > pack6 8 12 11 0 0 0 0 := by
  unfold pack6
  decide

end

end ZkCasino.Evaluation
