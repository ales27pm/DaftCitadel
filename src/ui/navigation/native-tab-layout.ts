import type { LayoutBreakpoint } from '../layout';

export interface NativeTabBarMetrics {
  height: number;
  paddingBottom: number;
  paddingTop: number;
}

const TAB_BAR_PADDING = 8;

export const resolveNativeTabBarMetrics = (
  breakpoint: LayoutBreakpoint,
  bottomInset: number,
): NativeTabBarMetrics => {
  const safeBottomInset = Number.isFinite(bottomInset) ? Math.max(0, bottomInset) : 0;
  const visualHeight = breakpoint === 'phone' ? 72 : 76;

  return {
    height: visualHeight + safeBottomInset,
    paddingBottom: TAB_BAR_PADDING + safeBottomInset,
    paddingTop: TAB_BAR_PADDING,
  };
};
