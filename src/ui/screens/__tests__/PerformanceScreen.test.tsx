import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Pressable } from 'react-native';

import { ThemeProvider } from '../../design-system';
import { PerformanceScreen } from '../PerformanceScreen';

jest.mock('../../session', () => ({
  useSessionViewModel: jest.fn(),
  useProjectedTransport: jest.fn(),
  useTransportControls: jest.fn(),
}));

jest.mock('../../settings', () => ({
  useUserPreferences: jest.fn(),
}));

const { useSessionViewModel, useProjectedTransport, useTransportControls } =
  jest.requireMock('../../session');
const { useUserPreferences } = jest.requireMock('../../settings');

describe('PerformanceScreen', () => {
  const locateBeats = jest.fn(async () => undefined);
  const play = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      transport: {
        bpm: 120,
        timeSignature: '4/4',
        lengthBeats: 128,
        totalBars: 32,
        playheadBeats: 0,
        playheadRatio: 0,
        isPlaying: false,
        diagnosticsGate: false,
      },
      tracks: [
        {
          clips: [
            {
              id: 'scene-a',
              name: 'Around the World',
              startMs: 30000,
              durationMs: 5000,
            },
          ],
        },
      ],
      diagnostics: { status: 'ready', xruns: 0, renderLoad: 0.2 },
      refresh: jest.fn(async () => undefined),
    });
    useProjectedTransport.mockReturnValue({ projectedBeats: 0, projectedRatio: 0 });
    useTransportControls.mockReturnValue({
      play,
      stop: jest.fn(async () => undefined),
      locateBeats,
      isAvailable: true,
      isPlaying: false,
    });
    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: true, showDiagnostics: true },
    });
  });

  it('locates and starts transport when launching an auto-play scene', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <PerformanceScreen />
        </ThemeProvider>,
      );
    });
    if (!renderer) {
      throw new Error('Renderer not initialized');
    }

    const buttons = renderer.root.findAllByType(Pressable);
    await act(async () => {
      buttons[3].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(locateBeats).toHaveBeenCalledWith(60);
    expect(play).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
