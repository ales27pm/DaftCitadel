import React from 'react';
import * as ReactNative from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, Pressable, Text } from 'react-native';

import { JUNO106_DEFAULT_PARAMETERS } from '../../../session';
import { ThemeProvider } from '../../design-system';
import type { TrackViewModel } from '../../session';
import { JunoPerformancePanel } from '../JunoPerformancePanel';

jest.mock('../../session', () => ({
  useInstrumentControls: jest.fn(),
  useSessionActions: jest.fn(),
}));

const { useInstrumentControls, useSessionActions } = jest.requireMock('../../session');

const createJunoTrack = (): TrackViewModel => ({
  id: 'juno-track',
  name: 'Live Juno',
  muted: false,
  solo: false,
  volumeDb: 0,
  pan: 0,
  automationCurves: [],
  clips: [],
  waveform: new Float32Array(),
  midiNotes: [],
  meterLevel: 0,
  plugins: [],
  instrument: {
    nodeId: 'juno-node',
    instrumentType: 'juno106',
    label: 'Juno-106',
    parameters: { ...JUNO106_DEFAULT_PARAMETERS },
  },
});

const renderPanel = async (tracks: TrackViewModel[], activeTrackId?: string) => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(
      <ThemeProvider>
        <JunoPerformancePanel
          activeTrackId={activeTrackId}
          status="ready"
          tracks={tracks}
        />
      </ThemeProvider>,
    );
    await Promise.resolve();
  });
  if (!renderer) {
    throw new Error('Renderer not initialized');
  }
  return renderer;
};

const findPressable = (
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): TestRenderer.ReactTestInstance => {
  const pressable = renderer.root
    .findAllByType(Pressable)
    .find((candidate) => candidate.props.testID === testID);
  if (!pressable) {
    throw new Error(`Pressable ${testID} not found`);
  }
  return pressable;
};

const findSlider = (
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): TestRenderer.ReactTestInstance => {
  const slider = renderer.root
    .findAll((candidate) => candidate.props.testID === testID)
    .find((candidate) => typeof candidate.props.onSlidingComplete === 'function');
  if (!slider) {
    throw new Error(`Slider ${testID} not found`);
  }
  return slider;
};

const flattenText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenText).join('');
  }
  return '';
};

const flattenStyle = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value)) {
    return Object.assign({}, ...value.map(flattenStyle));
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
};

const renderedText = (renderer: TestRenderer.ReactTestRenderer): string =>
  renderer.root
    .findAllByType(Text)
    .map((candidate) => flattenText(candidate.props.children))
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

