export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryStorage = new Map<string, string>();

const fallbackStorage: PreferenceStorage = {
  getItem: (key) => memoryStorage.get(key) ?? null,
  setItem: (key, value) => {
    memoryStorage.set(key, value);
  },
};

export const getPreferenceStorage = (): PreferenceStorage =>
  globalThis.localStorage ?? fallbackStorage;

export const clearPreferenceMemoryStorageForTesting = (): void => {
  memoryStorage.clear();
};
