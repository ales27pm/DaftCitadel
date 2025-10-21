import { InMemorySessionStorageAdapter } from '../storage/memoryAdapter';
import { RevisionConflictError } from '../storage';
import { Session } from '../models';

const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Memory Test',
  revision: 0,
  tracks: [
    {
      id: 'track-1',
      name: 'Track 1',
      clips: [
        {
          id: 'clip-1',
          name: 'Clip 1',
          start: 0,
          duration: 2000,
          audioFile: 'clip.wav',
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          automationCurveIds: [],
        },
      ],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [],
      routing: {
        input: 'bus:main',
        output: 'bus-master',
        graph: {
          version: 1,
          nodes: [],
          connections: [],
        },
      },
    },
  ],
  metadata: {
    version: 1,
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    bpm: 120,
    sampleRate: 48000,
    timeSignature: '4/4',
  },
  ...overrides,
});

describe('InMemorySessionStorageAdapter', () => {
  it('writes and reads sessions', async () => {
    const adapter = new InMemorySessionStorageAdapter();
    const session = createSession();
    await adapter.write(session, { expectedRevision: 0 });
    const loaded = await adapter.read(session.id);
    expect(loaded).toEqual(session);
  });

  it('throws on revision conflicts', async () => {
    const adapter = new InMemorySessionStorageAdapter();
    const session = createSession();
    await adapter.write(session, { expectedRevision: 0 });
    await expect(
      adapter.write({ ...session, revision: 2 }, { expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('commits staged transaction writes', async () => {
    const adapter = new InMemorySessionStorageAdapter();
    const session = createSession();
    const tx = await adapter.beginTransaction();
    await tx.write(session, { expectedRevision: 0 });
    await tx.commit();
    const loaded = await adapter.read(session.id);
    expect(loaded).toEqual(session);
  });

  it('rolls back staged transaction writes', async () => {
    const adapter = new InMemorySessionStorageAdapter();
    const session = createSession();
    const tx = await adapter.beginTransaction();
    await tx.write(session, { expectedRevision: 0 });
    await tx.rollback();
    const loaded = await adapter.read(session.id);
    expect(loaded).toBeNull();
  });
});
