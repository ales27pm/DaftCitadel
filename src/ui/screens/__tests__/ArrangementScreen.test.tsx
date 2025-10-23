import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import { ArrangementScreen } from '../ArrangementScreen';
import type { SessionManager } from '../../../session';

jest.mock('../../session', () => ({
  useSessionViewModel: jest.fn(),
  useTransportControls: jest.fn(),
}));

const { useSessionViewModel, useTransportControls } = jest.requireMock('../../session');

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
};

const baseDiagnostics = {
  status: 'ready' as const,
  xruns: 0,
  renderLoad: 0.25,
  clipBufferBytes: 0,
};

beforeEach(() => {
  jest.resetAllMocks();
  useTransportControls.mockReturnValue({
    play: jest.fn(),
    stop: jest.fn(),
    locateFrame: jest.fn(),
    locateBeats: jest.fn(),
    locateStart: jest.fn(),
    isAvailable: true,
    isPlaying: false,
    transportRuntime: null,
    transport: null,
  });
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
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [baseTrack],
      transport: { ...baseTransport, isPlaying: true, playheadRatio: 0.5 },
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
    expect(renderer.toJSON()).toMatchSnapshot();
    renderer.unmount();
  });

  it('renders diagnostics error state', async () => {
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
    expect(renderer.toJSON()).toMatchSnapshot();
    renderer.unmount();
  });

  it('renders diagnostics unavailable state', async () => {
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
    expect(renderer.toJSON()).toMatchSnapshot();
    renderer.unmount();
  });
});
