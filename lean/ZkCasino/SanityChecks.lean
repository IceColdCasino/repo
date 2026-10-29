module

import ZkCasino.Specification
import ZkCasino.Instance
public meta import ZkCasino.Instance

namespace DY.ZkCasino

open DY.Comparse

/-- Honest two-player hand: register, shuffle, share (open), showdown. -/
def honestRound : Traceful Unit := do
  let (_vkMsgA, pkA, skA) ← LongTermKeys.generateKeyPair "ZkCasino PKI" "Alice"
  let (_vkMsgB, pkB, skB) ← LongTermKeys.generateKeyPair "ZkCasino PKI" "Bob"
  let (regA, _msgA) ← Player.register "Alice" skA
  let (regB, msgB) ← Player.register "Bob" skB
  let (shufA, shufMsg) ← Player.shuffle "Alice" "Bob" skA regA pkB msgB
  let shufB ← Player.acceptShuffle "Bob" "Alice" pkA regB shufMsg
  let (_shareA, shareMsgA) ← Player.share "Alice" skA shufA true
  let (_shareB, shareMsgB) ← Player.share "Bob" skB shufB true
  Player.showdown "Alice" "Bob" pkB _shareA shareMsgB
  Player.showdown "Bob" "Alice" pkA _shareB shareMsgA
  return ()

#guard (honestRound.run Trace.nil).fst = some ()

#guard designatedPayload closedTag (Literal.literalToBytes "partial".toByteArray) = identityPayload

#guard designatedPayload openTag (Literal.literalToBytes "partial".toByteArray) =
  (Literal.literalToBytes "partial".toByteArray)

end DY.ZkCasino
