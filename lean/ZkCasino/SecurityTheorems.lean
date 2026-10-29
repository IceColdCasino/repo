module

import DY.Meta
import DY.Meta.Utils
public import ZkCasino.Specification
public import ZkCasino.Proof
import all ZkCasino.Proof
public import ZkCasino.Instance

namespace DY.ZkCasino

open DY.Comparse

/-- Second state contributes the public identity, not the DH partial. -/
theorem designated_closed (part : Bytes) :
    designatedPayload closedTag part = identityPayload := by
  unfold designatedPayload
  rw [ite_eq_right (by
    intro h
    exact literalToBytes_inj_ne (by decide) h)]

/-- First state contributes the partial `sk · c0`. -/
theorem designated_open (part : Bytes) :
    designatedPayload openTag part = part := by
  simp [designatedPayload]

theorem join_meet_left_isCorrupt (l1 l2 : Label) (tr : ExecTrace) :
    (Label.join (Label.meet l1 l2) l1).isCorrupt tr = l1.isCorrupt tr := by
  simp only [Label.joinIsCorrupt, Label.meetIsCorrupt]
  grind

theorem aggregated_label_isCorrupt
    (l1 l2 : Label) (tr : ExecTrace) :
    (Label.meet
      (Label.join (Label.meet l1 l2) l1)
      (Label.join (Label.meet l1 l2) l2)).isCorrupt tr =
    (l1.isCorrupt tr ∧ l2.isCorrupt tr) := by
  simp only [Label.meetIsCorrupt, Label.joinIsCorrupt]
  grind

theorem aggregatedPartials_label
    [HasBytesInvariants] (c0 skA skB : Bytes) (tr : ProofTrace) :
    (aggregatedPartials c0 skA skB).label tr =
      Label.meet
        (Label.join (c0.dhSkLabel tr) (skA.label tr))
        (Label.join (c0.dhSkLabel tr) (skB.label tr)) := by
  simp [aggregatedPartials]

/--
  The pair of partial decryptions is attacker-known only if both ElGamal
  states are compromised. One key is not enough: this is n-of-n.
-/
theorem aggregated_partials_secrecy
    (alice bob : Participant) (pkA pkB c0 skA skB : Bytes) (tA tB tS : Nat) :
    ∀ tr : ExecTrace,
      tr.Reachable reachability →
      tr.EventLoggedAt (CasinoEvent.register alice pkA) tA →
      tr.EventLoggedAt (CasinoEvent.register bob pkB) tB →
      tr.EventLoggedAt (CasinoEvent.shuffle alice bob pkA pkB c0) tS →
      pkA = DiffieHellman.dhPk skA →
      pkB = DiffieHellman.dhPk skB →
      (aggregatedPartials c0 skA skB).AttackerKnows tr →
      PlayerCompromised alice pkA tr ∧ PlayerCompromised bob pkB tr := by
  apply Trace.apply_Reachable_implies_Invariant
  intro tr hInv hA hB hS hpkA hpkB hKnows
  have invA := Trace.EventLoggedAt_imp_EventInv _ tA tr hInv hA
  have invB := Trace.EventLoggedAt_imp_EventInv _ tB tr hInv hB
  have invS := Trace.EventLoggedAt_imp_EventInv _ tS tr hInv hS
  simp only [ProtocolEvent.EventInv.invariant] at invA invB invS
  have hPub := Bytes.AttackerKnows_implies_Publishable (aggregatedPartials c0 skA skB) tr hInv hKnows
  simp only [Bytes.Publishable] at hPub
  have hAinv : pkA.Invariant (tr.prefix tA) := invA.1
  have hBinv : pkB.Invariant (tr.prefix tB) := invB.1
  have hSinv : c0.Invariant (tr.prefix tS) := by
    have := invS.2.2.1
    simp [Bytes.Publishable] at this
    exact this.1
  have hAleq : tr.prefix tA ≤ tr := by grind
  have hBleq : tr.prefix tB ≤ tr := by grind
  have hSleq : tr.prefix tS ≤ tr := by grind
  have hAsk : pkA.dhSkLabel tr = playerLabel alice pkA := by
    have hpre := invA.2
    have hlater := Bytes.dhSkLabel_later_fast pkA (tr.prefix tA) tr hAinv hAleq
    exact hlater.symm.trans hpre ▸ rfl
  have hBsk : pkB.dhSkLabel tr = playerLabel bob pkB := by
    have hpre := invB.2
    have hlater := Bytes.dhSkLabel_later_fast pkB (tr.prefix tB) tr hBinv hBleq
    exact hlater.symm.trans hpre ▸ rfl
  have hC0 : c0.dhSkLabel tr = Label.meet (playerLabel alice pkA) (playerLabel bob pkB) := by
    have hpre := invS.2.2.2.2
    have hc0inv : c0.Invariant (tr.prefix tS) := hSinv
    have hlater := Bytes.dhSkLabel_later_fast c0 (tr.prefix tS) tr hc0inv hSleq
    exact hlater.symm.trans hpre ▸ rfl
  rw [hpkA] at hAsk
  rw [Bytes.dhSkLabel_dhPk skA tr] at hAsk
  rw [← hpkA] at hAsk
  rw [hpkB] at hBsk
  rw [Bytes.dhSkLabel_dhPk skB tr] at hBsk
  rw [← hpkB] at hBsk
  have hLab := aggregatedPartials_label c0 skA skB tr
  rw [hLab, hC0, hAsk, hBsk] at hPub
  have hCorr := hPub.2
  rw [← canFlowPubEqIsCorrupt] at hCorr
  rw [aggregated_label_isCorrupt] at hCorr
  simpa [playerLabel, PlayerCompromised] using hCorr

