module

public import ZkCasino.Evaluation.Games

/-
Bingo cards and the craps bet sheet. The other seven games, including the
five-reel paylines and the roulette payout roundtrip, are proved in `Games.lean`.
-/

namespace ZkCasino.Evaluation

public section

/-! ## Bingo -/

def marked75 (cells balls : List Nat) (nCalled c : Nat) : Bool :=
  decide (c = 12) ||
    (balls.take nCalled).any fun b =>
      match cells[c]? with
      | some cell => decide (cell = b + 1)
      | none => false

def allMarked (cells balls : List Nat) (nCalled : Nat) (idxs : List Nat) : Bool :=
  idxs.all fun c => marked75 cells balls nCalled c

def row75 (cells balls : List Nat) (nCalled row : Nat) : Bool :=
  allMarked cells balls nCalled ((List.range 5).map fun k => row * 5 + k)

def col75 (cells balls : List Nat) (nCalled col : Nat) : Bool :=
  allMarked cells balls nCalled ((List.range 5).map fun k => k * 5 + col)

def anyLine75 (cells balls : List Nat) (nCalled : Nat) : Bool :=
  (List.range 5).any (row75 cells balls nCalled) ||
    (List.range 5).any (col75 cells balls nCalled) ||
    allMarked cells balls nCalled [0, 6, 12, 18, 24] ||
    allMarked cells balls nCalled [4, 8, 12, 16, 20]

def bingo75Hit (cells balls : List Nat) (nCalled pattern : Nat) : Bool :=
  if pattern = 0 then anyLine75 cells balls nCalled
  else if pattern = 1 then allMarked cells balls nCalled [0, 4, 20, 24]
  else if pattern = 2 then (List.range 25).all (marked75 cells balls nCalled)
  else false

def bingo75Result (cells balls : List Nat) (nCalled pattern : Nat) : Nat :=
  let hits := (List.range (min nCalled balls.length)).map fun t =>
    bingo75Hit cells balls (t + 1) pattern
  let idx := firstCompletion hits
  packBingo (decide (0 < idx)) idx

theorem bingo_center_starts_marked (cells balls : List Nat) (nCalled : Nat) :
    marked75 cells balls nCalled 12 = true := by
  simp [marked75]

