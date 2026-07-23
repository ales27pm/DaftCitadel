import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  JUNO106_PRESET_VERSION,
  listBuiltInJuno106Presets,
  type Juno106PresetRecord,
} from '../juno106Presets';
import {
  Juno106PresetStore,
  MAX_JUNO106_PRESET_INDEX_BYTES,
  MAX_STORED_JUNO106_PRESETS,
  type Juno106PresetStorageBackend,
} from '../junoPresetStorage';
import { computeJuno106RolandChecksum } from '../juno106SysEx';

class MemoryPresetBackend implements Juno106PresetStorageBackend {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const userPreset = (id: string, name = 'User preset'): Juno106PresetRecord => ({
  ...listBuiltInJuno106Presets()[0],
  id,
  name,
  source: { kind: 'user' },
});

const createValidSysEx = (patchNumber: number): number[] => {
  const bytes = new Array<number>(25).fill(0);
  bytes[0] = 0xf0;
  bytes[1] = 0x41;
  bytes[2] = 3;
  bytes[3] = patchNumber;
  bytes[5] = 64;
  bytes[7] = 32;
  bytes[8] = 96;
  bytes[10] = 80;
  bytes[11] = 48;
  bytes[15] = 100;
  bytes[16] = 24;
  bytes[19] = 72;
  bytes[20] = 52;
  bytes[21] = 0x40;
  bytes[22] = 0;
  bytes[23] = computeJuno106RolandChecksum(bytes.slice(5, 23));
  bytes[24] = 0xf7;
  return bytes;
};

const indexKey = (namespace: string): string =>
  `juno106-presets:${encodeURIComponent(namespace)}:index`;

describe('Juno106PresetStore', () => {
  it('validates, saves, loads, lists, updates, and deletes presets', async () => {
    const backend = new MemoryPresetBackend();
    const store = new Juno106PresetStore({ namespace: 'crud', backend });
    const first = userPreset('user-one');
    const second = userPreset('user-two', 'Second preset');

    const saved = await store.save(first);
    saved.name = 'Mutated return value';
    await store.save(second);
    await store.save({ ...first, name: 'Updated preset' });

    expect(await store.load('user-one')).toMatchObject({
      id: 'user-one',
      name: 'Updated preset',
      version: JUNO106_PRESET_VERSION,
    });
    expect((await store.list()).map(({ id }) => id)).toEqual(['user-one', 'user-two']);
    expect(await store.delete('user-one')).toBe(true);
    expect(await store.delete('user-one')).toBe(false);
    expect(await store.load('user-one')).toBeNull();
    expect((await store.list()).map(({ id }) => id)).toEqual(['user-two']);
  });

  it('imports a bounded SysEx bank into validated local records', async () => {
    const backend = new MemoryPresetBackend();
    const store = new Juno106PresetStore({ namespace: 'import', backend });

    const imported = await store.importSysEx([
      ...createValidSysEx(0),
      ...createValidSysEx(127),
    ]);

    expect(imported.map(({ id }) => id)).toEqual([
      'juno106-import-001-001',
      'juno106-import-128-002',
    ]);
    expect(imported.map(({ name }) => name)).toEqual([
      'Imported Juno-106 001',
      'Imported Juno-106 128',
    ]);
    expect(imported.every(({ rawSysEx }) => rawSysEx?.length === 25)).toBe(true);
    expect(await store.list()).toEqual(imported);

    const beforeInvalidImport = await store.list();
    const invalid = createValidSysEx(1);
    invalid[23] = (invalid[23] + 1) % 128;
    await expect(store.importSysEx(invalid)).rejects.toMatchObject({
      code: 'checksum',
    });
    expect(await store.list()).toEqual(beforeInvalidImport);
  });

  it('rejects invalid ids, records, index counts, and stored blobs', async () => {
    const backend = new MemoryPresetBackend();
    const namespace = 'bounds';
    const store = new Juno106PresetStore({ namespace, backend });

    await expect(store.load('../escape')).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(
      store.save({
        ...userPreset('invalid-parameter'),
        parameters: {
          ...userPreset('ignored').parameters,
          lfoRateHz: 21,
        },
      }),
    ).rejects.toMatchObject({ code: 'validation' });

    backend.values.set(
      indexKey(namespace),
      JSON.stringify({
        version: 1,
        ids: Array.from(
          { length: MAX_STORED_JUNO106_PRESETS + 1 },
          (_unused, index) => `preset-${index}`,
        ),
      }),
    );
    await expect(store.list()).rejects.toMatchObject({ code: 'bounds' });

    backend.values.set(
      indexKey(namespace),
      'x'.repeat(MAX_JUNO106_PRESET_INDEX_BYTES + 1),
    );
    await expect(store.list()).rejects.toMatchObject({ code: 'bounds' });
  });

  it('rejects an oversized or mismatched persisted preset before returning it', async () => {
    const backend = new MemoryPresetBackend();
    const namespace = 'corruption';
    const store = new Juno106PresetStore({ namespace, backend });
    await store.save(userPreset('stored-id'));
    const presetKey = Array.from(backend.values.keys()).find((key) =>
      key.endsWith('preset:stored-id'),
    );
    expect(presetKey).toBeDefined();

    backend.values.set(presetKey!, 'x'.repeat(4097));
    await expect(store.load('stored-id')).rejects.toMatchObject({
      code: 'bounds',
    });

    backend.values.set(presetKey!, JSON.stringify(userPreset('different-id')));
    await expect(store.load('stored-id')).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('uses AsyncStorage by default while allowing backend injection', async () => {
    await AsyncStorage.clear();
    const first = new Juno106PresetStore({ namespace: 'async-default' });
    const second = new Juno106PresetStore({ namespace: 'async-default' });

    await first.save(userPreset('persisted'));

    expect(await second.load('persisted')).toEqual(userPreset('persisted'));
  });

  it('rejects unsafe storage namespaces', () => {
    expect(() => new Juno106PresetStore({ namespace: '../presets' })).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
    expect(() => new Juno106PresetStore({ namespace: 'x'.repeat(65) })).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
  });
});
