import {
  createRemoteSessionPatchApplier,
  serializeCollabSessionPatch,
} from '../../services/collab/types';
import { SessionManager, type AudioEngineBridge } from '../sessionManager';
import type { Session } from '../models';
import { InMemorySessionStorageAdapter } from '../storage/memoryAdapter';
import type { CollabPayload } from '../../services/collab/encryption';

type MutableSession = Session;

const createBaseSession = (): Session => ({
  id: 'session-1',
  name: 'Base Session',
  revision: 0,
  tracks: [
    {
      id: 'track-1',
      name: 'Track 1',
      clips: [],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [],
      routing: {},
    },
  ],
  metadata: {
    version: 1,
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    sampleRate: 48000,
    bpm: 120,
    timeSignature: '4/4',
  },
});

class RecordingAudioEngine implements AudioEngineBridge {
  public applied: Session[] = [];

  async applySessionUpdate(session: Session): Promise<void> {
    this.applied.push(JSON.parse(JSON.stringify(session)) as Session);
  }
}

describe('SessionManager collaborative integration', () => {
  it('applies remote patches and records history entries', async () => {
    const storage = new InMemorySessionStorageAdapter();
    const audioEngine = new RecordingAudioEngine();
    const manager = new SessionManager(storage, audioEngine);

    const baseSession = createBaseSession();
    await manager.createSession(baseSession);
    const baseSnapshot = manager.getSession() as MutableSession;

    await manager.updateSession((session) => {
      session.name = 'Local Groove';
      session.metadata.bpm = 128;
      return session;
    });
    const localSnapshot = manager.getSession() as MutableSession;

    const remoteUpdate: Session = {
      ...baseSnapshot,
      revision: baseSnapshot.revision + 2,
      name: 'Remote Remix',
      metadata: {
        ...baseSnapshot.metadata,
        bpm: 110,
        updatedAt: new Date('2024-02-01T00:00:00.000Z').toISOString(),
      },
    };

    const patch = serializeCollabSessionPatch({
      sessionId: baseSnapshot.id,
      base: baseSnapshot,
      update: remoteUpdate,
      actorId: 'peer-remote',
    });

    const payload: CollabPayload<typeof patch> = {
      clock: Date.now(),
      schemaVersion: 1,
      body: patch,
    };

    const applyRemote = createRemoteSessionPatchApplier(manager);
    await applyRemote(payload);

    const merged = manager.getSession();
    expect(merged?.name).toBe('Remote Remix');
    expect(merged?.metadata.bpm).toBe(110);
    expect(merged?.revision).toBe(localSnapshot.revision + 1);

    const undoSession = await manager.undo();
    expect(undoSession?.name).toBe('Local Groove');
    expect(undoSession?.metadata.bpm).toBe(128);
  });

  it('preserves local changes when revisions tie and still records history', async () => {
    const storage = new InMemorySessionStorageAdapter();
    const audioEngine = new RecordingAudioEngine();
    const manager = new SessionManager(storage, audioEngine);

    const baseSession = createBaseSession();
    await manager.createSession(baseSession);
    const baseSnapshot = manager.getSession() as MutableSession;

    await manager.updateSession((session) => {
      session.name = 'Local Harmony';
      session.metadata.bpm = 130;
      return session;
    });

    const remoteUpdate: Session = {
      ...baseSnapshot,
      revision: baseSnapshot.revision + 1,
      name: 'Remote Attempt',
      metadata: {
        ...baseSnapshot.metadata,
        bpm: 118,
        updatedAt: new Date('2024-03-01T00:00:00.000Z').toISOString(),
      },
    };

    const patch = serializeCollabSessionPatch({
      sessionId: baseSnapshot.id,
      base: baseSnapshot,
      update: remoteUpdate,
      actorId: 'peer-remote',
    });

    const payload: CollabPayload<typeof patch> = {
      clock: Date.now(),
      schemaVersion: 1,
      body: patch,
    };

    const applyRemote = createRemoteSessionPatchApplier(manager);
    await applyRemote(payload);

    const merged = manager.getSession();
    expect(merged?.name).toBe('Local Harmony');
    expect(merged?.metadata.bpm).toBe(130);

    const undoSession = await manager.undo();
    expect(undoSession?.name).toBe('Local Harmony');
  });

  it('rejects remote patches that target a different session id', async () => {
    const storage = new InMemorySessionStorageAdapter();
    const audioEngine = new RecordingAudioEngine();
    const manager = new SessionManager(storage, audioEngine);

    const baseSession = createBaseSession();
    await manager.createSession(baseSession);

    const remoteBase: Session = {
      ...baseSession,
      id: 'session-remote',
    };

    const remoteUpdate: Session = {
      ...remoteBase,
      revision: remoteBase.revision + 1,
      name: 'Remote Out-of-Band',
    };

    const patch = serializeCollabSessionPatch({
      sessionId: remoteBase.id,
      base: remoteBase,
      update: remoteUpdate,
      actorId: 'peer-remote',
    });

    const payload: CollabPayload<typeof patch> = {
      clock: Date.now(),
      schemaVersion: 1,
      body: patch,
    };

    const applyRemote = createRemoteSessionPatchApplier(manager);

    await expect(applyRemote(payload)).rejects.toThrow('Remote patch targeted session');

    const current = manager.getSession();
    expect(current?.id).toBe(baseSession.id);
    expect(current?.name).toBe(baseSession.name);
  });
});
