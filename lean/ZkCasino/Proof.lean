module

import DY.Meta.Step
import DY.Meta.Utils
public import ZkCasino.Specification
import all ZkCasino.Specification

namespace DY.ZkCasino

open DY.Comparse

public section ProofTraceConfig

class HasProofTrace extends HasExecTrace where
  [traceProof: ProofTraceTypes]
  [traceProof0: ProofTraceTypes.Has Network.ProofEntryT]
  [traceProof1: ProofTraceTypes.Has Random.ProofEntryT]
  [traceProof2: ProofTraceTypes.Has (ProtocolEvent.ProofEntryT CasinoEvent)]
  [traceProof3: ProofTraceTypes.Has (PersistentLocalState.CompromisableState.ProofEntryT RegisterState)]
  [traceProof4: ProofTraceTypes.Has (PersistentLocalState.CompromisableState.ProofEntryT ShuffleState)]
  [traceProof5: ProofTraceTypes.Has (PersistentLocalState.CompromisableState.ProofEntryT ShareState)]
  [traceProof6: ProofTraceTypes.Has (LongTermKeys.ProofEntryT "ZkCasino PKI")]

attribute [reducible, scoped instance] HasProofTrace.traceProof
attribute [reducible, scoped instance] HasProofTrace.traceProof0
attribute [reducible, scoped instance] HasProofTrace.traceProof1
attribute [reducible, scoped instance] HasProofTrace.traceProof2
attribute [reducible, scoped instance] HasProofTrace.traceProof3
attribute [reducible, scoped instance] HasProofTrace.traceProof4
attribute [reducible, scoped instance] HasProofTrace.traceProof5
attribute [reducible, scoped instance] HasProofTrace.traceProof6

end ProofTraceConfig

public section BytesInvariants

variable [HasProofTrace]

structure LongTermKeyUsage where
  principal : Participant

instance : ParseableSerializeable LongTermKeyUsage := .make <|
  .triviallyIsomorphic
    (.string)
    (fun principal => { principal })
    (fun { principal := principal } => principal)

@[grind]
def mkLongTermUsage (me : Participant) : Usage := {
  type := "SigKey"
  tag := "ZkCasino PKI"
  data := serialize ({ principal := me } : LongTermKeyUsage)
}

@[grind inj]
theorem mkLongTermUsage_inj : Function.Injective mkLongTermUsage := by
  simp [Function.Injective, mkLongTermUsage]
  grind

/-- What an honest casino signing key is allowed to sign. -/
def casinoSignPred [BytesWellFormed] [GetUsage] [GetLabel]
    (skUsg : Usage) (_vk msg : Bytes) (tr : ProofTrace) : Prop :=
  ∃ player, skUsg = mkLongTermUsage player ∧
    match parse msg with
    | none => False
    | some (body : SigBody) =>
      (body.phase = registerTag ∧
        body.b = emptyBytes ∧
        body.c = emptyBytes ∧
        ∃ sk,
          body.a = DiffieHellman.dhPk sk ∧
          sk.label tr = playerLabel player body.a ∧
          tr.erase.EventLogged (CasinoEvent.register player body.a)) ∨
      (body.phase = shuffleTag ∧
        ∃ peer r,
          body.c = DiffieHellman.dhPk r ∧
          r.label tr = Label.meet (playerLabel player body.a) (playerLabel peer body.b) ∧
          tr.erase.EventLogged (CasinoEvent.shuffle player peer body.a body.b body.c)) ∨
      (body.phase = shareTag ∧
        body.c = emptyBytes ∧
        tr.erase.EventLogged (CasinoEvent.share player body.a body.b))

instance : Signature.SignPred where
  pred := casinoSignPred

instance
  [BytesInvariants]
  [BytesInvariants.Has DiffieHellman.DhPk.invariants]
  [BytesInvariants.Has Literal.invariants]
  [BytesInvariants.Has Concat.invariants]
  : Signature.SignPredProof
