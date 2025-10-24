import { Platform } from 'react-native';

let cachedAndroidApiLevel: number | undefined;
let hasCachedAndroidApiLevel = false;

function parseAndroidApiLevel(version: typeof Platform.Version): number | undefined {
  if (typeof version === 'number') {
    return Number.isFinite(version) ? version : undefined;
  }

  if (typeof version === 'string') {
    const parsed = Number.parseInt(version, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function getAndroidApiLevel(): number | undefined {
  if (Platform.OS !== 'android') {
    return undefined;
  }

  if (hasCachedAndroidApiLevel) {
    return cachedAndroidApiLevel;
  }

  cachedAndroidApiLevel = parseAndroidApiLevel(Platform.Version);
  hasCachedAndroidApiLevel = true;

  return cachedAndroidApiLevel;
}

export function resetAndroidApiLevelCacheForTesting(): void {
  cachedAndroidApiLevel = undefined;
  hasCachedAndroidApiLevel = false;
}
