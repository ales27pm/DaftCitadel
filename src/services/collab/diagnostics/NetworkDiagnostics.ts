import { EventEmitter } from 'events';
import {
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

import { getAndroidApiLevel } from '../../platform/android';

type NullableNumber = number | null | undefined;

export type NetworkQualityCategory = 'excellent' | 'good' | 'degraded' | 'unusable';

export interface LinkMetrics {
  readonly interfaceName?: string;
  readonly rssi?: number;
  readonly noise?: number;
  /** Normalized Wi-Fi signal reported by iOS (0...1); it is not dBm. */
  readonly signalStrength?: number;
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
}

const COLLAPSED_INTERFACE_KEYS = ['interfaceName', 'interface'];
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
  signalStrength,
}: {
  rssi?: number;
  noise?: number;
  linkSpeedMbps?: number;
  signalStrength?: number;
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
  if (typeof rssi !== 'number' && typeof signalStrength === 'number') {
    if (signalStrength >= 0.75) {
      return 'good';
    }
    if (signalStrength >= 0.35) {
      return 'degraded';
    }
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
  const signalStrength = clamp(
    normalizeNumber(raw.signalStrength as NullableNumber),
    0,
    1,
  );
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
  const timestamp = normalizeNumber(raw.timestamp as NullableNumber) ?? Date.now();

  return {
    interfaceName: coerceInterfaceName(raw),
    rssi,
    noise,
    signalStrength,
    linkSpeedMbps,
    transmitRateMbps,
    timestamp,
    category: evaluateQuality({ rssi, noise, linkSpeedMbps, signalStrength }),
  };
}

const ANDROID_API_LEVEL_NEARBY_WIFI_DEVICES = 33;

const requestAndroidWifiPermission = async (): Promise<void> => {
  if (Platform.OS !== 'android') {
    return;
  }

  const apiLevel = getAndroidApiLevel();
  if (typeof apiLevel === 'number' && apiLevel >= ANDROID_API_LEVEL_NEARBY_WIFI_DEVICES) {
    const permission = PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES;
    if (await PermissionsAndroid.check(permission)) {
      return;
    }
    const result = await PermissionsAndroid.request(permission);
    if (result === PermissionsAndroid.RESULTS.GRANTED) {
      return;
    }
    throw new Error('Nearby Wi-Fi permission was denied');
  }

  const legacyPermissions = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ];
  const existing = await Promise.all(
    legacyPermissions.map((permission) => PermissionsAndroid.check(permission)),
  );
  if (existing.some(Boolean)) {
    return;
  }
  const results = await PermissionsAndroid.requestMultiple(legacyPermissions);
  if (
    legacyPermissions.some(
      (permission) => results[permission] === PermissionsAndroid.RESULTS.GRANTED,
    )
  ) {
    return;
  }
  throw new Error('Location permission for Wi-Fi diagnostics was denied');
};

class DefaultNetworkDiagnostics implements NetworkDiagnostics {
  private readonly module?: NativeDiagnosticsModule;
  private readonly emitter: NativeEventEmitter | EventEmitter;
  private cachedFallbackMetrics: LinkMetrics | null = null;
  private subscriberCount = 0;
  private permissionRequest: Promise<void> | null = null;
  private observationStart: Promise<void> | null = null;
  private observationStarted = false;

  constructor(module?: NativeDiagnosticsModule) {
    this.module = module;

    if (module) {
      this.emitter = new NativeEventEmitter(
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

    await this.ensureNativePermission();
    const metrics = await this.module.getCurrentLinkMetrics();
    return normalizeMetrics(metrics);
  }

  subscribe(listener: NetworkMetricsListener): () => void {
    if (!this.module) {
      const metrics = this.getFallbackMetrics();
      listener(metrics);
      return () => {};
    }

    let active = true;
    const handler = (payload: Record<string, unknown>) => {
      if (active) {
        listener(normalizeMetrics(payload));
      }
    };

    const subscription = (this.emitter as NativeEventEmitter).addListener(
      EVENT_NAME,
      handler,
    );

    this.subscriberCount += 1;
    this.ensureNativeObservationStarted().catch((error) => {
      if (!active) {
        return;
      }
      console.warn('Unable to start Wi-Fi diagnostics observation', error);
      listener(this.getFallbackMetrics());
    });

    return () => {
      if (!active) {
        return;
      }
      active = false;
      subscription.remove();
      this.subscriberCount = Math.max(0, this.subscriberCount - 1);
      if (this.subscriberCount === 0) {
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

  private async startNativeObservation(): Promise<void> {
    if (!this.module) {
      return;
    }
    await this.ensureNativePermission();
    if (this.subscriberCount === 0 || this.observationStarted) {
      return;
    }
    if (typeof this.module.beginObserving === 'function') {
      this.module.beginObserving();
      this.observationStarted = true;
    } else if (typeof this.module.startObserving === 'function') {
      this.module.startObserving();
      this.observationStarted = true;
    }
  }

  private ensureNativeObservationStarted(): Promise<void> {
    if (this.observationStarted) {
      return Promise.resolve();
    }
    if (!this.observationStart) {
      this.observationStart = this.startNativeObservation().finally(() => {
        this.observationStart = null;
      });
    }
    return this.observationStart;
  }

  private ensureNativePermission(): Promise<void> {
    if (!this.permissionRequest) {
      this.permissionRequest = requestAndroidWifiPermission().finally(() => {
        this.permissionRequest = null;
      });
    }
    return this.permissionRequest;
  }

  private stopNativeObservation(): void {
    if (!this.module || !this.observationStarted) {
      return;
    }
    this.observationStarted = false;
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
  if (Platform.OS !== 'android') {
    return false;
  }

  const apiLevel = getAndroidApiLevel();

  if (typeof apiLevel !== 'number') {
    return true;
  }

  return apiLevel < ANDROID_API_LEVEL_NEARBY_WIFI_DEVICES;
}
