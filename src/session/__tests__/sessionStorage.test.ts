import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { AutomationCurve, Clip, Session, Track } from '../models';
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

const createTestTrack = (overrides: Partial<Track> = {}): Track => ({
  id: 'track-1',
  name: 'Bass',
  clips: [createTestClip()],
  muted: false,
  solo: false,
  volume: -3,
  pan: 0,
  automationCurves: [createAutomationCurve()],
  routing: {
    input: 'line-1',
    output: 'bus-master',
    sends: { 'reverb-send': -6 },
  },
  ...overrides,
});

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

  async applySessionUpdate(session: Session): Promise<void> {
    this.updates.push(JSON.parse(JSON.stringify(session)));
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

  override async pull(
    _sessionId: string,
  ): Promise<{ session: Session | null; revision: number }> {
    return { session: this.remote, revision: this.remote?.revision ?? 0 };
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
});
