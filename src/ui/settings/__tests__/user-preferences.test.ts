import { DEFAULT_USER_PREFERENCES, userPreferencesStore } from '../user-preferences';

describe('userPreferencesStore', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    userPreferencesStore.resetForTesting();
  });

  it('uses defaults and persists updates', () => {
    expect(userPreferencesStore.getSnapshot()).toEqual(DEFAULT_USER_PREFERENCES);

    userPreferencesStore.update({ autoPlayScenes: true });

    expect(userPreferencesStore.getSnapshot()).toEqual({
      autoPlayScenes: true,
      showDiagnostics: true,
    });
    userPreferencesStore.resetForTesting();
    expect(userPreferencesStore.getSnapshot().autoPlayScenes).toBe(true);
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
      autoPlayScenes: false,
      showDiagnostics: false,
    });
  });
});
