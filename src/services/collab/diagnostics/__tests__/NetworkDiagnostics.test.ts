import {
  NativeModules,
  PermissionsAndroid,
  Platform,
  type PermissionStatus,
} from 'react-native';

import {
  createNetworkDiagnostics,
  requiresLocationPermission,
} from '../NetworkDiagnostics';
import { resetAndroidApiLevelCacheForTesting } from '../../../platform/android';

const flushAsyncWork = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('requiresLocationPermission', () => {
  const originalPlatform = { ...Platform };

  afterEach(() => {
    jest.restoreAllMocks();
    Platform.OS = originalPlatform.OS;
    Platform.Version = originalPlatform.Version;
    resetAndroidApiLevelCacheForTesting();
  });

  it('returns false for non-Android platforms', () => {
    Platform.OS = 'ios';
    expect(requiresLocationPermission()).toBe(false);
  });

  it('returns true for Android API levels below 33', () => {
    Platform.OS = 'android';
    Platform.Version = 32;

    expect(requiresLocationPermission()).toBe(true);
  });

  it('returns false for Android API level 33 and above', () => {
    Platform.OS = 'android';
    Platform.Version = 33;

    expect(requiresLocationPermission()).toBe(false);
  });

  it('falls back to requesting location permission when API level is unknown', () => {
    Platform.OS = 'android';
    Platform.Version = Number.NaN;

    expect(requiresLocationPermission()).toBe(true);
  });

  it('falls back to requesting location permission when Platform.Version is non-numeric', () => {
    Platform.OS = 'android';
    Platform.Version = 'unknown';

    expect(requiresLocationPermission()).toBe(true);
  });

  it('requests Nearby Wi-Fi Devices before collecting Android 13+ metrics', async () => {
    Platform.OS = 'android';
    Platform.Version = 33;
    const checkSpy = jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    const requestSpy = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);

    await createNetworkDiagnostics().getCurrentLinkMetrics();

    expect(checkSpy).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
    );
    expect(requestSpy).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
    );
  });

  it('rejects collection when Android Wi-Fi permission is denied', async () => {
    Platform.OS = 'android';
    Platform.Version = 34;
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
    const nativeModule = NativeModules.CollabNetworkDiagnostics as {
      getCurrentLinkMetrics(): Promise<Record<string, unknown>>;
    };
    const nativeMetricsSpy = jest.spyOn(nativeModule, 'getCurrentLinkMetrics');

    await expect(createNetworkDiagnostics().getCurrentLinkMetrics()).rejects.toThrow(
      'Nearby Wi-Fi permission was denied',
    );
    expect(nativeMetricsSpy).not.toHaveBeenCalled();
  });

  it('does not notify an unsubscribed listener after a pending permission denial', async () => {
    Platform.OS = 'android';
    Platform.Version = 33;
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    let resolvePermission!: (result: PermissionStatus) => void;
    jest.spyOn(PermissionsAndroid, 'request').mockReturnValue(
      new Promise<PermissionStatus>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    const listener = jest.fn();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const unsubscribe = createNetworkDiagnostics().subscribe(listener);
    await flushAsyncWork();
    unsubscribe();
    resolvePermission(PermissionsAndroid.RESULTS.DENIED);
    await flushAsyncWork();

    expect(listener).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('notifies only active subscribers when their shared permission request fails', async () => {
    Platform.OS = 'android';
    Platform.Version = 33;
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    let resolvePermission!: (result: PermissionStatus) => void;
    jest.spyOn(PermissionsAndroid, 'request').mockReturnValue(
      new Promise<PermissionStatus>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const firstListener = jest.fn();
    const secondListener = jest.fn();
    const diagnostics = createNetworkDiagnostics();

    const unsubscribeFirst = diagnostics.subscribe(firstListener);
    const unsubscribeSecond = diagnostics.subscribe(secondListener);
    await flushAsyncWork();
    unsubscribeFirst();
    resolvePermission(PermissionsAndroid.RESULTS.DENIED);
    await flushAsyncWork();

    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'unusable' }),
    );
    unsubscribeSecond();
  });

  it('starts native observation once for concurrent subscribers', async () => {
    Platform.OS = 'android';
    Platform.Version = 33;
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    const nativeModule = NativeModules.CollabNetworkDiagnostics as {
      beginObserving(): void;
    };
    const beginSpy = jest.spyOn(nativeModule, 'beginObserving');
    const diagnostics = createNetworkDiagnostics();

    const unsubscribeFirst = diagnostics.subscribe(jest.fn());
    const unsubscribeSecond = diagnostics.subscribe(jest.fn());
    await flushAsyncWork();

    expect(beginSpy).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('requests legacy location permissions on Android 12 and below', async () => {
    Platform.OS = 'android';
    Platform.Version = 32;
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    const requestSpy = jest
      .spyOn(PermissionsAndroid, 'requestMultiple')
      .mockResolvedValue({
        [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]:
          PermissionsAndroid.RESULTS.GRANTED,
        [PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION]:
          PermissionsAndroid.RESULTS.GRANTED,
      } as unknown as Awaited<ReturnType<typeof PermissionsAndroid.requestMultiple>>);

    await createNetworkDiagnostics().getCurrentLinkMetrics();

    expect(requestSpy).toHaveBeenCalledWith([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);
  });

  it('classifies normalized iOS signal strength without treating it as dBm', async () => {
    Platform.OS = 'ios';
    const nativeModule = NativeModules.CollabNetworkDiagnostics as {
      getCurrentLinkMetrics(): Promise<Record<string, unknown>>;
    };
    jest.spyOn(nativeModule, 'getCurrentLinkMetrics').mockResolvedValue({
      interface: 'en0',
      signalStrength: 0.82,
      timestamp: 123,
    });

    const metrics = await createNetworkDiagnostics().getCurrentLinkMetrics();

    expect(metrics).toMatchObject({
      interfaceName: 'en0',
      signalStrength: 0.82,
      category: 'good',
    });
    expect(metrics.rssi).toBeUndefined();
  });
});
