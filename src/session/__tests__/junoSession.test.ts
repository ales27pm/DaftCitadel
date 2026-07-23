import {
  JUNO106_DEFAULT_PARAMETERS,
  createDefaultJunoTrack,
  createEmptySession,
  createJunoRoutingGraph,
  validateSession,
  type Clip,
  type InstrumentRoutingNode,
  type Session,
  type Track,
} from '../models';
import { deserializeSession, serializeSession } from '../serialization';
import { JunoParameterId } from '../../audio/Instruments';

const createMidiClip = (): Clip => ({
  id: 'midi-clip-1',
  name: 'Juno phrase',
  start: 0,
  duration: 2000,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  automationCurveIds: [],
  midi: {
    pulsesPerQuarter: 960,
    notes: [
      {
        id: 'note-1',
        pitch: 60,
        startBeat: 0,
        durationBeats: 1,
        velocity: 100,
      },
    ],
  },
});

const createSessionWithTrack = (track: Track): Session => ({
  ...createEmptySession('juno-session', 'Juno Session'),
  tracks: [track],
});

const findInstrument = (track: Track): InstrumentRoutingNode => {
  const node = track.routing.graph?.nodes.find(
    (candidate): candidate is InstrumentRoutingNode => candidate.type === 'instrument',
  );
  if (!node) {
    throw new Error('Juno fixture is missing its instrument node');
  }
  return node;
};

