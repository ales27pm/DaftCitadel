import { Platform } from 'react-native';

import { getAndroidApiLevel, resetAndroidApiLevelCacheForTesting } from '../android';

describe('getAndroidApiLevel', () => {
  const originalPlatform = { ...Platform };

  afterEach(() => {
    Platform.OS = originalPlatform.OS;
    Platform.Version = originalPlatform.Version;
    resetAndroidApiLevelCacheForTesting();
  });

  it('returns undefined when invoked on non-Android platforms', () => {
    Platform.OS = 'ios';

    expect(getAndroidApiLevel()).toBeUndefined();
  });

  it('returns undefined for non-numeric version strings', () => {
    Platform.OS = 'android';
    Platform.Version = 'unknown';

    expect(getAndroidApiLevel()).toBeUndefined();
  });

  it('caches the parsed API level for subsequent calls', () => {
    Platform.OS = 'android';
    Platform.Version = '34';

    expect(getAndroidApiLevel()).toBe(34);

    Platform.Version = '29';

    expect(getAndroidApiLevel()).toBe(34);
  });
});
