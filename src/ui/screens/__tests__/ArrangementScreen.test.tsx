import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import { ArrangementScreen } from '../ArrangementScreen';
import type { SessionManager } from '../../../session';

jest.mock('../../session', () => ({
  useSessionViewModel: jest.fn(),
  useTransportControls: jest.fn(),
  useProjectedTransport: jest.fn(),
}));

const { useSessionViewModel, useTransportControls, useProjectedTransport } =
  jest.requireMock('../../session');

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
  useProjectedTransport.mockReturnValue({
    projectedBeats: 0,
    projectedRatio: 0,
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
    expect(renderer.toJSON()).toMatchSnapshot();
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
    expect(renderer.toJSON()).toMatchSnapshot();
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
    expect(renderer.toJSON()).toMatchSnapshot();
    renderer.unmount();
  });

  it('disables Play and Rewind and prompts for an instrument with no tracks', async () => {
    useProjectedTransport.mockReturnValue({
      projectedBeats: baseTransport.playheadBeats,
      projectedRatio: baseTransport.playheadRatio,
      transport: baseTransport,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      tracks: [],
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
    const toolbar = renderer.root.findByProps({ title: 'Arrangement' });
    const play = toolbar.props.actions.find(
      (action: { label: string }) => action.label === 'Play',
    );
    const rewind = toolbar.props.actions.find(
      (action: { label: string }) => action.label === 'Rewind',
    );

    expect(play.disabled).toBe(true);
    expect(rewind.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Start with an instrument');
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Add a Juno track from Performance before starting playback.',
    );
    renderer.unmount();
  });
});
