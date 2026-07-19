import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
  AutomationCurve,
  Clip,
  Session,
  Track,
  createDefaultTrackRoutingGraph,
} from '../models';
import { deserializeSession, mergeSessions, serializeSession } from '../serialization';
import { JsonSessionStorageAdapter } from '../storage/jsonAdapter';
import { RevisionConflictError, SessionStorageAdapter } from '../storage';
import { SQLiteConnection, SQLiteSessionStorageAdapter } from '../storage/sqliteAdapter';
import { SessionManager, AudioEngineBridge } from '../sessionManager';
import { CloudSyncProvider, NoopCloudSyncProvider } from '../cloud';

const createTestClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  name: 'Bass Intro',
  start: 0,
  duration: 4000,
  audioFile: 'bass-intro.wav',
  gain: 1,
  fadeIn: 50,
  fadeOut: 50,
  automationCurveIds: ['curve-1'],
  ...overrides,
});

const createAutomationCurve = (
  overrides: Partial<AutomationCurve> = {},
): AutomationCurve => ({
  id: 'curve-1',
  parameter: 'volume',
  interpolation: 'linear',
  points: [
    { time: 0, value: 0.8 },
    { time: 2000, value: 0.9 },
  ],
  ...overrides,
});

const createTestTrack = (overrides: Partial<Track> = {}): Track => {
  const trackId = overrides.id ?? 'track-1';
  const baseRouting = {
    input: 'line-1',
    output: 'bus-master',
    sends: { 'reverb-send': -6 },
    graph: createDefaultTrackRoutingGraph(trackId),
  };
  const overrideRouting = overrides.routing;
  const routing = overrideRouting
    ? {
        ...baseRouting,
        ...overrideRouting,
        graph: overrideRouting.graph ?? baseRouting.graph,
      }
    : baseRouting;
  const track: Track = {
    id: trackId,
    name: 'Bass',
    clips: [createTestClip()],
    muted: false,
    solo: false,
    volume: -3,
    pan: 0,
    automationCurves: [createAutomationCurve()],
    routing,
    ...overrides,
  };
  return track;
};

const createTestSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-test',
  name: 'Test Session',
  revision: 1,
  tracks: [createTestTrack()],
  metadata: {
    version: 1,
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    sampleRate: 48000,
    bpm: 120,
    timeSignature: '4/4',
  },
  ...overrides,
});

class InMemorySQLiteConnection implements SQLiteConnection {
  private store = new Map<
    string,
    { payload: string; revision: number; updatedAt: string }
  >();
  private snapshot: Map<
    string,
    { payload: string; revision: number; updatedAt: string }
  > | null = null;

  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith('CREATE TABLE')) {
      return;
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      const [id, payload, revision, updatedAt] = params as [
        string,
        string,
        number,
        string,
      ];
      this.store.set(id, { payload, revision, updatedAt });
      return;
    }
    if (sql.startsWith('UPDATE sessions')) {
      const [payload, revision, updatedAt, id] = params as [
        string,
        number,
        string,
        string,
      ];
      const existing = this.store.get(id);
      if (!existing) {
        throw new Error('Row not found');
      }
      this.store.set(id, { payload, revision, updatedAt });
      return;
    }
    if (sql.startsWith('DELETE FROM sessions')) {
      const [id] = params as [string];
      this.store.delete(id);
      return;
    }
    throw new Error(`Unsupported SQL: ${sql}`);
  }

  async get<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    if (sql.startsWith('SELECT revision')) {
      const [id] = params as [string];
      const row = this.store.get(id);
      return (row ? { revision: row.revision } : null) as T | null;
    }
    if (sql.startsWith('SELECT payload')) {
      const [id] = params as [string];
      const row = this.store.get(id);
      return (row ? { payload: row.payload } : null) as T | null;
    }
    throw new Error(`Unsupported SQL: ${sql}`);
  }

  async all<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    if (!sql.startsWith('SELECT payload, updated_at')) {
      throw new Error(`Unsupported SQL: ${sql}`);
    }
    return Array.from(this.store.values()).map(
      (row) =>
        ({
          payload: row.payload,
          updated_at: row.updatedAt,
        }) as unknown as T,
    );
  }

  async beginTransaction(): Promise<void> {
    this.snapshot = new Map(this.store);
  }

  async commit(): Promise<void> {
    this.snapshot = null;
  }

  async rollback(): Promise<void> {
    if (this.snapshot) {
      this.store = new Map(this.snapshot);
    }
    this.snapshot = null;
  }
}

