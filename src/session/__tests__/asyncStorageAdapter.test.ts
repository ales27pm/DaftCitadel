import AsyncStorage from '@react-native-async-storage/async-storage';
import { Session } from '../models';
import { serializeSession } from '../serialization';
import { AsyncStorageSessionStorageAdapter } from '../storage/asyncStorageAdapter.native';
import { RevisionConflictError } from '../storage';

const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'AsyncStorage Test',
  revision: 1,
  tracks: [],
  metadata: {
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    bpm: 120,
    sampleRate: 48000,
    timeSignature: '4/4',
  },
  ...overrides,
});

const asyncStorageMock = AsyncStorage as typeof AsyncStorage & {
  __reset(): void;
};

describe('AsyncStorageSessionStorageAdapter', () => {
  beforeEach(() => {
    asyncStorageMock.__reset();
    jest.restoreAllMocks();
  });

  it('serializes concurrent compare-and-swap writes across adapter instances', async () => {
    const firstAdapter = new AsyncStorageSessionStorageAdapter('concurrent');
    const secondAdapter = new AsyncStorageSessionStorageAdapter('concurrent');
    const first = createSession({ name: 'First writer' });
    const second = createSession({ name: 'Second writer' });

    const results = await Promise.allSettled([
      firstAdapter.write(first, { expectedRevision: 0 }),
      secondAdapter.write(second, { expectedRevision: 0 }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.any(RevisionConflictError),
    });
    expect(['First writer', 'Second writer']).toContain(
      (await firstAdapter.read(first.id))?.name,
    );
  });

  it('restores every record when a multi-record commit fails partway through', async () => {
    const adapter = new AsyncStorageSessionStorageAdapter('partial-commit');
    const first = createSession({ id: 'session-first', name: 'First' });
    const second = createSession({ id: 'session-second', name: 'Second' });
    await adapter.write(first, { expectedRevision: 0 });
    await adapter.write(second, { expectedRevision: 0 });

    const tx = await adapter.beginTransaction();
    await tx.write(
      { ...first, name: 'First staged', revision: 2 },
      { expectedRevision: 1 },
    );
    await tx.write(
      { ...second, name: 'Second staged', revision: 2 },
      { expectedRevision: 1 },
    );

    const realSetItem = AsyncStorage.setItem.bind(AsyncStorage);
    let setCount = 0;
    const setItemSpy = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockImplementation(async (key, value) => {
        setCount += 1;
        if (setCount === 3) {
          throw new Error('Injected AsyncStorage failure');
        }
        await realSetItem(key, value);
      });

    await expect(tx.commit()).rejects.toThrow('Injected AsyncStorage failure');
    setItemSpy.mockRestore();

    expect(await adapter.read(first.id)).toEqual(first);
    expect(await adapter.read(second.id)).toEqual(second);
  });

  it('recovers an interrupted transaction from its durable journal', async () => {
    const directory = 'crash-recovery';
    const adapter = new AsyncStorageSessionStorageAdapter(directory);
    const session = createSession({ id: 'session-interrupted' });
    await adapter.write(session, { expectedRevision: 0 });
    const sessionKey = `session:${encodeURIComponent(directory)}:${session.id}`;
    const journalKey = `session-transaction:${encodeURIComponent(directory)}`;
    const originalRaw = await AsyncStorage.getItem(sessionKey);
    expect(originalRaw).not.toBeNull();
    const interruptedRecord = JSON.parse(originalRaw as string) as {
      payload: string;
      revision: number;
      updatedAt: string;
    };
    interruptedRecord.payload = serializeSession({
      ...session,
      name: 'Interrupted update',
      revision: 2,
    });
    interruptedRecord.revision = 2;
    await AsyncStorage.setItem(
      journalKey,
      JSON.stringify({
        version: 1,
        originals: [[session.id, originalRaw]],
      }),
    );
    await AsyncStorage.setItem(sessionKey, JSON.stringify(interruptedRecord));

    const recovered = await new AsyncStorageSessionStorageAdapter(directory).read(
      session.id,
    );

    expect(recovered).toEqual(session);
    expect(await AsyncStorage.getItem(journalKey)).toBeNull();
  });
});
