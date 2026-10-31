module

public import ZkCasino.Evaluation.Polynomial

/-
What the showdown publishes, and why that does not recover the hand.

`seal_showdown_pair` draws two coefficients inside MPC. Each coefficient is
`2^127` plus 127 free bits, so bit 127 is set and the value sits in
`[2^127, 2^128)`, the range `Num2BitsStrict(128)` checks. The instruction
encrypts those two values and reveals only four subset-sum rows. Each weight
is below `2^242`, so a revealed row is below `2^253` and is the same integer
in BN254 and in the MPC field.

`verify_deck_hash_chunk` opens one 4-limb batch and re-seals it. The callback
is `(0, 0, startIndex)`. The limbs are not in that tuple.

The public showdown field is `(result + 1) · c₀ + c₁` when the second result
is 0. Distinct results, and distinct coefficient pairs, can produce the same
field, so neither the result nor the coefficients is a function of that field.
Knowing the coefficients does determine a one-result value
(`polynomialHash_oneResult_injective`); the seal does not hand those
coefficients out.
-/

namespace ZkCasino.Evaluation

public section

def bitOf (n j : Nat) : Nat := (n / 2 ^ j) % 2

/-- Little-endian bits. The head is bit 0. -/
def packFree : List Bool → Nat
  | [] => 0
  | b :: bs => (if b then 1 else 0) + 2 * packFree bs

/-- `draw_coefficient`: bit 127 is forced on, and the lower bits are the MPC coins. -/
def drawnCoeff (free : List Bool) : Nat := packFree free + 2 ^ 127

def drawnBits (free : List Bool) : List Nat :=
  free.map (fun b => if b then 1 else 0) ++ [1]

theorem packFree_replicate_false : ∀ n : Nat, packFree (List.replicate n false) = 0
  | 0 => rfl
  | n + 1 => by simp [List.replicate_succ, packFree, packFree_replicate_false n]

theorem packFree_pow : ∀ n : Nat, packFree (List.replicate n false ++ [true]) = 2 ^ n
  | 0 => by simp [List.replicate, packFree]
  | n + 1 => by
    simp [List.replicate_succ, packFree, packFree_pow n, Nat.pow_succ, Nat.mul_comm]

theorem packFree_false (bs : List Bool) : packFree (false :: bs) = 2 * packFree bs := by
  simp [packFree]

theorem packFree_true (bs : List Bool) : packFree (true :: bs) = 1 + 2 * packFree bs := by
  simp [packFree]

theorem packFree_lt (free : List Bool) : packFree free < 2 ^ free.length := by
  induction free with
  | nil => simp [packFree, Nat.pow_zero]
  | cons b bs ih =>
    cases b <;> simp [packFree, List.length_cons, Nat.pow_succ] <;> omega

theorem length_freeHi : (List.replicate 126 false ++ [true]).length = 127 := by
  simp

theorem length_freeLo : (List.replicate 127 false).length = 127 := by
  simp

theorem length_bit0 : (true :: List.replicate 126 false).length = 127 := by
  simp

theorem length_bit1 : (false :: true :: List.replicate 125 false).length = 127 := by
  simp

theorem drawn_range (free : List Bool) (h : free.length ≤ 127) :
    2 ^ 127 ≤ drawnCoeff free ∧ drawnCoeff free < 2 ^ 128 := by
  have hlow : packFree free < 2 ^ 127 :=
    Nat.lt_of_lt_of_le (packFree_lt free) (Nat.pow_le_pow_right (by decide) h)
  refine ⟨?_, ?_⟩
  · exact Nat.le_add_left _ _
  · have hsum : packFree free + 2 ^ 127 < 2 ^ 127 + 2 ^ 127 := Nat.add_lt_add_right hlow _
    have htwo : 2 ^ 127 + 2 ^ 127 = 2 ^ 128 := by
      rw [← Nat.two_mul, Nat.mul_comm, ← Nat.pow_succ]
    simpa [drawnCoeff, htwo] using hsum

theorem drawn_min : drawnCoeff (List.replicate 127 false) = 2 ^ 127 := by
  unfold drawnCoeff
  rw [packFree_replicate_false]

theorem drawn_bit126 : drawnCoeff (List.replicate 126 false ++ [true]) = 2 ^ 127 + 2 ^ 126 := by
  unfold drawnCoeff
  rw [packFree_pow]

theorem drawn_bit0 : drawnCoeff (true :: List.replicate 126 false) = 2 ^ 127 + 1 := by
  unfold drawnCoeff
  rw [packFree_true, packFree_replicate_false]

theorem drawn_bit1 : drawnCoeff (false :: true :: List.replicate 125 false) = 2 ^ 127 + 2 := by
  unfold drawnCoeff
  rw [packFree_false, packFree_true, packFree_replicate_false]