where
  pred_later := by
    intro _ _ _ skUsg vk msg tr1 tr2 hvk hmsg hle h
    simp only [Signature.SignPred.pred, casinoSignPred] at h ⊢
    obtain ⟨player, husg, hmatch⟩ := h
    refine ⟨player, husg, ?_⟩
    cases hparse : parse (a := SigBody) msg
    · simp [hparse] at hmatch
    · rename_i body
      simp only [hparse] at hmatch ⊢
      have hrel : FormatRel msg body := by
        simpa [hparse] using parse_FormatRel (a := SigBody) msg
      have hfields := IsWellFormed_FormatRel_WellFormed msg body tr1 hrel
      rw [hfields, SigBody.IsWellFormed_eq] at hmsg
      have hele : tr1.erase ≤ tr2.erase := Trace.erase_le _ _ hle
      rcases hmatch with hreg | hshu | hshr
      · rcases hreg with ⟨hp, hb, hc, sk, ha, hlab, hev⟩
        have hsk : sk.WellFormed tr1 := by
          have hwa := hmsg.2.1
          rw [ha, DiffieHellman.dhPk.WellFormed] at hwa
          exact hwa
        refine Or.inl ⟨hp, hb, hc, sk, ha, ?_, Trace.EventLogged_le _ _ _ hele hev⟩
        rw [← Bytes.label_later sk tr1 tr2 hle hsk]
        exact hlab
      · rcases hshu with ⟨hp, peer, rand, hc, hlab, hev⟩
        have hr : rand.WellFormed tr1 := by
          have hwc := hmsg.2.2.2
          rw [hc, DiffieHellman.dhPk.WellFormed] at hwc
          exact hwc
        refine Or.inr (Or.inl ⟨hp, peer, rand, hc, ?_, Trace.EventLogged_le _ _ _ hele hev⟩)
        rw [← Bytes.label_later rand tr1 tr2 hle hr]
        exact hlab
      · rcases hshr with ⟨hp, hc, hev⟩
        exact Or.inr (Or.inr ⟨hp, hc, Trace.EventLogged_le _ _ _ hele hev⟩)

end BytesInvariants

public section BytesInvariantsConfig

class HasBytesInvariants extends HasProofTrace where
  [bytesInv: BytesInvariants]
  [bytesInvProof: BytesInvariantsProofs]
  [bytesInv0: BytesInvariants.Has Random.invariants]
  [bytesInv1: BytesInvariants.Has Literal.invariants]
  [bytesInv2: BytesInvariants.Has Concat.invariants]
  [bytesInv3: BytesInvariants.Has Hash.invariants]
  [bytesInv4: BytesInvariants.Has Signature.invariants]
  [bytesInv5: BytesInvariants.Has DiffieHellman.invariants]

attribute [reducible, scoped instance] HasBytesInvariants.bytesInv
attribute [           scoped instance] HasBytesInvariants.bytesInvProof
attribute [           scoped instance] HasBytesInvariants.bytesInv0
attribute [           scoped instance] HasBytesInvariants.bytesInv1
attribute [           scoped instance] HasBytesInvariants.bytesInv2
attribute [           scoped instance] HasBytesInvariants.bytesInv3
attribute [           scoped instance] HasBytesInvariants.bytesInv4
attribute [           scoped instance] HasBytesInvariants.bytesInv5

end BytesInvariantsConfig

public section TraceInvariant

variable [HasBytesInvariants]

instance : PersistentLocalState.CompromisableLocalStateInv RegisterState where
  invariant me st tr :=
    let { pk, sk } := st
    pk = DiffieHellman.dhPk sk ∧
    pk.Publishable tr ∧
    sk.Invariant tr ∧
    sk.label tr = playerLabel me pk
  invariant_later := by grind
  invariant_implies_KnowableBy participant state tr := by
    have : (playerLabel participant state.pk).canFlow (PersistentLocalState.label participant state) tr.erase := by
      cases state
      simp [Label.canFlow, playerLabel, PlayerCompromised]
      grind
    grind [canFlowTrans]

theorem RegisterStateInv_imp
    (participant : Participant) (st : RegisterState) :
    PersistentLocalState.LocalStateInv.invariant participant st tr →
      st.pk = DiffieHellman.dhPk st.sk ∧
      st.pk.Publishable tr ∧
      st.sk.Invariant tr ∧
      st.sk.label tr = playerLabel participant st.pk := by
  simp [PersistentLocalState.LocalStateInv.invariant]

grind_pattern RegisterStateInv_imp =>
  PersistentLocalState.LocalStateInv.invariant participant st tr
grind_pattern [grind_later] RegisterStateInv_imp =>
  PersistentLocalState.LocalStateInv.invariant participant st tr

instance : PersistentLocalState.CompromisableLocalStateInv ShuffleState where
  invariant _ st tr :=
    let { pk, peerPk, c0 } := st
    pk.Publishable tr ∧ peerPk.Publishable tr ∧ c0.Publishable tr
  invariant_later := by grind
  invariant_implies_KnowableBy participant state tr := by
    cases state
    simp [Bytes.Publishable]
    grind [canFlowTrans]

