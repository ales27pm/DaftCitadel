import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, useWindowDimensions } from 'react-native';

export type LayoutBreakpoint = 'phone' | 'tablet' | 'desktop';

export interface AdaptiveLayoutState {
  breakpoint: LayoutBreakpoint;
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
  isTablet: boolean;
  isLandscape: boolean;
  workspaceMode: 'deck' | 'split' | 'wide';
  contentPadding: number;
  maxContentWidth: number;
  prefersReducedMotion: boolean;
  screenReaderEnabled: boolean;
  platform: typeof Platform.OS;
}

export const BREAKPOINTS = {
  phone: 0,
  tablet: 768,
  desktop: 1280,
} as const;

export const resolveBreakpoint = (width: number): LayoutBreakpoint => {
  if (width >= BREAKPOINTS.desktop) {
    return 'desktop';
  }
  if (width >= BREAKPOINTS.tablet) {
    return 'tablet';
  }
  return 'phone';
};

export const useAdaptiveLayout = (): AdaptiveLayoutState => {
  const { height, width } = useWindowDimensions();
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false);

  useEffect(() => {
    let isMounted = true;

    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (isMounted) {
        setPrefersReducedMotion(Boolean(enabled));
      }
    });

    AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (isMounted) {
        setScreenReaderEnabled(Boolean(enabled));
      }
    });

    const reduceMotionListener = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        setPrefersReducedMotion(Boolean(enabled));
      },
    );

    const screenReaderListener = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      (enabled) => {
        setScreenReaderEnabled(Boolean(enabled));
      },
    );

    return () => {
      isMounted = false;
      reduceMotionListener.remove();
      screenReaderListener.remove();
    };
  }, []);

  const breakpoint = useMemo(() => resolveBreakpoint(width), [width]);
  const isLandscape = width > height;
  const isTablet = breakpoint !== 'phone';
  const workspaceMode =
    breakpoint === 'desktop' ? 'wide' : isTablet && isLandscape ? 'split' : 'deck';
  const contentPadding = breakpoint === 'phone' ? 16 : breakpoint === 'tablet' ? 24 : 32;
  const maxContentWidth =
    breakpoint === 'desktop' ? 1180 : breakpoint === 'tablet' ? 860 : width;

  return {
    breakpoint,
    width,
    height,
    orientation: isLandscape ? 'landscape' : 'portrait',
    isTablet,
    isLandscape,
    workspaceMode,
    contentPadding,
    maxContentWidth,
    prefersReducedMotion,
    screenReaderEnabled,
    platform: Platform.OS,
  };
};
