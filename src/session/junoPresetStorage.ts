import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';

import {
  cloneJuno106Preset,
  deserializeJuno106Preset,
  mapJuno106SysExPatchToPreset,
  MAX_JUNO106_PRESET_ID_LENGTH,
  MAX_JUNO106_PRESET_SERIALIZED_BYTES,
  serializeJuno106Preset,
  type Juno106PresetRecord,
} from './juno106Presets';
import { parseJuno106SysExBank, type Juno106SysExInput } from './juno106SysEx';
import { AsyncMutex } from './util';

export const MAX_STORED_JUNO106_PRESETS = 128;
export const MAX_JUNO106_PRESET_INDEX_BYTES = 16 * 1024;
export const MAX_JUNO106_PRESET_NAMESPACE_LENGTH = 64;

const STORAGE_VERSION = 1 as const;
const STORAGE_PREFIX = 'juno106-presets';
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface StoredPresetIndex {
  version: typeof STORAGE_VERSION;
  ids: string[];
}

export interface Juno106PresetStorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface Juno106PresetStorage {
  save(preset: Juno106PresetRecord): Promise<Juno106PresetRecord>;
  load(id: string): Promise<Juno106PresetRecord | null>;
  list(): Promise<Juno106PresetRecord[]>;
  delete(id: string): Promise<boolean>;
  importSysEx(input: Juno106SysExInput): Promise<Juno106PresetRecord[]>;
}

export type Juno106PresetStorageErrorCode = 'bounds' | 'storage' | 'validation';

export class Juno106PresetStorageError extends Error {
  constructor(
    message: string,
    public readonly code: Juno106PresetStorageErrorCode,
  ) {
    super(message);
    this.name = 'Juno106PresetStorageError';
  }
}

export interface Juno106PresetStoreOptions {
  namespace?: string;
  backend?: Juno106PresetStorageBackend;
}

const namespaceMutexes = new Map<string, AsyncMutex>();

const mutexForPrefix = (prefix: string): AsyncMutex => {
  const existing = namespaceMutexes.get(prefix);
  if (existing) {
    return existing;
  }
  const mutex = new AsyncMutex();
  namespaceMutexes.set(prefix, mutex);
  return mutex;
};

const storageError = (message: string, error: unknown): Juno106PresetStorageError =>
  new Juno106PresetStorageError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    error instanceof Juno106PresetStorageError ? error.code : 'storage',
  );

const validateNamespace = (namespace: string): void => {
  if (
    namespace.length === 0 ||
    namespace.length > MAX_JUNO106_PRESET_NAMESPACE_LENGTH ||
    !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw new Juno106PresetStorageError(
      `Juno-106 preset namespace must match ${NAMESPACE_PATTERN.source} and contain at most ${MAX_JUNO106_PRESET_NAMESPACE_LENGTH} characters`,
      'validation',
    );
  }
};

const validateStoredId = (id: unknown): string => {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_JUNO106_PRESET_ID_LENGTH ||
    !NAMESPACE_PATTERN.test(id)
  ) {
    throw new Juno106PresetStorageError(
      'Stored Juno-106 preset index contains an invalid id',
      'validation',
    );
  }
  return id;
};

