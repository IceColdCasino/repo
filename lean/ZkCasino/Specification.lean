module

/-
  Symbolic model of the ZK Casino four-phase protocol
  (register → shuffle → share → showdown), in DyLean.

  One ciphertext position, two seated players, n-of-n ElGamal.
  Games in `repo/docs/zk-casino` change the shoe and the evaluator;
  the secrecy and authentication goals are this genus.

  DyLean has Diffie–Hellman but no group law, so a partial decryption is
  `dh(c0, sk)` and the recovered witness is the pair of partials. The
  attacker can build that pair only from both secret keys. Hashout never
  puts those partials on the network: a first-state (open) designation
  contributes `dh(c0, sk)` as a private witness, and a second-state
  (closed) designation contributes the public identity.
-/

public import DY.Trace
public import DY.Bytes
public import DY.EquationalTheory.Literal
public import DY.EquationalTheory.Concat
public import DY.EquationalTheory.Hash
public import DY.EquationalTheory.Sign
public import DY.EquationalTheory.DiffieHellman
public import DY.Actions.Network
public import DY.Actions.Random
public import DY.Actions.ProtocolEvent
public import DY.Actions.PersistentLocalState
public import DY.Actions.LongTermKeys
public import DY.Comparse

namespace DY.ZkCasino

open DY.Comparse

public section ExecBytesConfig

class HasExecBytes where
  [bytesFunc: BytesFunctor]
  [bytesFunc0: BytesFunctor.Has Random.SubF]
  [bytesFunc1: BytesFunctor.Has Literal.SubF]
  [bytesFunc2: BytesFunctor.Has Concat.SubF]
  [bytesFunc3: BytesFunctor.Has Hash.SubF]
  [bytesFunc4: BytesFunctor.Has Signature.SubF]
  [bytesFunc5: BytesFunctor.Has DiffieHellman.SubF]
  [bytesLen: BytesLength]
  [bytesLen0: BytesLength.Has Random.SubF.length]
  [bytesLen1: BytesLength.Has Literal.SubF.length]
  [bytesLen2: BytesLength.Has Concat.SubF.length]
  [bytesLen3: BytesLength.Has Hash.SubF.length]
  [bytesLen4: BytesLength.Has Signature.SubF.length]
  [bytesLen5: BytesLength.Has DiffieHellman.SubF.length]
  [att: AttackerKnowledge]
  [att0: AttackerKnowledge.Has Random.attackerKnowledge]
  [att1: AttackerKnowledge.Has Literal.attackerKnowledge]
  [att2: AttackerKnowledge.Has Concat.attackerKnowledge]
  [att3: AttackerKnowledge.Has Hash.attackerKnowledge]
  [att4: AttackerKnowledge.Has Signature.attackerKnowledge]
  [att5: AttackerKnowledge.Has DiffieHellman.attackerKnowledge]

attribute [reducible, scoped instance] HasExecBytes.bytesFunc
attribute [reducible, scoped instance] HasExecBytes.bytesFunc0
attribute [reducible, scoped instance] HasExecBytes.bytesFunc1
attribute [reducible, scoped instance] HasExecBytes.bytesFunc2
attribute [reducible, scoped instance] HasExecBytes.bytesFunc3
attribute [reducible, scoped instance] HasExecBytes.bytesFunc4
attribute [reducible, scoped instance] HasExecBytes.bytesFunc5
attribute [reducible, scoped instance] HasExecBytes.bytesLen
attribute [           scoped instance] HasExecBytes.bytesLen0
attribute [           scoped instance] HasExecBytes.bytesLen1
attribute [           scoped instance] HasExecBytes.bytesLen2
attribute [           scoped instance] HasExecBytes.bytesLen3
attribute [           scoped instance] HasExecBytes.bytesLen4
attribute [           scoped instance] HasExecBytes.bytesLen5
attribute [reducible, scoped instance] HasExecBytes.att
attribute [           scoped instance] HasExecBytes.att0
attribute [           scoped instance] HasExecBytes.att1
attribute [           scoped instance] HasExecBytes.att2
attribute [           scoped instance] HasExecBytes.att3
attribute [           scoped instance] HasExecBytes.att4
attribute [           scoped instance] HasExecBytes.att5

end ExecBytesConfig

public section Structures

variable [HasExecBytes]

/-- Phase tag plus three payloads. Unused slots are the empty literal. -/
structure SigBody where
  phase : Bytes
  a : Bytes
  b : Bytes
  c : Bytes