/-- Bit 127 of every sealed coefficient is the forced one. -/
theorem drawn_top_bit (free : List Bool) (h : free.length ≤ 127) :
    bitOf (drawnCoeff free) 127 = 1 := by
  have hlow : packFree free < 2 ^ 127 :=
    Nat.lt_of_lt_of_le (packFree_lt free) (Nat.pow_le_pow_right (by decide) h)
  have hdiv : (packFree free + 2 ^ 127 * 1) / 2 ^ 127 = packFree free / 2 ^ 127 + 1 :=
    Nat.add_mul_div_left _ _ (Nat.two_pow_pos 127)
  rw [Nat.mul_one, Nat.div_eq_of_lt hlow, Nat.zero_add] at hdiv
  simp [bitOf, drawnCoeff, hdiv]

/-! ## Four subset-sum rows -/

def subsetSum : List Nat → List Nat → Nat
  | [], _ => 0
  | _, [] => 0
  | w :: ws, b :: bs => w * b + subsetSum ws bs

def slotRows (weights : List (List Nat)) (bits : List Nat) : List Nat :=
  weights.map (subsetSum · bits)

def addRows : List Nat → List Nat → List Nat
  | [], ys => ys
  | xs, [] => xs
  | x :: xs, y :: ys => (x + y) :: addRows xs ys

/-- Both slots. The third component is what `seal_showdown_pair` reveals. -/
def sealPair (free0 free1 : List Bool) (weights0 weights1 : List (List Nat)) :
    Nat × Nat × List Nat :=
  (drawnCoeff free0, drawnCoeff free1,
    addRows (slotRows weights0 (drawnBits free0)) (slotRows weights1 (drawnBits free1)))

theorem subsetSum_bound :
    ∀ (weights bits : List Nat),
      (∀ w ∈ weights, w < 2 ^ 242) → (∀ b ∈ bits, b ≤ 1) →
        subsetSum weights bits ≤ weights.length * (2 ^ 242 - 1)
  | [], _, _, _ => by simp [subsetSum]
  | _ :: _, [], hw, _ => by simp [subsetSum]
  | w :: ws, b :: bs, hw, hb => by
    have hw0 : w ≤ 2 ^ 242 - 1 := Nat.le_sub_one_of_lt (hw w (List.Mem.head _))
    have hb0 : b ≤ 1 := hb b (List.Mem.head _)
    have htail := subsetSum_bound ws bs
      (fun x hx => hw x (List.Mem.tail _ hx))
      (fun y hy => hb y (List.Mem.tail _ hy))
    have hb01 : b = 0 ∨ b = 1 := by omega
    simp only [subsetSum, List.length_cons]
    rcases hb01 with rfl | rfl
    · simpa using Nat.le_trans htail (by
        have : ws.length * (2 ^ 242 - 1) ≤ (ws.length + 1) * (2 ^ 242 - 1) := by
          exact Nat.mul_le_mul_right _ (Nat.le_succ _)
        exact this)
    · have hsum : w + subsetSum ws bs ≤ (2 ^ 242 - 1) + ws.length * (2 ^ 242 - 1) :=
        Nat.add_le_add hw0 htail
      have hmul : (2 ^ 242 - 1) + ws.length * (2 ^ 242 - 1) =
          (ws.length + 1) * (2 ^ 242 - 1) := by
        rw [Nat.succ_mul, Nat.add_comm]
      rw [hmul] at hsum
      simpa using hsum

theorem subsetSum_lt (weights bits : List Nat)
    (hw : ∀ w ∈ weights, w < 2 ^ 242) (hb : ∀ b ∈ bits, b ≤ 1)
    (hlen : weights.length ≤ 128) :
    subsetSum weights bits < 2 ^ 249 := by
  have hle := subsetSum_bound weights bits hw hb
  have hmul : weights.length * (2 ^ 242 - 1) ≤ 128 * (2 ^ 242 - 1) :=
    Nat.mul_le_mul_right _ hlen
  have h128 : 128 * (2 ^ 242 - 1) < 2 ^ 249 := by
    have hpow : 128 * 2 ^ 242 = 2 ^ 249 := by
      have : 128 = 2 ^ 7 := by decide
      rw [this, ← Nat.pow_add]
    have hsub : 128 * (2 ^ 242 - 1) = 128 * 2 ^ 242 - 128 := by
      have hone : 128 * 1 = 128 := Nat.mul_one _
      rw [← hone, ← Nat.mul_sub_left_distrib]
    omega
  omega

