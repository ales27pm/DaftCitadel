import {
  createDefaultJunoTrack,
  createDefaultTrackRoutingGraph,
  SessionManager,
  SessionStorageError,
  assertJuno106FeatureEnabled,
  validateJuno106Preset,
  type CreateJunoTrackOptions,
  type Clip,
  type ClipID,
  type Juno106PresetRecord,
  type Juno106ParameterName,
  type MidiNoteEvent,
  type Session,
  type Track,
  type TrackID,
} from '../../session';
import { quarterNoteBeatsPerBar } from '../utils/timeSignature';

export interface AddTrackOptions {
  name?: string;
}

export type AddJunoTrackOptions = CreateJunoTrackOptions;

export interface AddEmptyJunoMidiClipOptions {
  name?: string;
  bars?: number;
}

export interface CreateJunoMidiSceneOptions extends AddEmptyJunoMidiClipOptions {
  trackName?: string;
}

export interface AddJunoScenePartOptions {
  startMs: number;
  durationMs: number;
  name?: string;
  trackName?: string;
}

export interface DuplicateJunoMidiSceneOptions {
  startMs: number;
  durationMs: number;
}

export interface SessionActions {
  addTrack: (options?: AddTrackOptions) => Promise<Session>;
  addJunoTrack: (options?: AddJunoTrackOptions) => Promise<Session>;
  addJunoMidiClip: (trackId: TrackID) => Promise<Session>;
  addEmptyJunoMidiClip: (
    trackId: TrackID,
    options?: AddEmptyJunoMidiClipOptions,
  ) => Promise<Session>;
  createJunoMidiScene: (options?: CreateJunoMidiSceneOptions) => Promise<Session>;
  addJunoScenePart: (options: AddJunoScenePartOptions) => Promise<Session>;
  duplicateJunoMidiScene: (options: DuplicateJunoMidiSceneOptions) => Promise<Session>;
  setMidiClipNotes: (
    trackId: TrackID,
    clipId: ClipID,
    notes: ReadonlyArray<MidiNoteEvent>,
  ) => Promise<Session>;
  clearMidiClip: (trackId: TrackID, clipId: ClipID) => Promise<Session>;
  setTempo: (bpm: number) => Promise<Session>;
  setTrackVolume: (trackId: TrackID, volumeDb: number) => Promise<Session>;
  setTrackPan: (trackId: TrackID, pan: number) => Promise<Session>;
  undo: () => Promise<Session | null>;
  redo: () => Promise<Session | null>;
  setJunoParameter: (
    trackId: TrackID,
    parameter: Juno106ParameterName,
    value: number,
  ) => Promise<Session>;
  applyJunoPreset: (trackId: TrackID, preset: Juno106PresetRecord) => Promise<Session>;
  setTrackMuted: (trackId: TrackID, muted: boolean) => Promise<Session>;
  setTrackSolo: (trackId: TrackID, solo: boolean) => Promise<Session>;
}

interface NextTrackIdentity {
  id: TrackID;
  ordinal: number;
}

const STARTER_PATTERN_BARS = 4;
const STARTER_PATTERN_PITCHES = [48, 55, 60, 63, 55, 60, 63, 67] as const;
const DEFAULT_MIDI_CLIP_BARS = 1;
const MAX_MIDI_CLIP_BARS = 64;
const MIN_BPM = 20;
const MAX_BPM = 300;
const MIN_TRACK_VOLUME_DB = -60;
const MAX_TRACK_VOLUME_DB = 12;
const MIN_TRACK_PAN = -1;
const MAX_TRACK_PAN = 1;

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

const resolveNextMidiClipOrdinal = (track: Track): number => {
  const clipIds = new Set(track.clips.map((clip) => clip.id));
  let ordinal = 1;
  while (clipIds.has(`${track.id}:clip:midi-${ordinal}`)) {
    ordinal += 1;
  }
  return ordinal;
};

const hasJunoInstrument = (track: Track): boolean =>
  Boolean(
    track.routing.graph?.nodes.some(
      (node) => node.type === 'instrument' && node.instrumentType === 'juno106',
    ),
  );