structure Envelope where
  body : Bytes
  sig : Bytes

/-- ElGamal registration. `sk` stays in this state; `pk = dhPk sk` is public. -/
structure RegisterState where
  pk : Bytes
  sk : Bytes

/-- Public shuffle transcript. The encryption randomness is not stored. -/
structure ShuffleState where
  pk : Bytes
  peerPk : Bytes
  c0 : Bytes

structure ShareState where
  c0 : Bytes
  designation : Bytes

inductive CasinoEvent where
  | register (player : Participant) (pk : Bytes)
  | shuffle (shuffler peer : Participant) (pk peerPk c0 : Bytes)
  | accept (acceptor shuffler : Participant) (pk peerPk c0 : Bytes)
  | share (player : Participant) (c0 designation : Bytes)
  | showdown (player peer : Participant) (c0 designation peerDesignation : Bytes)
deriving DecidableEq

@[reducible] def registerTag : Bytes := Literal.literalToBytes "reg".toByteArray
@[reducible] def shuffleTag : Bytes := Literal.literalToBytes "shu".toByteArray
@[reducible] def shareTag : Bytes := Literal.literalToBytes "shr".toByteArray
@[reducible] def openTag : Bytes := Literal.literalToBytes "opn".toByteArray
@[reducible] def closedTag : Bytes := Literal.literalToBytes "cls".toByteArray
/-- Second-state payload: the BabyJub identity, a public constant. -/
@[reducible] def identityPayload : Bytes := Literal.literalToBytes "id".toByteArray
@[reducible] def emptyBytes : Bytes := Literal.literalToBytes ByteArray.empty

/--
  Claim 7 mux. First state (open) contributes the DH partial.
  Second state (closed) contributes the identity.
-/
def designatedPayload (designation part : Bytes) : Bytes :=
  if designation = openTag then part else identityPayload

/--
  Pair of ElGamal partials `sk · c0`. The circuit recovers the face as
  `c1` minus the group-sum of these partials. DyLean has no group addition;
  the pair is the witness the attacker must build, and concatenation is
  known only when both components are known.
-/
def aggregatedPartials (c0 skA skB : Bytes) : Bytes :=
  Concat.concat (DiffieHellman.dh c0 skA) (DiffieHellman.dh c0 skB)

end Structures

public section Formats

variable [HasExecBytes]

public
instance : ParseableSerializeable SigBody := .make <|
  .triviallyIsomorphic
    (.prod .slowBytes (.prod .slowBytes (.prod .slowBytes .bytes)))
    (fun ⟨ phase, a, b, c ⟩ => { phase, a, b, c })
    (fun { phase, a, b, c } => ⟨ phase, a, b, c ⟩)

public
theorem SigBody.IsWellFormed_eq
  (pre : Bytes → τ → Prop) [BytesCompatibleTracePred pre] (x : SigBody) (tr : τ) :
  IsWellFormed pre x tr = (
    pre x.phase tr ∧ pre x.a tr ∧ pre x.b tr ∧ pre x.c tr
  )
:= by
  simp [Comparse.IsWellFormed, Comparse.ParseableSerializeable.mf]

grind_pattern SigBody.IsWellFormed_eq => IsWellFormed pre x tr
grind_pattern [grind_later] SigBody.IsWellFormed_eq => IsWellFormed pre x tr

public
instance : ParseableSerializeable Envelope := .make <|
  .triviallyIsomorphic
    (.prod .slowBytes .bytes)
    (fun ⟨ body, sig ⟩ => { body, sig })
    (fun { body, sig } => ⟨ body, sig ⟩)

public
theorem Envelope.IsWellFormed_eq
  (pre : Bytes → τ → Prop) [BytesCompatibleTracePred pre] (x : Envelope) (tr : τ) :
  IsWellFormed pre x tr = (pre x.body tr ∧ pre x.sig tr)
:= by
  simp [Comparse.IsWellFormed, Comparse.ParseableSerializeable.mf]

grind_pattern Envelope.IsWellFormed_eq => IsWellFormed pre x tr
grind_pattern [grind_later] Envelope.IsWellFormed_eq => IsWellFormed pre x tr

public
instance : ParseableSerializeable RegisterState := .make <|
  .triviallyIsomorphic
    (.prod .slowBytes .bytes)
    (fun ⟨ pk, sk ⟩ => { pk, sk })
    (fun { pk, sk } => ⟨ pk, sk ⟩)

