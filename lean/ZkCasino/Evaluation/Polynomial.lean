module

/-
Integer semantics of `ShowdownPolynomialHash` and the radix packing each
showdown uses before that hash.

`out = Σ (resultᵢ + 1) · coefficientᵢ`. A one-result game passes `[result, 0]`,
so the field is `(result + 1) · c₀ + c₁`. The `+ 1` is the circuit's, so a
zero result still multiplies the coefficient.

Coefficients are 128-bit with bit 127 set, and every packed result used below
is far smaller than `2^124`. The sum is then strictly below `2^253`, which is
below the BN254 scalar, so the integer value and the circuit field element
are the same.
-/

namespace ZkCasino.Evaluation

public section

def polynomialHash : List Nat → List Nat → Nat
  | r :: rs, c :: cs => (r + 1) * c + polynomialHash rs cs
  | _, _ => 0

theorem polynomialHash_nil_left (cs : List Nat) : polynomialHash [] cs = 0 := by
  cases cs <;> rfl

theorem polynomialHash_nil_right (rs : List Nat) : polynomialHash rs [] = 0 := by
  cases rs <;> rfl

theorem polynomialHash_two (r0 r1 c0 c1 : Nat) :
    polynomialHash [r0, r1] [c0, c1] = (r0 + 1) * c0 + (r1 + 1) * c1 := by
  simp [polynomialHash]

/-- Second limb held at 0: the one-result showdowns. -/
theorem polynomialHash_oneResult (r c0 c1 : Nat) :
    polynomialHash [r, 0] [c0, c1] = (r + 1) * c0 + c1 := by
  simp [polynomialHash]

theorem polynomialHash_oneResult_injective {c0 c1 r s : Nat} (hc0 : 0 < c0)
    (h : polynomialHash [r, 0] [c0, c1] = polynomialHash [s, 0] [c0, c1]) :
    r = s := by
  simp [polynomialHash] at h
  have hmul : (r + 1) * c0 = (s + 1) * c0 := by omega
  have hsucc : r + 1 = s + 1 := Nat.eq_of_mul_eq_mul_right hc0 hmul
  omega

def packRadix (base : Nat) : List Nat → Nat
  | [] => 0
  | x :: xs => x + base * packRadix base xs

def unpackRadix : Nat → Nat → Nat → List Nat
  | 0, _, _ => []
  | n + 1, base, v => (v % base) :: unpackRadix n base (v / base)

theorem packRadix_cons (base x : Nat) (xs : List Nat) :
    packRadix base (x :: xs) = x + base * packRadix base xs := by rfl

theorem unpack_pack (base : Nat) (hb : 0 < base) (xs : List Nat)
    (h : ∀ x ∈ xs, x < base) :
    unpackRadix xs.length base (packRadix base xs) = xs := by
  induction xs with
  | nil => simp [unpackRadix, packRadix]
  | cons x xs ih =>
    have hx : x < base := h x (by simp)
    have hxs : ∀ y ∈ xs, y < base := fun y hy => h y (List.mem_cons_of_mem x hy)
    simp only [packRadix, List.length_cons, unpackRadix]
    have hmod : (x + base * packRadix base xs) % base = x := by
      rw [Nat.add_mul_mod_self_left, Nat.mod_eq_of_lt hx]
    have hdiv : (x + base * packRadix base xs) / base = packRadix base xs := by
      rw [Nat.add_mul_div_left _ _ hb, Nat.div_eq_of_lt hx, Nat.zero_add]
    rw [hmod, hdiv, ih hxs]

