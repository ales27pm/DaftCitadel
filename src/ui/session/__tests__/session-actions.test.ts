import {
  createEmptySession,
  InMemorySessionStorageAdapter,
  SessionManager,
  SessionStorageError,
  type Session,
  type Track,
} from '../../../session';
import { createSessionActions } from '../session-actions';
import { PassiveAudioEngineBridge } from '../environment';

const createTrack = (id: string): Track => ({
  id,
  name: id,
  clips: [],
  muted: false,
  solo: false,
  volume: 0,
  pan: 0,
  automationCurves: [],
  routing: {},
});

const createManager = async (tracks: Track[] = []): Promise<SessionManager> => {
  const storage = new InMemorySessionStorageAdapter();
  await storage.initialize();
  const manager = new SessionManager(storage, new PassiveAudioEngineBridge());
  const session: Session = {
    ...createEmptySession('session-actions', 'Session actions'),
    tracks,
  };
  await manager.createSession(session);
  return manager;
};

describe('createSessionActions', () => {
  it('adds a routed track using the first unused deterministic track id', async () => {
    const manager = await createManager([
      createTrack('track-1'),
      createTrack('track-3'),
      createTrack('custom-track'),
    ]);
    const actions = createSessionActions(manager);

    const updated = await actions.addTrack();
    const addedTrack = updated.tracks.at(-1);

    expect(addedTrack).toMatchObject({
      id: 'track-2',
      name: 'Track 2',
      clips: [],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
      automationCurves: [],
    });
    expect(addedTrack?.routing.graph).toEqual({
      version: 1,
      nodes: [
        expect.objectContaining({ id: 'track-2:input:main', type: 'trackInput' }),
        expect.objectContaining({ id: 'track-2:output:main', type: 'trackOutput' }),
      ],
      connections: [
        expect.objectContaining({
          id: 'track-2:connection:direct',
          from: { nodeId: 'track-2:input:main' },
          to: { nodeId: 'track-2:output:main' },
          signal: 'audio',
          enabled: true,
        }),
      ],
    });
    expect(manager.getSession()?.tracks.at(-1)?.id).toBe('track-2');
  });

  it('uses a trimmed custom track name without changing deterministic ids', async () => {
    const manager = await createManager();

    const updated = await createSessionActions(manager).addTrack({ name: '  Lead  ' });

    expect(updated.tracks[0]).toMatchObject({ id: 'track-1', name: 'Lead' });
  });

  it('updates mute and solo state through the session manager', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);

    await actions.setTrackMuted('track-1', true);
    const updated = await actions.setTrackSolo('track-1', true);

    expect(updated.tracks[0]).toMatchObject({ muted: true, solo: true });
    expect(manager.getSession()?.tracks[0]).toMatchObject({ muted: true, solo: true });
  });

  it('propagates missing-track errors without changing the session', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);
    const before = manager.getSession();

    await expect(actions.setTrackMuted('missing-track', true)).rejects.toEqual(
      expect.objectContaining<Partial<SessionStorageError>>({
        message: 'Track missing-track not found',
      }),
    );

    expect(manager.getSession()).toEqual(before);
  });
});
