import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../../design-system';
import {
  clampMixerMeterLevel,
  MixerScreen,
  resolveMixerChannelWidth,
  resolveMixerColumnCount,
} from '../MixerScreen';
import type { SessionManager } from '../../../session';

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('expo-symbols', () => ({ SymbolView: 'SymbolView' }));

jest.mock('../../session', () => ({
  useSessionActions: jest.fn(),
  useSessionViewModel: jest.fn(),
}));

jest.mock('../../layout', () => ({
  useAdaptiveLayout: jest.fn(),
}));

const { useSessionActions, useSessionViewModel } = jest.requireMock('../../session');
const { useAdaptiveLayout } = jest.requireMock('../../layout');

const refresh = jest.fn(async () => undefined);
const retryPlugin = jest.fn(async () => true);
const setTrackMuted = jest.fn(async () => undefined);
const setTrackPan = jest.fn(async () => undefined);
const setTrackSolo = jest.fn(async () => undefined);
const setTrackVolume = jest.fn(async () => undefined);

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

const createViewModel = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  status: 'ready',
  tracks: [baseTrack],
  diagnostics: baseDiagnostics,
  refresh,
  pluginAlerts: [],
  transport: null,
  transportRuntime: null,
  sessionId: 'session-1',
  sessionName: 'Fixture Session',
  error: undefined,
  manager: {} as SessionManager,
  retryPlugin,
  ...overrides,
});

