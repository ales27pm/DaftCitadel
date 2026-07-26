/* eslint-disable import/no-default-export */
declare module '@react-native-async-storage/async-storage' {
  export type MultiGetResult = Array<[string, string | null]>;

  interface AsyncStorageStatic {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    getAllKeys(): Promise<string[]>;
    multiGet(keys: readonly string[]): Promise<MultiGetResult>;
  }

  const AsyncStorage: AsyncStorageStatic;
  export default AsyncStorage;
}