public
theorem RegisterState.IsWellFormed_eq
  (pre : Bytes → τ → Prop) [BytesCompatibleTracePred pre] (x : RegisterState) (tr : τ) :
  IsWellFormed pre x tr = (pre x.pk tr ∧ pre x.sk tr)
:= by
  simp [Comparse.IsWellFormed, Comparse.ParseableSerializeable.mf]

grind_pattern RegisterState.IsWellFormed_eq => IsWellFormed pre x tr
grind_pattern [grind_later] RegisterState.IsWellFormed_eq => IsWellFormed pre x tr

public
instance : ParseableSerializeable ShuffleState := .make <|
  .triviallyIsomorphic
    (.prod .slowBytes (.prod .slowBytes .bytes))
    (fun ⟨ pk, peerPk, c0 ⟩ => { pk, peerPk, c0 })
    (fun { pk, peerPk, c0 } => ⟨ pk, peerPk, c0 ⟩)

public
theorem ShuffleState.IsWellFormed_eq
  (pre : Bytes → τ → Prop) [BytesCompatibleTracePred pre] (x : ShuffleState) (tr : τ) :
  IsWellFormed pre x tr = (pre x.pk tr ∧ pre x.peerPk tr ∧ pre x.c0 tr)
:= by
  simp [Comparse.IsWellFormed, Comparse.ParseableSerializeable.mf]

grind_pattern ShuffleState.IsWellFormed_eq => IsWellFormed pre x tr
grind_pattern [grind_later] ShuffleState.IsWellFormed_eq => IsWellFormed pre x tr

public
instance : ParseableSerializeable ShareState := .make <|
  .triviallyIsomorphic
    (.prod .slowBytes .bytes)
    (fun ⟨ c0, designation ⟩ => { c0, designation })
    (fun { c0, designation } => ⟨ c0, designation ⟩)

public
theorem ShareState.IsWellFormed_eq
  (pre : Bytes → τ → Prop) [BytesCompatibleTracePred pre] (x : ShareState) (tr : τ) :
  IsWellFormed pre x tr = (pre x.c0 tr ∧ pre x.designation tr)
:= by
  simp [Comparse.IsWellFormed, Comparse.ParseableSerializeable.mf]

grind_pattern ShareState.IsWellFormed_eq => IsWellFormed pre x tr
grind_pattern [grind_later] ShareState.IsWellFormed_eq => IsWellFormed pre x tr

end Formats

public section ExecTraceConfig

class HasExecTrace extends HasExecBytes where
  [traceExec: ExecTraceTypes]
  [traceExec0: ExecTraceTypes.Has Network.ExecEntryT]
  [traceExec1: ExecTraceTypes.Has Random.ExecEntryT]
  [traceExec2: ExecTraceTypes.Has (ProtocolEvent.ExecEntryT CasinoEvent)]
  [traceExec3: ExecTraceTypes.Has (PersistentLocalState.CompromisableState.ExecEntryT RegisterState)]
  [traceExec4: ExecTraceTypes.Has (PersistentLocalState.CompromisableState.ExecEntryT ShuffleState)]
  [traceExec5: ExecTraceTypes.Has (PersistentLocalState.CompromisableState.ExecEntryT ShareState)]
  [traceExec6: ExecTraceTypes.Has (LongTermKeys.ExecEntryT "ZkCasino PKI")]
  [attBase: BaseAttackerKnowledge]

attribute [reducible, scoped instance] HasExecTrace.traceExec
attribute [reducible, scoped instance] HasExecTrace.traceExec0
attribute [reducible, scoped instance] HasExecTrace.traceExec1
attribute [reducible, scoped instance] HasExecTrace.traceExec2
attribute [reducible, scoped instance] HasExecTrace.traceExec3
attribute [reducible, scoped instance] HasExecTrace.traceExec4
attribute [reducible, scoped instance] HasExecTrace.traceExec5
attribute [reducible, scoped instance] HasExecTrace.traceExec6
attribute [reducible, scoped instance] HasExecTrace.attBase

end ExecTraceConfig

public section Specification

variable [HasExecTrace]

instance : LongTermKeys.ExecConfig "ZkCasino PKI" Signature.vk where