instance : PersistentLocalState.CompromisableLocalStateInv ShareState where
  invariant me st tr :=
    let { c0, designation } := st
    c0.Publishable tr ∧
    designation.Publishable tr ∧
    tr.erase.EventLogged (CasinoEvent.share me c0 designation)
  invariant_later := by grind
  invariant_implies_KnowableBy participant state tr := by
    cases state
    simp [Bytes.Publishable]
    grind [canFlowTrans]

theorem ShuffleStateInv_imp
    (participant : Participant) (st : ShuffleState) :
    PersistentLocalState.LocalStateInv.invariant participant st tr →
      st.pk.Publishable tr ∧ st.peerPk.Publishable tr ∧ st.c0.Publishable tr := by
  simp [PersistentLocalState.LocalStateInv.invariant]

grind_pattern ShuffleStateInv_imp =>
  PersistentLocalState.LocalStateInv.invariant participant st tr
grind_pattern [grind_later] ShuffleStateInv_imp =>
  PersistentLocalState.LocalStateInv.invariant participant st tr

theorem ShareStateInv_imp
    (participant : Participant) (st : ShareState) :
    PersistentLocalState.LocalStateInv.invariant participant st tr →
      st.c0.Publishable tr ∧
      st.designation.Publishable tr ∧
      tr.erase.EventLogged (CasinoEvent.share participant st.c0 st.designation) := by
  simp [PersistentLocalState.LocalStateInv.invariant]

grind_pattern ShareStateInv_imp =>
  PersistentLocalState.LocalStateInv.invariant participant st tr
grind_pattern [grind_later] ShareStateInv_imp =>
  PersistentLocalState.LocalStateInv.invariant participant st tr

@[grind]
instance : LongTermKeys.ProofConfig "ZkCasino PKI" mkLongTermUsage (LongTermKeys.label "ZkCasino PKI") where
  IsLongTermPublicKey who vk tr :=
    vk.Publishable tr ∧
    vk.signkeyLabel tr = LongTermKeys.label "ZkCasino PKI" who vk ∧
    vk.SignkeyHasUsage (mkLongTermUsage who) tr
  IsLongTermPublicKey_implied := by
    simp_all [Bytes.Publishable]
    grind

instance : ProtocolEvent.EventInv CasinoEvent where
  invariant tr ev :=
    match ev with
    | .register _player pk =>
      pk.Invariant tr ∧
      pk.dhSkLabel tr = playerLabel _player pk
    | .shuffle shuffler peer pk peerPk c0 =>
      pk.Publishable tr ∧
      peerPk.Publishable tr ∧
      c0.Publishable tr ∧
      pk.dhSkLabel tr = playerLabel shuffler pk ∧
      c0.dhSkLabel tr = Label.meet (playerLabel shuffler pk) (playerLabel peer peerPk)
    | .accept _acceptor shuffler pk peerPk c0 =>
      pk.Publishable tr ∧
      peerPk.Publishable tr ∧
      c0.Publishable tr ∧
      ((∃ who, tr.erase.EventLogged (CasinoEvent.shuffle shuffler who pk peerPk c0)) ∨
        ∃ vk, (LongTermKeys.label "ZkCasino PKI" shuffler vk).isCorrupt tr.erase)
    | .share _player c0 designation =>
      c0.Publishable tr ∧
      designation.Publishable tr
    | .showdown player peer c0 designation peerDesignation =>
      c0.Publishable tr ∧
      tr.erase.EventLogged (CasinoEvent.share player c0 designation) ∧
      ((tr.erase.EventLogged (CasinoEvent.share peer c0 peerDesignation)) ∨
        ∃ vk, (LongTermKeys.label "ZkCasino PKI" peer vk).isCorrupt tr.erase)

end TraceInvariant

public section TraceInvariantConfig

class HasTraceInvariant extends HasBytesInvariants where
  [traceInv: TraceInvariant]
  [traceInv0: TraceInvariant.Has Network.ProofEntryT]
  [traceInv1: TraceInvariant.Has Random.ProofEntryT]
  [traceInv2: TraceInvariant.Has (ProtocolEvent.ProofEntryT CasinoEvent)]
  [traceInv3: TraceInvariant.Has (PersistentLocalState.CompromisableState.ProofEntryT RegisterState)]
  [traceInv4: TraceInvariant.Has (PersistentLocalState.CompromisableState.ProofEntryT ShuffleState)]
  [traceInv5: TraceInvariant.Has (PersistentLocalState.CompromisableState.ProofEntryT ShareState)]
  [traceInv6: TraceInvariant.Has (LongTermKeys.ProofEntryT "ZkCasino PKI")]
  [attBaseThm: BaseAttackerKnowledgeTheorem]
  [attThm: AttackerKnowledgeTheorem]

