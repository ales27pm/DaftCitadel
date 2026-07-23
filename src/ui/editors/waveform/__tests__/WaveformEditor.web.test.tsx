import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';

import { ThemeProvider } from '../../../design-system';
import { WaveformEditor } from '../WaveformEditor.web';

describe('WaveformEditor web playhead', () => {
  it('renders updates emitted by numeric playhead progress', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <WaveformEditor
            waveform={new Float32Array([0, 0.5, -0.5, 1])}
            width={200}
            playhead={0.25}
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
      renderer!.update(
        <ThemeProvider>
          <WaveformEditor
            waveform={new Float32Array([0, 0.5, -0.5, 1])}
            width={200}
            playhead={0.75}
          />
        </ThemeProvider>,
      );
    });

    expect(findPlayhead()?.props.style[1].left).toBe(150);
    renderer.unmount();
  });
});
