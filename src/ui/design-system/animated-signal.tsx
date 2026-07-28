import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useAdaptiveLayout } from '../layout';
import { useTheme } from './theme';

export interface AnimatedSignalProps {
  enabled?: boolean;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const AnimatedSignal: React.FC<AnimatedSignalProps> = ({
  enabled = true,
  height = 92,
  style,
  testID,
}) => {
  const { prefersReducedMotion } = useAdaptiveLayout();
  const theme = useTheme();
  const phase = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    phase.stopAnimation();
    if (!enabled || prefersReducedMotion) {
      phase.setValue(0.5);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(phase, {
          duration: theme.motion.ambient,
          easing: Easing.inOut(Easing.sin),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(phase, {
          duration: theme.motion.ambient,
          easing: Easing.inOut(Easing.sin),
          toValue: 0,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [enabled, phase, prefersReducedMotion, theme.motion.ambient]);

  const animationStyle = useMemo(
    () => ({
      opacity: phase.interpolate({
        inputRange: [0, 1],
        outputRange: [theme.motion.ambientOpacityFloor, 1],
      }),
      transform: [
        {
          translateX: phase.interpolate({
            inputRange: [0, 1],
            outputRange: [-theme.motion.ambientTravel, theme.motion.ambientTravel],
          }),
        },
        {
          scaleY: phase.interpolate({
            inputRange: [0, 1],
            outputRange: [
              1 - theme.motion.ambientScaleDelta,
              1 + theme.motion.ambientScaleDelta,
            ],
          }),
        },
      ],
    }),
    [
      phase,
      theme.motion.ambientOpacityFloor,
      theme.motion.ambientScaleDelta,
      theme.motion.ambientTravel,
    ],
  );

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.container, { height }, animationStyle, style]}
      testID={testID}
    >
      <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 360 92" width="100%">
        <Path
          d="M0 47 H360"
          fill="none"
          opacity={0.22}
          stroke={theme.colors.border}
          strokeWidth={1}
        />
        <Path
          d="M0 47 C18 47 22 42 34 47 S50 56 62 47 S78 32 92 47 S112 61 126 47 S142 39 154 47 S170 52 180 47 C190 43 194 16 202 47 C210 78 216 6 224 47 C232 88 238 21 246 47 C254 73 260 34 270 47 C282 63 290 39 302 47 S324 52 338 47 S350 43 360 47"
          fill="none"
          stroke={theme.colors.accentPrimary}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.4}
        />
        <Path
          d="M0 50 C30 50 42 46 64 50 S104 55 128 50 S170 45 190 50 S218 56 236 50 S270 44 292 50 S330 54 360 50"
          fill="none"
          opacity={0.62}
          stroke={theme.colors.accentTertiary}
          strokeDasharray="2 5"
          strokeLinecap="round"
          strokeWidth={1.25}
        />
        <Path
          d="M208 17 V77 M224 8 V84 M240 24 V69 M256 35 V58"
          fill="none"
          opacity={0.32}
          stroke={theme.colors.accentSecondary}
          strokeLinecap="round"
          strokeWidth={1.15}
        />
      </Svg>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    width: '100%',
  },
});
