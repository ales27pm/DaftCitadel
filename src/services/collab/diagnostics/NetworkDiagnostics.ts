import { EventEmitter } from 'events';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

type NullableNumber = number | null | undefined;

export type NetworkQualityCategory = 'excellent' | 'good' | 'degraded' | 'unusable';

export interface LinkMetrics {
  readonly interfaceName?: string;
  readonly rssi?: number;
  readonly noise?: number;
  readonly linkSpeedMbps?: number;
  readonly transmitRateMbps?: number;
  readonly timestamp: number;
  readonly category: NetworkQualityCategory;
}

export type NetworkMetricsListener = (metrics: LinkMetrics) => void;

export interface NetworkDiagnostics {
  getCurrentLinkMetrics(): Promise<LinkMetrics>;
  subscribe(listener: NetworkMetricsListener): () => void;
}

interface NativeDiagnosticsModule {
  getCurrentLinkMetrics: () => Promise<Record<string, unknown>>;
  startObserving?: () => void;
  stopObserving?: () => void;
  beginObserving?: () => void;
  endObserving?: () => void;
  setPollingInterval?: (intervalMs: number) => void;
  beginObserving?: () => void;
  endObserving?: () => void;
  setPollingInterval?: (intervalMs: number) => void;
}

const COLLAPSED_INTERFACE_KEYS = ['interface', 'ssid', 'bssid'];
const EVENT_NAME = 'CollabNetworkDiagnosticsEvent';

function normalizeNumber(value: NullableNumber): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function clamp(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function evaluateQuality({
  rssi,
  noise,
  linkSpeedMbps,
}: {
  rssi?: number;
  noise?: number;
  linkSpeedMbps?: number;
}): NetworkQualityCategory {
  if (typeof rssi === 'number' && rssi > -55 && (linkSpeedMbps ?? 0) > 400) {
    return 'excellent';
  }
  if (typeof rssi === 'number' && rssi > -65 && (linkSpeedMbps ?? 0) > 200) {
    return 'good';
  }
  if (typeof rssi === 'number' && rssi > -80) {
    return 'degraded';
  }
  if (typeof noise === 'number' && noise < -90) {
    return 'degraded';
  }
  return 'unusable';
}

function coerceInterfaceName(raw: Record<string, unknown>): string | undefined {
  for (const key of COLLAPSED_INTERFACE_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeMetrics(raw: Record<string, unknown>): LinkMetrics {
  const rssi = clamp(normalizeNumber(raw.rssi as NullableNumber), -120, -10);
  const noise = clamp(normalizeNumber(raw.noise as NullableNumber), -140, -20);
  const linkSpeedMbps = clamp(
    normalizeNumber(raw.linkSpeedMbps as NullableNumber),
    0,
    10_000,
  );
  const transmitRateMbps = clamp(
    normalizeNumber(raw.transmitRateMbps as NullableNumber),
    0,
    10_000,
  );

  return {
    interfaceName: coerceInterfaceName(raw),
    rssi,
    noise,
    linkSpeedMbps,
    transmitRateMbps,
    timestamp: Date.now(),
    category: evaluateQuality({ rssi, noise, linkSpeedMbps }),
  };
}

class DefaultNetworkDiagnostics implements NetworkDiagnostics {
  private readonly module?: NativeDiagnosticsModule;
  private readonly emitter: NativeEventEmitter | EventEmitter;
  private cachedFallbackMetrics: LinkMetrics | null = null;

  constructor(module?: NativeDiagnosticsModule) {
    this.module = module;
      this.startNativeObservation();
        this.stopNativeObservation();

  private startNativeObservation(): void {
    if (!this.module) {
      return;
    }
    if (typeof this.module.beginObserving === 'function') {
      this.module.beginObserving();
    } else if (typeof this.module.startObserving === 'function') {
      this.module.startObserving();
    }
  }

  private stopNativeObservation(): void {
    if (!this.module) {
      return;
    }
    if (typeof this.module.endObserving === 'function') {
      this.module.endObserving();
    } else if (typeof this.module.stopObserving === 'function') {
      this.module.stopObserving();
    }
  }
        module as unknown as {
          addListener: (eventType: string) => void;
          removeListeners: (count: number) => void;
        },
      );
    } else {
      this.emitter = new EventEmitter();
    }
  }

  async getCurrentLinkMetrics(): Promise<LinkMetrics> {
    if (!this.module) {
      return this.getFallbackMetrics();
    }
    const metrics = await this.module.getCurrentLinkMetrics();
    return normalizeMetrics(metrics);
  }

  subscribe(listener: NetworkMetricsListener): () => void {
    if (!this.module) {
      const metrics = this.getFallbackMetrics();
      listener(metrics);
      return () => {};
    }

    if (this.emitter.listenerCount(EVENT_NAME) === 0) {
      this.startNativeObservation();
    }

    const handler = (payload: Record<string, unknown>) => {
      listener(normalizeMetrics(payload));
    };

    const subscription = (this.emitter as NativeEventEmitter).addListener(
      EVENT_NAME,
      handler,
    );

    return () => {
      subscription.remove();
      if (this.emitter.listenerCount(EVENT_NAME) === 0) {
        this.stopNativeObservation();
      }
    };
  }

  private getFallbackMetrics(): LinkMetrics {
    if (!this.cachedFallbackMetrics) {
      this.cachedFallbackMetrics = {
        timestamp: Date.now(),
        category: 'unusable',
      };
    }
    return this.cachedFallbackMetrics;
  }

  private startNativeObservation(): void {
    if (!this.module) {
      return;
    }
    if (typeof this.module.beginObserving === 'function') {
      this.module.beginObserving();
    } else if (typeof this.module.startObserving === 'function') {
      this.module.startObserving();
    }
  }

  private stopNativeObservation(): void {
    if (!this.module) {
      return;
    }
    if (typeof this.module.endObserving === 'function') {
      this.module.endObserving();
    } else if (typeof this.module.stopObserving === 'function') {
      this.module.stopObserving();
    }
  }
}

export function createNetworkDiagnostics(): NetworkDiagnostics {
  const nativeModule = NativeModules.CollabNetworkDiagnostics as
    | NativeDiagnosticsModule
    | undefined;

  return new DefaultNetworkDiagnostics(nativeModule);
}

export function requiresLocationPermission(): boolean {
  return Platform.OS === 'android';
}