theorem drawnBits_bit (free : List Bool) : ∀ b ∈ drawnBits free, b ≤ 1 := by
  intro b hb
  simp only [drawnBits, List.mem_append, List.mem_map] at hb
  rcases hb with ⟨_, _, rfl⟩ | hb
  · split <;> decide
  · simp at hb
    simp [hb]

theorem slot_row_lt (weights : List Nat) (free : List Bool)
    (hw : ∀ w ∈ weights, w < 2 ^ 242) (hlen : weights.length ≤ 128) :
    subsetSum weights (drawnBits free) < 2 ^ 249 :=
  subsetSum_lt weights (drawnBits free) hw (drawnBits_bit free) hlen

theorem revealed_row_lt (row0 row1 : List Nat) (free0 free1 : List Bool)
    (h0 : ∀ w ∈ row0, w < 2 ^ 242) (h1 : ∀ w ∈ row1, w < 2 ^ 242)
    (l0 : row0.length ≤ 128) (l1 : row1.length ≤ 128) :
    subsetSum row0 (drawnBits free0) + subsetSum row1 (drawnBits free1) < 2 ^ 253 := by
  have a := slot_row_lt row0 free0 h0 l0
  have b := slot_row_lt row1 free1 h1 l1
  have hsum : subsetSum row0 (drawnBits free0) + subsetSum row1 (drawnBits free1) <
      2 ^ 249 + 2 ^ 249 := Nat.add_lt_add a b
  have htwo : 2 ^ 249 + 2 ^ 249 = 2 ^ 250 := by
    rw [← Nat.two_mul, Nat.mul_comm, ← Nat.pow_succ]
  have hfield : 2 ^ 250 < 2 ^ 253 := Nat.pow_lt_pow_right (by decide) (by decide)
  omega

/-! ## 4-limb deck-hash verification -/

/-- `verify_deck_hash_chunk`: re-seal the four limbs, reveal two zeros and the batch index. -/
def verifyDeckHashChunk (limbs : List Nat) (startIndex : Nat) : List Nat × Nat × Nat × Nat :=
  (limbs.take 4, 0, 0, startIndex)

theorem verify_reseals (limbs : List Nat) (startIndex : Nat) (h : limbs.length = 4) :
    (verifyDeckHashChunk limbs startIndex).1 = limbs := by
  simp [verifyDeckHashChunk]
  rw [← h]
  exact List.take_length

theorem verify_reveals_index (limbs : List Nat) (startIndex : Nat) :
    (verifyDeckHashChunk limbs startIndex).2 = (0, 0, startIndex) := by
  rfl

