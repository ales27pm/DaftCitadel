export interface UserPreferences {
  autoPlayScenes: boolean;
  showDiagnostics: boolean;
}

type PreferenceListener = () => void;
type PreferenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const STORAGE_KEY = 'daft-citadel:user-preferences:v1';

export const DEFAULT_USER_PREFERENCES: Readonly<UserPreferences> = {
  autoPlayScenes: false,
  showDiagnostics: true,
};

const listeners = new Set<PreferenceListener>();
const memoryStorage = new Map<string, string>();
let snapshot: UserPreferences | undefined;

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const getPreferenceStorage = (): PreferenceStorage => {
  if (globalThis.localStorage !== undefined) {
    return globalThis.localStorage;
  }
  return {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
  };
};

const readPreferences = (): UserPreferences => {
  try {
    const stored = getPreferenceStorage().getItem(STORAGE_KEY);
    if (!stored) {
      return { ...DEFAULT_USER_PREFERENCES };
    }
    const parsed = JSON.parse(stored) as Partial<UserPreferences>;
    return {
      autoPlayScenes: isBoolean(parsed.autoPlayScenes)
        ? parsed.autoPlayScenes
        : DEFAULT_USER_PREFERENCES.autoPlayScenes,
      showDiagnostics: isBoolean(parsed.showDiagnostics)
        ? parsed.showDiagnostics
        : DEFAULT_USER_PREFERENCES.showDiagnostics,
    };
  } catch (error) {
    console.warn('Failed to load user preferences; using defaults', error);
    return { ...DEFAULT_USER_PREFERENCES };
  }
};

const getSnapshot = (): UserPreferences => {
  snapshot ??= readPreferences();
  return snapshot;
};

const setPreferences = (next: UserPreferences): void => {
  snapshot = next;
  try {
    getPreferenceStorage().setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('Failed to persist user preferences', error);
  }
  listeners.forEach((listener) => listener());
};

export const userPreferencesStore = {
  getSnapshot,
  subscribe(listener: PreferenceListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  update(patch: Partial<UserPreferences>): void {
    setPreferences({ ...getSnapshot(), ...patch });
  },
  resetForTesting(): void {
    snapshot = undefined;
    memoryStorage.clear();
    listeners.clear();
  },
};
