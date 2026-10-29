module

public import ZkCasino.Specification
public import ZkCasino.Proof

namespace DY.ZkCasino

public section

#combine +toplevel into BytesFunctor, BytesLength, attackerKnowledge from
  Random,
  Literal,
  Concat,
  Hash,
  Signature,
  DiffieHellman,

instance : HasExecBytes where

#combine +toplevel into
  ExecEntryT,
  baseAttackerKnowledge,
from
  Network,
  Random,
  ProtocolEvent CasinoEvent,
  PersistentLocalState.CompromisableState RegisterState,
  PersistentLocalState.CompromisableState ShuffleState,
  PersistentLocalState.CompromisableState ShareState,
  LongTermKeys "ZkCasino PKI",

instance : HasExecTrace where

#combine +toplevel into
  ProofEntryT,
from
  Network,
  Random,
  ProtocolEvent CasinoEvent,
  PersistentLocalState.CompromisableState RegisterState,
  PersistentLocalState.CompromisableState ShuffleState,
  PersistentLocalState.CompromisableState ShareState,
  LongTermKeys "ZkCasino PKI",

instance : HasProofTrace where

#combine +toplevel into BytesInvariants, BytesInvariantsProofs from
  Random,
  Literal,
  Concat,
  Hash,
  Signature,
  DiffieHellman,

instance : HasBytesInvariants where

#combine +toplevel into
  SubTraceInvariant,
  SubBaseAttackerKnowledgeTheorem,
from
  Network,
  Random,
  ProtocolEvent CasinoEvent,
  PersistentLocalState.CompromisableState RegisterState,
  PersistentLocalState.CompromisableState ShuffleState,
  PersistentLocalState.CompromisableState ShareState,
  LongTermKeys "ZkCasino PKI",

#combine +toplevel into SubAttackerKnowledgeTheorem from
  Random,
  Literal,
  Concat,
  Hash,
  Signature,
  DiffieHellman,

instance : HasTraceInvariant where

end

end DY.ZkCasino