attribute [reducible, scoped instance] HasTraceInvariant.traceInv
attribute [           scoped instance] HasTraceInvariant.traceInv0
attribute [           scoped instance] HasTraceInvariant.traceInv1
attribute [           scoped instance] HasTraceInvariant.traceInv2
attribute [           scoped instance] HasTraceInvariant.traceInv3
attribute [           scoped instance] HasTraceInvariant.traceInv4
attribute [           scoped instance] HasTraceInvariant.traceInv5
attribute [           scoped instance] HasTraceInvariant.traceInv6
attribute [           scoped instance] HasTraceInvariant.attBaseThm
attribute [           scoped instance] HasTraceInvariant.attThm

end TraceInvariantConfig

public section Proofs

variable [HasTraceInvariant]

attribute [local grind] ProtocolEvent.EventInv.invariant
attribute [local grind] PersistentLocalState.LocalStateInv.invariant
attribute [local grind] PersistentLocalState.CompromisableLocalStateInv.toLocalStateInv
attribute [local grind] Signature.SignPred.pred
attribute [local grind] casinoSignPred
attribute [local grind] LongTermKeys.IsLongTermPublicKey
attribute [local grind] LongTermKeys.IsLongTermSecretKey
attribute [local grind] Literal.literalToBytes.Invariant
attribute [local grind] DiffieHellman.dhPk.Invariant

grind_pattern [grind_later] Literal.literalToBytes.Invariant =>
  Bytes.Invariant (Literal.literalToBytes lit) tr

theorem publishable_of_pub (b : Bytes) (tr : ProofTrace)
    (hinv : b.Invariant tr) (hlab : b.label tr = Label.pub) : b.Publishable tr := by
  simp [Bytes.Publishable, hlab, Label.pubCanFlow, hinv]

theorem invariant_of_publishable (b : Bytes) (tr : ProofTrace) (h : b.Publishable tr) :
    b.Invariant tr := by
  simp only [Bytes.Publishable] at h
  exact h.1

theorem literalPublishable (lit : ByteArray) (tr : ProofTrace) :
    Bytes.Publishable (Literal.literalToBytes lit) tr :=
  publishable_of_pub _ tr (Literal.literalToBytes.Invariant lit tr) (Literal.literalToBytes.label lit tr)

grind_pattern literalPublishable => Bytes.Publishable (Literal.literalToBytes lit) tr
grind_pattern [grind_later] literalPublishable => Bytes.Publishable (Literal.literalToBytes lit) tr

theorem sigBody_serialize_publishable (body : SigBody) (tr : ProofTrace)
    (h : body.phase.Publishable tr ∧ body.a.Publishable tr ∧ body.b.Publishable tr ∧ body.c.Publishable tr) :
    (serialize body).Publishable tr := by
  simpa [Publishable_serialize, SigBody.IsWellFormed_eq] using h

theorem sigBody_serialize_invariant (body : SigBody) (tr : ProofTrace)
    (h : body.phase.Invariant tr ∧ body.a.Invariant tr ∧ body.b.Invariant tr ∧ body.c.Invariant tr) :
    (serialize body).Invariant tr := by
  simpa [Invariant_serialize, SigBody.IsWellFormed_eq] using h

theorem envelope_publishable (body sig : Bytes) (tr : ProofTrace)
    (hb : body.Publishable tr) (hs : sig.Publishable tr) :
    (serialize ({ body, sig } : Envelope)).Publishable tr := by
  simp only [Publishable_serialize, Envelope.IsWellFormed_eq]
  exact ⟨hb, hs⟩

theorem sig_publishable_of_msg (sig msg : Bytes) (tr : ProofTrace)
    (hinv : sig.Invariant tr) (hlab : sig.label tr = msg.label tr) (hmsg : msg.Publishable tr) :
    sig.Publishable tr := by
  simp only [Bytes.Publishable] at hmsg ⊢
  exact ⟨hinv, hlab ▸ hmsg.2⟩

theorem received_sigBody (buf : Bytes) (env : Envelope) (body : SigBody) (tr : ProofTrace)
    (hbuf : buf.Publishable tr) (henv : FormatRel buf env) (hbody : FormatRel env.body body) :
    body.phase.Publishable tr ∧ body.a.Publishable tr ∧ body.b.Publishable tr ∧ body.c.Publishable tr ∧
    env.sig.Publishable tr := by
  have henvP := IsWellFormed_FormatRel_Publishable buf env tr henv
  rw [henvP, Envelope.IsWellFormed_eq] at hbuf
  have hbodyP := IsWellFormed_FormatRel_Publishable env.body body tr hbody
  rw [hbodyP, SigBody.IsWellFormed_eq] at hbuf
  rcases hbuf with ⟨⟨hp, ha, hb, hc⟩, hsig⟩
  exact ⟨hp, ha, hb, hc, hsig⟩