describe('JunoPerformancePanel', () => {
  const addJunoTrack = jest.fn(async () => undefined);
  const setJunoParameter = jest.fn(async () => undefined);
  const applyJunoPreset = jest.fn(async () => undefined);
  const sendInstrumentMidi = jest.fn(async () => undefined);
  const setInstrumentParameter = jest.fn(async () => undefined);
  const allNotesOff = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106;
    useSessionActions.mockReturnValue({
      addJunoTrack,
      applyJunoPreset,
      setJunoParameter,
    });
    useInstrumentControls.mockReturnValue({
      isAvailable: true,
      sendInstrumentMidi,
      setInstrumentParameter,
      allNotesOff,
    });
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106;
  });

  it('hides Juno creation when the rollout flag is disabled', async () => {
    process.env.EXPO_PUBLIC_DAFT_CITADEL_ENABLE_JUNO106 = 'false';

    const renderer = await renderPanel([]);

    expect(renderedText(renderer)).toContain('Juno-106 is disabled for this build.');
    expect(
      renderer.root.findAll((candidate) => candidate.props.testID === 'add-juno-button'),
    ).toHaveLength(0);
    expect(addJunoTrack).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('offers Add Juno for a fresh session', async () => {
    const renderer = await renderPanel([]);
    const addButton = findPressable(renderer, 'add-juno-button');

    await act(async () => {
      addButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addJunoTrack).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('persists parameter edits and forwards them to live controls', async () => {
    const renderer = await renderPanel([createJunoTrack()]);
    const visibleText = renderedText(renderer);

    expect(visibleText).toContain('DCO');
    expect(visibleText).toContain('LFO');
    expect(visibleText).toContain('VCF');
    expect(visibleText).toContain('ENV');
    expect(visibleText).toContain('OUTPUT');
    expect(visibleText).toContain('Advanced controls & diagnostics');

    const increaseCutoff = findPressable(renderer, 'juno-cutoffHz-increase');
    await act(async () => {
      increaseCutoff.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'cutoffHz', 2650);

    await act(async () => {
      findPressable(renderer, 'juno-advanced-toggle').props.onPress();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).toContain('CHORUS');

    const chorusTwo = findPressable(renderer, 'juno-chorus-2');
    await act(async () => {
      chorusTwo.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'chorusMode', 2);

    const increaseLfoDepth = findPressable(renderer, 'juno-lfoDepth-increase');
    await act(async () => {
      increaseLfoDepth.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'lfoDepth', 0.05);
    expect(setInstrumentParameter).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('previews continuous parameters and commits them when the slider is released', async () => {
    const renderer = await renderPanel([createJunoTrack()]);
    const cutoffSlider = findSlider(renderer, 'juno-cutoffHz-slider');

    expect(cutoffSlider.props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 20,
      text: '2400 Hz',
    });

    await act(async () => {
      cutoffSlider.props.onValueChange(4375);
      await Promise.resolve();
    });

    expect(renderedText(renderer)).toContain('4375 Hz');
    expect(setJunoParameter).not.toHaveBeenCalled();

    await act(async () => {
      cutoffSlider.props.onSlidingComplete(4375);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'cutoffHz', 4375);
    renderer.unmount();
  });

  it('applies built-in presets through the persisted session action', async () => {
    const renderer = await renderPanel([createJunoTrack()]);
    const presetButton = findPressable(renderer, 'juno-preset-builtin-neon-bass');

    await act(async () => {
      presetButton.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(applyJunoPreset).toHaveBeenCalledWith(
      'juno-track',
      expect.objectContaining({ id: 'builtin-neon-bass', name: 'Neon Bass' }),
    );
    renderer.unmount();
  });

  it('sends held-key note on/off events and clears notes on cleanup', async () => {
    const renderer = await renderPanel([createJunoTrack()]);
    const key = findPressable(renderer, 'juno-key-60');

    await act(async () => {
      key.props.onPressIn();
      await Promise.resolve();
    });
    expect(sendInstrumentMidi).toHaveBeenCalledWith('juno-node', {
      type: 0,
      channel: 0,
      data1: 60,
      data2: 100,
    });

    await act(async () => {
      key.props.onPressOut();
      await Promise.resolve();
    });
    expect(sendInstrumentMidi).toHaveBeenCalledWith('juno-node', {
      type: 1,
      channel: 0,
      data1: 60,
      data2: 0,
    });

    await act(async () => {
      renderer.unmount();
      await Promise.resolve();
    });
    expect(allNotesOff).toHaveBeenCalledWith('juno-node');
  });

  it('gives every key an expanded 44-point target and an assistive activation path', async () => {
    const renderer = await renderPanel([createJunoTrack()]);
    const whiteKey = findPressable(renderer, 'juno-key-60');
    const blackKey = findPressable(renderer, 'juno-key-61');
    const whiteKeyStyle = flattenStyle(whiteKey.props.style({ pressed: false }));
    const blackKeyStyle = flattenStyle(blackKey.props.style({ pressed: false }));

    expect(Number(whiteKeyStyle.minWidth)).toBeGreaterThanOrEqual(44);
    expect(blackKey.props.hitSlop).toEqual({
      bottom: 0,
      left: 8,
      right: 8,
      top: 0,
    });
    expect(
      Number(blackKeyStyle.width) +
        blackKey.props.hitSlop.left +
        blackKey.props.hitSlop.right,
    ).toBeGreaterThanOrEqual(44);
    expect(whiteKey.props.onAccessibilityTap).toEqual(expect.any(Function));
    expect(blackKey.props.onAccessibilityTap).toEqual(expect.any(Function));

    await act(async () => {
      whiteKey.props.onAccessibilityTap();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendInstrumentMidi).toHaveBeenNthCalledWith(1, 'juno-node', {
      type: 0,
      channel: 0,
      data1: 60,
      data2: 100,
    });
    expect(sendInstrumentMidi).toHaveBeenNthCalledWith(2, 'juno-node', {
      type: 1,
      channel: 0,
      data1: 60,
      data2: 0,
    });
    renderer.unmount();
  });

  it('surfaces the real keyboard failure beside the keyboard controls', async () => {
    sendInstrumentMidi.mockRejectedValueOnce(new Error('Native MIDI queue is offline'));
    const renderer = await renderPanel([createJunoTrack()]);

    await act(async () => {
      findPressable(renderer, 'juno-key-60').props.onPressIn();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = renderer.root.findByProps({ testID: 'juno-action-error' });
    const announcement = findAccessibleText(renderer, 'juno-action-error-announcement');
    expect(alert.parent?.props.testID).toBe('juno-keyboard-section');
    expect(alert.props.accessibilityLabel).toBeUndefined();
    expect(alert.props.accessibilityRole).toBeUndefined();
    expect(alert.props.role).toBeUndefined();
    expect(alert.props.accessible).not.toBe(true);
    expect(announcement.props.accessible).toBe(true);
    expect(announcement.props.accessibilityRole).toBe('text');
    expect(announcement.props.accessibilityLiveRegion).toBe('assertive');
    expect(announcement.props.accessibilityLabel).toBe(
      'Juno action failed. Native MIDI queue is offline',
    );
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      'Juno action failed. Native MIDI queue is offline',
      {
        queue: true,
      },
    );
    expect(renderedText(renderer)).toContain('Native MIDI queue is offline');
    renderer.unmount();
  });

  it('uses two parameter columns on a compact phone with large text', async () => {
    const dimensions = jest.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({
      fontScale: 2,
      height: 740,
      scale: 3,
      width: 350,
    });

    try {
      const renderer = await renderPanel([createJunoTrack()]);
      const pulseControl = renderer.root.findByProps({
        testID: 'juno-control-pulseWidth',
      });

      expect(flattenStyle(pulseControl.props.style).flexBasis).toBe('47%');
      renderer.unmount();
    } finally {
      dimensions.mockRestore();
    }
  });

  it('targets live notes and patch edits at the explicitly selected Juno part', async () => {
    const first = createJunoTrack();
    const second: TrackViewModel = {
      ...createJunoTrack(),
      id: 'juno-track-2',
      name: 'Chord Part',
      instrument: {
        ...createJunoTrack().instrument!,
        nodeId: 'juno-node-2',
      },
    };
    const renderer = await renderPanel([first, second], second.id);

    await act(async () => {
      findPressable(renderer, 'juno-key-60').props.onPressIn();
      await Promise.resolve();
    });
    expect(sendInstrumentMidi).toHaveBeenCalledWith('juno-node-2', {
      type: 0,
      channel: 0,
      data1: 60,
      data2: 100,
    });

    await act(async () => {
      findPressable(renderer, 'juno-cutoffHz-increase').props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setJunoParameter).toHaveBeenCalledWith('juno-track-2', 'cutoffHz', 2650);
    renderer.unmount();
  });

  it('shows native unavailability, disables keys, and still persists patch edits', async () => {
    useInstrumentControls.mockReturnValue({
      isAvailable: false,
      sendInstrumentMidi,
      setInstrumentParameter,
      allNotesOff,
    });
    const renderer = await renderPanel([createJunoTrack()]);

    expect(renderedText(renderer)).toContain(
      'Patch edits save normally; live keys require the native audio bridge.',
    );
    expect(findPressable(renderer, 'juno-key-60').props.disabled).toBe(true);

    const increaseCutoff = findPressable(renderer, 'juno-cutoffHz-increase');
    await act(async () => {
      increaseCutoff.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'cutoffHz', 2650);
    expect(setInstrumentParameter).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
