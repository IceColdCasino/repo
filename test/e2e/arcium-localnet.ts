import { LocalnetOrchestrator, stopStaleLocalnet, localnetStatus } from './localnet-orchestrator';

/**
 * Shared arcium localnet for the test process.
 * - Reuses a fully ready localnet (validator + MXE).
 * - Half-dead state (RPC without MXE) is cleaned before a managed start.
 * - Starts at most one orchestrator per process; ref-counted acquire/release.
 * - Prefer `bun run localnet:start` for interactive / long-lived localnet.
 */
export class ArciumLocalnet {
  private static orchestrator?: LocalnetOrchestrator;
  private static refCount = 0;
  /** We attached to an external localnet; do not stop it on shutdown. */
  private static external = false;
  private static exitHookRegistered = false;

  static async acquire(): Promise<LocalnetOrchestrator> {
    ArciumLocalnet.registerExitHook();

    if (ArciumLocalnet.orchestrator) {
      ArciumLocalnet.refCount++;
      return ArciumLocalnet.orchestrator;
    }

    const status = localnetStatus();
    if (status.ready) {
      console.log('[localnet] attaching to existing ready localnet');
      ArciumLocalnet.orchestrator = new LocalnetOrchestrator({ managed: false });
      ArciumLocalnet.external = true;
      ArciumLocalnet.refCount = 1;
      return ArciumLocalnet.orchestrator;
    }

    // Validator-only / MXE-only leftovers will poison a fresh start.
    if (status.validator || status.mxe || status.pid !== null) {
      console.log('[localnet] half-dead localnet detected — cleaning before start');
      stopStaleLocalnet({ killCli: false });
    }

    const orchestrator = new LocalnetOrchestrator({ managed: true, streamLogs: true });
    await orchestrator.start();
    ArciumLocalnet.orchestrator = orchestrator;
    ArciumLocalnet.external = false;
    ArciumLocalnet.refCount = 1;
    return orchestrator;
  }

  /** Decrement ref-count; localnet stays up until process shutdown. */
  static async release(): Promise<void> {
    if (ArciumLocalnet.refCount <= 0) return;
    ArciumLocalnet.refCount--;
  }

  static async shutdown(): Promise<void> {
    if (ArciumLocalnet.refCount > 0) return;

    const orchestrator = ArciumLocalnet.orchestrator;
    ArciumLocalnet.orchestrator = undefined;
    const external = ArciumLocalnet.external;
    ArciumLocalnet.external = false;

    if (orchestrator && !external) {
      await orchestrator.stop();
    }
  }

  private static registerExitHook(): void {
    if (ArciumLocalnet.exitHookRegistered) return;
    ArciumLocalnet.exitHookRegistered = true;

    const runShutdown = () => {
      ArciumLocalnet.refCount = 0;
      void ArciumLocalnet.shutdown();
    };
    process.once('beforeExit', runShutdown);
    process.once('SIGINT', runShutdown);
    process.once('SIGTERM', runShutdown);
  }
}

export { LOCALNET_RPC, isArciumMxeReady, isLocalnetReady, isValidatorReady } from './localnet-health';
export {
  localnetStatus,
  stopStaleLocalnet,
  isDockerRunning,
  LOG_PATH,
  PID_PATH,
} from './localnet-orchestrator';