grind_pattern received_sigBody =>
  Bytes.Publishable buf tr, FormatRel buf env, FormatRel env.body body

theorem signPre_of
    (me : Participant) (sigSk sigNonce msg : Bytes) (tr : ProofTrace)
    (hSecret : LongTermKeys.IsLongTermSecretKey "ZkCasino PKI" me sigSk tr)
    (hNonceInv : sigNonce.Invariant tr)
    (hNonceLab : sigNonce.label tr = Label.secret)
    (hMsg : msg.Invariant tr)
    (hPred : Signature.SignPred.pred (mkLongTermUsage me) (Signature.vk sigSk) msg tr) :
    sigSk.Invariant tr ∧ sigNonce.Invariant tr ∧ msg.Invariant tr ∧
    sigSk.HasUsage (mkLongTermUsage me) tr ∧
    (sigSk.label tr).canFlow (sigNonce.label tr) tr.erase ∧
    ((mkLongTermUsage me).type = "SigKey" ∧
      Signature.SignPred.pred (mkLongTermUsage me) (Signature.vk sigSk) msg tr ∨
      (sigSk.label tr).canFlow Label.pub tr.erase) := by
  simp only [LongTermKeys.IsLongTermSecretKey] at hSecret
  rcases hSecret with ⟨hInv, -, hUsg⟩
  refine ⟨hInv, hNonceInv, hMsg, hUsg, ?_, Or.inl ⟨?_, hPred⟩⟩
  · rw [hNonceLab]
    exact Label.secret.canFlow _ _
  · simp [mkLongTermUsage]

def registerSigBody (pk : Bytes) : SigBody where
  phase := registerTag
  a := pk
  b := emptyBytes
  c := emptyBytes

theorem literalToBytes_inj_ne {a b : ByteArray} (hne : a ≠ b)
    (h : (Literal.literalToBytes a : Bytes) = Literal.literalToBytes b) : False := by
  have hc := congrArg Literal.bytesToLiteral h
  simp only [Literal.bytesToLiteral_literalToBytes] at hc
  injection hc with hab
  exact hne hab

/-- Open publishes the designation tag; closed publishes the public identity. -/
theorem designation_publishable (isOpen : Bool) (tr : ProofTrace) :
    (if isOpen then openTag else closedTag).Publishable tr := by
  cases isOpen <;> simp [openTag, closedTag, Bytes.Publishable, Label.pubCanFlow]

theorem designationInvariant (isOpen : Bool) (tr : ProofTrace) :
    Bytes.Invariant (if isOpen = true then Literal.literalToBytes "opn".toByteArray
      else Literal.literalToBytes "cls".toByteArray) tr := by
  cases isOpen <;> exact Literal.literalToBytes.Invariant _ _

theorem designationPublishable (isOpen : Bool) (tr : ProofTrace) :
    Bytes.Publishable (if isOpen = true then Literal.literalToBytes "opn".toByteArray
      else Literal.literalToBytes "cls".toByteArray) tr := by
  cases isOpen <;> exact literalPublishable _ _

theorem serializedSigBody_invariant (body : SigBody) (tr : ProofTrace)
    (h : body.phase.Invariant tr ∧ body.a.Invariant tr ∧ body.b.Invariant tr ∧ body.c.Invariant tr) :
    (serialize body).Invariant tr := by
  simpa [Invariant_serialize, SigBody.IsWellFormed_eq] using h