const resolveTrackAppendStart = (track: Track): number =>
  track.clips.reduce(
    (latestEnd, clip) => Math.max(latestEnd, clip.start + clip.duration),
    0,
  );

const resolveGlobalAppendStart = (session: Session): number =>
  session.tracks.reduce(
    (sessionEnd, track) => Math.max(sessionEnd, resolveTrackAppendStart(track)),
    0,
  );

const resolveNextSceneOrdinal = (session: Session): number => {
  const clipNames = new Set(
    session.tracks.flatMap((track) => track.clips.map((clip) => clip.name)),
  );
  let ordinal = 1;
  while (clipNames.has(`Scene ${ordinal}`)) {
    ordinal += 1;
  }
  return ordinal;
};

const resolveDuplicateClipName = (track: Track, sourceName: string): string => {
  const names = new Set(track.clips.map((clip) => clip.name));
  const baseName = `${sourceName} Copy`;
  if (!names.has(baseName)) {
    return baseName;
  }
  let ordinal = 2;
  while (names.has(`${baseName} ${ordinal}`)) {
    ordinal += 1;
  }
  return `${baseName} ${ordinal}`;
};

const assertFiniteRange = (
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): void => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
};

const validateSceneTiming = (startMs: number, durationMs: number): void => {
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new RangeError('Scene startMs must be finite and non-negative');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('Scene durationMs must be finite and positive');
  }
};

const validateMidiNotes = (notes: ReadonlyArray<MidiNoteEvent>): void => {
  const noteIds = new Set<string>();

  notes.forEach((note) => {
    if (!note.id.trim()) {
      throw new Error('MIDI note id is required');
    }
    if (noteIds.has(note.id)) {
      throw new Error(`Duplicate MIDI note id: ${note.id}`);
    }
    noteIds.add(note.id);

    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
      throw new RangeError('MIDI note pitch must be an integer between 0 and 127');
    }
    if (!Number.isFinite(note.startBeat) || note.startBeat < 0) {
      throw new RangeError('MIDI note startBeat must be finite and non-negative');
    }
    if (!Number.isFinite(note.durationBeats) || note.durationBeats <= 0) {
      throw new RangeError('MIDI note durationBeats must be finite and positive');
    }
    if (!Number.isInteger(note.velocity) || note.velocity < 0 || note.velocity > 127) {
      throw new RangeError('MIDI note velocity must be an integer between 0 and 127');
    }
  });
};

const createStarterMidiClip = (session: Session, track: Track, ordinal: number): Clip => {
  const clipId = `${track.id}:clip:midi-${ordinal}`;
  const totalBeats = Math.max(
    1,
    quarterNoteBeatsPerBar(session.metadata.timeSignature) * STARTER_PATTERN_BARS,
  );
  const bpm =
    Number.isFinite(session.metadata.bpm) && session.metadata.bpm > 0
      ? session.metadata.bpm
      : 120;
  const notes: MidiNoteEvent[] = Array.from(
    { length: Math.max(1, Math.floor(totalBeats)) },
    (_unused, index) => ({
      id: `note-${index + 1}`,
      pitch: STARTER_PATTERN_PITCHES[index % STARTER_PATTERN_PITCHES.length],
      startBeat: index,
      durationBeats: Math.min(0.75, totalBeats - index),
      velocity: index % 4 === 0 ? 108 : 96,
    }),
  );
  const start = resolveTrackAppendStart(track);

  return {
    id: clipId,
    name: `Starter Pattern ${ordinal}`,
    start,
    duration: Math.max(1, Math.round(totalBeats * (60000 / bpm))),
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    automationCurveIds: [],
    midi: {
      pulsesPerQuarter: 480,
      notes,
    },
  };
};

