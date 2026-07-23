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
  const locateStart = jest.fn(async () => undefined);
  const play = jest.fn(async () => undefined);
  const stop = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      sessionName: 'Night Drive',
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
    });
    useProjectedTransport.mockReturnValue({ projectedBeats: 0, projectedRatio: 0 });
    useTransportControls.mockReturnValue({
      play,
      stop,
      locateBeats,
      locateStart,
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
    const launchButton = buttons.find(
      (button) => button.props.accessibilityLabel === 'Around the World',
    );
    if (!launchButton) {
      throw new Error('Around the World scene launch button not found');
    }
    await act(async () => {
      launchButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(locateBeats).toHaveBeenCalledWith(60);
    expect(play).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('exposes supported transport actions without a refresh control', async () => {
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

    const playButton = renderer.root.findByProps({ accessibilityLabel: 'Play' });
    const rewindButton = renderer.root.findByProps({ accessibilityLabel: 'Rewind' });

    await act(async () => {
      playButton.props.onPress();
      rewindButton.props.onPress();
      await Promise.resolve();
    });

    expect(play).toHaveBeenCalledTimes(1);
    expect(locateStart).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(
      0,
    );
    renderer.unmount();
  });

  it('stops an active transport', async () => {
    useTransportControls.mockReturnValue({
      play,
      stop,
      locateBeats,
      locateStart,
      isAvailable: true,
      isPlaying: true,
    });

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

    const stopButton = renderer.root.findByProps({ accessibilityLabel: 'Stop' });
    await act(async () => {
      stopButton.props.onPress();
      await Promise.resolve();
    });

    expect(stop).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('renders an honest empty state and hides optional diagnostics', async () => {
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      sessionName: 'Untitled Session',
      transport: {
        bpm: 120,
        timeSignature: '4/4',
        lengthBeats: 2,
        totalBars: 1,
        playheadBeats: 0,
        playheadRatio: 0,
        isPlaying: false,
        diagnosticsGate: false,
      },
      tracks: [],
      diagnostics: { status: 'ready', xruns: 0, renderLoad: 0 },
    });
    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: false, showDiagnostics: false },
    });

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

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'No launchable scenes' }),
    ).toBeDefined();
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Audio diagnostics' }),
    ).toHaveLength(0);
    renderer.unmount();
  });

  it('surfaces transport failures as an accessible alert', async () => {
    play.mockRejectedValueOnce(new Error('Audio output is unavailable'));

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

    const playButton = renderer.root.findByProps({ accessibilityLabel: 'Play' });
    await act(async () => {
      playButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({ accessibilityLabel: 'Transport error' });
    expect(alert.props.accessibilityRole).toBe('alert');
    expect(
      renderer.root.findByProps({ children: 'Audio output is unavailable' }),
    ).toBeDefined();
    renderer.unmount();
  });
});
