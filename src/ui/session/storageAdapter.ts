import type { SessionStorageAdapter } from '../../session/storage';
import { JsonSessionStorageAdapter } from '../../session/storage/jsonAdapter';

export const createSessionStorageAdapter = (directory: string): SessionStorageAdapter => {
  return new JsonSessionStorageAdapter(directory);
};