const createEmptyMidiClip = (
  session: Session,
  track: Track,
  ordinal: number,
  options: AddEmptyJunoMidiClipOptions,
): Clip => {
  const bars = options.bars ?? DEFAULT_MIDI_CLIP_BARS;
  const beats = Math.max(
    1,
    quarterNoteBeatsPerBar(session.metadata.timeSignature) * bars,
  );
  const name = options.name?.trim();

  return {
    id: `${track.id}:clip:midi-${ordinal}`,
    name: name || `MIDI Loop ${ordinal}`,
    start: resolveTrackAppendStart(track),
    duration: Math.max(1, Math.round(beats * (60000 / session.metadata.bpm))),
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    automationCurveIds: [],
    midi: {
      pulsesPerQuarter: 480,
      notes: [],
    },
  };
};

const createAlignedEmptyMidiClip = (
  track: Track,
  ordinal: number,
  startMs: number,
  durationMs: number,
  name: string,
): Clip => ({
  id: `${track.id}:clip:midi-${ordinal}`,
  name,
  start: startMs,
  duration: durationMs,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  automationCurveIds: [],
  midi: {
    pulsesPerQuarter: 480,
    notes: [],
  },
});

const duplicateAlignedMidiClips = (
  track: Track,
  sourceStartMs: number,
  sourceDurationMs: number,
  targetStartMs: number,
): { track: Track; duplicatedCount: number } => {
  const sourceClips = track.clips.filter(
    (clip) =>
      Boolean(clip.midi) &&
      clip.start === sourceStartMs &&
      clip.duration === sourceDurationMs,
  );
  let updatedTrack = track;

  sourceClips.forEach((sourceClip) => {
    const midi = sourceClip.midi;
    if (!midi) {
      return;
    }
    const ordinal = resolveNextMidiClipOrdinal(updatedTrack);
    const duplicate: Clip = {
      ...sourceClip,
      id: `${track.id}:clip:midi-${ordinal}`,
      name: resolveDuplicateClipName(updatedTrack, sourceClip.name),
      start: targetStartMs,
      automationCurveIds: [...sourceClip.automationCurveIds],
      midi: {
        ...midi,
        notes: midi.notes.map((note) => ({ ...note })),
      },
    };
    updatedTrack = {
      ...updatedTrack,
      clips: [...updatedTrack.clips, duplicate],
    };
  });

  return { track: updatedTrack, duplicatedCount: sourceClips.length };
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

const replaceMidiClipNotes = (
  session: Session,
  trackId: TrackID,
  clipId: ClipID,
  notes: ReadonlyArray<MidiNoteEvent>,
): Session =>
  updateTrack(session, trackId, (track) => {
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
    if (clipIndex < 0) {
      throw new SessionStorageError(`Clip ${clipId} not found on track ${trackId}`);
    }
    const clip = track.clips[clipIndex];
    if (!clip.midi) {
      throw new SessionStorageError(`Clip ${clipId} is not a MIDI clip`);
    }

    return {
      ...track,
      clips: track.clips.map((candidate, index) =>
        index === clipIndex
          ? {
              ...clip,
              midi: {
                ...clip.midi,
                notes: notes.map((note) => ({ ...note })),
              },
            }
          : candidate,
      ),
    };
  });

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
  addJunoTrack: (options = {}) =>
    manager.updateSession((session) => {
      assertJuno106FeatureEnabled();
      const identity = resolveNextTrackIdentity(session.tracks);
      const track = createDefaultJunoTrack(identity.id, options);

      return {
        ...session,
        tracks: [...session.tracks, track],
      };
    }),
  addJunoMidiClip: (trackId) =>
    manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => {
        assertJuno106FeatureEnabled();
        if (!hasJunoInstrument(track)) {
          throw new SessionStorageError(`Track ${trackId} has no Juno instrument`);
        }
        const ordinal = resolveNextMidiClipOrdinal(track);
        return {
          ...track,
          clips: [...track.clips, createStarterMidiClip(session, track, ordinal)],
        };
      }),
    ),
  addEmptyJunoMidiClip: async (trackId, options = {}) => {
    const bars = options.bars ?? DEFAULT_MIDI_CLIP_BARS;
    if (!Number.isInteger(bars) || bars < 1 || bars > MAX_MIDI_CLIP_BARS) {
      throw new RangeError(
        `MIDI clip bars must be an integer between 1 and ${MAX_MIDI_CLIP_BARS}`,
      );
    }

    return manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => {
        assertJuno106FeatureEnabled();
        if (!hasJunoInstrument(track)) {
          throw new SessionStorageError(`Track ${trackId} has no Juno instrument`);
        }
        const ordinal = resolveNextMidiClipOrdinal(track);
        return {
          ...track,
          clips: [...track.clips, createEmptyMidiClip(session, track, ordinal, options)],
        };
      }),
    );
  },
  createJunoMidiScene: async (options = {}) => {
    const bars = options.bars ?? DEFAULT_MIDI_CLIP_BARS;
    if (!Number.isInteger(bars) || bars < 1 || bars > MAX_MIDI_CLIP_BARS) {
      throw new RangeError(
        `MIDI clip bars must be an integer between 1 and ${MAX_MIDI_CLIP_BARS}`,
      );
    }

    return manager.updateSession((session) => {
      assertJuno106FeatureEnabled();
      const startMs = resolveGlobalAppendStart(session);
      const beats = Math.max(
        1,
        quarterNoteBeatsPerBar(session.metadata.timeSignature) * bars,
      );
      const durationMs = Math.max(1, Math.round(beats * (60000 / session.metadata.bpm)));
      const sceneName =
        options.name?.trim() || `Scene ${resolveNextSceneOrdinal(session)}`;
      const existingTrackIndex = session.tracks.findIndex(hasJunoInstrument);

      if (existingTrackIndex >= 0) {
        const track = session.tracks[existingTrackIndex];
        const ordinal = resolveNextMidiClipOrdinal(track);
        const clip = createAlignedEmptyMidiClip(
          track,
          ordinal,
          startMs,
          durationMs,
          sceneName,
        );
        return {
          ...session,
          tracks: session.tracks.map((candidate, index) =>
            index === existingTrackIndex
              ? { ...track, clips: [...track.clips, clip] }
              : candidate,
          ),
        };
      }

      const identity = resolveNextTrackIdentity(session.tracks);
      const track = createDefaultJunoTrack(identity.id, { name: options.trackName });
      const clip = createAlignedEmptyMidiClip(
        track,
        resolveNextMidiClipOrdinal(track),
        startMs,
        durationMs,
        sceneName,
      );
      return {
        ...session,
        tracks: [...session.tracks, { ...track, clips: [clip] }],
      };
    });
  },
  addJunoScenePart: async (options) => {
    validateSceneTiming(options.startMs, options.durationMs);
    return manager.updateSession((session) => {
      assertJuno106FeatureEnabled();
      const identity = resolveNextTrackIdentity(session.tracks);
      const track = createDefaultJunoTrack(identity.id, { name: options.trackName });
      const clip = createAlignedEmptyMidiClip(
        track,
        resolveNextMidiClipOrdinal(track),
        options.startMs,
        options.durationMs,
        options.name?.trim() || `Scene Part ${identity.ordinal}`,
      );
      return {
        ...session,
        tracks: [...session.tracks, { ...track, clips: [clip] }],
      };
    });
  },
  duplicateJunoMidiScene: async (options) => {
    validateSceneTiming(options.startMs, options.durationMs);
    return manager.updateSession((session) => {
      assertJuno106FeatureEnabled();
      const targetStartMs = resolveGlobalAppendStart(session);
      let duplicatedCount = 0;
      const tracks = session.tracks.map((track) => {
        if (!hasJunoInstrument(track)) {
          return track;
        }
        const result = duplicateAlignedMidiClips(
          track,
          options.startMs,
          options.durationMs,
          targetStartMs,
        );
        duplicatedCount += result.duplicatedCount;
        return result.track;
      });
      if (duplicatedCount === 0) {
        throw new SessionStorageError(
          `No Juno MIDI scene found at ${options.startMs} ms with duration ${options.durationMs} ms`,
        );
      }
      return { ...session, tracks };
    });
  },
  setMidiClipNotes: async (trackId, clipId, notes) => {
    validateMidiNotes(notes);
    return manager.updateSession((session) =>
      replaceMidiClipNotes(session, trackId, clipId, notes),
    );
  },
  clearMidiClip: (trackId, clipId) =>
    manager.updateSession((session) =>
      replaceMidiClipNotes(session, trackId, clipId, []),
    ),
  setTempo: async (bpm) => {
    assertFiniteRange('Tempo BPM', bpm, MIN_BPM, MAX_BPM);
    return manager.updateSession((session) => {
      const midiTimingScale = session.metadata.bpm / bpm;
      return {
        ...session,
        tracks: session.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => {
            const hasAudio =
              typeof clip.audioFile === 'string' && clip.audioFile.trim().length > 0;
            if (!clip.midi || hasAudio) {
              return clip;
            }
            return {
              ...clip,
              start: clip.start * midiTimingScale,
              duration: clip.duration * midiTimingScale,
            };
          }),
        })),
        metadata: {
          ...session.metadata,
          bpm,
        },
      };
    });
  },
  setTrackVolume: async (trackId, volumeDb) => {
    assertFiniteRange('Track volume', volumeDb, MIN_TRACK_VOLUME_DB, MAX_TRACK_VOLUME_DB);
    return manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => ({ ...track, volume: volumeDb })),
    );
  },
  setTrackPan: async (trackId, pan) => {
    assertFiniteRange('Track pan', pan, MIN_TRACK_PAN, MAX_TRACK_PAN);
    return manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => ({ ...track, pan })),
    );
  },
  undo: () => manager.undo(),
  redo: () => manager.redo(),
  setJunoParameter: (trackId, parameter, value) => {
    if (!Number.isFinite(value)) {
      return Promise.reject(new Error(`Juno parameter ${parameter} must be finite`));
    }
    return manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => {
        assertJuno106FeatureEnabled();
        const graph = track.routing.graph;
        if (!graph) {
          throw new SessionStorageError(`Track ${trackId} has no Juno instrument`);
        }
        let instrumentFound = false;
        const nodes = graph.nodes.map((node) => {
          if (node.type !== 'instrument' || node.instrumentType !== 'juno106') {
            return node;
          }
          instrumentFound = true;
          return {
            ...node,
            parameters: {
              ...node.parameters,
              [parameter]: value,
            },
            preset: undefined,
          };
        });
        if (!instrumentFound) {
          throw new SessionStorageError(`Track ${trackId} has no Juno instrument`);
        }
        return {
          ...track,
          routing: {
            ...track.routing,
            graph: { ...graph, nodes },
          },
        };
      }),
    );
  },
  applyJunoPreset: (trackId, preset) => {
    validateJuno106Preset(preset);
    return manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => {
        assertJuno106FeatureEnabled();
        const graph = track.routing.graph;
        if (!graph) {
          throw new SessionStorageError(`Track ${trackId} has no Juno instrument`);
        }
        let instrumentFound = false;
        const nodes = graph.nodes.map((node) => {
          if (node.type !== 'instrument' || node.instrumentType !== 'juno106') {
            return node;
          }
          instrumentFound = true;
          return {
            ...node,
            parameters: { ...preset.parameters },
            preset: {
              id: preset.id,
              version: preset.version,
              name: preset.name,
            },
          };
        });
        if (!instrumentFound) {
          throw new SessionStorageError(`Track ${trackId} has no Juno instrument`);
        }
        return {
          ...track,
          routing: {
            ...track.routing,
            graph: { ...graph, nodes },
          },
        };
      }),
    );
  },
  setTrackMuted: (trackId, muted) =>
    manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => ({ ...track, muted })),
    ),
  setTrackSolo: (trackId, solo) =>
    manager.updateSession((session) =>
      updateTrack(session, trackId, (track) => ({ ...track, solo })),
    ),
});
