import {
  createDefaultTrackRoutingGraph,
  SessionManager,
  SessionStorageError,
  type Session,
  type Track,
  type TrackID,
} from '../../session';

export interface AddTrackOptions {
  name?: string;
}

export interface SessionActions {
  addTrack: (options?: AddTrackOptions) => Promise<Session>;
  setTrackMuted: (trackId: TrackID, muted: boolean) => Promise<Session>;
  setTrackSolo: (trackId: TrackID, solo: boolean) => Promise<Session>;
}

interface NextTrackIdentity {
  id: TrackID;
  ordinal: number;
}

const resolveNextTrackIdentity = (tracks: ReadonlyArray<Track>): NextTrackIdentity => {
  const existingIds = new Set(tracks.map((track) => track.id));
  let ordinal = 1;

  while (existingIds.has(`track-${ordinal}`)) {
    ordinal += 1;
  }

  return { id: `track-${ordinal}`, ordinal };
};

const resolveTrackName = (name: string | undefined, ordinal: number): string => {
  const normalized = name?.trim();
  return normalized ? normalized : `Track ${ordinal}`;
};

const updateTrack = (
  session: Session,
  trackId: TrackID,
  update: (track: Track) => Track,
): Session => {
  const trackIndex = session.tracks.findIndex((track) => track.id === trackId);
  if (trackIndex < 0) {
    throw new SessionStorageError(`Track ${trackId} not found`);
  }

  return {
    ...session,
    tracks: session.tracks.map((track, index) =>
      index === trackIndex ? update(track) : track,
    ),
  };
};

export const createSessionActions = (manager: SessionManager): SessionActions => ({
  addTrack: (options = {}) =>
    manager.updateSession((session) => {
      const identity = resolveNextTrackIdentity(session.tracks);
      const track: Track = {
        id: identity.id,
        name: resolveTrackName(options.name, identity.ordinal),
        clips: [],
        muted: false,
        solo: false,
        volume: 0,
        pan: 0,
        automationCurves: [],
        routing: {
          graph: createDefaultTrackRoutingGraph(identity.id),
        },
      };

      return {
        ...session,
        tracks: [...session.tracks, track],
      };
    }),
  setTrackMuted: (trackId, muted) =>
    manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => ({ ...track, muted })),
    ),
  setTrackSolo: (trackId, solo) =>
    manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => ({ ...track, solo })),
    ),
});
