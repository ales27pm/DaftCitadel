import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Pressable } from 'react-native';

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

describe('JunoPerformancePanel', () => {
  const addJunoTrack = jest.fn(async () => undefined);
  const setJunoParameter = jest.fn(async () => undefined);
  const applyJunoPreset = jest.fn(async () => undefined);
  const sendInstrumentMidi = jest.fn(async () => undefined);
  const setInstrumentParameter = jest.fn(async () => undefined);
  const allNotesOff = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
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
    const serialized = JSON.stringify(renderer.toJSON());

    expect(serialized).toContain('DCO');
    expect(serialized).toContain('LFO');
    expect(serialized).toContain('VCF');
    expect(serialized).toContain('ENV');
    expect(serialized).toContain('CHORUS');
    expect(serialized).toContain('OUTPUT');

    const increaseCutoff = findPressable(renderer, 'juno-cutoffHz-increase');
    await act(async () => {
      increaseCutoff.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'cutoffHz', 1250);

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
    expect(setJunoParameter).toHaveBeenCalledWith('juno-track-2', 'cutoffHz', 1250);
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

    expect(JSON.stringify(renderer.toJSON())).toContain('Live Juno controls unavailable');
    expect(findPressable(renderer, 'juno-key-60').props.disabled).toBe(true);

    const increaseCutoff = findPressable(renderer, 'juno-cutoffHz-increase');
    await act(async () => {
      increaseCutoff.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setJunoParameter).toHaveBeenCalledWith('juno-track', 'cutoffHz', 1250);
    expect(setInstrumentParameter).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