const parseStoredIndex = (raw: string | null): string[] => {
  if (raw === null) {
    return [];
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_JUNO106_PRESET_INDEX_BYTES) {
    throw new Juno106PresetStorageError(
      `Stored Juno-106 preset index exceeds the ${MAX_JUNO106_PRESET_INDEX_BYTES}-byte limit`,
      'bounds',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Juno106PresetStorageError(
      `Stored Juno-106 preset index is invalid JSON: ${(error as Error).message}`,
      'validation',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Juno106PresetStorageError(
      'Stored Juno-106 preset index has an invalid shape',
      'validation',
    );
  }
  const index = parsed as Partial<StoredPresetIndex>;
  if (
    index.version !== STORAGE_VERSION ||
    !Array.isArray(index.ids) ||
    Object.keys(index).length !== 2 ||
    !Object.keys(index).every((key) => ['version', 'ids'].includes(key))
  ) {
    throw new Juno106PresetStorageError(
      'Stored Juno-106 preset index has an unsupported version or shape',
      'validation',
    );
  }
  if (index.ids.length > MAX_STORED_JUNO106_PRESETS) {
    throw new Juno106PresetStorageError(
      `Stored Juno-106 preset index exceeds the ${MAX_STORED_JUNO106_PRESETS}-preset limit`,
      'bounds',
    );
  }

  const ids = index.ids.map(validateStoredId);
  if (new Set(ids).size !== ids.length) {
    throw new Juno106PresetStorageError(
      'Stored Juno-106 preset index contains duplicate ids',
      'validation',
    );
  }
  return ids;
};

const serializeStoredIndex = (ids: ReadonlyArray<string>): string => {
  if (ids.length > MAX_STORED_JUNO106_PRESETS) {
    throw new Juno106PresetStorageError(
      `At most ${MAX_STORED_JUNO106_PRESETS} Juno-106 presets may be stored`,
      'bounds',
    );
  }
  ids.forEach(validateStoredId);
  const serialized = JSON.stringify({ version: STORAGE_VERSION, ids });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JUNO106_PRESET_INDEX_BYTES) {
    throw new Juno106PresetStorageError(
      `Juno-106 preset index exceeds the ${MAX_JUNO106_PRESET_INDEX_BYTES}-byte limit`,
      'bounds',
    );
  }
  return serialized;
};

export class Juno106PresetStore implements Juno106PresetStorage {
  private readonly backend: Juno106PresetStorageBackend;
  private readonly indexKey: string;
  private readonly mutex: AsyncMutex;
  private readonly prefix: string;

  constructor(options: Juno106PresetStoreOptions = {}) {
    const namespace = options.namespace ?? 'default';
    validateNamespace(namespace);
    this.backend = options.backend ?? AsyncStorage;
    this.prefix = `${STORAGE_PREFIX}:${encodeURIComponent(namespace)}:`;
    this.indexKey = `${this.prefix}index`;
    this.mutex = mutexForPrefix(this.prefix);
  }

  async save(preset: Juno106PresetRecord): Promise<Juno106PresetRecord> {
    const serialized = serializeJuno106Preset(preset);
    return this.runExclusive(async () => {
      const ids = await this.readIndex();
      const isExisting = ids.includes(preset.id);
      if (!isExisting && ids.length >= MAX_STORED_JUNO106_PRESETS) {
        throw new Juno106PresetStorageError(
          `At most ${MAX_STORED_JUNO106_PRESETS} Juno-106 presets may be stored`,
          'bounds',
        );
      }

      const presetKey = this.keyForPreset(preset.id);
      const original = await this.getItem(presetKey, 'read preset before saving');
      try {
        await this.setItem(presetKey, serialized, 'save preset');
        if (!isExisting) {
          await this.setItem(
            this.indexKey,
            serializeStoredIndex([...ids, preset.id]),
            'update preset index',
          );
        }
      } catch (error) {
        await this.restoreItem(presetKey, original, error);
        throw storageError('Failed to save Juno-106 preset', error);
      }
      return deserializeJuno106Preset(serialized);
    });
  }

  async load(id: string): Promise<Juno106PresetRecord | null> {
    validateStoredId(id);
    return this.runExclusive(async () => {
      const ids = await this.readIndex();
      if (!ids.includes(id)) {
        return null;
      }
      return this.readPreset(id);
    });
  }

  async list(): Promise<Juno106PresetRecord[]> {
    return this.runExclusive(async () => {
      const ids = await this.readIndex();
      const presets: Juno106PresetRecord[] = [];
      for (const id of ids) {
        presets.push(await this.readPreset(id));
      }
      return presets;
    });
  }

  async delete(id: string): Promise<boolean> {
    validateStoredId(id);
    return this.runExclusive(async () => {
      const ids = await this.readIndex();
      if (!ids.includes(id)) {
        return false;
      }
      const presetKey = this.keyForPreset(id);
      const originalPreset = await this.getItem(presetKey, 'read preset before deleting');
      if (originalPreset === null) {
        throw new Juno106PresetStorageError(
          `Stored Juno-106 preset ${id} is missing`,
          'validation',
        );
      }
      const originalIndex = serializeStoredIndex(ids);
      try {
        await this.setItem(
          this.indexKey,
          serializeStoredIndex(ids.filter((storedId) => storedId !== id)),
          'update preset index',
        );
        await this.removeItem(presetKey, 'delete preset');
      } catch (error) {
        const rollbackErrors = await Promise.allSettled([
          this.backend.setItem(this.indexKey, originalIndex),
          this.backend.setItem(presetKey, originalPreset),
        ]);
        const rollbackFailure = rollbackErrors.find(
          (result) => result.status === 'rejected',
        );
        if (rollbackFailure?.status === 'rejected') {
          throw storageError(
            `Failed to delete Juno-106 preset and roll back (${String(
              rollbackFailure.reason,
            )})`,
            error,
          );
        }
        throw storageError('Failed to delete Juno-106 preset', error);
      }
      return true;
    });
  }

  async importSysEx(input: Juno106SysExInput): Promise<Juno106PresetRecord[]> {
    const patches = parseJuno106SysExBank(input);
    const presets = patches.map((patch, index) => {
      const patchLabel = String(patch.sourcePatchNumber + 1).padStart(3, '0');
      const bankLabel = String(index + 1).padStart(3, '0');
      return mapJuno106SysExPatchToPreset(patch, {
        id: `juno106-import-${patchLabel}-${bankLabel}`,
        name: `Imported Juno-106 ${patchLabel}`,
      });
    });
    const serializedPresets = presets.map((preset) => ({
      preset,
      serialized: serializeJuno106Preset(preset),
    }));

    return this.runExclusive(async () => {
      const ids = await this.readIndex();
      const importedIds = presets.map((preset) => preset.id);
      const mergedIds = [...ids, ...importedIds.filter((id) => !ids.includes(id))];
      if (mergedIds.length > MAX_STORED_JUNO106_PRESETS) {
        throw new Juno106PresetStorageError(
          `Import would exceed the ${MAX_STORED_JUNO106_PRESETS}-preset storage limit`,
          'bounds',
        );
      }

      const originals = new Map<string, string | null>();
      for (const { preset } of serializedPresets) {
        originals.set(
          preset.id,
          await this.getItem(this.keyForPreset(preset.id), 'read preset before import'),
        );
      }
      const originalIndex = serializeStoredIndex(ids);

      try {
        for (const { preset, serialized } of serializedPresets) {
          await this.setItem(this.keyForPreset(preset.id), serialized, 'import preset');
        }
        await this.setItem(
          this.indexKey,
          serializeStoredIndex(mergedIds),
          'update preset index',
        );
      } catch (error) {
        const rollbackOperations = Array.from(originals, ([id, original]) =>
          original === null
            ? this.backend.removeItem(this.keyForPreset(id))
            : this.backend.setItem(this.keyForPreset(id), original),
        );
        rollbackOperations.push(this.backend.setItem(this.indexKey, originalIndex));
        const rollbackResults = await Promise.allSettled(rollbackOperations);
        const rollbackFailure = rollbackResults.find(
          (result) => result.status === 'rejected',
        );
        if (rollbackFailure?.status === 'rejected') {
          throw storageError(
            `Failed to import Juno-106 presets and roll back (${String(
              rollbackFailure.reason,
            )})`,
            error,
          );
        }
        throw storageError('Failed to import Juno-106 presets', error);
      }
      return presets.map(cloneJuno106Preset);
    });
  }

  private keyForPreset(id: string): string {
    validateStoredId(id);
    return `${this.prefix}preset:${id}`;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.mutex.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readIndex(): Promise<string[]> {
    const raw = await this.getItem(this.indexKey, 'read preset index');
    return parseStoredIndex(raw);
  }

  private async readPreset(id: string): Promise<Juno106PresetRecord> {
    const raw = await this.getItem(this.keyForPreset(id), 'read preset');
    if (raw === null) {
      throw new Juno106PresetStorageError(
        `Stored Juno-106 preset ${id} is missing`,
        'validation',
      );
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_JUNO106_PRESET_SERIALIZED_BYTES) {
      throw new Juno106PresetStorageError(
        `Stored Juno-106 preset ${id} exceeds the ${MAX_JUNO106_PRESET_SERIALIZED_BYTES}-byte limit`,
        'bounds',
      );
    }
    const preset = deserializeJuno106Preset(raw);
    if (preset.id !== id) {
      throw new Juno106PresetStorageError(
        `Stored Juno-106 preset key ${id} does not match payload id ${preset.id}`,
        'validation',
      );
    }
    return preset;
  }

  private async getItem(key: string, action: string): Promise<string | null> {
    try {
      return await this.backend.getItem(key);
    } catch (error) {
      throw storageError(`Failed to ${action}`, error);
    }
  }

  private async setItem(key: string, value: string, action: string): Promise<void> {
    try {
      await this.backend.setItem(key, value);
    } catch (error) {
      throw storageError(`Failed to ${action}`, error);
    }
  }

  private async removeItem(key: string, action: string): Promise<void> {
    try {
      await this.backend.removeItem(key);
    } catch (error) {
      throw storageError(`Failed to ${action}`, error);
    }
  }

  private async restoreItem(
    key: string,
    original: string | null,
    originalError: unknown,
  ): Promise<void> {
    try {
      if (original === null) {
        await this.backend.removeItem(key);
      } else {
        await this.backend.setItem(key, original);
      }
    } catch (rollbackError) {
      throw storageError(
        `Storage operation failed (${String(
          originalError,
        )}) and rollback failed (${String(rollbackError)})`,
        rollbackError,
      );
    }
  }
}
