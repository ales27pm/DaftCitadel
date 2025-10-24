import { Platform } from 'react-native';

import { requiresLocationPermission } from '../NetworkDiagnostics';

describe('requiresLocationPermission', () => {
  const originalPlatform = { ...Platform };

  afterEach(() => {
    Platform.OS = originalPlatform.OS;
    Platform.Version = originalPlatform.Version;
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
});
