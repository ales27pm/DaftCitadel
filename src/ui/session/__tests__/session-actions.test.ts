import {
  createEmptySession,
  InMemorySessionStorageAdapter,
  listBuiltInJuno106Presets,
  SessionManager,
  SessionStorageError,
  type Clip,
  type MidiNoteEvent,
  type Session,
  type Track,
} from '../../../session';
import { createSessionActions } from '../session-actions';

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

const createAudioClip = (id: string, start: number, duration: number): Clip => ({
  id,
  name: id,
  start,
  duration,
  audioFile: `${id}.wav`,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  automationCurveIds: [],
});

const createManager = async (tracks: Track[] = []): Promise<SessionManager> => {
  const storage = new InMemorySessionStorageAdapter();
  await storage.initialize();
  const manager = new SessionManager(storage, {
    applySessionUpdate: async () => undefined,
    resetSession: async () => undefined,
  });
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

  it('adds a persisted Juno track with deterministic identity and parameter overrides', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);

    const updated = await actions.addJunoTrack({
      name: '  Synth Lead  ',
      parameters: { cutoffHz: 2400, chorusMode: 2 },
      preset: { id: 'bright-lead', name: 'Bright Lead', version: 1 },
    });
    const addedTrack = updated.tracks.at(-1);
    const instrument = addedTrack?.routing.graph?.nodes.find(
      (node) => node.type === 'instrument',
    );

    expect(addedTrack).toMatchObject({
      id: 'track-2',
      name: 'Synth Lead',
      clips: [],
      muted: false,
      solo: false,
      volume: 0,
      pan: 0,
    });
    expect(instrument).toMatchObject({
      id: 'track-2:instrument:juno106',
      type: 'instrument',
      instrumentType: 'juno106',
      parameters: expect.objectContaining({
        pulseWidth: 0.5,
        cutoffHz: 2400,
        chorusMode: 2,
        outputGain: 0.2,
      }),
      preset: { id: 'bright-lead', name: 'Bright Lead', version: 1 },
    });
    expect(manager.getSession()?.tracks.at(-1)).toEqual(addedTrack);
  });

  it('adds a playable four-bar MIDI starter clip to a Juno track', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();

    const updated = await actions.addJunoMidiClip('track-1');
    const clip = updated.tracks[0].clips[0];

    expect(clip).toMatchObject({
      id: 'track-1:clip:midi-1',
      name: 'Starter Pattern 1',
      start: 0,
      duration: 8000,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      automationCurveIds: [],
      midi: { pulsesPerQuarter: 480 },
    });
    expect(clip.midi?.notes).toHaveLength(16);
    expect(clip.midi?.notes[0]).toEqual({
      id: 'note-1',
      pitch: 48,
      startBeat: 0,
      durationBeats: 0.75,
      velocity: 108,
    });
    expect(manager.getSession()?.tracks[0].clips[0]).toEqual(clip);
  });

  it('appends uniquely identified MIDI clips and rejects tracks without a Juno', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();
    await actions.addJunoMidiClip('track-2');
    const updated = await actions.addJunoMidiClip('track-2');

    expect(updated.tracks[1].clips).toEqual([
      expect.objectContaining({ id: 'track-2:clip:midi-1', start: 0, duration: 8000 }),
      expect.objectContaining({
        id: 'track-2:clip:midi-2',
        start: 8000,
        duration: 8000,
      }),
    ]);
    await expect(actions.addJunoMidiClip('track-1')).rejects.toEqual(
      expect.objectContaining<Partial<SessionStorageError>>({
        message: 'Track track-1 has no Juno instrument',
      }),
    );
  });

  it('adds empty Juno MIDI clips using the session meter, tempo, and append position', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();

    const firstUpdate = await actions.addEmptyJunoMidiClip('track-1');
    const secondUpdate = await actions.addEmptyJunoMidiClip('track-1', {
      name: '  Verse Loop  ',
      bars: 2,
    });

    expect(firstUpdate.tracks[0].clips[0]).toEqual({
      id: 'track-1:clip:midi-1',
      name: 'MIDI Loop 1',
      start: 0,
      duration: 2000,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      automationCurveIds: [],
      midi: { pulsesPerQuarter: 480, notes: [] },
    });
    expect(secondUpdate.tracks[0].clips[1]).toMatchObject({
      id: 'track-1:clip:midi-2',
      name: 'Verse Loop',
      start: 2000,
      duration: 4000,
      midi: { notes: [] },
    });
    expect(manager.getSession()?.tracks[0].clips).toEqual(secondUpdate.tracks[0].clips);
  });

  it('uses the current non-four-four meter and tempo for an empty MIDI clip', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();
    await manager.updateSession((session) => ({
      ...session,
      metadata: { ...session.metadata, bpm: 90, timeSignature: '3/4' },
    }));

    const updated = await actions.addEmptyJunoMidiClip('track-1', { bars: 2 });

    expect(updated.tracks[0].clips[0]).toMatchObject({ start: 0, duration: 4000 });
  });

  it('atomically creates a globally appended Juno MIDI scene and its track', async () => {
    const audioTrack = createTrack('track-1');
    audioTrack.clips = [createAudioClip('intro', 500, 2500)];
    const manager = await createManager([audioTrack]);
    const actions = createSessionActions(manager);
    const before = manager.getSession();

    const updated = await actions.createJunoMidiScene({
      bars: 2,
      name: '  Verse  ',
      trackName: '  Scene Juno  ',
    });

    expect(updated.revision).toBe((before?.revision ?? 0) + 1);
    expect(updated.tracks).toHaveLength(2);
    expect(updated.tracks[1]).toMatchObject({ id: 'track-2', name: 'Scene Juno' });
    expect(updated.tracks[1].routing.graph?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'instrument', instrumentType: 'juno106' }),
      ]),
    );
    expect(updated.tracks[1].clips).toEqual([
      expect.objectContaining({
        id: 'track-2:clip:midi-1',
        name: 'Verse',
        start: 3000,
        duration: 4000,
        midi: { pulsesPerQuarter: 480, notes: [] },
      }),
    ]);

    const undone = await actions.undo();
    expect(undone?.tracks).toEqual(before?.tracks);
  });

  it('reuses the first Juno track and assigns deterministic scene identities', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack({ name: 'Existing Juno' });

    const first = await actions.createJunoMidiScene({ trackName: 'Ignored Name' });
    const second = await actions.createJunoMidiScene();

    expect(first.tracks).toHaveLength(1);
    expect(second.tracks).toHaveLength(1);
    expect(second.tracks[0].name).toBe('Existing Juno');
    expect(second.tracks[0].clips).toEqual([
      expect.objectContaining({
        id: 'track-1:clip:midi-1',
        name: 'Scene 1',
        start: 0,
        duration: 2000,
      }),
      expect.objectContaining({
        id: 'track-1:clip:midi-2',
        name: 'Scene 2',
        start: 2000,
        duration: 2000,
      }),
    ]);
  });

  it('atomically adds an exactly aligned scene part on a new Juno track', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);
    const before = manager.getSession();

    const updated = await actions.addJunoScenePart({
      startMs: 1250.5,
      durationMs: 3333.25,
      name: '  Bass Part  ',
      trackName: '  Bass Juno  ',
    });

    expect(updated.revision).toBe((before?.revision ?? 0) + 1);
    expect(updated.tracks[1]).toMatchObject({ id: 'track-2', name: 'Bass Juno' });
    expect(updated.tracks[1].clips).toEqual([
      expect.objectContaining({
        id: 'track-2:clip:midi-1',
        name: 'Bass Part',
        start: 1250.5,
        duration: 3333.25,
        midi: { pulsesPerQuarter: 480, notes: [] },
      }),
    ]);
    expect(
      updated.tracks[1].routing.graph?.nodes.some(
        (node) => node.type === 'instrument' && node.instrumentType === 'juno106',
      ),
    ).toBe(true);

    expect((await actions.undo())?.tracks).toEqual(before?.tracks);
  });

  it('duplicates every aligned Juno MIDI scene part at one global append point', async () => {
    const audioTrack = createTrack('track-1');
    audioTrack.clips = [createAudioClip('intro', 5000, 1000)];
    const manager = await createManager([audioTrack]);
    const actions = createSessionActions(manager);
    await actions.createJunoMidiScene({ name: 'Lead' });
    await actions.addJunoScenePart({
      startMs: 6000,
      durationMs: 2000,
      name: 'Bass',
      trackName: 'Bass Juno',
    });
    await actions.setMidiClipNotes('track-2', 'track-2:clip:midi-1', [
      { id: 'lead-note', pitch: 72, startBeat: 0, durationBeats: 1, velocity: 110 },
    ]);
    await actions.setMidiClipNotes('track-3', 'track-3:clip:midi-1', [
      { id: 'bass-note', pitch: 48, startBeat: 0, durationBeats: 2, velocity: 96 },
    ]);
    await manager.updateSession((session) => {
      session.tracks[0].clips.push(createAudioClip('outro', 10000, 500));
    });
    const before = manager.getSession();

    const updated = await actions.duplicateJunoMidiScene({
      startMs: 6000,
      durationMs: 2000,
    });
    const leadSource = updated.tracks[1].clips[0];
    const leadCopy = updated.tracks[1].clips[1];
    const bassSource = updated.tracks[2].clips[0];
    const bassCopy = updated.tracks[2].clips[1];

    expect(updated.revision).toBe((before?.revision ?? 0) + 1);
    expect(leadCopy).toMatchObject({
      id: 'track-2:clip:midi-2',
      name: 'Lead Copy',
      start: 10500,
      duration: 2000,
      midi: { notes: [{ id: 'lead-note', pitch: 72 }] },
    });
    expect(bassCopy).toMatchObject({
      id: 'track-3:clip:midi-2',
      name: 'Bass Copy',
      start: 10500,
      duration: 2000,
      midi: { notes: [{ id: 'bass-note', pitch: 48 }] },
    });
    expect(leadCopy.midi).not.toBe(leadSource.midi);
    expect(leadCopy.midi?.notes[0]).not.toBe(leadSource.midi?.notes[0]);
    expect(bassCopy.midi).not.toBe(bassSource.midi);

    const undone = await actions.undo();
    expect(undone?.tracks).toEqual(before?.tracks);
  });

  it('rejects invalid scene timing and missing duplicate sources atomically', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);
    const before = manager.getSession();

    await expect(actions.createJunoMidiScene({ bars: 0 })).rejects.toThrow(
      'MIDI clip bars must be an integer between 1 and 64',
    );
    await expect(
      actions.addJunoScenePart({ startMs: -1, durationMs: 2000 }),
    ).rejects.toThrow('Scene startMs must be finite and non-negative');
    await expect(
      actions.addJunoScenePart({ startMs: 0, durationMs: Number.NaN }),
    ).rejects.toThrow('Scene durationMs must be finite and positive');
    await expect(
      actions.duplicateJunoMidiScene({ startMs: 0, durationMs: 2000 }),
    ).rejects.toThrow('No Juno MIDI scene found at 0 ms with duration 2000 ms');
    expect(manager.getSession()).toEqual(before);
  });

  it('rejects invalid empty-clip lengths and tracks without a Juno', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);
    const before = manager.getSession();

    await expect(actions.addEmptyJunoMidiClip('track-1', { bars: 0 })).rejects.toThrow(
      'MIDI clip bars must be an integer between 1 and 64',
    );
    await expect(actions.addEmptyJunoMidiClip('track-1')).rejects.toEqual(
      expect.objectContaining<Partial<SessionStorageError>>({
        message: 'Track track-1 has no Juno instrument',
      }),
    );
    expect(manager.getSession()).toEqual(before);
  });

  it('atomically replaces and clears MIDI clip notes', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();
    await actions.addEmptyJunoMidiClip('track-1');
    const notes: MidiNoteEvent[] = [
      {
        id: 'note-late',
        pitch: 67,
        startBeat: 1,
        durationBeats: 0.5,
        velocity: 102,
      },
      {
        id: 'note-early',
        pitch: 60,
        startBeat: 0,
        durationBeats: 0.25,
        velocity: 96,
      },
    ];

    const updated = await actions.setMidiClipNotes(
      'track-1',
      'track-1:clip:midi-1',
      notes,
    );

    expect(updated.tracks[0].clips[0].midi?.notes).toEqual([
      expect.objectContaining({ id: 'note-early', startBeat: 0 }),
      expect.objectContaining({ id: 'note-late', startBeat: 1 }),
    ]);
    const cleared = await actions.clearMidiClip('track-1', 'track-1:clip:midi-1');
    expect(cleared.tracks[0].clips[0].midi?.notes).toEqual([]);
    expect(manager.getSession()?.tracks[0].clips[0].midi?.notes).toEqual([]);
  });

  it('rejects missing and non-MIDI clips without changing the session', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();
    await manager.updateSession((session) => {
      session.tracks[0].clips.push({
        id: 'audio-clip',
        name: 'Audio clip',
        start: 0,
        duration: 1000,
        audioFile: 'audio.wav',
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        automationCurveIds: [],
      });
    });
    const before = manager.getSession();

    await expect(actions.setMidiClipNotes('track-1', 'missing-clip', [])).rejects.toThrow(
      'Clip missing-clip not found on track track-1',
    );
    await expect(actions.setMidiClipNotes('track-1', 'audio-clip', [])).rejects.toThrow(
      'Clip audio-clip is not a MIDI clip',
    );
    expect(manager.getSession()).toEqual(before);
  });

  it('rejects invalid MIDI note fields without applying a partial edit', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();
    await actions.addEmptyJunoMidiClip('track-1');
    const before = manager.getSession();
    const baseNote: MidiNoteEvent = {
      id: 'note-1',
      pitch: 60,
      startBeat: 0,
      durationBeats: 0.25,
      velocity: 100,
    };
    const invalidNotes: Array<{ note: MidiNoteEvent; message: string }> = [
      {
        note: { ...baseNote, pitch: 128 },
        message: 'MIDI note pitch must be an integer between 0 and 127',
      },
      {
        note: { ...baseNote, velocity: -1 },
        message: 'MIDI note velocity must be an integer between 0 and 127',
      },
      {
        note: { ...baseNote, startBeat: Number.NaN },
        message: 'MIDI note startBeat must be finite and non-negative',
      },
      {
        note: { ...baseNote, durationBeats: 0 },
        message: 'MIDI note durationBeats must be finite and positive',
      },
    ];

    for (const { note, message } of invalidNotes) {
      await expect(
        actions.setMidiClipNotes('track-1', 'track-1:clip:midi-1', [note]),
      ).rejects.toThrow(message);
    }
    expect(manager.getSession()).toEqual(before);
  });

  it('persists bounded tempo, volume, and pan edits', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);

    await actions.setTempo(132);
    await actions.setTrackVolume('track-1', -9);
    const updated = await actions.setTrackPan('track-1', 0.25);

    expect(updated.metadata.bpm).toBe(132);
    expect(updated.tracks[0]).toMatchObject({ volume: -9, pan: 0.25 });
    expect(manager.getSession()).toMatchObject({
      metadata: { bpm: 132 },
      tracks: [expect.objectContaining({ volume: -9, pan: 0.25 })],
    });
  });

  it('retimes MIDI clips with tempo while leaving audio milliseconds and notes intact', async () => {
    const audioTrack = createTrack('track-1');
    audioTrack.clips = [createAudioClip('audio-clip', 1000, 500)];
    const manager = await createManager([audioTrack]);
    const actions = createSessionActions(manager);
    await actions.createJunoMidiScene({ name: 'Pattern A' });
    await actions.createJunoMidiScene({ name: 'Pattern B' });
    await actions.setMidiClipNotes('track-2', 'track-2:clip:midi-1', [
      {
        id: 'note-1',
        pitch: 60,
        startBeat: 1.25,
        durationBeats: 0.5,
        velocity: 100,
      },
    ]);
    const beforeTempo = manager.getSession();

    const updated = await actions.setTempo(240);

    expect(updated.metadata.bpm).toBe(240);
    expect(updated.tracks[0].clips[0]).toMatchObject({ start: 1000, duration: 500 });
    expect(updated.tracks[1].clips).toEqual([
      expect.objectContaining({
        id: 'track-2:clip:midi-1',
        start: 750,
        duration: 1000,
        midi: expect.objectContaining({
          notes: [
            {
              id: 'note-1',
              pitch: 60,
              startBeat: 1.25,
              durationBeats: 0.5,
              velocity: 100,
            },
          ],
        }),
      }),
      expect.objectContaining({
        id: 'track-2:clip:midi-2',
        start: 1750,
        duration: 1000,
      }),
    ]);

    const undone = await actions.undo();
    expect(undone?.metadata.bpm).toBe(120);
    expect(undone?.tracks).toEqual(beforeTempo?.tracks);
    const redone = await actions.redo();
    expect(redone?.metadata.bpm).toBe(240);
    expect(redone?.tracks[0].clips[0]).toMatchObject({ start: 1000, duration: 500 });
    expect(redone?.tracks[1].clips[1]).toMatchObject({
      start: 1750,
      duration: 1000,
    });
  });

  it('rejects out-of-range tempo, volume, and pan edits', async () => {
    const manager = await createManager([createTrack('track-1')]);
    const actions = createSessionActions(manager);
    const before = manager.getSession();

    await expect(actions.setTempo(301)).rejects.toThrow(
      'Tempo BPM must be between 20 and 300',
    );
    await expect(actions.setTrackVolume('track-1', -61)).rejects.toThrow(
      'Track volume must be between -60 and 12',
    );
    await expect(
      actions.setTrackPan('track-1', Number.POSITIVE_INFINITY),
    ).rejects.toThrow('Track pan must be between -1 and 1');
    expect(manager.getSession()).toEqual(before);
  });

  it('exposes session-manager undo and redo semantics', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);

    expect(await actions.undo()).toBeNull();
    await actions.setTempo(128);
    expect((await actions.undo())?.metadata.bpm).toBe(120);
    expect((await actions.redo())?.metadata.bpm).toBe(128);
  });

  it('persists Juno parameter edits through the session manager', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();

    const updated = await actions.setJunoParameter('track-1', 'cutoffHz', 3250);
    const instrument = updated.tracks[0].routing.graph?.nodes.find(
      (node) => node.type === 'instrument',
    );

    expect(instrument?.type === 'instrument' && instrument.parameters.cutoffHz).toBe(
      3250,
    );
    expect(instrument?.type === 'instrument' && instrument.preset).toBeUndefined();
    expect(
      manager
        .getSession()
        ?.tracks[0].routing.graph?.nodes.find((node) => node.type === 'instrument'),
    ).toMatchObject({ parameters: expect.objectContaining({ cutoffHz: 3250 }) });
  });

  it('applies a versioned Juno preset to the persisted instrument', async () => {
    const manager = await createManager();
    const actions = createSessionActions(manager);
    await actions.addJunoTrack();
    const preset = listBuiltInJuno106Presets()[1];

    const updated = await actions.applyJunoPreset('track-1', preset);
    const instrument = updated.tracks[0].routing.graph?.nodes.find(
      (node) => node.type === 'instrument',
    );

    expect(instrument).toMatchObject({
      parameters: preset.parameters,
      preset: { id: preset.id, name: preset.name, version: preset.version },
    });
  });

  it('rejects Juno parameter edits for tracks without an instrument', async () => {
    const manager = await createManager([createTrack('track-1')]);

    await expect(
      createSessionActions(manager).setJunoParameter('track-1', 'resonance', 0.4),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SessionStorageError>>({
        message: 'Track track-1 has no Juno instrument',
      }),
    );
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
