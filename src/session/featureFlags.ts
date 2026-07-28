import { SessionStorageError } from './storage';

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const DISABLED_VALUES = new Set(['', '0', 'false', 'off', 'no', 'disabled']);

export const readPublicFeatureFlag = (name: string, defaultValue: boolean): boolean => {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }
  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }

  return false;
};

export const isJuno106FeatureEnabled = (): boolean =>
  readPublicFeatureFlag('EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106', true);

export const assertJuno106FeatureEnabled = (): void => {
  if (!isJuno106FeatureEnabled()) {
    throw new SessionStorageError(
      'Juno-106 instrument is disabled by EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106',
    );
  }
};
