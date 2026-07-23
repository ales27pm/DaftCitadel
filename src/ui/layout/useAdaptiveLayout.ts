import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, useWindowDimensions } from 'react-native';

export type LayoutBreakpoint = 'phone' | 'tablet' | 'desktop';

export type LayoutOrientation = 'portrait' | 'landscape';

export type WorkspaceMode = 'studio' | 'deck';

export type LayoutDeviceIdiom = 'phone' | 'tablet' | 'desktop';

export interface AdaptiveLayoutMetrics {
  width: number;
  height: number;
  breakpoint: LayoutBreakpoint;
  orientation: LayoutOrientation;
  isTablet: boolean;
  isLandscape: boolean;
  workspaceMode: WorkspaceMode;
  contentPadding: number;
  maxContentWidth: number;
}

export interface AdaptiveLayoutState extends AdaptiveLayoutMetrics {
  prefersReducedMotion: boolean;
  screenReaderEnabled: boolean;
  platform: typeof Platform.OS;
}

export interface ResolveAdaptiveLayoutOptions {
  platform?: typeof Platform.OS;
  deviceIdiom?: LayoutDeviceIdiom;
}

export const BREAKPOINTS = {
  phone: 0,
  tablet: 768,
  desktop: 1280,
} as const;

export const TABLET_SHORTEST_SIDE = 600;

export const CONTENT_PADDING = {
  phonePortrait: 16,
  phoneLandscape: 20,
  tablet: 24,
  desktop: 32,
} as const;

export const MAX_CONTENT_WIDTH = {
  tablet: 1180,
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

const normalizeDimension = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const resolveDeviceBreakpoint = (
  width: number,
  height: number,
  options: ResolveAdaptiveLayoutOptions,
): LayoutBreakpoint => {
  if (options.deviceIdiom) {
    return options.deviceIdiom;
  }

  const shortestSide = Math.min(width, height);
  const isNativeMobile = options.platform === 'ios' || options.platform === 'android';

  if (isNativeMobile) {
    return shortestSide >= TABLET_SHORTEST_SIDE ? 'tablet' : 'phone';
  }

  // A short side below the tablet threshold is a compact device even when a
  // landscape viewport happens to cross the legacy width-only breakpoints.
  if (shortestSide < TABLET_SHORTEST_SIDE) {
    return 'phone';
  }

  return resolveBreakpoint(width);
};

/**
 * Resolves layout geometry without reading React Native globals. Callers can
 * supply a known device idiom (for example, iPad) while Android and unknown
 * native devices fall back to the shortest-side convention.
 */
export const resolveAdaptiveLayout = (
  widthValue: number,
  heightValue: number,
  options: ResolveAdaptiveLayoutOptions = {},
): AdaptiveLayoutMetrics => {
  const width = normalizeDimension(widthValue);
  const height = normalizeDimension(heightValue);
  const isLandscape = width > height;
  const orientation: LayoutOrientation = isLandscape ? 'landscape' : 'portrait';
  const breakpoint = resolveDeviceBreakpoint(width, height, options);
  const isTablet = breakpoint === 'tablet';
  const workspaceMode: WorkspaceMode =
    breakpoint === 'phone' && !isLandscape ? 'deck' : 'studio';

  const contentPadding =
    breakpoint === 'desktop'
      ? CONTENT_PADDING.desktop
      : isTablet
        ? CONTENT_PADDING.tablet
        : isLandscape
          ? CONTENT_PADDING.phoneLandscape
          : CONTENT_PADDING.phonePortrait;

  const maxContentWidth =
    breakpoint === 'desktop'
      ? MAX_CONTENT_WIDTH.desktop
      : isTablet
        ? MAX_CONTENT_WIDTH.tablet
        : width;

  return {
    width,
    height,
    breakpoint,
    orientation,
    isTablet,
    isLandscape,
    workspaceMode,
    contentPadding,
    maxContentWidth,
  };
};

const resolvePlatformDeviceIdiom = (): LayoutDeviceIdiom | undefined => {
  const platform = Platform as typeof Platform & { isPad?: boolean };
  if (Platform.OS === 'ios' && typeof platform.isPad === 'boolean') {
    return platform.isPad ? 'tablet' : 'phone';
  }
  if (Platform.OS === 'macos' || Platform.OS === 'windows') {
    return 'desktop';
  }
  return undefined;
};

export const useAdaptiveLayout = (): AdaptiveLayoutState => {
  const { width, height } = useWindowDimensions();
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

  const layout = useMemo(
    () =>
      resolveAdaptiveLayout(width, height, {
        platform: Platform.OS,
        deviceIdiom: resolvePlatformDeviceIdiom(),
      }),
    [height, width],
  );

  return {
    ...layout,
    prefersReducedMotion,
    screenReaderEnabled,
    platform: Platform.OS,
  };
};