/-- Phase 210. Sample an ElGamal key, prove `pk = sk · G` by publishing `dhPk sk`. -/
def Player.register (me : Participant) (sigSkHandle : Nat) : Traceful (Nat × Nat) := do
  let sigSk ← LongTermKeys.getPrivateKey "ZkCasino PKI" me sigSkHandle
  let skElg ← Random.genRand 32
  let pk := DiffieHellman.dhPk skElg
  let sigNonce ← Random.genRand 32
  let body : SigBody := { phase := registerTag, a := pk, b := emptyBytes, c := emptyBytes }
  let sig := Signature.sign sigSk sigNonce (serialize body)
  ProtocolEvent.logEvent (CasinoEvent.register me pk)
  let st ← PersistentLocalState.storeLocalState me ({ pk, sk := skElg } : RegisterState)
  let msg ← Network.sendMessage (serialize ({ body := serialize body, sig } : Envelope))
  return (st, msg)

/--
  Phase 220. Sample committee randomness `r` labeled with the meet of the two
  seated keys (neither player's compromise alone reveals it) and publish
  `c0 = dhPk r`.
-/
def Player.shuffle
    (me peer : Participant) (sigSkHandle myReg peerSigPk peerRegMsg : Nat) :
    Traceful (Nat × Nat) := do
  let envBytes ← Network.receiveMessage peerRegMsg
  let env : Envelope ← parse envBytes
  let body : SigBody ← parse env.body
  let peerVk ← LongTermKeys.getPublicKey "ZkCasino PKI" peer peerSigPk
  -- Rebuild the registration body so a signature only counts for phase 210.
  let signedBody : SigBody := { phase := registerTag, a := body.a, b := emptyBytes, c := emptyBytes }
  guard (Signature.verify peerVk (serialize signedBody) env.sig)
  let mine : RegisterState ← PersistentLocalState.getLocalState me myReg
  let sigSk ← LongTermKeys.getPrivateKey "ZkCasino PKI" me sigSkHandle
  let r ← Random.genRand 32
  let c0 := DiffieHellman.dhPk r
  let sigNonce ← Random.genRand 32
  let outBody : SigBody := { phase := shuffleTag, a := mine.pk, b := body.a, c := c0 }
  let sig := Signature.sign sigSk sigNonce (serialize outBody)
  ProtocolEvent.logEvent (CasinoEvent.shuffle me peer mine.pk body.a c0)
  let st ← PersistentLocalState.storeLocalState me ({ pk := mine.pk, peerPk := body.a, c0 } : ShuffleState)
  let msg ← Network.sendMessage (serialize ({ body := serialize outBody, sig } : Envelope))
  return (st, msg)

/-- Check the shuffler's signature and keep the public ciphertext. -/
def Player.acceptShuffle
    (me peer : Participant) (peerSigPk myReg shuffleMsg : Nat) : Traceful Nat := do
  let mine : RegisterState ← PersistentLocalState.getLocalState me myReg
  let envBytes ← Network.receiveMessage shuffleMsg
  let env : Envelope ← parse envBytes
  let body : SigBody ← parse env.body
  let peerVk ← LongTermKeys.getPublicKey "ZkCasino PKI" peer peerSigPk
  let signedBody : SigBody := { phase := shuffleTag, a := body.a, b := mine.pk, c := body.c }
  guard (Signature.verify peerVk (serialize signedBody) env.sig)
  ProtocolEvent.logEvent (CasinoEvent.accept me peer body.a mine.pk body.c)
  let st ← PersistentLocalState.storeLocalState me ({ pk := body.a, peerPk := mine.pk, c0 := body.c } : ShuffleState)
  return st

/--
  Phase 230. Publish only the designation bit.
  Open (first state) would contribute `dh(c0, sk)` inside the hashout witness.
  Closed (second state) contributes `identityPayload`. Neither partial is sent.
-/
def Player.shareDesignated
    (me : Participant) (sigSkHandle shuffleSt : Nat) (tag : String) :
    Traceful (Nat × Nat) := do
  let shuffle : ShuffleState ← PersistentLocalState.getLocalState me shuffleSt
  let designation := Literal.literalToBytes tag.toByteArray
  let sigSk ← LongTermKeys.getPrivateKey "ZkCasino PKI" me sigSkHandle
  let sigNonce ← Random.genRand 32
  let body : SigBody := { phase := shareTag, a := shuffle.c0, b := designation, c := emptyBytes }
  let sig := Signature.sign sigSk sigNonce (serialize body)
  ProtocolEvent.logEvent (CasinoEvent.share me shuffle.c0 designation)
  let st ← PersistentLocalState.storeLocalState me ({ c0 := shuffle.c0, designation } : ShareState)
  let msg ← Network.sendMessage (serialize ({ body := serialize body, sig } : Envelope))
  return (st, msg)

def Player.share
    (me : Participant) (sigSkHandle shuffleSt : Nat) (isOpen : Bool) :
    Traceful (Nat × Nat) :=
  if isOpen then
    Player.shareDesignated me sigSkHandle shuffleSt "opn"
  else
    Player.shareDesignated me sigSkHandle shuffleSt "cls"

/-- Phase 240. Agree on the peer's signed designation. The partials stay off the wire. -/
def Player.showdown
    (me peer : Participant) (peerSigPk myShare peerShareMsg : Nat) : Traceful Unit := do
  let mine : ShareState ← PersistentLocalState.getLocalState me myShare
  let envBytes ← Network.receiveMessage peerShareMsg
  let env : Envelope ← parse envBytes
  let body : SigBody ← parse env.body
  let peerVk ← LongTermKeys.getPublicKey "ZkCasino PKI" peer peerSigPk
  let signedBody : SigBody := { phase := shareTag, a := mine.c0, b := body.b, c := emptyBytes }
  guard (Signature.verify peerVk (serialize signedBody) env.sig)
  ProtocolEvent.logEvent (CasinoEvent.showdown me peer mine.c0 mine.designation body.b)
  return ()

def RegisterState.compromise (stHandle : Nat) : Traceful Nat := do
  PersistentLocalState.compromise RegisterState stHandle

def ShuffleState.compromise (stHandle : Nat) : Traceful Nat := do
  PersistentLocalState.compromise ShuffleState stHandle

def ShareState.compromise (stHandle : Nat) : Traceful Nat := do
  PersistentLocalState.compromise ShareState stHandle

end Specification

public section SecurityPredicates

variable [HasExecTrace]

def PlayerCompromised (me : Participant) (pk : Bytes) (tr : ExecTrace) : Prop :=
  ∃ sk, PersistentLocalState.LocalStateCompromised me ({ pk, sk } : RegisterState) tr

theorem PlayerCompromised_le
    (me : Participant) (pk : Bytes) (tr1 tr2 : ExecTrace) :
    tr1 ≤ tr2 → PlayerCompromised me pk tr1 → PlayerCompromised me pk tr2 := by
  simp only [PlayerCompromised]
  grind

grind_pattern PlayerCompromised_le => tr1 ≤ tr2, PlayerCompromised me pk tr1
grind_pattern [grind_later] PlayerCompromised_le => tr1 ≤ tr2, PlayerCompromised me pk tr1

def playerLabel (me : Participant) (pk : Bytes) : Label where
  isCorrupt tr := PlayerCompromised me pk tr
  isCorruptLater := PlayerCompromised_le me pk

end SecurityPredicates

public section Reachability

variable [HasExecTrace]

@[expose] public section
def Player.register.reachability : ReachabilityConfig :=
  .make (fun (me, sigSkHandle) => Player.register me sigSkHandle)
def Player.shuffle.reachability : ReachabilityConfig :=
  .make (fun (me, peer, sigSk, myReg, peerSigPk, peerRegMsg) =>
    Player.shuffle me peer sigSk myReg peerSigPk peerRegMsg)
def Player.acceptShuffle.reachability : ReachabilityConfig :=
  .make (fun (me, peer, peerSigPk, myReg, shuffleMsg) =>
    Player.acceptShuffle me peer peerSigPk myReg shuffleMsg)
def Player.share.reachability : ReachabilityConfig :=
  .make (fun (me, sigSk, shuffleSt, isOpen) =>
    Player.share me sigSk shuffleSt isOpen)
def Player.showdown.reachability : ReachabilityConfig :=
  .make (fun (me, peer, peerSigPk, myShare, peerShareMsg) =>
    Player.showdown me peer peerSigPk myShare peerShareMsg)
def RegisterState.compromise.reachability : ReachabilityConfig :=
  .make (fun stHandle => RegisterState.compromise stHandle)
def ShuffleState.compromise.reachability : ReachabilityConfig :=
  .make (fun stHandle => ShuffleState.compromise stHandle)
def ShareState.compromise.reachability : ReachabilityConfig :=
  .make (fun stHandle => ShareState.compromise stHandle)
end

#combine into ReachabilityConfig from
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

end Reachability

end DY.ZkCasino
