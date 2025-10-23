import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import { MixerScreen } from '../MixerScreen';
import type { SessionManager } from '../../../session';

jest.mock('../../session', () => ({
  useSessionViewModel: jest.fn(),
}));

const { useSessionViewModel } = jest.requireMock('../../session');

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

describe('MixerScreen plugin alerts', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders plugin crash alerts with retry affordances', async () => {
    const retryPlugin = jest.fn().mockResolvedValue(true);
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
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
          reason: 'Render thread crash',
          recovered: false,
        },
      ],
      transport: null,
      transportRuntime: null,
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      error: undefined,
      manager: {} as SessionManager,
      retryPlugin,
    });

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

    const tree = renderer.root;
    const retryButton = tree.findByProps({ label: 'Retry' });
    await act(async () => {
      retryButton.props.onPress();
      await Promise.resolve();
    });

    expect(retryPlugin).toHaveBeenCalledWith('plugin-1');
    renderer.unmount();
  });
});
