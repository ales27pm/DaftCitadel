import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import { PerformanceScreen } from '../PerformanceScreen';

jest.mock('../../session', () => ({
  useInstrumentControls: jest.fn(),
  useProjectedTransport: jest.fn(),
  useSessionActions: jest.fn(),
  useSessionViewModel: jest.fn(),
  useTransportControls: jest.fn(),
}));

jest.mock('../../settings', () => ({
  useUserPreferences: jest.fn(),
}));

jest.mock('../../layout', () => ({
  useAdaptiveLayout: jest.fn(),
}));

const {
  useInstrumentControls,
  useProjectedTransport,
  useSessionActions,
  useSessionViewModel,
  useTransportControls,
} = jest.requireMock('../../session');
const { useUserPreferences } = jest.requireMock('../../settings');
const { useAdaptiveLayout } = jest.requireMock('../../layout');

const play = jest.fn(async () => undefined);
const stop = jest.fn(async () => undefined);
const locateStart = jest.fn(async () => undefined);
const locateBeats = jest.fn(async () => undefined);
const setLoopBeats = jest.fn(async () => undefined);
const refresh = jest.fn(async () => undefined);
const sendInstrumentMidi = jest.fn(async () => undefined);
const allNotesOff = jest.fn(async () => undefined);
const addJunoTrack = jest.fn();
const addEmptyJunoMidiClip = jest.fn();
const createJunoMidiScene = jest.fn();
const addJunoScenePart = jest.fn();
const duplicateJunoMidiScene = jest.fn();
const setMidiClipNotes = jest.fn(async () => undefined);
const clearMidiClip = jest.fn(async () => undefined);
const setTrackMuted = jest.fn(async () => undefined);
const setTrackSolo = jest.fn(async () => undefined);
const setTrackVolume = jest.fn(async () => undefined);
const setJunoParameter = jest.fn(async () => undefined);
const applyJunoPreset = jest.fn(async () => undefined);

const instrumentParameters = {
  pulseWidth: 0.5,
  subLevel: 0,
  cutoffHz: 1000,
  resonance: 0.1,
  attackSeconds: 0.01,
  releaseSeconds: 0.5,
  chorusMode: 1,
  outputGain: 0.2,
  lfoRateHz: 0.8,
  lfoDepth: 0,
};

const junoTrack = {
  id: 'track-juno',
  name: 'Juno Loops',
  color: '#76E7CB',
  muted: false,
  solo: false,
  volumeDb: 0,
  pan: 0,
  automationCurves: [],
  clips: [
    {
      id: 'loop-1',
      name: 'Loop 1',
      startMs: 0,
      durationMs: 2000,
      midiNotes: [],
    },
  ],
  waveform: new Float32Array(),
  midiNotes: [],
  meterLevel: 0,
  plugins: [],
  instrument: {
    nodeId: 'track-juno:instrument:juno106',
    instrumentType: 'juno106',
    parameters: instrumentParameters,
  },
};

const transport = {
  bpm: 120,
  timeSignature: '4/4',
  lengthBeats: 32,
  totalBars: 8,
  playheadBeats: 0,
  playheadRatio: 0,
  isPlaying: false,
  diagnosticsGate: false,
};

const renderScreen = async () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      <ThemeProvider>
        <PerformanceScreen />
      </ThemeProvider>,
    );
    await Promise.resolve();
  });
  if (!renderer) {
    throw new Error('Renderer not initialized');
  }
  return renderer;
};

