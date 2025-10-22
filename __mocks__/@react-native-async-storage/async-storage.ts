const store = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.has(key) ? store.get(key)! : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  async getAllKeys(): Promise<string[]> {
    return Array.from(store.keys());
  },
  async multiGet(keys: readonly string[]): Promise<Array<[string, string | null]>> {
    return keys.map((key) => [key, store.has(key) ? store.get(key)! : null]);
  },
  async clear(): Promise<void> {
    store.clear();
  },
  __reset(): void {
    store.clear();
  },
};

export default AsyncStorage;
export const __store = store;