/-- Honest register signature: the body is public and the sign predicate holds. -/
theorem signPre_register
    (me : Participant) (sigSk sigNonce skElg msg : Bytes) (tr : ProofTrace)
    (hMsg : msg = serialize (registerSigBody (DiffieHellman.dhPk skElg)))
    (hSecret : LongTermKeys.IsLongTermSecretKey "ZkCasino PKI" me sigSk tr)
    (hNonceInv : sigNonce.Invariant tr)
    (hNonceLab : sigNonce.label tr = Label.secret)
    (hSkInv : skElg.Invariant tr)
    (hSkLab : skElg.label tr = playerLabel me (DiffieHellman.dhPk skElg))
    (hEv : Trace.EventLogged (CasinoEvent.register me (DiffieHellman.dhPk skElg)) tr.erase) :
    sigSk.Invariant tr ∧
    sigNonce.Invariant tr ∧
    msg.Invariant tr ∧
    sigSk.HasUsage (mkLongTermUsage me) tr ∧
    (sigSk.label tr).canFlow (sigNonce.label tr) tr.erase ∧
    ((mkLongTermUsage me).type = "SigKey" ∧
      Signature.SignPred.pred (mkLongTermUsage me) (Signature.vk sigSk) msg tr ∨
      (sigSk.label tr).canFlow Label.pub tr.erase) := by
  simp only [LongTermKeys.IsLongTermSecretKey] at hSecret
  rcases hSecret with ⟨hSkSig, -, hUsg⟩
  refine ⟨hSkSig, hNonceInv, ?msg, hUsg, ?flow, Or.inl ⟨?type, ?pred⟩⟩
  case msg =>
    rw [hMsg]
    apply serializedSigBody_invariant
    exact ⟨Literal.literalToBytes.Invariant _ _, DiffieHellman.dhPk.Invariant _ _ hSkInv,
      Literal.literalToBytes.Invariant _ _, Literal.literalToBytes.Invariant _ _⟩
  case flow =>
    rw [hNonceLab]
    exact Label.secret.canFlow _ _
  case type =>
    simp [mkLongTermUsage]
  case pred =>
    rw [hMsg]
    simp only [Signature.SignPred.pred, casinoSignPred, parse_serialize_inv, registerSigBody]
    exact ⟨me, rfl, Or.inl ⟨trivial, trivial, trivial, skElg, rfl, hSkLab, hEv⟩⟩

@[instance]
theorem Player.register.proof (me : Participant) (sigSkHandle : Nat) :
    HoareTriple (Player.register me sigSkHandle) (fun _ => True) (fun _ _ => True) := by
  apply HoareTriple.mk
  unfold Player.register
  step
  step with ⟨ fun sk => playerLabel me (DiffieHellman.dhPk sk), Usage.nothing ⟩
  step
  step with ⟨ fun _ => Label.secret, Usage.nothing ⟩
  step_intro
  hoist
  step_intro
  step_intro
  step by
    simp only [ProtocolEvent.EventInv.invariant]
    refine ⟨?_, ?_⟩
    · grind
    · rw [Bytes.dhSkLabel_dhPk]
      grind
  step_let sig with ⟨ mkLongTermUsage me ⟩ by
    apply signPre_register me sigSk sigNonce skElg sig_msg
    · rfl
    · grind
    · grind
    · grind
    · grind
    · grind
    · grind
  step by
    simp only [PersistentLocalState.LocalStateInv.invariant]
    grind
  step by
    grind
  step
  grind

@[instance]
theorem Player.shuffle.proof
    (me peer : Participant) (sigSkHandle myReg peerSigPk peerRegMsg : Nat) :
    HoareTriple
      (Player.shuffle me peer sigSkHandle myReg peerSigPk peerRegMsg)
      (fun _ => True) (fun _ _ => True) := by
  apply HoareTriple.mk
  unfold Player.shuffle
  step
  step
  step
  step
  step_intro
  step with ⟨ mkLongTermUsage peer ⟩ by
    grind
  step
  step
  step with ⟨ fun _ => Label.meet (playerLabel me mine.pk) (playerLabel peer body.a), Usage.nothing ⟩
  step
  step with ⟨ fun _ => Label.secret, Usage.nothing ⟩
  step_intro
  hoist
  step_intro
  step_intro
  step by
    simp only [ProtocolEvent.EventInv.invariant]
    grind
  step_let sig with ⟨ mkLongTermUsage me ⟩ by
    apply signPre_of me sigSk sigNonce sig_msg
    · grind
    · grind
    · grind
    · grind
    · unfold sig_msg
      simp only [Signature.SignPred.pred, casinoSignPred, parse_serialize_inv]
      refine ⟨me, rfl, Or.inr (Or.inl ⟨rfl, peer, r, rfl, ?_, ?_⟩)⟩
      · grind
      · grind
  step by
    simp only [PersistentLocalState.LocalStateInv.invariant]
    grind
  step by
    grind
  step
  grind