class MockAudioEngine implements AudioEngineBridge {
  public updates: Session[] = [];
  public resets = 0;
  private nextFailure: Error | null = null;
  private nextResetFailure: Error | null = null;

  failNextUpdate(error = new Error('Audio update failed')): void {
    this.nextFailure = error;
  }

  failNextReset(error = new Error('Audio reset failed')): void {
    this.nextResetFailure = error;
  }

  async applySessionUpdate(session: Session): Promise<void> {
    this.updates.push(JSON.parse(JSON.stringify(session)));
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = null;
      throw error;
    }
  }

  async resetSession(): Promise<void> {
    this.resets += 1;
    if (this.nextResetFailure) {
      const error = this.nextResetFailure;
      this.nextResetFailure = null;
      throw error;
    }
  }
}

class RevisionProtectedAudioEngine implements AudioEngineBridge {
  public currentSession: Session | null = null;
  public resets = 0;

  async applySessionUpdate(session: Session): Promise<void> {
    if (this.currentSession && session.revision < this.currentSession.revision) {
      throw new Error('Session revision regressed; refusing to apply update');
    }
    this.currentSession = JSON.parse(JSON.stringify(session)) as Session;
  }

  async resetSession(): Promise<void> {
    this.resets += 1;
    this.currentSession = null;
  }
}

class RecordingCloudProvider extends NoopCloudSyncProvider {
  public pushed: Session[] = [];
  private remote: Session | null = null;

  constructor(private conflictResolver?: CloudSyncProvider['resolveConflict']) {
    super();
  }

  setRemote(session: Session | null) {
    this.remote = session;
  }

  override async pull(_sessionId: string): Promise<{ session: Session | null }> {
    return { session: this.remote };
  }

  override async push(session: Session): Promise<void> {
    this.pushed.push(JSON.parse(JSON.stringify(session)));
    this.remote = session;
  }

  override async resolveConflict(params: {
    local: Session;
    remote: Session;
    base: Session;
  }): Promise<Session> {
    if (this.conflictResolver) {
      return this.conflictResolver(params);
    }
    return mergeSessions(params.base, params.local, params.remote);
  }
}

describe('Session serialization', () => {
  it('round-trips sessions through JSON serialization', () => {
    const session = createTestSession();
    const payload = serializeSession(session);
    const restored = deserializeSession(payload);
    expect(restored).toEqual(session);
  });
});

