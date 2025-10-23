import {
  COLLAB_SESSION_PATCH_VERSION,
  createRemoteSessionPatchApplier,
  deserializeCollabSessionPatch,
  serializeCollabSessionPatch,
} from '../types';
import type { CollabPayload } from '../encryption';
import type { Session, Track, Clip, AutomationCurve } from '../../../session/models';

const createAutomationCurve = (
  overrides: Partial<AutomationCurve> = {},
): AutomationCurve => ({
  id: overrides.id ?? 'curve-1',
  parameter: overrides.parameter ?? 'volume',
  interpolation: overrides.interpolation ?? 'linear',
  points: overrides.points ?? [
    { time: 2000, value: 0.9 },
    { time: 0, value: 0.8 },
  ],
});

const createClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: overrides.id ?? 'clip-1',
  name: overrides.name ?? 'Clip',
  start: overrides.start ?? 0,
  duration: overrides.duration ?? 1000,
  audioFile: overrides.audioFile ?? 'clip.wav',
  gain: overrides.gain ?? 1,
  fadeIn: overrides.fadeIn ?? 0,
  fadeOut: overrides.fadeOut ?? 0,
  automationCurveIds: overrides.automationCurveIds ?? [],
  midi: overrides.midi,
});

const createTrack = (overrides: Partial<Track> = {}): Track => ({
  id: overrides.id ?? 'track-1',
  name: overrides.name ?? 'Track 1',
  clips: overrides.clips ?? [],
  muted: overrides.muted ?? false,
  solo: overrides.solo ?? false,
  volume: overrides.volume ?? 0,
  pan: overrides.pan ?? 0,
  automationCurves: overrides.automationCurves ?? [],
  routing: overrides.routing ?? {},
});

const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: overrides.id ?? 'session-1',
  name: overrides.name ?? 'Base Session',
  revision: overrides.revision ?? 0,
  tracks: overrides.tracks ?? [createTrack()],
  metadata: {
    version: overrides.metadata?.version ?? 1,
    createdAt:
      overrides.metadata?.createdAt ?? new Date('2024-01-01T00:00:00.000Z').toISOString(),
    updatedAt:
      overrides.metadata?.updatedAt ?? new Date('2024-01-01T00:00:00.000Z').toISOString(),
    sampleRate: overrides.metadata?.sampleRate ?? 48000,
    bpm: overrides.metadata?.bpm ?? 120,
    timeSignature: overrides.metadata?.timeSignature ?? '4/4',
  },
});

describe('collaboration types', () => {
  it('serializes and deserializes session patches with normalization', () => {
    const base = createSession();
    const update = createSession({
      revision: 1,
      tracks: [
        createTrack({
          id: 'track-1',
          clips: [
            createClip({ id: 'clip-b', start: 2500 }),
            createClip({ id: 'clip-a', start: 0 }),
          ],
          automationCurves: [createAutomationCurve()],
        }),
      ],
    });

    const serialized = serializeCollabSessionPatch({
      sessionId: base.id,
      base,
      update,
      actorId: 'peer-a',
    });

    expect(serialized.version).toBe(COLLAB_SESSION_PATCH_VERSION);

    const roundTrip = deserializeCollabSessionPatch(serialized);
    expect(roundTrip.update.tracks[0].clips[0].id).toBe('clip-a');
    expect(roundTrip.update.tracks[0].automationCurves[0].points[0].time).toBe(0);
  });

  it('rejects serialization when actor id is blank', () => {
    const base = createSession();
    const update = createSession({ revision: 1 });

    expect(() =>
      serializeCollabSessionPatch({
        sessionId: base.id,
        base,
        update,
        actorId: '   ',
      }),
    ).toThrow('Collaborative patch requires a non-empty actor id');
  });

  it('throws when deserializing patches missing actorId', () => {
    const base = createSession();
    const update = createSession({ revision: 1 });
    const patch = {
      sessionId: base.id,
      base,
      update,
      version: COLLAB_SESSION_PATCH_VERSION,
    } as unknown;

    expect(() => deserializeCollabSessionPatch(patch)).toThrow(
      'Collaborative patch requires a non-empty actor id',
    );
  });

  it('throws when deserializing patches missing base session', () => {
    const base = createSession();
    const patch = {
      sessionId: base.id,
      update: createSession({ revision: 1 }),
      actorId: 'peer-a',
      version: COLLAB_SESSION_PATCH_VERSION,
    } as unknown;

    expect(() => deserializeCollabSessionPatch(patch)).toThrow(
      'Collaborative session patch missing base or update payload',
    );
  });

  it('throws when deserializing patches missing update session', () => {
    const base = createSession();
    const patch = {
      sessionId: base.id,
      base,
      actorId: 'peer-a',
      version: COLLAB_SESSION_PATCH_VERSION,
    } as unknown;

    expect(() => deserializeCollabSessionPatch(patch)).toThrow(
      'Collaborative session patch missing base or update payload',
    );
  });

  it('throws when deserializing unsupported patch version', () => {
    const base = createSession();
    const update = createSession({ revision: 1 });
    const patch = {
      sessionId: base.id,
      base,
      update,
      actorId: 'peer-a',
      version: 99,
    } as unknown;

    expect(() => deserializeCollabSessionPatch(patch)).toThrow(
      'Unsupported collaborative session patch version',
    );
  });

  it('merges remote patches through the session manager applier', async () => {
    const base = createSession();
    const metadataTemplate = base.metadata;
    const local = createSession({
      revision: 1,
      name: 'Local Groove',
      metadata: { ...metadataTemplate, bpm: 124 },
    });
    const remote = createSession({
      revision: 2,
      name: 'Remote Remix',
      metadata: { ...metadataTemplate, bpm: 110 },
    });

    const serializedPatch = serializeCollabSessionPatch({
      sessionId: base.id,
      base,
      update: remote,
      actorId: 'peer-remote',
    });

    const payload: CollabPayload<typeof serializedPatch> = {
      clock: Date.now(),
      schemaVersion: 1,
      body: serializedPatch,
    };

    const updateSession = jest.fn(
      async (mutator: (session: Session) => Session | void) => {
        const working = JSON.parse(JSON.stringify(local)) as Session;
        mutator(working);
        expect(working.name).toBe('Remote Remix');
        expect(working.metadata.bpm).toBe(110);
        return working;
      },
    );

    const applier = createRemoteSessionPatchApplier({ updateSession } as unknown as {
      updateSession: (mutator: (session: Session) => Session | void) => Promise<Session>;
    });

    await applier(payload);

    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it('throws when the patch targets a different session id', async () => {
    const base = createSession();
    const remote = createSession({ revision: 1 });
    const serializedPatch = serializeCollabSessionPatch({
      sessionId: base.id,
      base,
      update: remote,
      actorId: 'peer-x',
    });
    const payload: CollabPayload<typeof serializedPatch> = {
      clock: Date.now(),
      schemaVersion: 1,
      body: serializedPatch,
    };

    const applier = createRemoteSessionPatchApplier({
      updateSession: async (mutator: (session: Session) => Session | void) => {
        const working = createSession({ id: 'other-session', revision: 1 });
        mutator(working);
        return working;
      },
    } as unknown as {
      updateSession: (mutator: (session: Session) => Session | void) => Promise<Session>;
    });

    await expect(applier(payload)).rejects.toThrow(/Remote patch targeted session/);
  });
});