describe('PerformanceScreen Juno looper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      sessionName: 'Night Drive',
      transport,
      tracks: [junoTrack],
      diagnostics: { status: 'ready', xruns: 0, renderLoad: 0.2 },
      refresh,
    });
    useProjectedTransport.mockReturnValue({ projectedBeats: 0, projectedRatio: 0 });
    useTransportControls.mockReturnValue({
      play,
      stop,
      locateBeats,
      locateStart,
      setLoopBeats,
      setLoopFrames: jest.fn(async () => undefined),
      isAvailable: true,
      isLoopAvailable: true,
      isPlaying: false,
      transport,
      transportRuntime: { sampleRate: 48000 },
    });
    useInstrumentControls.mockReturnValue({
      isAvailable: true,
      sendInstrumentMidi,
      setInstrumentParameter: jest.fn(async () => undefined),
      allNotesOff,
    });
    useSessionActions.mockReturnValue({
      addJunoTrack,
      addEmptyJunoMidiClip,
      addJunoScenePart,
      createJunoMidiScene,
      duplicateJunoMidiScene,
      setMidiClipNotes,
      clearMidiClip,
      setTrackMuted,
      setTrackSolo,
      setTrackVolume,
      setJunoParameter,
      applyJunoPreset,
    });
    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: true, showDiagnostics: true },
    });
    useAdaptiveLayout.mockReturnValue({
      width: 390,
      height: 844,
      breakpoint: 'phone',
      orientation: 'portrait',
      isTablet: false,
      isLandscape: false,
      workspaceMode: 'deck',
      contentPadding: 16,
      maxContentWidth: 390,
      prefersReducedMotion: false,
      screenReaderEnabled: false,
      platform: 'ios',
    });
    addJunoTrack.mockResolvedValue({
      tracks: [
        {
          id: 'track-new',
          routing: {
            graph: {
              nodes: [{ type: 'instrument', instrumentType: 'juno106' }],
            },
          },
        },
      ],
    });
    addEmptyJunoMidiClip.mockResolvedValue({
      tracks: [{ id: 'track-new', clips: [{ id: 'loop-new' }] }],
    });
    createJunoMidiScene.mockResolvedValue({
      tracks: [
        {
          id: 'track-new',
          clips: [
            {
              id: 'loop-new',
              name: 'Scene 2 · Part 1',
              start: 2000,
              duration: 2000,
              midi: { notes: [] },
            },
          ],
          routing: {
            graph: {
              nodes: [{ type: 'instrument', instrumentType: 'juno106' }],
            },
          },
        },
      ],
    });
    addJunoScenePart.mockResolvedValue({ tracks: [] });
    duplicateJunoMidiScene.mockResolvedValue({ tracks: [] });
  });

  it('renders a complete 4x4 scene grid and launches a native loop', async () => {
    const renderer = await renderScreen();
    expect(renderer.root.findAllByProps({ testID: 'juno-scene-pad' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ testID: 'juno-add-scene-pad' })).toHaveLength(
      15,
    );

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Scene 1, 1 part' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setLoopBeats).toHaveBeenCalledWith(0, 4, true);
    expect(locateBeats).toHaveBeenCalledWith(0);
    expect(play).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('selects without playback when auto-play is off and keeps an explicit launch', async () => {
    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: false, showDiagnostics: true },
    });
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Scene 1, 1 part' })
        .props.onPress();
      await Promise.resolve();
    });
    expect(setLoopBeats).not.toHaveBeenCalled();

    await act(async () => {
      renderer.root.findByProps({ testID: 'launch-juno-scene' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setLoopBeats).toHaveBeenCalledWith(0, 4, true);
    renderer.unmount();
  });

  it('creates a routed Juno scene from an empty pad', async () => {
    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      tracks: [],
    });
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Add scene 1' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createJunoMidiScene).toHaveBeenCalledWith({
      bars: 1,
      name: 'Scene 1 · Part 1',
      trackName: 'Juno Part 1',
    });
    renderer.unmount();
  });

  it('groups aligned Juno clips into one scene and targets the selected part', async () => {
    const chordTrack = {
      ...junoTrack,
      id: 'track-chords',
      name: 'Juno Chords',
      clips: [
        {
          id: 'loop-chords',
          name: 'Chords',
          startMs: 0,
          durationMs: 2000,
          midiNotes: [],
        },
      ],
      instrument: {
        ...junoTrack.instrument,
        nodeId: 'juno-chords-node',
      },
    };
    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      tracks: [junoTrack, chordTrack],
    });
    const renderer = await renderScreen();

    expect(renderer.root.findAllByProps({ testID: 'juno-scene-pad' })).toHaveLength(1);
    const partButtons = renderer.root
      .findAllByProps({ testID: 'juno-scene-part' })
      .filter((candidate) => typeof candidate.props.onPress === 'function');
    expect(
      new Set(partButtons.map((candidate) => candidate.props.accessibilityLabel)),
    ).toEqual(new Set(['Edit Juno Loops in Scene 1', 'Edit Juno Chords in Scene 1']));
    const chordButton = partButtons.find(
      (candidate) => candidate.props.accessibilityLabel === 'Edit Juno Chords in Scene 1',
    );
    expect(chordButton).toBeDefined();

    await act(async () => {
      chordButton?.props.onPress();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Play Juno C4' }).props.onPressIn();
      await Promise.resolve();
    });

    expect(sendInstrumentMidi).toHaveBeenCalledWith('juno-chords-node', {
      type: 0,
      channel: 0,
      data1: 60,
      data2: 100,
    });
    renderer.unmount();
  });

  it('adds an aligned part and duplicates the complete selected scene', async () => {
    addJunoScenePart.mockResolvedValue({
      tracks: [
        {
          id: 'track-part-2',
          clips: [
            {
              id: 'loop-part-2',
              start: 0,
              duration: 2000,
              midi: { notes: [] },
            },
          ],
          routing: {
            graph: {
              nodes: [{ type: 'instrument', instrumentType: 'juno106' }],
            },
          },
        },
      ],
    });
    duplicateJunoMidiScene.mockResolvedValue({
      tracks: [
        {
          id: 'track-juno',
          clips: [
            { id: 'loop-1', start: 0, duration: 2000, midi: { notes: [] } },
            { id: 'loop-2', start: 2000, duration: 2000, midi: { notes: [] } },
          ],
          routing: {
            graph: {
              nodes: [{ type: 'instrument', instrumentType: 'juno106' }],
            },
          },
        },
      ],
    });
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root.findByProps({ testID: 'add-juno-scene-part' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addJunoScenePart).toHaveBeenCalledWith({
      durationMs: 2000,
      name: 'Scene 1 · Part 2',
      startMs: 0,
      trackName: 'Juno Part 2',
    });

    await act(async () => {
      renderer.root.findByProps({ testID: 'duplicate-juno-scene' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(duplicateJunoMidiScene).toHaveBeenCalledWith({
      durationMs: 2000,
      startMs: 0,
    });
    renderer.unmount();
  });

  it('records touch-keyboard notes into the selected persisted MIDI clip', async () => {
    let timestamp = 1000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      timestamp += 125;
      return timestamp;
    });
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root.findByProps({ testID: 'record-loop' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const c4 = renderer.root.findByProps({ accessibilityLabel: 'Play Juno C4' });
    await act(async () => {
      c4.props.onPressIn();
      await Promise.resolve();
      c4.props.onPressOut();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'finish-loop-take' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setMidiClipNotes).toHaveBeenCalledWith(
      'track-juno',
      'loop-1',
      expect.arrayContaining([
        expect.objectContaining({ pitch: 60, velocity: 100, durationBeats: 0.25 }),
      ]),
    );
    nowSpy.mockRestore();
    renderer.unmount();
  });

  it('allocates collision-free note ids when overdubbing after a remount', async () => {
    let timestamp = 2000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      timestamp += 125;
      return timestamp;
    });
    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      tracks: [
        {
          ...junoTrack,
          clips: [
            {
              ...junoTrack.clips[0],
              midiNotes: [
                {
                  id: 'loop-1:take-1-1',
                  pitch: 48,
                  start: 0,
                  duration: 0.25,
                  velocity: 96,
                },
              ],
            },
          ],
        },
      ],
    });
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root.findByProps({ testID: 'overdub-loop' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    const c4 = renderer.root.findByProps({ accessibilityLabel: 'Play Juno C4' });
    await act(async () => {
      c4.props.onPressIn();
      await Promise.resolve();
      c4.props.onPressOut();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'finish-loop-take' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setMidiClipNotes).toHaveBeenCalledWith(
      'track-juno',
      'loop-1',
      expect.arrayContaining([
        expect.objectContaining({ id: 'take-1-1', pitch: 48 }),
        expect.objectContaining({ id: 'take-1-2', pitch: 60 }),
      ]),
    );
    nowSpy.mockRestore();
    renderer.unmount();
  });

  it('keeps the global transport controls wired', async () => {
    const renderer = await renderScreen();
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Play' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Rewind' }).props.onPress();
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(locateStart).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('disables record honestly when the installed native build lacks loop support', async () => {
    useTransportControls.mockReturnValue({
      ...useTransportControls(),
      isLoopAvailable: false,
    });
    const renderer = await renderScreen();
    expect(JSON.stringify(renderer.toJSON())).toContain('Dev build required');
    expect(renderer.root.findByProps({ testID: 'record-loop' }).props.disabled).toBe(
      true,
    );
    renderer.unmount();
  });

  it('surfaces transport failures and retries a failed session load', async () => {
    play.mockRejectedValueOnce(new Error('Audio output is unavailable'));
    const renderer = await renderScreen();
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Play' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('Audio output is unavailable');
    renderer.unmount();

    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      status: 'error',
      error: new Error('Session database is unavailable'),
    });
    const failedRenderer = await renderScreen();
    await act(async () => {
      failedRenderer.root.findByProps({ accessibilityLabel: 'Retry' }).props.onPress();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    failedRenderer.unmount();
  });
});