describe('JsonSessionStorageAdapter', () => {
  let tempDir: string;
  let adapter: JsonSessionStorageAdapter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-json-'));
    adapter = new JsonSessionStorageAdapter(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('persists and loads sessions', async () => {
    const session = createTestSession();
    await adapter.write(session);
    const loaded = await adapter.read(session.id);
    expect(loaded).toEqual(session);

    const records = await adapter.list();
    expect(records).toHaveLength(1);
    expect(records[0].session).toEqual(session);
  });

  it('throws on revision conflicts', async () => {
    const session = createTestSession();
    await adapter.write(session, { expectedRevision: 0 });

    await expect(
      adapter.write(
        { ...session, revision: session.revision + 1 },
        { expectedRevision: session.revision + 5 },
      ),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('retains staged expected revisions across multiple writes', async () => {
    const session = createTestSession();
    await adapter.write(session, { expectedRevision: 0 });

    const tx = await adapter.beginTransaction();
    const firstUpdate = { ...session, name: 'First', revision: session.revision + 1 };
    await tx.write(firstUpdate, { expectedRevision: session.revision });
    const secondUpdate = {
      ...firstUpdate,
      name: 'Second',
      revision: firstUpdate.revision + 1,
    };
    await tx.write(secondUpdate);

    await adapter.write(
      { ...session, name: 'External', revision: session.revision + 1 },
      { expectedRevision: session.revision },
    );

    await expect(tx.commit()).rejects.toBeInstanceOf(RevisionConflictError);
    await tx.rollback().catch(() => undefined);
  });

  it('serializes concurrent compare-and-swap writes across adapter instances', async () => {
    const firstAdapter = new JsonSessionStorageAdapter(tempDir);
    const secondAdapter = new JsonSessionStorageAdapter(tempDir);
    const first = createTestSession({ name: 'First writer', revision: 1 });
    const second = createTestSession({ name: 'Second writer', revision: 1 });

    const results = await Promise.allSettled([
      firstAdapter.write(first, { expectedRevision: 0 }),
      secondAdapter.write(second, { expectedRevision: 0 }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(RevisionConflictError),
    });
    expect(['First writer', 'Second writer']).toContain(
      (await adapter.read(first.id))?.name,
    );
  });

  it('restores every record when a multi-record commit fails partway through', async () => {
    const first = createTestSession({ id: 'session-first', name: 'First' });
    const second = createTestSession({ id: 'session-second', name: 'Second' });
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

    const realRename = fs.rename.bind(fs);
    let renameCount = 0;
    const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      renameCount += 1;
      if (renameCount === 3) {
        throw new Error('Injected rename failure');
      }
      await realRename(...args);
    });

    await expect(tx.commit()).rejects.toThrow('Injected rename failure');
    renameSpy.mockRestore();

    expect(await adapter.read(first.id)).toEqual(first);
    expect(await adapter.read(second.id)).toEqual(second);
  });

  it('recovers an interrupted transaction from its durable journal', async () => {
    const session = createTestSession({ id: 'session-interrupted' });
    await adapter.write(session, { expectedRevision: 0 });
    const sessionPath = path.join(tempDir, `${session.id}.json`);
    const originalRaw = await fs.readFile(sessionPath, 'utf-8');
    const interruptedRecord = JSON.parse(originalRaw) as {
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
    await fs.writeFile(
      path.join(tempDir, '.session-transaction.journal'),
      JSON.stringify({
        version: 1,
        originals: [[session.id, originalRaw]],
      }),
    );
    await fs.writeFile(sessionPath, JSON.stringify(interruptedRecord));

    const recovered = await new JsonSessionStorageAdapter(tempDir).read(session.id);

    expect(recovered).toEqual(session);
    await expect(
      fs.access(path.join(tempDir, '.session-transaction.journal')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SQLiteSessionStorageAdapter', () => {
  let connection: InMemorySQLiteConnection;
  let adapter: SQLiteSessionStorageAdapter;

  beforeEach(async () => {
    connection = new InMemorySQLiteConnection();
    adapter = new SQLiteSessionStorageAdapter(connection);
    await adapter.initialize();
  });

  it('stores and retrieves sessions', async () => {
    const session = createTestSession();
    await adapter.write(session, { expectedRevision: 0 });
    const loaded = await adapter.read(session.id);
    expect(loaded).toEqual(session);

    const records = await adapter.list();
    expect(records).toHaveLength(1);
    expect(records[0].session).toEqual(session);
  });

  it('supports transactional writes', async () => {
    const session = createTestSession({ revision: 2 });
    await adapter.write(session, { expectedRevision: 0 });
    const tx = await adapter.beginTransaction();
    const updated = { ...session, name: 'Renamed', revision: session.revision + 1 };
    await tx.write(updated, { expectedRevision: session.revision });
    await tx.commit();

    const reloaded = await adapter.read(session.id);
    expect(reloaded?.name).toBe('Renamed');
  });
});

describe('SessionManager', () => {
  let tempDir: string;
  let storage: SessionStorageAdapter;
  let engine: MockAudioEngine;
  let cloud: RecordingCloudProvider;
  let manager: SessionManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-manager-'));
    storage = new JsonSessionStorageAdapter(tempDir);
    engine = new MockAudioEngine();
    cloud = new RecordingCloudProvider();
    manager = new SessionManager(storage, engine, { cloudSyncProvider: cloud });
    await manager.initialize();
    await manager.createSession(createTestSession({ revision: 0 }));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('applies updates with undo/redo semantics', async () => {
    await manager.updateSession((session) => {
      session.name = 'Updated Session';
    });
    expect(engine.updates.at(-1)?.name).toBe('Updated Session');

    const undone = await manager.undo();
    expect(undone?.name).toBe('Test Session');

    const redone = await manager.redo();
    expect(redone?.name).toBe('Updated Session');
  });

  it('merges remote changes during sync', async () => {
    const local = await manager.getSession();
    expect(local).not.toBeNull();
    const remoteSession = createTestSession({
      revision: (local as Session).revision + 5,
      name: 'Remote Session',
      tracks: [
        createTestTrack({
          id: 'track-remote',
          name: 'Remote Lead',
        }),
      ],
    });
    cloud.setRemote(remoteSession);

    const merged = await manager.syncWithCloud();
    expect(merged?.name).toBe('Remote Session');
    expect(merged?.tracks[0].id).toBe('track-remote');
  });

  it('notifies subscribers when sessions change', async () => {
    const snapshots: Session[] = [];
    const unsubscribe = manager.subscribe((session) => {
      if (session) {
        snapshots.push(session);
      }
    });

    await manager.updateSession((session) => {
      session.name = 'Subscribed Session';
    });

    unsubscribe();

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    snapshots[0].name = 'Mutated Locally';
    const latest = manager.getSession();
    expect(latest?.name).toBe('Subscribed Session');
  });

  it('does not publish or persist an update rejected by the audio engine', async () => {
    const before = manager.getSession();
    const notifications: Array<Session | null> = [];
    const unsubscribe = manager.subscribe((session) => notifications.push(session));
    engine.failNextUpdate();

    await expect(
      manager.updateSession((session) => {
        session.name = 'Rejected Session';
      }),
    ).rejects.toThrow('Audio update failed');

    expect(manager.getSession()).toEqual(before);
    expect(await storage.read((before as Session).id)).toEqual(before);
    expect(notifications).toEqual([before]);
    expect(await manager.undo()).toBeNull();
    expect(engine.updates.at(-1)).toEqual(before);
    unsubscribe();
  });

  it('restores audio and local state when persistence fails after audio applies', async () => {
    const before = manager.getSession();
    const notifications: Array<Session | null> = [];
    const unsubscribe = manager.subscribe((session) => notifications.push(session));
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('Injected persistence failure'));

    await expect(
      manager.updateSession((session) => {
        session.name = 'Uncommitted Session';
      }),
    ).rejects.toThrow('Injected persistence failure');
    renameSpy.mockRestore();

    expect(manager.getSession()).toEqual(before);
    expect(await storage.read((before as Session).id)).toEqual(before);
    expect(notifications).toEqual([before]);
    expect(await manager.undo()).toBeNull();
    expect(engine.updates.at(-1)).toEqual(before);
    unsubscribe();
  });

  it('resets before restoring a lower audio revision after persistence fails', async () => {
    const protectedEngine = new RevisionProtectedAudioEngine();
    const protectedStorage = new JsonSessionStorageAdapter(tempDir);
    const protectedManager = new SessionManager(protectedStorage, protectedEngine);
    await protectedManager.createSession(
      createTestSession({ id: 'session-revision-protected', revision: 0 }),
    );
    const before = protectedManager.getSession();
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('Injected protected commit failure'));

    await expect(
      protectedManager.updateSession((session) => {
        session.name = 'Higher Uncommitted Revision';
      }),
    ).rejects.toThrow('Injected protected commit failure');
    renameSpy.mockRestore();

    expect(protectedEngine.resets).toBe(1);
    expect(protectedEngine.currentSession).toEqual(before);
    expect(protectedManager.getSession()).toEqual(before);
    expect(await protectedStorage.read((before as Session).id)).toEqual(before);
  });

  it('preserves the operation error and attaches rollback failure context', async () => {
    const before = manager.getSession();
    const rollbackFailure = new Error('Injected audio reset failure');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    engine.failNextReset(rollbackFailure);
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('Injected contextual commit failure'));

    let operationError: unknown;
    try {
      await manager.updateSession((session) => {
        session.name = 'Contextual Failure';
      });
    } catch (error) {
      operationError = error;
    }
    renameSpy.mockRestore();
    errorSpy.mockRestore();

    expect(operationError).toBeInstanceOf(Error);
    const contextualError = operationError as Error & {
      cause?: Error;
      rollbackError?: Error;
    };
    expect(contextualError.message).toContain('Injected contextual commit failure');
    expect(contextualError.cause).toBe(contextualError.rollbackError);
    expect(contextualError.rollbackError).toMatchObject({
      name: 'SessionRollbackError',
      message: expect.stringContaining('audio-reset'),
    });
    expect(manager.getSession()).toEqual(before);
    expect(engine.updates.at(-1)).toEqual(before);
  });

  it('retains undo and redo entries when their transitions fail', async () => {
    await manager.updateSession((session) => {
      session.name = 'Updated Session';
    });
    const updated = manager.getSession();

    engine.failNextUpdate();
    await expect(manager.undo()).rejects.toThrow('Audio update failed');
    expect(manager.getSession()).toEqual(updated);
    expect(await storage.read((updated as Session).id)).toEqual(updated);

    const undone = await manager.undo();
    expect(undone?.name).toBe('Test Session');

    engine.failNextUpdate();
    await expect(manager.redo()).rejects.toThrow('Audio update failed');
    expect(manager.getSession()).toEqual(undone);
    expect(await storage.read((undone as Session).id)).toEqual(undone);

    const redone = await manager.redo();
    expect(redone?.name).toBe('Updated Session');
  });

  it('leaves a failed create absent from all published and persisted state', async () => {
    const isolatedStorage = new JsonSessionStorageAdapter(tempDir);
    const isolatedEngine = new MockAudioEngine();
    const isolatedManager = new SessionManager(isolatedStorage, isolatedEngine);
    const notifications: Array<Session | null> = [];
    isolatedManager.subscribe((session) => notifications.push(session));
    isolatedEngine.failNextUpdate();

    await expect(
      isolatedManager.createSession(
        createTestSession({ id: 'session-rejected', revision: 0 }),
      ),
    ).rejects.toThrow('Audio update failed');

    expect(isolatedManager.getSession()).toBeNull();
    expect(await isolatedStorage.read('session-rejected')).toBeNull();
    expect(notifications).toEqual([null]);
    expect(isolatedEngine.resets).toBe(1);
  });

  it('resets audio when a create commit fails without a previous session', async () => {
    const isolatedStorage = new JsonSessionStorageAdapter(tempDir);
    const isolatedEngine = new MockAudioEngine();
    const isolatedManager = new SessionManager(isolatedStorage, isolatedEngine);
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('Injected create commit failure'));

    await expect(
      isolatedManager.createSession(
        createTestSession({ id: 'session-create-commit-failure', revision: 0 }),
      ),
    ).rejects.toThrow('Injected create commit failure');
    renameSpy.mockRestore();

    expect(isolatedManager.getSession()).toBeNull();
    expect(await isolatedStorage.read('session-create-commit-failure')).toBeNull();
    expect(isolatedEngine.resets).toBe(1);
  });

  it('resets audio when a remote load commit fails without a previous session', async () => {
    const remoteSession = createTestSession({
      id: 'session-load-commit-failure',
      revision: 4,
    });
    const isolatedStorage = new JsonSessionStorageAdapter(tempDir);
    const isolatedEngine = new MockAudioEngine();
    const isolatedCloud = new RecordingCloudProvider();
    isolatedCloud.setRemote(remoteSession);
    const isolatedManager = new SessionManager(isolatedStorage, isolatedEngine, {
      cloudSyncProvider: isolatedCloud,
    });
    const renameSpy = jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('Injected load commit failure'));

    await expect(isolatedManager.loadSession(remoteSession.id)).rejects.toThrow(
      'Injected load commit failure',
    );
    renameSpy.mockRestore();

    expect(isolatedManager.getSession()).toBeNull();
    expect(await isolatedStorage.read(remoteSession.id)).toBeNull();
    expect(isolatedEngine.resets).toBe(1);
  });
});
