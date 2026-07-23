import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import { ArrangementScreen } from '../ArrangementScreen';
import type { SessionManager } from '../../../session';

jest.mock('../../session', () => ({
  useSessionViewModel: jest.fn(),
  useTransportControls: jest.fn(),
  useProjectedTransport: jest.fn(),
  useSessionActions: jest.fn(),
  useInstrumentControls: jest.fn(),
}));

jest.mock('../../layout', () => ({
  useAdaptiveLayout: jest.fn(),
}));

const {
  useSessionViewModel,
  useTransportControls,
  useProjectedTransport,
  useSessionActions,
  useInstrumentControls,
} = jest.requireMock('../../session');
const { useAdaptiveLayout } = jest.requireMock('../../layout');

const baseTrack = {
  id: 'track-1',
  name: 'Fixture Track',
  color: '#FF00FF',
  muted: false,
  solo: false,
  volumeDb: 0,
  pan: 0,
  automationCurves: [],
  clips: [],
  waveform: new Float32Array([0, 0, 0]),
  midiNotes: [],
  meterLevel: 0.5,
  plugins: [],
};

const baseTransport = {
  bpm: 120,
  timeSignature: '4/4',
  lengthBeats: 32,
  totalBars: 8,
  playheadBeats: 0,
  playheadRatio: 0,
  isPlaying: false,
  diagnosticsGate: false,
  playheadReference: undefined,
};

const baseDiagnostics = {
  status: 'ready' as const,
  xruns: 0,
  renderLoad: 0.25,
  clipBufferBytes: 0,
};

const addJunoTrack = jest.fn();
const addEmptyJunoMidiClip = jest.fn();
const setTrackMuted = jest.fn();
const setTrackSolo = jest.fn();
const setTrackVolume = jest.fn();
const setTempo = jest.fn();
const setMidiClipNotes = jest.fn();
const clearMidiClip = jest.fn();
const undo = jest.fn();
const redo = jest.fn();
const play = jest.fn();
const stop = jest.fn();
const locateStart = jest.fn();

