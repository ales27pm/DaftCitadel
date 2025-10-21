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
  startObserving: () => void;
  stopObserving: () => void;
}

const COLLAPSED_INTERFACE_KEYS = ['interface', 'ssid', 'bssid'];

function normalizeNumber(value: NullableNumber): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
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
  const rssi = normalizeNumber(raw.rssi as NullableNumber);
  const noise = normalizeNumber(raw.noise as NullableNumber);
  const linkSpeedMbps = normalizeNumber(raw.linkSpeedMbps as NullableNumber);
  const transmitRateMbps = normalizeNumber(raw.transmitRateMbps as NullableNumber);

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

class NativeNetworkDiagnostics implements NetworkDiagnostics {
  private readonly module: NativeDiagnosticsModule;
  private readonly emitter: NativeEventEmitter;
  private activeListeners = 0;

  constructor(module: NativeDiagnosticsModule) {
    this.module = module;
    const emitterModule = module as unknown as {
      addListener: (eventType: string) => void;
      removeListeners: (count: number) => void;
    };
    this.emitter = new NativeEventEmitter(emitterModule);
  }

  async getCurrentLinkMetrics(): Promise<LinkMetrics> {
    const metrics = await this.module.getCurrentLinkMetrics();
    return normalizeMetrics(metrics);
  }

  subscribe(listener: NetworkMetricsListener): () => void {
    if (this.activeListeners === 0) {
      this.module.startObserving();
    }
    this.activeListeners += 1;
    const subscription = this.emitter.addListener(
      'CollabNetworkDiagnosticsEvent',
      (payload: Record<string, unknown>) => {
        listener(normalizeMetrics(payload));
      },
    );
    return () => {
      subscription.remove();
      this.activeListeners = Math.max(0, this.activeListeners - 1);
      if (this.activeListeners === 0) {
        this.module.stopObserving();
      }
    };
  }
}

class NoopNetworkDiagnostics implements NetworkDiagnostics {
  private cached: LinkMetrics | null = null;

  async getCurrentLinkMetrics(): Promise<LinkMetrics> {
    if (!this.cached) {
      this.cached = {
        timestamp: Date.now(),
        category: 'unusable',
      };
    }
    return this.cached;
  }

  subscribe(listener: NetworkMetricsListener): () => void {
    listener({
      timestamp: Date.now(),
      category: 'unusable',
    });
    return () => {};
  }
}

export function createNetworkDiagnostics(): NetworkDiagnostics {
  const nativeModule = NativeModules.CollabNetworkDiagnostics as
    | NativeDiagnosticsModule
    | undefined;

  if (nativeModule) {
    return new NativeNetworkDiagnostics(nativeModule);
  }

  return new NoopNetworkDiagnostics();
}

export function requiresLocationPermission(): boolean {
  return Platform.OS === 'android';
}
