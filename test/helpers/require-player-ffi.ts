/** Fail fast unless libzkcasino player math and the prove bridge are both loadable. */
import { requirePlayerBridge } from '../../src/player-bridge-ffi';
import { requirePlayerFfi } from '../../src/player-ffi';

requirePlayerFfi();
requirePlayerBridge();
