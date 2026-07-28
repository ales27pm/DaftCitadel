import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';

import '../../../test-support/setupReactAct';
import { StudioPanel } from '../studio-components';
import { ThemeProvider } from '../theme';

const flattenStyle = (style: unknown): Record<string, unknown> =>
  Object.assign(
    {},
    ...(Array.isArray(style) ? style : [style]).filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object',
    ),
  );

describe('StudioPanel effects', () => {
  it('uses cross-platform box shadows for vivid glow', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider appearance={{ glow: 'vivid' }}>
          <StudioPanel testID="glowing-panel" variant="raised" />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    if (!renderer) {
      throw new Error('Renderer not initialized');
    }
    const panel = renderer.root
      .findAllByType(View)
      .find((view) => view.props.testID === 'glowing-panel');
    expect(panel).toBeDefined();
    const style = flattenStyle(panel?.props.style);
    expect(style.boxShadow).toEqual([
      expect.objectContaining({
        blurRadius: 22,
        color: expect.stringMatching(/^#[\dA-F]{8}$/i),
        offsetX: 0,
        offsetY: 0,
      }),
    ]);
    expect(style.shadowOpacity).toBeUndefined();
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  it('removes panel shadows for calm glow', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider appearance={{ glow: 'calm' }}>
          <StudioPanel testID="calm-panel" />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    if (!renderer) {
      throw new Error('Renderer not initialized');
    }
    const panel = renderer.root
      .findAllByType(View)
      .find((view) => view.props.testID === 'calm-panel');
    expect(panel).toBeDefined();
    const style = flattenStyle(panel?.props.style);
    expect(style.boxShadow).toBeUndefined();
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });
});