theorem packRadix_lt_pow (base : Nat) (_hb : 1 < base) (xs : List Nat)
    (h : ∀ x ∈ xs, x < base) :
    packRadix base xs < base ^ xs.length := by
  induction xs with
  | nil => simp [packRadix, Nat.pow_zero]
  | cons x xs ih =>
    have hx : x < base := h x (by simp)
    have hxs : ∀ y ∈ xs, y < base := fun y hy => h y (List.mem_cons_of_mem x hy)
    have ih' : packRadix base xs < base ^ xs.length := ih hxs
    have hstep : packRadix base xs + 1 ≤ base ^ xs.length := Nat.succ_le_of_lt ih'
    have hxlt : x + base * packRadix base xs < base + base * packRadix base xs :=
      Nat.add_lt_add_right hx _
    have hrew : base + base * packRadix base xs = base * (packRadix base xs + 1) := by
      rw [Nat.mul_add, Nat.mul_one, Nat.add_comm]
    have hmul : base * (packRadix base xs + 1) ≤ base * base ^ xs.length :=
      Nat.mul_le_mul_left _ hstep
    have hpow : base * base ^ xs.length = base ^ (xs.length + 1) := by
      rw [Nat.pow_succ, Nat.mul_comm]
    have hlt : x + base * packRadix base xs < base * base ^ xs.length := by
      rw [hrew] at hxlt
      exact Nat.lt_of_lt_of_le hxlt hmul
    rw [hpow] at hlt
    simpa [packRadix, List.length_cons] using hlt

private theorem term_lt (r c k : Nat) (hr : r + 1 ≤ 2 ^ k) (hc : c < 2 ^ 128) :
    (r + 1) * c < 2 ^ (k + 128) := by
  have hle : (r + 1) * c ≤ 2 ^ k * c := Nat.mul_le_mul_right c hr
  have hlt : 2 ^ k * c < 2 ^ k * 2 ^ 128 := Nat.mul_lt_mul_of_pos_left hc (Nat.two_pow_pos k)
  have : (r + 1) * c < 2 ^ k * 2 ^ 128 := Nat.lt_of_le_of_lt hle hlt
  simpa [Nat.pow_add] using this

/-- Two sealed terms stay below `2^253` when each result is at most `2^k - 1` and `k ≤ 124`. -/
theorem polynomialHash_below_scalar (r0 r1 c0 c1 k : Nat)
    (hr0 : r0 + 1 ≤ 2 ^ k) (hr1 : r1 + 1 ≤ 2 ^ k)
    (hc0 : c0 < 2 ^ 128) (hc1 : c1 < 2 ^ 128) (hk : k ≤ 124) :
    polynomialHash [r0, r1] [c0, c1] < 2 ^ 253 := by
  simp only [polynomialHash_two]
  have h0 : (r0 + 1) * c0 < 2 ^ (k + 128) := term_lt r0 c0 k hr0 hc0
  have h1 : (r1 + 1) * c1 < 2 ^ (k + 128) := term_lt r1 c1 k hr1 hc1
  have hsum : (r0 + 1) * c0 + (r1 + 1) * c1 < 2 ^ (k + 129) := by
    have h0s : (r0 + 1) * c0 + 1 ≤ 2 ^ (k + 128) := Nat.succ_le_of_lt h0
    have h1s : (r1 + 1) * c1 + 1 ≤ 2 ^ (k + 128) := Nat.succ_le_of_lt h1
    have hadd : (r0 + 1) * c0 + (r1 + 1) * c1 + 2 ≤ 2 ^ (k + 128) + 2 ^ (k + 128) := by
      have hpair := Nat.add_le_add h0s h1s
      omega
    have htwo : 2 ^ (k + 128) + 2 ^ (k + 128) = 2 ^ (k + 129) := by
      rw [← Nat.two_mul]
      rw [Nat.mul_comm]
      rw [← Nat.pow_succ]
    have hle : (r0 + 1) * c0 + (r1 + 1) * c1 + 2 ≤ 2 ^ (k + 129) := by
      rwa [htwo] at hadd
    exact Nat.lt_of_lt_of_le (Nat.lt_add_of_pos_right (by decide)) hle
  have hexp : k + 129 ≤ 253 := by omega
  exact Nat.lt_of_lt_of_le hsum (Nat.pow_le_pow_right (by decide) hexp)

end

end ZkCasino.Evaluation