beforeEach(() => {
  jest.resetAllMocks();
  addJunoTrack.mockResolvedValue({ tracks: [{ ...baseTrack, id: 'track-juno' }] });
  addEmptyJunoMidiClip.mockResolvedValue({
    tracks: [{ ...baseTrack, id: 'track-juno', clips: [{ id: 'pattern-1' }] }],
  });
  setTrackMuted.mockResolvedValue(undefined);
  setTrackSolo.mockResolvedValue(undefined);
  setTrackVolume.mockResolvedValue(undefined);
  setTempo.mockResolvedValue(undefined);
  setMidiClipNotes.mockResolvedValue(undefined);
  clearMidiClip.mockResolvedValue(undefined);
  undo.mockResolvedValue(undefined);
  redo.mockResolvedValue(undefined);
  play.mockResolvedValue(undefined);
  stop.mockResolvedValue(undefined);
  locateStart.mockResolvedValue(undefined);
  useTransportControls.mockReturnValue({
    play,
    stop,
    locateFrame: jest.fn(),
    locateBeats: jest.fn(),
    locateStart,
    isAvailable: true,
    isLoopAvailable: true,
    isPlaying: false,
    transportRuntime: null,
    transport: null,
  });
  useProjectedTransport.mockReturnValue({
    projectedBeats: 0,
    projectedRatio: 0,
    transport: null,
  });
  useSessionActions.mockReturnValue({
    addJunoTrack,
    addEmptyJunoMidiClip,
    setTrackMuted,
    setTrackSolo,
    setTrackVolume,
    setTempo,
    setMidiClipNotes,
    clearMidiClip,
    undo,
    redo,
  });
  useInstrumentControls.mockReturnValue({
    isAvailable: true,
    sendInstrumentMidi: jest.fn(async () => undefined),
    setInstrumentParameter: jest.fn(async () => undefined),
    allNotesOff: jest.fn(async () => undefined),
  });
  useAdaptiveLayout.mockReturnValue({
    width: 1280,
    height: 832,
    breakpoint: 'desktop',
    orientation: 'landscape',
    isTablet: false,
    isLandscape: true,
    workspaceMode: 'studio',
    contentPadding: 32,
    maxContentWidth: 1280,
    prefersReducedMotion: false,
    screenReaderEnabled: false,
    platform: 'web',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ArrangementScreen diagnostics', () => {
  const renderScreen = async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <ArrangementScreen />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    if (!renderer) {
      throw new Error('Renderer not initialized');
    }
    return renderer;
  };

  it('renders diagnostics summary when ready', async () => {
    jest.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('1/1/2024, 12:00:00 AM');
    const transport = { ...baseTransport, isPlaying: true, playheadRatio: 0.5 };
    useProjectedTransport.mockReturnValue({
      projectedBeats: transport.lengthBeats * 0.5,
      projectedRatio: 0.5,
      transport,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
      transport,
      diagnostics: baseDiagnostics,
      refresh: jest.fn(() => Promise.resolve()),
      pluginAlerts: [
        {
          instanceId: 'plugin-1',
          descriptor: {
            identifier: 'com.acme.Plugin',
            name: 'Fixture Plugin',
            format: 'auv3',
            manufacturer: 'Acme',
            version: '1.0.0',
            supportsSandbox: true,
            audioInputChannels: 2,
            audioOutputChannels: 2,
            midiInput: false,
            midiOutput: false,
            parameters: [],
          },
          timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
          reason: 'Test crash',
          recovered: false,
        },
      ],
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      manager: {} as SessionManager,
      error: undefined,
      transportRuntime: null,
      retryPlugin: jest.fn(async () => true),
    });

    const renderer = await renderScreen();
    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain('Engine 25% · 0 xruns');
    expect(serialized).toContain('Plugin needs attention');
    expect(serialized).toContain('Fixture Plugin');
    renderer.unmount();
  });

  it('renders diagnostics error state', async () => {
    useProjectedTransport.mockReturnValue({
      projectedBeats: baseTransport.playheadBeats,
      projectedRatio: baseTransport.playheadRatio,
      transport: baseTransport,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
      transport: baseTransport,
      diagnostics: {
        status: 'error',
        xruns: 0,
        renderLoad: 0,
        error: new Error('Diagnostics failed'),
      },
      refresh: jest.fn(() => Promise.resolve()),
      pluginAlerts: [],
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      manager: {} as SessionManager,
      error: undefined,
      transportRuntime: null,
      retryPlugin: jest.fn(async () => true),
    });

    const renderer = await renderScreen();
    expect(JSON.stringify(renderer.toJSON())).toContain('Diagnostics failed');
    renderer.unmount();
  });

  it('renders diagnostics unavailable state', async () => {
    useProjectedTransport.mockReturnValue({
      projectedBeats: baseTransport.playheadBeats,
      projectedRatio: baseTransport.playheadRatio,
      transport: baseTransport,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
      transport: baseTransport,
      diagnostics: {
        status: 'unavailable',
        xruns: 0,
        renderLoad: 0,
      },
      refresh: jest.fn(() => Promise.resolve()),
      pluginAlerts: [],
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      manager: {} as SessionManager,
      error: undefined,
      transportRuntime: null,
      retryPlugin: jest.fn(async () => true),
    });

    const renderer = await renderScreen();
    expect(JSON.stringify(renderer.toJSON())).toContain('Audio diagnostics unavailable');
    renderer.unmount();
  });

  it('keeps the compact arrangement shell wired to real track and transport actions', async () => {
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
      transport: baseTransport,
      diagnostics: baseDiagnostics,
      refresh: jest.fn(() => Promise.resolve()),
      pluginAlerts: [],
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      manager: {} as SessionManager,
      error: undefined,
      transportRuntime: null,
      retryPlugin: jest.fn(async () => true),
    });

    const renderer = await renderScreen();
    const serialized = JSON.stringify(renderer.toJSON());
    expect(serialized).toContain('DAFT CITADEL');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Timeline ruler' }),
    ).toBeDefined();

    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Mute Fixture Track' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Solo Fixture Track' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Play' }).props.onPress();
      renderer.root.findByProps({ accessibilityLabel: 'Rewind' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Add Juno pattern track' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setTrackMuted).toHaveBeenCalledWith('track-1', true);
    expect(setTrackSolo).toHaveBeenCalledWith('track-1', true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(locateStart).toHaveBeenCalledTimes(1);
    expect(addJunoTrack).toHaveBeenCalledTimes(1);
    expect(addEmptyJunoMidiClip).toHaveBeenCalledWith('track-juno', {
      bars: 1,
      name: 'Pattern 1',
    });
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Record' })).toHaveLength(
      0,
    );
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Loop' })).toHaveLength(0);
    renderer.unmount();
  });

  it('selects a Juno track and creates a blank MIDI pattern from its empty timeline', async () => {
    const junoTrack = {
      ...baseTrack,
      id: 'track-juno',
      name: 'Juno-106',
      instrument: {
        nodeId: 'track-juno:instrument:juno106',
        instrumentType: 'juno106',
        parameters: {},
      },
    };
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack, junoTrack],
      transport: baseTransport,
      diagnostics: baseDiagnostics,
      pluginAlerts: [],
      sessionName: 'Juno Session',
      error: undefined,
    });

    const renderer = await renderScreen();
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Juno-106, 0 clips' }).props
        .accessibilityState,
    ).toEqual({ selected: true });
    const createClipButton = renderer.root.findByProps({
      accessibilityLabel: 'Create blank pattern',
    });
    await act(async () => {
      createClipButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addEmptyJunoMidiClip).toHaveBeenCalledWith('track-juno', {
      bars: 1,
      name: 'Pattern 1',
    });
    renderer.unmount();
  });

  it('writes a selected pitch into the persisted 16-step pattern', async () => {
    const junoTrack = {
      ...baseTrack,
      id: 'track-juno',
      name: 'Juno-106',
      clips: [
        {
          id: 'pattern-1',
          name: 'Pattern 1',
          startMs: 0,
          durationMs: 2000,
          midiNotes: [],
        },
      ],
      instrument: {
        nodeId: 'track-juno:instrument:juno106',
        instrumentType: 'juno106',
        parameters: {},
      },
    };
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [junoTrack],
      transport: baseTransport,
      diagnostics: baseDiagnostics,
      pluginAlerts: [],
      sessionName: 'Pattern Session',
      error: undefined,
    });

    const renderer = await renderScreen();
    await act(async () => {
      renderer.root.findByProps({ testID: 'midi-step-1' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setMidiClipNotes).toHaveBeenCalledWith('track-juno', 'pattern-1', [
      {
        id: 'step-1',
        pitch: 60,
        startBeat: 0,
        durationBeats: 0.25,
        velocity: 100,
      },
    ]);

    await act(async () => {
      renderer.root.findByProps({ testID: 'tempo-up' }).props.onPress();
      await Promise.resolve();
    });
    expect(setTempo).toHaveBeenCalledWith(121);
    renderer.unmount();
  });

  it('uses the active meter for its position and ruler', async () => {
    const transport = { ...baseTransport, timeSignature: '3/4', totalBars: 11 };
    useProjectedTransport.mockReturnValue({
      projectedBeats: 3,
      projectedRatio: 3 / transport.lengthBeats,
      transport,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
      transport,
      diagnostics: baseDiagnostics,
      pluginAlerts: [],
      sessionName: 'Odd Meter',
      error: undefined,
    });

    const renderer = await renderScreen();
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Position 2.1.00' }),
    ).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'timeline-ruler-beat' })).toHaveLength(
      12,
    );
    renderer.unmount();
  });

  it('keeps transport controls on-screen and track creation available when offline', async () => {
    useAdaptiveLayout.mockReturnValue({
      width: 320,
      height: 568,
      breakpoint: 'phone',
      orientation: 'portrait',
      isTablet: false,
      isLandscape: false,
      workspaceMode: 'deck',
      contentPadding: 16,
      maxContentWidth: 320,
      prefersReducedMotion: false,
      screenReaderEnabled: false,
      platform: 'ios',
    });
    useTransportControls.mockReturnValue({
      play,
      stop,
      locateStart,
      isAvailable: false,
      isLoopAvailable: false,
      isPlaying: false,
      transportRuntime: null,
      transport: null,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [],
      transport: baseTransport,
      diagnostics: baseDiagnostics,
      pluginAlerts: [],
      sessionName: 'Offline Session',
      error: undefined,
    });

    const renderer = await renderScreen();
    expect(JSON.stringify(renderer.toJSON())).toContain('OFFLINE');
    expect(
      renderer.root.findByProps({ testID: 'transport-button-group' }).props.style,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ width: '100%' })]));
    const addButton = renderer.root.findByProps({
      accessibilityLabel: 'Create first instrument',
    });
    expect(addButton.props.disabled).toBe(false);
    await act(async () => {
      addButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addJunoTrack).toHaveBeenCalledTimes(1);
    expect(addEmptyJunoMidiClip).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