const renderScreen = async (): Promise<TestRenderer.ReactTestRenderer> => {
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

describe('MixerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    useSessionActions.mockReturnValue({
      setTrackMuted,
      setTrackPan,
      setTrackSolo,
      setTrackVolume,
    });
    useSessionViewModel.mockReturnValue(createViewModel());
  });

  it('renders plugin crash alerts with retry affordances', async () => {
    useSessionViewModel.mockReturnValue(
      createViewModel({
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
    const tree = renderer.root;
    const retryButton = tree.findByProps({ label: 'Retry' });
    await act(async () => {
      retryButton.props.onPress();
      await Promise.resolve();
    });

    expect(retryPlugin).toHaveBeenCalledWith('plugin-1');
    renderer.unmount();
  });

  it('wires accessible level, pan, mute, and solo controls to session actions', async () => {
    const renderer = await renderScreen();
    const tree = renderer.root;

    const volume = tree
      .findAllByProps({ testID: 'mixer-volume-track-1' })
      .find((node) => node.props.accessibilityRole === 'adjustable');
    if (!volume) {
      throw new Error('Volume accessibility control not found');
    }
    expect(volume.props.accessibilityRole).toBe('adjustable');
    expect(volume.props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 83,
      text: '0.0 dB',
    });

    const pan = tree
      .findAllByProps({ testID: 'mixer-pan-track-1' })
      .find((node) => node.props.accessibilityRole === 'adjustable');
    if (!pan) {
      throw new Error('Pan accessibility control not found');
    }
    expect(pan.props.accessibilityRole).toBe('adjustable');
    expect(pan.props.accessibilityValue.text).toBe('Center');

    await act(async () => {
      tree
        .findByProps({ accessibilityLabel: 'Increase Fixture Track volume' })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setTrackVolume).toHaveBeenCalledWith('track-1', 1);

    await act(async () => {
      pan.props.onAccessibilityAction({
        nativeEvent: { actionName: 'decrement' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setTrackPan).toHaveBeenCalledWith('track-1', -0.1);

    await act(async () => {
      tree.findByProps({ accessibilityLabel: 'Fixture Track mute' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setTrackMuted).toHaveBeenCalledWith('track-1', true);

    await act(async () => {
      tree.findByProps({ accessibilityLabel: 'Fixture Track solo' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setTrackSolo).toHaveBeenCalledWith('track-1', true);

    renderer.unmount();
  });

  it('clamps meter output and exposes it as progressbar accessibility data', async () => {
    useSessionViewModel.mockReturnValue(
      createViewModel({
        tracks: [{ ...baseTrack, meterLevel: 1.75 }],
      }),
    );
    const renderer = await renderScreen();
    const meter = renderer.root.findByProps({ testID: 'mixer-meter-track-1' });

    expect(meter.props.accessibilityRole).toBe('progressbar');
    expect(meter.props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 100,
      text: '100%',
    });
    expect(clampMixerMeterLevel(-0.25)).toBe(0);
    expect(clampMixerMeterLevel(Number.NaN)).toBe(0);

    renderer.unmount();
  });

  it('uses a full-width phone channel and explicit larger-screen columns', () => {
    expect(resolveMixerColumnCount('phone')).toBe(1);
    expect(resolveMixerColumnCount('tablet')).toBe(2);
    expect(resolveMixerColumnCount('desktop')).toBe(3);
    expect(
      resolveMixerChannelWidth({
        columns: 1,
        contentWidth: 358,
        gap: 20,
      }),
    ).toBe(358);
    expect(
      resolveMixerChannelWidth({
        columns: 3,
        contentWidth: 1116,
        gap: 20,
      }),
    ).toBeCloseTo(358.67, 2);
  });

  it('sizes columns from the measured safe content instead of the window', async () => {
    useAdaptiveLayout.mockReturnValue({
      width: 1366,
      height: 1024,
      breakpoint: 'tablet',
      orientation: 'landscape',
      isTablet: true,
      isLandscape: true,
      workspaceMode: 'split',
      contentPadding: 24,
      maxContentWidth: 860,
      prefersReducedMotion: false,
      screenReaderEnabled: false,
      platform: 'ios',
    });
    useSessionViewModel.mockReturnValue(
      createViewModel({
        tracks: [baseTrack, { ...baseTrack, id: 'track-2', name: 'Second Track' }],
      }),
    );
    const renderer = await renderScreen();

    expect(
      renderer.root.findByProps({ testID: 'mixer-channel-track-1' }).props.style,
    ).toEqual(expect.objectContaining({ width: '100%' }));

    await act(async () => {
      renderer.root.findByProps({ testID: 'mixer-safe-content' }).props.onLayout({
        nativeEvent: {
          layout: { height: 600, width: 620, x: 0, y: 0 },
        },
      });
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({ testID: 'mixer-channel-track-1' }).props.style,
    ).toEqual(expect.objectContaining({ width: 300 }));
    expect(
      renderer.root.findByProps({ testID: 'mixer-channel-track-2' }).props.style,
    ).toEqual(expect.objectContaining({ width: 300 }));

    renderer.unmount();
  });

  it('preserves refresh and loading, error, and empty states', async () => {
    const renderer = await renderScreen();
    expect(
      renderer.root.findAllByProps({
        accessible: false,
        contentFit: 'contain',
      }),
    ).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ label: 'Refresh' }).props.onPress();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    renderer.unmount();

    useSessionViewModel.mockReturnValue(createViewModel({ status: 'loading' }));
    const loadingRenderer = await renderScreen();
    expect(
      loadingRenderer.root.findAllByProps({ children: 'Preparing mixer channels...' })
        .length,
    ).toBeGreaterThan(0);
    expect(
      loadingRenderer.root.findAllByProps({
        accessible: false,
        contentFit: 'contain',
      }),
    ).toHaveLength(0);
    loadingRenderer.unmount();

    useSessionViewModel.mockReturnValue(createViewModel({ status: 'error' }));
    const errorRenderer = await renderScreen();
    expect(
      errorRenderer.root.findAllByProps({ children: 'Mixer data unavailable.' }).length,
    ).toBeGreaterThan(0);
    expect(
      errorRenderer.root.findAllByProps({
        accessible: false,
        contentFit: 'contain',
      }),
    ).toHaveLength(0);
    errorRenderer.unmount();

    useSessionViewModel.mockReturnValue(createViewModel({ tracks: [] }));
    const emptyRenderer = await renderScreen();
    expect(
      emptyRenderer.root.findAllByProps({
        children: 'No tracks routed to the mixer yet.',
      }).length,
    ).toBeGreaterThan(0);
    const illustrations = emptyRenderer.root.findAllByProps({
      accessible: false,
      contentFit: 'contain',
    });
    expect(illustrations.length).toBeGreaterThan(0);
    expect(
      illustrations.every(
        (illustration) => illustration.props.style.aspectRatio === 16 / 9,
      ),
    ).toBe(true);
    emptyRenderer.unmount();
  });
});
