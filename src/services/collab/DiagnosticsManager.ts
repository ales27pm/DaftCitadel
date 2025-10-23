import type { LinkMetrics, NetworkDiagnostics } from './diagnostics/NetworkDiagnostics';
import type { Logger } from './types';

function sanitizeMetrics(metrics: LinkMetrics): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...metrics };
  delete sanitized.interfaceName;
  delete sanitized.ssid;
  delete sanitized.bssid;
  return sanitized;
}

export class DiagnosticsManager {
  private readonly diagnostics: NetworkDiagnostics;
  private readonly logger: Logger;
  private readonly onMetrics: (metrics: LinkMetrics) => void;
  private unsubscribe?: () => void;

  constructor({
    diagnostics,
    logger,
    onMetrics,
  }: {
    diagnostics: NetworkDiagnostics;
    logger: Logger;
    onMetrics: (metrics: LinkMetrics) => void;
  }) {
    this.diagnostics = diagnostics;
    this.logger = logger;
    this.onMetrics = onMetrics;
  }

  start(): void {
    this.stop();
    this.unsubscribe = this.diagnostics.subscribe((metrics) => {
      this.logger('collab.networkMetrics', sanitizeMetrics(metrics));
      this.onMetrics(metrics);
    });
    this.diagnostics
      .getCurrentLinkMetrics()
      .then((metrics) => {
        this.logger('collab.networkMetrics.initial', sanitizeMetrics(metrics));
        this.onMetrics(metrics);
      })
      .catch((error) => {
        this.logger('collab.networkMetrics.error', { error: String(error) });
      });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
