import React from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import { PerformanceScreen } from '../PerformanceScreen';

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');

jest.mock('expo-symbols', () => ({
  SymbolView: 'SymbolView',
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));

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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
const scrollTo = jest.fn();

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
      {
        createNodeMock: (element) =>
          element.type === 'ScrollView' ? { scrollTo } : null,
      },
    );
    await Promise.resolve();
  });
  if (!renderer) {
    throw new Error('Renderer not initialized');
  }
  return renderer;
};

const renderedText = (renderer: TestRenderer.ReactTestRenderer): string =>
  renderer.root
    .findAllByType(Text)
    .flatMap((node) =>
      node.children.filter((child): child is string => typeof child === 'string'),
    )
    .join(' ');

const findAccessibleText = (
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): TestRenderer.ReactTestInstance => {
  const text = renderer.root
    .findAllByType(Text)
    .find((candidate) => candidate.props.testID === testID);
  if (!text) {
    throw new Error(`Accessible text ${testID} not found`);
  }
  return text;
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

  it('switches explicitly between the scene launcher and instrument workspace', async () => {
    const renderer = await renderScreen();
    const scenesTab = renderer.root.findByProps({ accessibilityLabel: 'Scenes' });
    const instrumentTab = renderer.root.findByProps({
      accessibilityLabel: 'Instrument',
    });

    expect(scenesTab.props.accessibilityRole).toBe('tab');
    expect(scenesTab.props.accessibilityState).toEqual({ selected: true });
    expect(
      renderer.root.findByProps({ testID: 'performance-scenes-panel' }).props.role,
    ).toBe('tabpanel');
    expect(renderer.root.findAllByProps({ testID: 'juno-scene-pad-grid' })).toHaveLength(
      1,
    );

    await act(async () => {
      instrumentTab.props.onPress();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Instrument' }).props
        .accessibilityState,
    ).toEqual({ selected: true });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Instrument' })).toBe(
      instrumentTab,
    );
    expect(renderer.root.findByProps({ accessibilityLabel: 'Scenes' })).toBe(scenesTab);
    expect(scrollTo).toHaveBeenCalledWith({ animated: false, y: 0 });
    expect(
      renderer.root.findByProps({ testID: 'performance-instrument-panel' }).props.role,
    ).toBe('tabpanel');
    expect(renderer.root.findAllByProps({ testID: 'juno-scene-pad-grid' })).toHaveLength(
      0,
    );
    expect(renderedText(renderer)).toContain('Juno-106');
    renderer.unmount();
  }, 15_000);

  it('renders the performance signal art as a decorative header', async () => {
    const renderer = await renderScreen();
    const header = renderer.root.findByProps({
      testID: 'performance-signal-header',
    });

    expect(header.props.accessible).toBe(false);
    expect(header.props.contentFit).toBe('cover');
    renderer.unmount();
  });

  it('honors the diagnostics visibility preference', async () => {
    const visibleRenderer = await renderScreen();
    const visibleDiagnostics = visibleRenderer.root.findAll(
      (node) => node.type === View && node.props.testID === 'performance-diagnostics',
    );
    expect(visibleDiagnostics).toHaveLength(1);
    expect(visibleDiagnostics[0]?.props.role).toBe('status');
    visibleRenderer.unmount();

    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: true, showDiagnostics: false },
    });
    const hiddenRenderer = await renderScreen();
    expect(
      hiddenRenderer.root.findAllByProps({ testID: 'performance-diagnostics' }),
    ).toHaveLength(0);
    hiddenRenderer.unmount();
  }, 15_000);

  it('announces loading separately and withholds interactive workspaces', async () => {
    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      status: 'loading',
    });
    const renderer = await renderScreen();

    const loading = renderer.root.findByProps({
      testID: 'performance-session-loading',
    });
    expect(loading.props.role).toBe('status');
    expect(loading.props.accessibilityLiveRegion).toBe('polite');
    expect(
      renderer.root.findAllByProps({ testID: 'performance-mode-switch' }),
    ).toHaveLength(0);
    renderer.unmount();
  });

  it('surfaces refresh failures as an accessible alert and permits another attempt', async () => {
    refresh.mockRejectedValueOnce(new Error('Session refresh timed out'));
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Refresh' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({ testID: 'performance-action-error' });
    const announcement = findAccessibleText(
      renderer,
      'performance-action-error-announcement',
    );
    expect(alert.props.role).toBeUndefined();
    expect(alert.props.accessibilityLabel).toBeUndefined();
    expect(alert.props.accessible).not.toBe(true);
    expect(announcement.props.accessible).toBe(true);
    expect(announcement.props.accessibilityRole).toBe('text');
    expect(announcement.props.accessibilityLiveRegion).toBe('assertive');
    expect(announcement.props.accessibilityLabel).toBe(
      'Performance action failed. Session refresh timed out',
    );
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      'Performance action failed. Session refresh timed out',
      {
        queue: true,
      },
    );
    expect(renderedText(renderer)).toContain('Session refresh timed out');

    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Refresh' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it('announces diagnostics failures without grouping the status panel', async () => {
    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      diagnostics: {
        error: new Error('Render telemetry timed out'),
        renderLoad: 0,
        status: 'error',
        xruns: 0,
      },
    });
    const renderer = await renderScreen();
    const diagnostics = renderer.root.findByProps({
      testID: 'performance-diagnostics',
    });
    const announcement = findAccessibleText(
      renderer,
      'performance-diagnostics-error-announcement',
    );

    expect(diagnostics.props.role).toBeUndefined();
    expect(diagnostics.props.accessibilityLabel).toBeUndefined();
    expect(diagnostics.props.accessible).not.toBe(true);
    expect(announcement.props.accessibilityLabel).toBe(
      'Audio engine diagnostics failed. Render telemetry timed out',
    );
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      'Audio engine diagnostics failed. Render telemetry timed out',
      { queue: true },
    );
    renderer.unmount();
  });

  it('renders a complete 4x4 scene grid and launches a native loop', async () => {
    const renderer = await renderScreen();
    expect(renderer.root.findAllByProps({ testID: 'juno-scene-pad' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ testID: 'juno-add-scene-pad' })).toHaveLength(
      15,
    );

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Scene 1, 1 part, loop' })
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

  it('announces scene playback and mute state directly in each pad label', async () => {
    useTransportControls.mockReturnValue({
      ...useTransportControls(),
      isPlaying: true,
    });
    const playingRenderer = await renderScreen();
    expect(
      playingRenderer.root.findByProps({
        accessibilityLabel: 'Scene 1, 1 part, playing',
      }),
    ).toBeTruthy();
    playingRenderer.unmount();

    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      tracks: [{ ...junoTrack, muted: true }],
    });
    const mutedRenderer = await renderScreen();
    expect(
      mutedRenderer.root.findByProps({
        accessibilityLabel: 'Scene 1, 1 part, muted',
      }),
    ).toBeTruthy();
    mutedRenderer.unmount();
  });

  it('announces a scene while its native launch is starting', async () => {
    let resolveLoopConfiguration: (() => void) | undefined;
    setLoopBeats.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveLoopConfiguration = () => resolve(undefined);
        }),
    );
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Scene 1, 1 part, loop' })
        .props.onPress();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Scene 1, 1 part, starting',
      }),
    ).toBeTruthy();

    await act(async () => {
      resolveLoopConfiguration?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    renderer.unmount();
  });

  it('surfaces the native launch error beside the scene grid with its real message', async () => {
    setLoopBeats.mockRejectedValueOnce(new Error('Native loop graph rejected the scene'));
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Scene 1, 1 part, loop' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({ testID: 'looper-grid-action-error' });
    const announcement = findAccessibleText(
      renderer,
      'looper-grid-action-error-announcement',
    );
    expect(alert.props.accessibilityLabel).toBeUndefined();
    expect(alert.props.accessibilityRole).toBeUndefined();
    expect(alert.props.role).toBeUndefined();
    expect(alert.props.accessible).not.toBe(true);
    expect(announcement.props.accessibilityLabel).toBe(
      'Looper action failed. Native loop graph rejected the scene',
    );
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      'Looper action failed. Native loop graph rejected the scene',
      { queue: true },
    );
    expect(renderedText(renderer)).toContain('Native loop graph rejected the scene');
    renderer.unmount();
  });

  it('surfaces selected-part failures beside the selected scene controls', async () => {
    setTrackMuted.mockRejectedValueOnce(new Error('Mixer route is locked'));
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root.findByProps({ testID: 'loop-mute' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({
      testID: 'looper-selection-action-error',
    });
    const announcement = findAccessibleText(
      renderer,
      'looper-selection-action-error-announcement',
    );
    expect(alert.props.accessibilityLabel).toBeUndefined();
    expect(alert.props.accessibilityRole).toBeUndefined();
    expect(alert.props.role).toBeUndefined();
    expect(alert.props.accessible).not.toBe(true);
    expect(announcement.props.accessibilityLabel).toBe(
      'Looper action failed. Mixer route is locked',
    );
    expect(renderedText(renderer)).toContain('Mixer route is locked');
    renderer.unmount();
  });

  it('selects without playback when auto-play is off and keeps an explicit launch', async () => {
    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: false, showDiagnostics: true },
    });
    const renderer = await renderScreen();

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Scene 1, 1 part, loop' })
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
    const emptyIllustration = renderer.root.findByProps({
      testID: 'juno-scene-launcher-empty-illustration',
    });
    expect(emptyIllustration.props.accessible).toBe(false);
    expect(emptyIllustration.props.contentFit).toBe('contain');

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

  it('does not show scene-launcher empty art when a persisted scene exists', async () => {
    const renderer = await renderScreen();

    expect(
      renderer.root.findAllByProps({
        testID: 'juno-scene-launcher-empty-illustration',
      }),
    ).toHaveLength(0);
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
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Scene 1, 1 part, recording',
      }),
    ).toBeTruthy();
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
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Scene 1, 1 part, overdub',
      }),
    ).toBeTruthy();
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
    expect(renderedText(renderer)).toContain('Dev build required');
    const scenePad = renderer.root.findByProps({ testID: 'juno-scene-pad' });
    expect(scenePad.props.disabled).toBe(true);
    expect(scenePad.props.accessibilityState.disabled).toBe(true);
    expect(scenePad.props.accessibilityHint).toBe(
      'Unavailable while Auto-play scenes requires native loop transport',
    );
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Add scene 2' }).props.disabled,
    ).toBe(false);
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
    expect(renderedText(renderer)).toContain('Audio output is unavailable');
    renderer.unmount();

    useSessionViewModel.mockReturnValue({
      ...useSessionViewModel(),
      status: 'error',
      error: new Error('Session database is unavailable'),
    });
    const failedRenderer = await renderScreen();
    const sessionAlert = failedRenderer.root.findByProps({
      testID: 'performance-session-error',
    });
    const sessionAnnouncement = findAccessibleText(
      failedRenderer,
      'performance-session-error-announcement',
    );
    expect(sessionAlert.props.role).toBeUndefined();
    expect(sessionAlert.props.accessibilityLabel).toBeUndefined();
    expect(sessionAlert.props.accessibilityRole).toBeUndefined();
    expect(sessionAlert.props.accessible).not.toBe(true);
    expect(sessionAnnouncement.props.accessibilityLabel).toBe(
      'Performance unavailable. Session database is unavailable',
    );
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      'Performance unavailable. Session database is unavailable',
      { queue: true },
    );
    expect(renderedText(failedRenderer)).toContain('Session database is unavailable');
    const retry = failedRenderer.root.findByProps({ accessibilityLabel: 'Retry' });
    expect(retry.props.accessibilityRole).toBe('button');
    await act(async () => {
      retry.props.onPress();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    failedRenderer.unmount();
  });
});
