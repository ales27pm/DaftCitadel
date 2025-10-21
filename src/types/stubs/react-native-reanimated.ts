/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ComponentType, ReactNode } from 'react';
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';

export interface SharedValue<T> {
  value: T;
}

export type DerivedValue<T> = SharedValue<T>;

export interface AnimatedScrollEvent extends NativeScrollEvent {}

export interface WithTimingConfig {
  duration?: number;
}

export const useSharedValue = <T>(initialValue: T): SharedValue<T> => ({
  value: initialValue,
});

export const useDerivedValue = <T>(
  factory: () => T,
  _deps?: ReadonlyArray<unknown>,
): DerivedValue<T> => ({
  value: factory(),
});

export const useAnimatedReaction = <T>(
  prepare: () => T,
  react: (value: T, previous: T | null) => void,
  _deps?: ReadonlyArray<unknown>,
): void => {
  react(prepare(), null);
};

export const useAnimatedStyle = <T extends object>(
  updater: () => T,
  _deps?: ReadonlyArray<unknown>,
): StyleProp<ViewStyle> => updater() as unknown as StyleProp<ViewStyle>;

export const useAnimatedScrollHandler = (
  handlers: {
    onScroll?: (event: AnimatedScrollEvent) => void;
    onBeginDrag?: (event: AnimatedScrollEvent) => void;
    onEndDrag?: (event: AnimatedScrollEvent) => void;
  },
  _deps?: ReadonlyArray<unknown>,
): ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) => {
  return (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    handlers.onScroll?.(event.nativeEvent as AnimatedScrollEvent);
  };
};

export const runOnJS = <T extends (...args: any[]) => any>(
  handler: T,
): ((...args: Parameters<T>) => ReturnType<T>) => {
  return (...args: Parameters<T>) => handler(...args) as ReturnType<T>;
};

export const withTiming = <T>(value: T, _config?: WithTimingConfig): T => value;

export const withRepeat = <T>(value: T, _count?: number, _reverse?: boolean): T => value;

interface AnimatedCommonProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  [key: string]: unknown;
}

interface AnimatedScrollViewProps extends AnimatedCommonProps {
  horizontal?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

type AnimatedModule = {
  View: ComponentType<AnimatedCommonProps>;
  ScrollView: ComponentType<AnimatedScrollViewProps>;
};

const Animated: AnimatedModule = {
  View: (() => null) as ComponentType<AnimatedCommonProps>,
  ScrollView: (() => null) as ComponentType<AnimatedScrollViewProps>,
};

// eslint-disable-next-line import/no-default-export
export default Animated;