/-- Two different plaintexts at the same index produce the same callback. -/
theorem verify_hides_limbs (limbs limbs' : List Nat) (startIndex : Nat) :
    (verifyDeckHashChunk limbs startIndex).2 = (verifyDeckHashChunk limbs' startIndex).2 := by
  rfl

/-! ## The public field does not determine the hand or the coefficients -/

theorem mpc_hash_collision :
    polynomialHash [0, 0]
        [drawnCoeff (List.replicate 126 false ++ [true]),
          drawnCoeff (List.replicate 126 false ++ [true])] =
      polynomialHash [1, 0]
        [drawnCoeff (List.replicate 127 false), drawnCoeff (List.replicate 127 false)] := by
  rw [drawn_bit126, drawn_min]
  simp [polynomialHash_oneResult]

theorem mpc_coeff_collision :
    polynomialHash [0, 0]
        [drawnCoeff (List.replicate 127 false),
          drawnCoeff (false :: true :: List.replicate 125 false)] =
      polynomialHash [0, 0]
        [drawnCoeff (true :: List.replicate 126 false),
          drawnCoeff (true :: List.replicate 126 false)] := by
  rw [drawn_min, drawn_bit1, drawn_bit0]
  simp [polynomialHash_oneResult]

theorem showdown_hides_result :
    ∃ r s c0 c1 d0 d1,
      r ≠ s ∧
      2 ^ 127 ≤ c0 ∧ c0 < 2 ^ 128 ∧ 2 ^ 127 ≤ c1 ∧ c1 < 2 ^ 128 ∧
      2 ^ 127 ≤ d0 ∧ d0 < 2 ^ 128 ∧ 2 ^ 127 ≤ d1 ∧ d1 < 2 ^ 128 ∧
      polynomialHash [r, 0] [c0, c1] = polynomialHash [s, 0] [d0, d1] := by
  let freeHi := List.replicate 126 false ++ [true]
  let freeLo := List.replicate 127 false
  have hhi := drawn_range freeHi (by rw [length_freeHi]; decide)
  have hlo := drawn_range freeLo (by rw [length_freeLo]; decide)
  exact ⟨0, 1, drawnCoeff freeHi, drawnCoeff freeHi, drawnCoeff freeLo, drawnCoeff freeLo,
    by decide, hhi.1, hhi.2, hhi.1, hhi.2, hlo.1, hlo.2, hlo.1, hlo.2, mpc_hash_collision⟩

theorem showdown_hides_coefficients :
    ∃ c0 c1 d0 d1,
      (c0, c1) ≠ (d0, d1) ∧
      2 ^ 127 ≤ c0 ∧ c0 < 2 ^ 128 ∧ 2 ^ 127 ≤ c1 ∧ c1 < 2 ^ 128 ∧
      2 ^ 127 ≤ d0 ∧ d0 < 2 ^ 128 ∧ 2 ^ 127 ≤ d1 ∧ d1 < 2 ^ 128 ∧
      polynomialHash [0, 0] [c0, c1] = polynomialHash [0, 0] [d0, d1] := by
  let a := List.replicate 127 false
  let b := false :: true :: List.replicate 125 false
  let c := true :: List.replicate 126 false
  have ha := drawn_range a (by rw [length_freeLo]; decide)
  have hb := drawn_range b (by rw [length_bit1]; decide)
  have hc := drawn_range c (by rw [length_bit0]; decide)
  have hne : (drawnCoeff a, drawnCoeff b) ≠ (drawnCoeff c, drawnCoeff c) := by
    intro h
    have := congrArg Prod.fst h
    rw [drawn_min, drawn_bit0] at this
    omega
  exact ⟨drawnCoeff a, drawnCoeff b, drawnCoeff c, drawnCoeff c,
    hne, ha.1, ha.2, hb.1, hb.2, hc.1, hc.2, hc.1, hc.2, mpc_coeff_collision⟩

/-- No function of the public field returns the result for every legal coefficient pair. -/
theorem no_result_decoder :
    ¬ ∃ decode : Nat → Nat,
      ∀ r c0 c1,
        2 ^ 127 ≤ c0 → c0 < 2 ^ 128 →
        2 ^ 127 ≤ c1 → c1 < 2 ^ 128 →
        r ≤ 1 →
        decode (polynomialHash [r, 0] [c0, c1]) = r := by
  intro ⟨decode, hdec⟩
  let freeHi := List.replicate 126 false ++ [true]
  let freeLo := List.replicate 127 false
  have hhi := drawn_range freeHi (by rw [length_freeHi]; decide)
  have hlo := drawn_range freeLo (by rw [length_freeLo]; decide)
  have h0 := hdec 0 (drawnCoeff freeHi) (drawnCoeff freeHi) hhi.1 hhi.2 hhi.1 hhi.2 (by decide)
  have h1 := hdec 1 (drawnCoeff freeLo) (drawnCoeff freeLo) hlo.1 hlo.2 hlo.1 hlo.2 (by decide)
  rw [mpc_hash_collision] at h0
  dsimp [freeLo] at h1
  exact absurd (h0.symm.trans h1) (by decide)

/-- No function of the public field returns the coefficient pair, even at a fixed result. -/
theorem no_coefficient_decoder :
    ¬ ∃ decode : Nat → Nat × Nat,
      ∀ c0 c1,
        2 ^ 127 ≤ c0 → c0 < 2 ^ 128 →
        2 ^ 127 ≤ c1 → c1 < 2 ^ 128 →
        decode (polynomialHash [0, 0] [c0, c1]) = (c0, c1) := by
  intro ⟨decode, hdec⟩
  let a := List.replicate 127 false
  let b := false :: true :: List.replicate 125 false
  let c := true :: List.replicate 126 false
  have ha := drawn_range a (by rw [length_freeLo]; decide)
  have hb := drawn_range b (by rw [length_bit1]; decide)
  have hc := drawn_range c (by rw [length_bit0]; decide)
  have h0 := hdec (drawnCoeff a) (drawnCoeff b) ha.1 ha.2 hb.1 hb.2
  have h1 := hdec (drawnCoeff c) (drawnCoeff c) hc.1 hc.2 hc.1 hc.2
  rw [mpc_coeff_collision] at h0
  dsimp [a, b, c] at h0 h1
  have heq : (drawnCoeff (List.replicate 127 false),
      drawnCoeff (false :: true :: List.replicate 125 false)) =
      (drawnCoeff (true :: List.replicate 126 false),
        drawnCoeff (true :: List.replicate 126 false)) :=
    h0.symm.trans h1
  have hne : drawnCoeff (List.replicate 127 false) ≠
      drawnCoeff (true :: List.replicate 126 false) := by
    rw [drawn_min, drawn_bit0]
    decide
  exact hne (congrArg Prod.fst heq)

end

end ZkCasino.Evaluation
