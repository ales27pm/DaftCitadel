import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { ThemeProvider } from '../../../design-system';
import { WaveformEditor } from '../WaveformEditor.web';

describe('WaveformEditor web playhead', () => {
  it('renders updates emitted by an external shared value', async () => {
    const listeners = new Map<number, (value: number) => void>();
    const playhead = {
      value: 0.25,
      addListener: (id: number, listener: (value: number) => void) => {
        listeners.set(id, listener);
      },
      removeListener: (id: number) => {
        listeners.delete(id);
      },
    } as unknown as SharedValue<number>;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <WaveformEditor
            waveform={new Float32Array([0, 0.5, -0.5, 1])}
            width={200}
            playhead={playhead}
          />
        </ThemeProvider>,
      );
    });
    if (!renderer) {
      throw new Error('Renderer not initialized');
    }

    const findPlayhead = () =>
      renderer!.root.findAllByType(View).find((view) => {
        const styles = view.props.style as Array<{ width?: number }> | undefined;
        return Array.isArray(styles) && styles[0]?.width === 2;
      });

    expect(findPlayhead()?.props.style[1].left).toBe(50);

    await act(async () => {
      playhead.value = 0.75;
      listeners.forEach((listener) => listener(playhead.value));
    });

    expect(findPlayhead()?.props.style[1].left).toBe(150);
    renderer.unmount();
  });
});
