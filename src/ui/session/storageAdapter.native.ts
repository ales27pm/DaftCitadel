import type { SessionStorageAdapter } from '../../session/storage';
import { AsyncStorageSessionStorageAdapter } from '../../session/storage/asyncStorageAdapter.native';

export const createSessionStorageAdapter = (directory: string): SessionStorageAdapter => {
  return new AsyncStorageSessionStorageAdapter(directory);
};
