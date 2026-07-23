import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider, TransportBar } from '../design-system';
import { MidiPianoRoll as NativeMidiPianoRoll } from '../editors/midi/MidiPianoRoll';
import { MidiPianoRoll as WebMidiPianoRoll } from '../editors/midi/MidiPianoRoll.web';

const renderWithTheme = async (element: React.ReactElement) => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(<ThemeProvider>{element}</ThemeProvider>);
    await Promise.resolve();
  });
  if (!renderer) {
    throw new Error('Renderer not initialized');
  }
  return renderer;
};

describe('meter-aware shared UI components', () => {
  it('formats transport position in signature beats', async () => {
    const renderer = await renderWithTheme(
      <TransportBar
        bpm={120}
        timeSignature="6/8"
        positionBeats={3.25}
        isPlaying={false}
        isAvailable
        onPlay={jest.fn()}
        onStop={jest.fn()}
        onRewind={jest.fn()}
      />,
    );

    expect(renderer.root.findByProps({ children: '2.1.50' })).toBeDefined();
    renderer.unmount();
  });

  it('sizes and accents the native MIDI grid using the active meter', async () => {
    const renderer = await renderWithTheme(
      <NativeMidiPianoRoll
        notes={[]}
        totalBars={2}
        timeSignature="6/8"
        pixelsPerBeat={10}
      />,
    );

    const horizontalScroll = renderer.root.findByProps({ horizontal: true });
    expect(horizontalScroll.props.contentContainerStyle).toMatchObject({ width: 60 });

    const barLines = renderer.root.findAll(
      (node) =>
        node.props.pointerEvents === 'none' &&
        node.props.style?.opacity === 0.45 &&
        typeof node.props.style?.left === 'number',
    );
    expect(barLines.map((line) => line.props.style.left)).toEqual(
      expect.arrayContaining([0, 30, 60]),
    );
    renderer.unmount();
  });

  it('sizes and accents the web MIDI grid using the active meter', async () => {
    const renderer = await renderWithTheme(
      <WebMidiPianoRoll
        notes={[]}
        totalBars={2}
        timeSignature="6/8"
        pixelsPerBeat={10}
      />,
    );

    const horizontalScroll = renderer.root.findByProps({ horizontal: true });
    expect(horizontalScroll.props.contentContainerStyle).toMatchObject({ width: 60 });

    const barLines = renderer.root.findAll(
      (node) =>
        node.props.pointerEvents === 'none' &&
        node.props.style?.opacity === 0.45 &&
        typeof node.props.style?.left === 'number',
    );
    expect(barLines.map((line) => line.props.style.left)).toEqual([0, 30, 60]);
    renderer.unmount();
  });
});
