import { deepFreeze } from './util';

export type SessionID = string;
export type TrackID = string;
export type ClipID = string;
export type AutomationCurveID = string;

export interface Clip {
  id: ClipID;
  name: string;
  start: number; // milliseconds
  duration: number; // milliseconds
  audioFile: string;
  gain: number; // linear amplitude multiplier
  fadeIn: number; // milliseconds
  fadeOut: number; // milliseconds
  automationCurveIds: AutomationCurveID[];
}

export type AutomationInterpolation = 'linear' | 'step' | 'exponential';

export interface AutomationPoint {
  time: number; // milliseconds relative to clip or track
  value: number;
}

export interface AutomationCurve {
  id: AutomationCurveID;
  parameter: string; // e.g. volume, pan, filter cutoff
  interpolation: AutomationInterpolation;
  points: AutomationPoint[];
}

export interface TrackRouting {
  input?: string;
  output?: string;
  sends?: Record<string, number>;
  sidechainSource?: string;
}

export interface Track {
  id: TrackID;
  name: string;
  color?: string;
  clips: Clip[];
  muted: boolean;
  solo: boolean;
  volume: number; // dB
  pan: number; // -1 to 1
  automationCurves: AutomationCurve[];
  routing: TrackRouting;
}

export interface SessionMetadata {
  version: number;
  createdAt: string;
  updatedAt: string;
  sampleRate: number;
  bpm: number;
  timeSignature: string;
}

export interface Session {
  id: SessionID;
  name: string;
  tracks: Track[];
  metadata: SessionMetadata;
  revision: number;
}

export const createEmptySession = (id: SessionID, name: string): Session => {
  const now = new Date().toISOString();
  const session: Session = {
    id,
    name,
    revision: 0,
    tracks: [],
    metadata: {
      version: 1,
      createdAt: now,
      updatedAt: now,
      bpm: 120,
      sampleRate: 48000,
      timeSignature: '4/4',
    },
  };
  return deepFreeze(session);
};

export const updateSessionTimestamp = (session: Session): Session => ({
  ...session,
  metadata: {
    ...session.metadata,
    updatedAt: new Date().toISOString(),
  },
});

export const sortAutomationPoints = (curve: AutomationCurve): AutomationCurve => ({
  ...curve,
  points: [...curve.points].sort((a, b) => a.time - b.time),
});

export const normalizeTrack = (track: Track): Track => ({
  ...track,
  clips: [...track.clips].sort((a, b) => a.start - b.start),
  automationCurves: track.automationCurves.map(sortAutomationPoints),
});

export const normalizeSession = (session: Session): Session => ({
  ...session,
  tracks: session.tracks.map(normalizeTrack),
});

export const validateSession = (session: Session): void => {
  if (!session.id) {
    throw new Error('Session id is required');
  }

  session.tracks.forEach((track) => {
    if (!track.id) {
      throw new Error('Track id is required');
    }

    const clipIds = new Set<ClipID>();
    track.clips.forEach((clip) => {
      if (!clip.id) {
        throw new Error('Clip id is required');
      }
      if (clipIds.has(clip.id)) {
        throw new Error(`Duplicate clip id detected: ${clip.id}`);
      }
      clipIds.add(clip.id);
      if (clip.duration <= 0) {
        throw new Error('Clip duration must be positive');
      }
    });
  });
};
