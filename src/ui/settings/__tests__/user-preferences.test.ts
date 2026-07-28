import { DEFAULT_USER_PREFERENCES, userPreferencesStore } from '../user-preferences';

describe('userPreferencesStore', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    userPreferencesStore.resetForTesting();
  });

  it('uses defaults and persists updates', () => {
    expect(userPreferencesStore.getSnapshot()).toEqual(DEFAULT_USER_PREFERENCES);

    userPreferencesStore.update({ autoPlayScenes: true });

    expect(userPreferencesStore.getSnapshot()).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      autoPlayScenes: true,
    });
    expect(globalThis.localStorage.getItem('daft-citadel:user-preferences:v1')).toBe(
      JSON.stringify({ ...DEFAULT_USER_PREFERENCES, autoPlayScenes: true }),
    );

    // Dropping the in-module snapshot mirrors a reload without erasing storage.
    userPreferencesStore.resetForTesting();
    expect(userPreferencesStore.getSnapshot()).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      autoPlayScenes: true,
    });
  });

  it('notifies subscribers after updates', () => {
    const listener = jest.fn();
    const unsubscribe = userPreferencesStore.subscribe(listener);

    userPreferencesStore.update({ showDiagnostics: false });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    userPreferencesStore.update({ showDiagnostics: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('repairs malformed stored preferences', () => {
    globalThis.localStorage.setItem(
      'daft-citadel:user-preferences:v1',
      JSON.stringify({ autoPlayScenes: 'yes', showDiagnostics: false }),
    );

    expect(userPreferencesStore.getSnapshot()).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      autoPlayScenes: false,
      showDiagnostics: false,
    });
  });

  it('persists valid appearance choices and repairs unknown values', () => {
    userPreferencesStore.update({
      accentPalette: 'magenta',
      glowIntensity: 'vivid',
      interfaceDensity: 'compact',
      studioSurface: 'spectral',
    });
    userPreferencesStore.resetForTesting();

    expect(userPreferencesStore.getSnapshot()).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      accentPalette: 'magenta',
      glowIntensity: 'vivid',
      interfaceDensity: 'compact',
      studioSurface: 'spectral',
    });

    globalThis.localStorage.setItem(
      'daft-citadel:user-preferences:v1',
      JSON.stringify({
        ...DEFAULT_USER_PREFERENCES,
        accentPalette: 'ultraviolet',
        glowIntensity: 'maximum',
        interfaceDensity: 'tiny',
        studioSurface: 'glass',
      }),
    );
    userPreferencesStore.resetForTesting();
    expect(userPreferencesStore.getSnapshot()).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('uses deterministic defaults when persistent storage cannot be read', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        ...storage,
        getItem: () => {
          throw new Error('storage unavailable');
        },
      },
    });
    userPreferencesStore.resetForTesting();

    expect(userPreferencesStore.getSnapshot()).toEqual(DEFAULT_USER_PREFERENCES);
    expect(warning).toHaveBeenCalledWith(
      'Failed to load user preferences; using defaults',
      expect.any(Error),
    );

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    warning.mockRestore();
  });
});
