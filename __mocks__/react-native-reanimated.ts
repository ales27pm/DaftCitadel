/* eslint-disable @typescript-eslint/no-explicit-any */
const NOOP = () => undefined;

export const useSharedValue = <T,>(initial: T) => ({ value: initial });
export const useAnimatedStyle = (fn: () => any) => fn();
export const useAnimatedReaction = NOOP;
export const useDerivedValue = (fn: () => any) => ({ value: fn() });
export const useAnimatedScrollHandler = () => NOOP;
export const withTiming = <T,>(value: T) => value;
export const withRepeat = <T,>(value: T) => value;
export const runOnJS = (fn: (...args: any[]) => any) => (...args: any[]) => fn(...args);
export const Easing = { linear: NOOP } as const;

const Animated = {
  View: 'View',
  ScrollView: 'ScrollView',
};

export default Animated;