describe('Juno session model', () => {
  it('keeps LFO parameter IDs aligned with the native core', () => {
    expect(JunoParameterId.LfoRateHz).toBe(0x0009);
    expect(JunoParameterId.LfoDepth).toBe(0x000a);
  });

  it('creates a MIDI-to-Juno-to-stereo routing graph with native-aligned defaults', () => {
    const graph = createJunoRoutingGraph('juno-track');
    const track = createDefaultJunoTrack('juno-track');
    const instrument = findInstrument(track);

    expect(graph).toEqual(track.routing.graph);
    expect(instrument).toMatchObject({
      id: 'juno-track:instrument:juno106',
      type: 'instrument',
      instrumentType: 'juno106',
      parameters: JUNO106_DEFAULT_PARAMETERS,
    });
    expect(graph.connections).toEqual([
      expect.objectContaining({
        from: { nodeId: 'juno-track:input:midi' },
        to: { nodeId: 'juno-track:instrument:juno106' },
        signal: 'midi',
      }),
      expect.objectContaining({
        from: { nodeId: 'juno-track:instrument:juno106' },
        to: { nodeId: 'juno-track:output:main' },
        signal: 'audio',
      }),
    ]);
  });

  it('round-trips a MIDI-only Juno track, parameters, and versioned preset', () => {
    const track = createDefaultJunoTrack('juno-track', {
      name: 'Memory Brass',
      parameters: { cutoffHz: 2400, chorusMode: 2 },
      preset: { id: 'memory-brass', name: 'Memory Brass', version: 1 },
    });
    track.clips = [createMidiClip()];
    const session = createSessionWithTrack(track);

    const payload = serializeSession(session);
    const envelope = JSON.parse(payload) as {
      schemaVersion: number;
      session: Session;
    };
    const restored = deserializeSession(payload);

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.session.tracks[0].clips[0]).not.toHaveProperty('audioFile');
    expect(restored).toEqual(session);
    expect(findInstrument(restored.tracks[0])).toMatchObject({
      parameters: {
        ...JUNO106_DEFAULT_PARAMETERS,
        cutoffHz: 2400,
        chorusMode: 2,
      },
      preset: { id: 'memory-brass', name: 'Memory Brass', version: 1 },
    });
  });

  it('rejects clips that contain neither audio nor MIDI data', () => {
    const invalidClip: Clip = {
      id: 'empty-clip',
      name: 'Empty',
      start: 0,
      duration: 1000,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      automationCurveIds: [],
    };
    const track = createDefaultJunoTrack('juno-track');
    track.clips = [invalidClip];

    expect(() => validateSession(createSessionWithTrack(track))).toThrow(
      'Clip empty-clip must contain audio or MIDI data',
    );
  });

  it.each([
    ['non-integer pitch', { pitch: 60.5 }, 'Invalid MIDI pitch'],
    ['non-finite start', { startBeat: Number.NaN }, 'MIDI note start'],
    ['negative start', { startBeat: -0.25 }, 'MIDI note start'],
    ['non-finite duration', { durationBeats: Number.NaN }, 'MIDI note duration'],
    ['non-integer velocity', { velocity: 99.5 }, 'Invalid MIDI velocity'],
  ])('rejects %s before native scheduling', (_case, noteUpdate, expectedMessage) => {
    const track = createDefaultJunoTrack('juno-track');
    const clip = createMidiClip();
    clip.midi!.notes[0] = { ...clip.midi!.notes[0], ...noteUpdate };
    track.clips = [clip];

    expect(() => validateSession(createSessionWithTrack(track))).toThrow(expectedMessage);
  });

  it('rejects invalid MIDI PPQ before persistence', () => {
    const track = createDefaultJunoTrack('juno-track');
    const clip = createMidiClip();
    clip.midi!.pulsesPerQuarter = 0;
    track.clips = [clip];

    expect(() => validateSession(createSessionWithTrack(track))).toThrow(
      'MIDI pulsesPerQuarter must be a positive integer',
    );
  });

  it('rejects invalid persisted instrument parameters and preset versions', () => {
    const track = createDefaultJunoTrack('juno-track');
    const instrument = findInstrument(track);
    instrument.parameters.cutoffHz = Number.NaN;

    expect(() => validateSession(createSessionWithTrack(track))).toThrow(
      'Instrument node juno-track:instrument:juno106 parameter cutoffHz must be finite',
    );

    instrument.parameters.cutoffHz = JUNO106_DEFAULT_PARAMETERS.cutoffHz;
    instrument.parameters.lfoRateHz = 0;
    expect(() => validateSession(createSessionWithTrack(track))).toThrow(
      'Instrument node juno-track:instrument:juno106 parameter lfoRateHz must be between 0.05 and 20 Hz',
    );

    instrument.parameters.lfoRateHz = JUNO106_DEFAULT_PARAMETERS.lfoRateHz;
    instrument.parameters.lfoDepth = 1.1;
    expect(() => validateSession(createSessionWithTrack(track))).toThrow(
      'Instrument node juno-track:instrument:juno106 parameter lfoDepth must be between 0 and 1',
    );

    instrument.parameters.lfoDepth = JUNO106_DEFAULT_PARAMETERS.lfoDepth;
    instrument.preset = { id: 'invalid-preset', version: 0 };
    expect(() => validateSession(createSessionWithTrack(track))).toThrow(
      'Instrument node juno-track:instrument:juno106 preset version must be a positive integer',
    );
  });

  it.each([
    ['pulseWidth', 0.01],
    ['subLevel', 1.1],
    ['cutoffHz', 22000],
    ['resonance', 1.3],
    ['attackSeconds', 0],
    ['releaseSeconds', 31],
    ['outputGain', 2.1],
  ] as const)(
    'rejects persisted %s values that the native DSP would otherwise clamp',
    (parameter, value) => {
      const track = createDefaultJunoTrack('juno-track');
      findInstrument(track).parameters[parameter] = value;

      expect(() => validateSession(createSessionWithTrack(track))).toThrow(
        `parameter ${parameter} must be between`,
      );
    },
  );

  it('fills new LFO defaults while loading an older Juno parameter map', () => {
    const track = createDefaultJunoTrack('juno-track');
    const instrument = findInstrument(track);
    const legacyParameters = instrument.parameters as Partial<
      InstrumentRoutingNode['parameters']
    >;
    delete legacyParameters.lfoRateHz;
    delete legacyParameters.lfoDepth;

    const restored = deserializeSession(
      JSON.stringify({
        schemaVersion: 1,
        session: createSessionWithTrack(track),
      }),
    );

    expect(findInstrument(restored.tracks[0]).parameters).toMatchObject({
      lfoRateHz: 0.8,
      lfoDepth: 0,
    });
  });

  it('continues to deserialize schema-v1 audio-only tracks', () => {
    const legacyTrack: Track = {
      id: 'legacy-track',
      name: 'Legacy audio',
      clips: [
        {
          id: 'audio-clip',
          name: 'Audio clip',
          start: 0,
          duration: 1000,
          audioFile: 'audio.wav',
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
      routing: {},
    };
    const payload = JSON.stringify({
      schemaVersion: 1,
      session: createSessionWithTrack(legacyTrack),
    });

    const restored = deserializeSession(payload);

    expect(restored.tracks[0].clips[0].audioFile).toBe('audio.wav');
    expect(restored.tracks[0].routing.graph?.version).toBe(1);
  });
});