@[instance]
theorem Player.acceptShuffle.proof
    (me peer : Participant) (peerSigPk myReg shuffleMsg : Nat) :
    HoareTriple
      (Player.acceptShuffle me peer peerSigPk myReg shuffleMsg)
      (fun _ => True) (fun _ _ => True) := by
  apply HoareTriple.mk
  unfold Player.acceptShuffle
  step
  step
  step
  step
  step
  step_intro
  step with ⟨ mkLongTermUsage peer ⟩ by
    grind
  step by
    simp only [ProtocolEvent.EventInv.invariant]
    have hrec := received_sigBody envBytes env body tr (by assumption) (by assumption) (by assumption)
    have hmine := RegisterStateInv_imp me mine (by assumption)
    refine ⟨hrec.2.1, hmine.2.1, hrec.2.2.2.1, ?_⟩
    have hpost : true = true →
        ((mkLongTermUsage peer).type = "SigKey" →
          Signature.SignPred.pred (mkLongTermUsage peer) peerVk (serialize signedBody) tr) ∨
        (peerVk.signkeyLabel tr).canFlow Label.pub tr.erase := by assumption
    rcases hpost rfl with hhon | hcor
    · have hpred := hhon (by simp [mkLongTermUsage])
      simp only [Signature.SignPred.pred, casinoSignPred, parse_serialize_inv, signedBody] at hpred
      rcases hpred with ⟨player, husg, hreg | hshu | hshr⟩
      · rcases hreg with ⟨hp, -⟩
        have hp' : (shuffleTag : Bytes) = registerTag := by simpa [shuffleTag, signedBody] using hp
        exact False.elim (literalToBytes_inj_ne (by decide) hp')
      · rcases hshu with ⟨-, who, -, -, -, hev⟩
        have hplayer : player = peer := mkLongTermUsage_inj husg.symm
        subst hplayer
        exact Or.inl ⟨who, hev⟩
      · rcases hshr with ⟨hp, -⟩
        have hp' : (shuffleTag : Bytes) = shareTag := by simpa [shuffleTag, signedBody] using hp
        exact False.elim (literalToBytes_inj_ne (by decide) hp')
    · have hpk : LongTermKeys.IsLongTermPublicKey "ZkCasino PKI" peer peerVk tr := by assumption
      simp only [LongTermKeys.IsLongTermPublicKey] at hpk
      refine Or.inr ⟨peerVk, ?_⟩
      rw [← hpk.2.1, canFlowPubEqIsCorrupt]
      exact hcor
  step by
    simp only [PersistentLocalState.LocalStateInv.invariant]
    grind
  grind

theorem Player.shareDesignated.proof
    (me : Participant) (sigSkHandle shuffleSt : Nat) (tag : String) :
    HoareTriple
      (Player.shareDesignated me sigSkHandle shuffleSt tag)
      (fun _ => True) (fun _ _ => True) := by
  apply HoareTriple.mk
  unfold Player.shareDesignated
  step
  step_intro
  step
  step with ⟨ fun _ => Label.secret, Usage.nothing ⟩
  step_intro
  hoist
  step_intro
  step_intro
  step by
    simp only [ProtocolEvent.EventInv.invariant]
    refine ⟨?_, literalPublishable _ _⟩
    grind
  step_let sig with ⟨ mkLongTermUsage me ⟩ by
    apply signPre_of me sigSk sigNonce sig_msg
    · grind
    · grind
    · grind
    · grind
    · unfold sig_msg
      simp only [Signature.SignPred.pred, casinoSignPred, parse_serialize_inv]
      refine ⟨me, rfl, Or.inr (Or.inr ⟨rfl, rfl, ?_⟩)⟩
      grind
  step by
    simp only [PersistentLocalState.LocalStateInv.invariant]
    refine ⟨?_, literalPublishable _ _, ?_⟩
    · grind
    · grind
  step by
    grind
  step
  grind

@[instance]
theorem Player.share.proof
    (me : Participant) (sigSkHandle shuffleSt : Nat) (isOpen : Bool) :
    HoareTriple
      (Player.share me sigSkHandle shuffleSt isOpen)
      (fun _ => True) (fun _ _ => True) := by
  cases isOpen
  · simp only [Player.share, Bool.false_eq_true, ite_false]
    exact Player.shareDesignated.proof me sigSkHandle shuffleSt "cls"
  · simp only [Player.share, ite_true]
    exact Player.shareDesignated.proof me sigSkHandle shuffleSt "opn"

@[instance]
theorem Player.showdown.proof
    (me peer : Participant) (peerSigPk myShare peerShareMsg : Nat) :
    HoareTriple
      (Player.showdown me peer peerSigPk myShare peerShareMsg)
      (fun _ => True) (fun _ _ => True) := by
  apply HoareTriple.mk
  unfold Player.showdown
  step
  step
  step
  step
  step
  step_intro
  step with ⟨ mkLongTermUsage peer ⟩ by
    grind
  step by
    simp only [ProtocolEvent.EventInv.invariant]
    have hmine := ShareStateInv_imp me mine (by assumption)
    refine ⟨hmine.1, hmine.2.2, ?_⟩
    have hpost : true = true →
        ((mkLongTermUsage peer).type = "SigKey" →
          Signature.SignPred.pred (mkLongTermUsage peer) peerVk (serialize signedBody) tr) ∨
        (peerVk.signkeyLabel tr).canFlow Label.pub tr.erase := by assumption
    rcases hpost rfl with hhon | hcor
    · have hpred := hhon (by simp [mkLongTermUsage])
      simp only [Signature.SignPred.pred, casinoSignPred, parse_serialize_inv, signedBody] at hpred
      rcases hpred with ⟨player, husg, hreg | hshu | hshr⟩
      · rcases hreg with ⟨hp, -⟩
        have hp' : (shareTag : Bytes) = registerTag := by simpa [shareTag, signedBody] using hp
        exact False.elim (literalToBytes_inj_ne (by decide) hp')
      · rcases hshu with ⟨hp, -⟩
        have hp' : (shareTag : Bytes) = shuffleTag := by simpa [shareTag, signedBody] using hp
        exact False.elim (literalToBytes_inj_ne (by decide) hp')
      · rcases hshr with ⟨-, -, hev⟩
        have hplayer : player = peer := mkLongTermUsage_inj husg.symm
        subst hplayer
        exact Or.inl hev
    · have hpk : LongTermKeys.IsLongTermPublicKey "ZkCasino PKI" peer peerVk tr := by assumption
      simp only [LongTermKeys.IsLongTermPublicKey] at hpk
      refine Or.inr ⟨peerVk, ?_⟩
      rw [← hpk.2.1, canFlowPubEqIsCorrupt]
      exact hcor
  step
  grind

@[instance]
theorem RegisterState.compromise.proof (stHandle : Nat) :
    HoareTriple (RegisterState.compromise stHandle) (fun _ => True) (fun _ _ => True) := by
  unfold RegisterState.compromise
  step
  grind

@[instance]
theorem ShuffleState.compromise.proof (stHandle : Nat) :
    HoareTriple (ShuffleState.compromise stHandle) (fun _ => True) (fun _ _ => True) := by
  unfold ShuffleState.compromise
  step
  grind

@[instance]
theorem ShareState.compromise.proof (stHandle : Nat) :
    HoareTriple (ShareState.compromise stHandle) (fun _ => True) (fun _ _ => True) := by
  unfold ShareState.compromise
  step
  grind

end Proofs

section ReachabilityImpliesInvariant

variable [HasTraceInvariant]

public instance : ReachableImpliesInvariant Player.register.reachability :=
  .mk (fun (me, sigSkHandle) => Player.register.proof me sigSkHandle)
public instance : ReachableImpliesInvariant Player.shuffle.reachability :=
  .mk (fun (me, peer, sigSk, myReg, peerSigPk, peerRegMsg) =>
    Player.shuffle.proof me peer sigSk myReg peerSigPk peerRegMsg)
public instance : ReachableImpliesInvariant Player.acceptShuffle.reachability :=
  .mk (fun (me, peer, peerSigPk, myReg, shuffleMsg) =>
    Player.acceptShuffle.proof me peer peerSigPk myReg shuffleMsg)
public instance : ReachableImpliesInvariant Player.share.reachability :=
  .mk (fun (me, sigSk, shuffleSt, isOpen) =>
    Player.share.proof me sigSk shuffleSt isOpen)
public instance : ReachableImpliesInvariant Player.showdown.reachability :=
  .mk (fun (me, peer, peerSigPk, myShare, peerShareMsg) =>
    Player.showdown.proof me peer peerSigPk myShare peerShareMsg)
public instance : ReachableImpliesInvariant RegisterState.compromise.reachability :=
  .mk (fun stHandle => RegisterState.compromise.proof stHandle)
public instance : ReachableImpliesInvariant ShuffleState.compromise.reachability :=
  .mk (fun stHandle => ShuffleState.compromise.proof stHandle)
public instance : ReachableImpliesInvariant ShareState.compromise.reachability :=
  .mk (fun stHandle => ShareState.compromise.proof stHandle)

#combine into ReachabilityTheorem from
  Network,
  LongTermKeys "ZkCasino PKI",
  Player.register,
  Player.shuffle,
  Player.acceptShuffle,
  Player.share,
  Player.showdown,
  RegisterState.compromise,
  ShuffleState.compromise,
  ShareState.compromise,

end ReachabilityImpliesInvariant

end DY.ZkCasino