def bingo75TopRow : List Nat :=
  [1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

theorem bingo75_row_completes_on_fifth :
    bingo75Result bingo75TopRow [0, 1, 2, 3, 4] 5 0 = packBingo true 5 := by
  unfold bingo75Result
  have hhits :
      (List.range (min 5 [0, 1, 2, 3, 4].length)).map
          (fun t => bingo75Hit bingo75TopRow [0, 1, 2, 3, 4] (t + 1) 0) =
        [false, false, false, false, true] := by
    decide
  simp only [hhits]
  have hidx : firstCompletion [false, false, false, false, true] = 5 := by
    refine firstCompletion_least _ 4 (by decide) (by decide) ?_
    intro j hj
    have : j = 0 ∨ j = 1 ∨ j = 2 ∨ j = 3 := by omega
    rcases this with rfl | rfl | rfl | rfl <;> decide
  have hwon : decide (0 < 5) = true := by decide
  simp [hidx, hwon]

theorem bingo_corners_win (cells balls : List Nat) (nCalled : Nat)
    (h0 : marked75 cells balls nCalled 0 = true)
    (h4 : marked75 cells balls nCalled 4 = true)
    (h20 : marked75 cells balls nCalled 20 = true)
    (h24 : marked75 cells balls nCalled 24 = true) :
    bingo75Hit cells balls nCalled 1 = true := by
  simp [bingo75Hit, allMarked, h0, h4, h20, h24]

theorem bingo75_eval_showdown (cells balls : List Nat) (nCalled pattern c0 c1 : Nat) :
    polynomialHash [bingo75Result cells balls nCalled pattern, 0] [c0, c1] =
      (bingo75Result cells balls nCalled pattern + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

def marked90 (cells balls : List Nat) (nCalled c : Nat) : Bool :=
  match cells[c]? with
  | some cell => decide (cell ≠ 0) && (balls.take nCalled).any fun b => decide (cell = b + 1)
  | none => false

def bingo90Lines (cells balls : List Nat) (nCalled : Nat) : Nat :=
  (List.range 3).countP fun r =>
    ((List.range 9).filter fun k => marked90 cells balls nCalled (r * 9 + k)).length = 5

def firstLines (cells balls : List Nat) (nCalled need : Nat) : Nat :=
  firstCompletion <| (List.range (min nCalled balls.length)).map fun t =>
    decide (need ≤ bingo90Lines cells balls (t + 1))

def bingo90Result (cells balls : List Nat) (nCalled : Nat) : Nat :=
  let one := firstLines cells balls nCalled 1
  let two := firstLines cells balls nCalled 2
  let house := firstLines cells balls nCalled 3
  bingo90Packed (one, decide (0 < one)) (two, decide (0 < two)) (house, decide (0 < house))

theorem bingo90_blank_has_no_line :
    bingo90Lines (List.replicate 27 0) [] 0 = 0 := by
  decide

/-- Balls are 0-based: card cell `n` is marked by ball `n - 1`. -/
theorem bingo90_full_row_is_one_line :
    bingo90Lines [1, 2, 3, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      [0, 1, 2, 3, 4] 5 = 1 := by
  decide

theorem bingo90_eval_showdown (cells balls : List Nat) (nCalled c0 c1 : Nat) :
    polynomialHash [bingo90Result cells balls nCalled, 0] [c0, c1] =
      (bingo90Result cells balls nCalled + 1) * c0 + c1 :=
  polynomialHash_oneResult _ _ _

/-! ## Craps bets -/

def pointNumber (index : Nat) : Nat :=
  if index = 0 then 4 else if index = 1 then 5 else if index = 2 then 6
  else if index = 3 then 8 else if index = 4 then 9 else if index = 5 then 10 else 0

def bandCode (index outer mid inner : Nat) : Nat :=
  if index = 0 || index = 5 then outer
  else if index = 1 || index = 4 then mid
  else if index = 2 || index = 3 then inner else 0

def settleKLW (hit lose : Bool) (winCode : Nat) : Nat :=
  if hit then winCode else if lose then 0 else 1

def hardNumber (index : Nat) : Nat :=
  if index = 0 then 4 else if index = 1 then 6 else if index = 2 then 8
  else if index = 3 then 10 else 0

/-- One encrypted bet. `hard` is the two dice showing the same face. -/
def crapsBet (type modifier phase point total : Nat) (hard : Bool) : Nat :=
  let seven := decide (total = 7)
  let eleven := decide (total = 11)
  let two := decide (total = 2)
  let three := decide (total = 3)
  let twelve := decide (total = 12)
  let craps := two || three || twelve
  if type = 0 then passLine phase total point
  else if type = 1 then dontPass phase total point
  else if type = 2 then
    if modifier = 0 then settleKLW (seven || eleven) craps 31
    else settleKLW (decide (total = pointNumber (modifier - 1))) seven 31
  else if type = 3 then
    if modifier = 0 then settleKLW (two || three) (seven || eleven) 31
    else settleKLW seven (decide (total = pointNumber (modifier - 1))) 31
  else if type = 4 then
    let family := modifier / 6
    let idx := modifier % 6
    let num := pointNumber idx
    let onPoint := decide (phase = 1)
    let pointOk := decide (point = num)
    let hitNum := decide (total = num)
    let workingPass := onPoint && pointOk
    let hit :=
      if family = 0 then workingPass && hitNum
      else if family = 1 then workingPass && seven
      else if family = 2 then onPoint && hitNum
      else if family = 3 then seven
      else false
    let lose :=
      if family = 0 then workingPass && seven
      else if family = 1 then workingPass && hitNum
      else if family = 2 then onPoint && seven
      else if family = 3 then hitNum
      else false
    let code :=
      if family = 0 || family = 2 then bandCode idx 61 46 37 else bandCode idx 16 21 26
    settleKLW hit lose code
  else if type = 5 then
    settleKLW (decide (phase = 1) && decide (total = pointNumber modifier))
      (decide (phase = 1) && seven) (bandCode modifier 55 43 36)
  else if type = 6 then
    settleKLW (decide (phase = 1) && decide (total = pointNumber modifier))
      (decide (phase = 1) && seven) (bandCode modifier 61 46 37)
  else if type = 7 then
    settleKLW seven (decide (total = pointNumber modifier)) (bandCode modifier 16 21 26)
  else if type = 8 then
    let hit := two || three || decide (total = 4) || decide (total = 9) ||
      decide (total = 10) || eleven || twelve
    settleKLW hit (!hit) (if two || twelve then 61 else 31)
  else if type = 9 then
    let hit :=
      if modifier = 0 then seven
      else if modifier = 1 then two || three || twelve
      else if modifier = 2 then eleven
      else if modifier = 3 then three
      else if modifier = 4 then two
      else if modifier = 5 then twelve
      else if modifier = 6 then two || twelve
      else false
    let code :=
      if modifier = 0 then 121 else if modifier = 1 then 211 else if modifier = 2 then 451
      else if modifier = 3 then 451 else if modifier = 4 then 901 else if modifier = 5 then 901
      else if modifier = 6 then 451 else 0
    settleKLW hit (!hit) code
  else if type = 10 then
    let num := hardNumber modifier
    let matched := decide (total = num)
    let code := if modifier = 0 || modifier = 3 then 211 else 271
    settleKLW (decide (phase = 1) && hard && matched)
      (decide (phase = 1) && ((!hard && matched) || seven)) code
  else if type = 11 then
    let num := if modifier = 0 then 6 else 8
    settleKLW (decide (phase = 1) && decide (total = num)) (decide (phase = 1) && seven) 31
  else 0

def crapsBetCodes (bets : List (Nat × Nat)) (phase point total : Nat) (hard : Bool) : List Nat :=
  bets.map fun bet => crapsBet bet.1 bet.2 phase point total hard

theorem craps_pass_comes_out_natural (point : Nat) :
    crapsBet 0 0 0 point 7 false = 31 := by
  simp only [crapsBet]
  exact pass_comeout_natural 7 point (Or.inl rfl)

theorem craps_dont_twelve_pushes (point : Nat) :
    crapsBet 1 0 0 point 12 false = 1 := by
  simp only [crapsBet]
  exact dontPass_twelve_pushes point

theorem craps_field_two_pays_double (phase point : Nat) :
    crapsBet 8 0 phase point 2 false = 61 := by
  simp [crapsBet, settleKLW]

theorem craps_field_seven_loses (phase point : Nat) :
    crapsBet 8 0 phase point 7 false = 0 := by
  simp [crapsBet, settleKLW]

theorem craps_any_seven_pays (phase point : Nat) :
    crapsBet 9 0 phase point 7 false = 121 := by
  simp [crapsBet, settleKLW]

theorem craps_come_natural (point : Nat) :
    crapsBet 2 0 0 point 7 false = 31 := by
  simp [crapsBet, settleKLW]

theorem craps_hard_four (point : Nat) :
    crapsBet 10 0 1 point 4 true = 211 := by
  simp [crapsBet, settleKLW, hardNumber]

theorem craps_place_miss_keeps (point : Nat) :
    crapsBet 5 0 0 point 4 false = 1 := by
  simp [crapsBet, settleKLW, pointNumber, bandCode]

theorem craps_eval_showdown (bets : List (Nat × Nat)) (phase point d0 d1 c0 c1 : Nat) :
    let total := crapsTotal d0 d1
    let roll := crapsRoll d0 d1 phase point
    let codes := crapsBetCodes bets phase point total (decide (d0 = d1))
    polynomialHash [packRadix 1024 codes, crapsTableTerm roll.1 roll.2] [c0, c1] =
      (packRadix 1024 codes + 1) * c0 + (crapsTableTerm roll.1 roll.2 + 1) * c1 := by
  simp [crapsBetCodes, polynomialHash_two]

end

end ZkCasino.Evaluation