/-- A single partial `sk · c0` is attacker-known only if that player's key state is compromised. -/
theorem partial_secrecy
    (alice bob : Participant) (pkA pkB c0 skA : Bytes) (tA tB tS : Nat) :
    ∀ tr : ExecTrace,
      tr.Reachable reachability →
      tr.EventLoggedAt (CasinoEvent.register alice pkA) tA →
      tr.EventLoggedAt (CasinoEvent.register bob pkB) tB →
      tr.EventLoggedAt (CasinoEvent.shuffle alice bob pkA pkB c0) tS →
      pkA = DiffieHellman.dhPk skA →
      (DiffieHellman.dh c0 skA).AttackerKnows tr →
      PlayerCompromised alice pkA tr := by
  apply Trace.apply_Reachable_implies_Invariant
  intro tr hInv hA _hB hS hpkA hKnows
  have invA := Trace.EventLoggedAt_imp_EventInv _ tA tr hInv hA
  have invS := Trace.EventLoggedAt_imp_EventInv _ tS tr hInv hS
  simp only [ProtocolEvent.EventInv.invariant] at invA invS
  have hPub := Bytes.AttackerKnows_implies_Publishable (DiffieHellman.dh c0 skA) tr hInv hKnows
  simp only [Bytes.Publishable, DiffieHellman.dh.label] at hPub
  have hAinv : pkA.Invariant (tr.prefix tA) := invA.1
  have hAleq : tr.prefix tA ≤ tr := by grind
  have hSleq : tr.prefix tS ≤ tr := by grind
  have hc0inv : c0.Invariant (tr.prefix tS) := by
    have := invS.2.2.1
    simp [Bytes.Publishable] at this
    exact this.1
  have hAsk : pkA.dhSkLabel tr = playerLabel alice pkA := by
    have hlater := Bytes.dhSkLabel_later_fast pkA (tr.prefix tA) tr hAinv hAleq
    exact hlater.symm.trans invA.2 ▸ rfl
  have hC0 : c0.dhSkLabel tr = Label.meet (playerLabel alice pkA) (playerLabel bob pkB) := by
    have hlater := Bytes.dhSkLabel_later_fast c0 (tr.prefix tS) tr hc0inv hSleq
    exact hlater.symm.trans invS.2.2.2.2 ▸ rfl
  rw [hpkA] at hAsk
  rw [Bytes.dhSkLabel_dhPk skA tr] at hAsk
  rw [← hpkA] at hAsk
  rw [hC0, hAsk] at hPub
  have hCorr := hPub.2
  rw [← canFlowPubEqIsCorrupt] at hCorr
  rw [join_meet_left_isCorrupt] at hCorr
  simpa [playerLabel, PlayerCompromised] using hCorr

/-- Accepting a shuffle means the shuffler logged it, or their signing key was compromised. -/
theorem shuffle_auth
    (acceptor shuffler : Participant) (pk peerPk c0 : Bytes) (t : Nat) :
    ∀ tr : ExecTrace,
      tr.Reachable reachability →
      tr.EventLoggedAt (CasinoEvent.accept acceptor shuffler pk peerPk c0) t →
      (∃ who, (tr.prefix t).EventLogged (CasinoEvent.shuffle shuffler who pk peerPk c0)) ∨
        (∃ vk, LongTermKeys.LongTermKeyCompromised "ZkCasino PKI" shuffler vk (tr.prefix t)) := by
  apply Trace.apply_Reachable_implies_Invariant
  intro tr hInv hEv
  have inv := Trace.EventLoggedAt_imp_EventInv _ t tr hInv hEv
  simp only [ProtocolEvent.EventInv.invariant, LongTermKeys.label, Trace.prefix_erase] at inv
  exact inv.2.2.2

/-- A showdown's peer designation was signed by that peer, or their signing key was compromised. -/
theorem showdown_auth
    (player peer : Participant) (c0 designation peerDesignation : Bytes) (t : Nat) :
    ∀ tr : ExecTrace,
      tr.Reachable reachability →
      tr.EventLoggedAt (CasinoEvent.showdown player peer c0 designation peerDesignation) t →
      ((tr.prefix t).EventLogged (CasinoEvent.share player c0 designation) ∧
        (tr.prefix t).EventLogged (CasinoEvent.share peer c0 peerDesignation)) ∨
        (∃ vk, LongTermKeys.LongTermKeyCompromised "ZkCasino PKI" peer vk (tr.prefix t)) := by
  apply Trace.apply_Reachable_implies_Invariant
  intro tr hInv hEv
  have inv := Trace.EventLoggedAt_imp_EventInv _ t tr hInv hEv
  simp only [ProtocolEvent.EventInv.invariant, LongTermKeys.label, Trace.prefix_erase] at inv
  rcases inv with ⟨-, hOwn, hPeer | hCor⟩
  · exact Or.inl ⟨hOwn, hPeer⟩
  · exact Or.inr hCor

end DY.ZkCasino
