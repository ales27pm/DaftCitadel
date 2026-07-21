import type { SessionStorageAdapter } from '../../session/storage';
import { LocalStorageSessionStorageAdapter } from '../../session/storage/localStorageAdapter.web';

export const createSessionStorageAdapter = (directory: string): SessionStorageAdapter => {
  return new LocalStorageSessionStorageAdapter(directory);
};
