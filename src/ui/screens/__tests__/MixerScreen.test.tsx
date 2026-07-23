import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { SessionManager } from '../../../session';
import { ThemeProvider } from '../../design-system';
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
  const addTrack = jest.fn().mockResolvedValue(undefined);
  const setTrackMuted = jest.fn().mockResolvedValue(undefined);
  const setTrackSolo = jest.fn().mockResolvedValue(undefined);

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
    addTrack.mockResolvedValue(undefined);
    setTrackMuted.mockResolvedValue(undefined);
    setTrackSolo.mockResolvedValue(undefined);
    useSessionActions.mockReturnValue({ addTrack, setTrackMuted, setTrackSolo });
    useSessionViewModel.mockReturnValue(createViewModel());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders honest channel estimates without a refresh action', async () => {
    const renderer = await renderScreen();
    const serialized = JSON.stringify(renderer.toJSON());

    expect(serialized).toContain('LEVEL ESTIMATE');
    expect(serialized).toContain('Fixture Track');
    expect(serialized).not.toContain('Refresh');

    renderer.unmount();
  });

  it('routes mute and solo through session actions', async () => {
    const renderer = await renderScreen();
    const muteButton = renderer.root.findByProps({ label: 'Mute' });
    const soloButton = renderer.root.findByProps({ label: 'Solo' });

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

  it('adds a routed track from the useful empty state', async () => {
    useSessionViewModel.mockReturnValue(createViewModel({ tracks: [] }));
    const renderer = await renderScreen();
    const addButton = renderer.root.findByProps({ label: 'Add first track' });

    await act(async () => {
      addButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addTrack).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('preserves plugin crash retry affordances', async () => {
    const retryPlugin = jest.fn().mockResolvedValue(true);
    useSessionViewModel.mockReturnValue(
      createViewModel({
        retryPlugin,
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
            reason: 'Render thread crash',
            recovered: false,
          },
        ],
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
});
