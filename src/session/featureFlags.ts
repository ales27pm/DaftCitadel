const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

const readPublicEnvFlag = (name: string): string | undefined => {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
};

export const isJuno106FeatureEnabled = (): boolean => {
  const value = readPublicEnvFlag('EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106');
  return value === undefined || !DISABLED_VALUES.has(value);
};

export const assertJuno106FeatureEnabled = (): void => {
  if (!isJuno106FeatureEnabled()) {
    throw new Error(
      'Juno-106 instrument is disabled by EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106',
    );
  }
};
