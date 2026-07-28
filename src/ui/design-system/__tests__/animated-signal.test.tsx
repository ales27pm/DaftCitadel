import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, Animated } from 'react-native';

import '../../../test-support/setupReactAct';
import { AnimatedSignal } from '../animated-signal';
import { ThemeProvider } from '../theme';

type TestAccessibilityInfo = typeof AccessibilityInfo & {
  __setReduceMotionEnabled: (value: boolean) => void;
};

const testAccessibilityInfo = AccessibilityInfo as TestAccessibilityInfo;

describe('AnimatedSignal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testAccessibilityInfo.__setReduceMotionEnabled(false);
  });

  it('renders the accessible-hidden SVG signal layers in the active accent palette', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider appearance={{ accentPalette: 'cyan' }}>
          <AnimatedSignal testID="fixture-signal" />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    if (!renderer) {
      throw new Error('Renderer not initialized');
    }

    const signal = renderer.root.findByType('AnimatedView' as never);
    expect(signal.props.testID).toBe('fixture-signal');
    expect(signal.props.accessibilityElementsHidden).toBe(true);
    expect(renderer.root.findAllByType('SvgPath' as never)).toHaveLength(4);
    expect(Animated.loop).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  it('does not start motion while disabled or when reduced motion is enabled', async () => {
    testAccessibilityInfo.__setReduceMotionEnabled(true);
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <AnimatedSignal enabled={false} />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    expect(Animated.loop).not.toHaveBeenCalled();
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  it('stops active motion when the signal becomes inactive', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <AnimatedSignal enabled />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const loopAnimation = (Animated.loop as jest.Mock).mock.results[0]?.value as
      { stop: jest.Mock } | undefined;
    expect(loopAnimation).toBeDefined();

    await act(async () => {
      renderer?.update(
        <ThemeProvider>
          <AnimatedSignal enabled={false} />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    expect(loopAnimation?.stop).toHaveBeenCalled();
    expect(Animated.loop).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });

  it('uses the selected glow level to tune ambient motion', async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider appearance={{ glow: 'vivid' }}>
          <AnimatedSignal />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    expect(Animated.timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 3800, useNativeDriver: true }),
    );
    await act(async () => {
      renderer?.unmount();
      await Promise.resolve();
    });
  });
});
