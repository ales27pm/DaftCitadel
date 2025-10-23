import type { LinkMetrics, NetworkDiagnostics } from './diagnostics/NetworkDiagnostics';
import type { Logger } from './types';

function sanitizeMetrics(metrics: LinkMetrics): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    timestamp: metrics.timestamp,
    category: metrics.category,
  };

  if (typeof metrics.rssi === 'number') {
    sanitized.rssi = metrics.rssi;
  }
  if (typeof metrics.noise === 'number') {
    sanitized.noise = metrics.noise;
  }
  if (typeof metrics.linkSpeedMbps === 'number') {
    sanitized.linkSpeedMbps = metrics.linkSpeedMbps;
  }
  if (typeof metrics.transmitRateMbps === 'number') {
    sanitized.transmitRateMbps = metrics.transmitRateMbps;
  }

  return sanitized;
}

export class DiagnosticsManager {
  private readonly diagnostics: NetworkDiagnostics;
  private readonly logger: Logger;
  private readonly onMetrics: (metrics: LinkMetrics) => void;
  private unsubscribe?: () => void;
  private latestMetrics?: LinkMetrics;

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
      this.latestMetrics = metrics;
      this.logger('collab.networkMetrics', sanitizeMetrics(metrics));
      this.onMetrics(metrics);
    });
    this.diagnostics
      .getCurrentLinkMetrics()
      .then((metrics) => {
        this.latestMetrics = metrics;
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

  getLatestMetrics(): LinkMetrics | undefined {
    return this.latestMetrics ? { ...this.latestMetrics } : undefined;
  }

  getLatestSanitizedMetrics(): Record<string, unknown> | undefined {
    return this.latestMetrics ? sanitizeMetrics(this.latestMetrics) : undefined;
  }
}
