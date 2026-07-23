import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { SessionManager } from '../../../session';
import { StudioText, ThemeProvider } from '../../design-system';
import { MixerScreen } from '../MixerScreen';

jest.mock('../../session', () => ({
  useSessionActions: jest.fn(),
  useSessionViewModel: jest.fn(),
}));

const { useSessionActions, useSessionViewModel } = jest.requireMock('../../session');

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

const baseDiagnostics = {
  status: 'ready' as const,
  xruns: 0,
  renderLoad: 0.2,
};

const crashedPluginAlert = {
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
  reason: 'Render thread crash',
  recovered: false,
};

const createViewModel = (overrides: Record<string, unknown> = {}) => ({
  status: 'ready',
  tracks: [baseTrack],
  diagnostics: baseDiagnostics,
  pluginAlerts: [],
  transport: null,
  transportRuntime: null,
  sessionId: 'session-1',
  sessionName: 'Fixture Session',
  error: undefined,
  manager: {} as SessionManager,
  retryPlugin: jest.fn().mockResolvedValue(true),
  refresh: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('MixerScreen', () => {
  const addJunoTrack = jest.fn();
  const addEmptyJunoMidiClip = jest.fn();
  const setTrackMuted = jest.fn().mockResolvedValue(undefined);
  const setTrackSolo = jest.fn().mockResolvedValue(undefined);
  const setTrackVolume = jest.fn().mockResolvedValue(undefined);
  const setTrackPan = jest.fn().mockResolvedValue(undefined);

  const renderScreen = async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <MixerScreen />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    if (!renderer) {
      throw new Error('Renderer not initialized');
    }
    return renderer;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    addJunoTrack.mockResolvedValue({ tracks: [{ id: 'track-juno' }] });
    addEmptyJunoMidiClip.mockResolvedValue(undefined);
    setTrackMuted.mockResolvedValue(undefined);
    setTrackSolo.mockResolvedValue(undefined);
    setTrackVolume.mockResolvedValue(undefined);
    setTrackPan.mockResolvedValue(undefined);
    useSessionActions.mockReturnValue({
      addJunoTrack,
      addEmptyJunoMidiClip,
      setTrackMuted,
      setTrackSolo,
      setTrackVolume,
      setTrackPan,
    });
    useSessionViewModel.mockReturnValue(createViewModel());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders honest channel strips and a deterministic master without a refresh action', async () => {
    const renderer = await renderScreen();
    const serialized = JSON.stringify(renderer.toJSON());

    expect(serialized).toContain('Fixture Track level estimate 50 percent');
    expect(serialized).toContain('Master mixer channel');
    expect(serialized).toContain('Scroll horizontally to see all channels');
    expect(serialized).toContain('Fixture Track');
    expect(serialized).not.toContain('Refresh');

    renderer.unmount();
  });

  it('routes mute and solo through session actions', async () => {
    const renderer = await renderScreen();
    const muteButton = renderer.root.findByProps({
      accessibilityLabel: 'Mute Fixture Track',
    });
    const soloButton = renderer.root.findByProps({
      accessibilityLabel: 'Solo Fixture Track',
    });

    await act(async () => {
      muteButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      soloButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setTrackMuted).toHaveBeenCalledWith('track-1', true);
    expect(setTrackSolo).toHaveBeenCalledWith('track-1', true);
    renderer.unmount();
  });

  it('makes level and pan editable from each channel strip', async () => {
    const renderer = await renderScreen();
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Increase Fixture Track level' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Pan Fixture Track right' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setTrackVolume).toHaveBeenCalledWith('track-1', 1);
    expect(setTrackPan).toHaveBeenCalledWith('track-1', 0.1);
    renderer.unmount();
  });

  it('adds a routed instrument and blank pattern from the useful empty state', async () => {
    useSessionViewModel.mockReturnValue(createViewModel({ tracks: [] }));
    const renderer = await renderScreen();
    const addButton = renderer.root.findByProps({ label: 'Create first instrument' });

    await act(async () => {
      addButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addJunoTrack).toHaveBeenCalledWith({ name: 'Juno-106' });
    expect(addEmptyJunoMidiClip).toHaveBeenCalledWith('track-juno', {
      bars: 1,
      name: 'Pattern 1',
    });
    renderer.unmount();
  });

  it('surfaces session action failures as accessible errors', async () => {
    setTrackMuted.mockRejectedValueOnce(new Error('Mute unavailable'));
    const renderer = await renderScreen();
    const muteButton = renderer.root.findByProps({
      accessibilityLabel: 'Mute Fixture Track',
    });

    await act(async () => {
      muteButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({ accessibilityLabel: 'Mixer action error' });
    expect(alert.props.accessibilityRole).toBe('alert');
    expect(renderer.root.findByProps({ children: 'Mute unavailable' })).toBeDefined();
    renderer.unmount();
  });

  it('preserves plugin crash retry affordances', async () => {
    const retryPlugin = jest.fn().mockResolvedValue(true);
    useSessionViewModel.mockReturnValue(
      createViewModel({
        retryPlugin,
        pluginAlerts: [crashedPluginAlert],
      }),
    );

    const renderer = await renderScreen();
    const retryButton = renderer.root.findByProps({ label: 'Retry' });
    await act(async () => {
      retryButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(retryPlugin).toHaveBeenCalledWith('plugin-1');
    renderer.unmount();
  });

  it('surfaces a declined plugin retry and prevents duplicate in-flight attempts', async () => {
    let finishRetry: ((result: boolean) => void) | undefined;
    const retryPlugin = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRetry = resolve;
        }),
    );
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    useSessionViewModel.mockReturnValue(
      createViewModel({ retryPlugin, pluginAlerts: [crashedPluginAlert] }),
    );

    const renderer = await renderScreen();
    const retryButton = renderer.root.findByProps({ label: 'Retry' });
    await act(async () => {
      retryButton.props.onPress();
      retryButton.props.onPress();
      await Promise.resolve();
    });
    expect(retryPlugin).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRetry?.(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'The plugin could not be retried',
    );
    renderer.unmount();
  });

  it('shows the actual session-load error', async () => {
    useSessionViewModel.mockReturnValue(
      createViewModel({
        status: 'error',
        tracks: [],
        error: new Error('Project database unavailable'),
      }),
    );

    const renderer = await renderScreen();
    expect(JSON.stringify(renderer.toJSON())).toContain('Project database unavailable');
    renderer.unmount();
  });

  it('does not present zero-valued metrics when diagnostics are unavailable', async () => {
    useSessionViewModel.mockReturnValue(
      createViewModel({
        diagnostics: { status: 'unavailable', xruns: 0, renderLoad: 0 },
      }),
    );

    const renderer = await renderScreen();
    expect(
      renderer.root.findAll(
        (node) => node.type === StudioText && node.props.children === '—',
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(renderer.toJSON())).toContain('METRICS OFFLINE');
    renderer.unmount();
  });
});
