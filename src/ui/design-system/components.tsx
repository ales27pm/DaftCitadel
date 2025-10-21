import React, { PropsWithChildren, useEffect, useMemo } from 'react';
import {
  AccessibilityProps,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextProps,
  View,
  ViewProps,
  ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { ThemeIntent, mapIntentToColor } from './tokens';
import { createTextStyle, TypographyVariant } from './typography';
import { useTheme } from './theme';

export interface NeonSurfaceProps extends ViewProps, AccessibilityProps {
  elevation?: keyof ReturnType<typeof useTheme>['elevation'];
  intent?: ThemeIntent;
  glow?: number;
}

export const NeonSurface: React.FC<PropsWithChildren<NeonSurfaceProps>> = ({
  children,
  style,
  elevation = 'md',
  intent = 'primary',
  glow = 0.8,
  ...rest
}) => {
  const theme = useTheme();
  const glowValue = useSharedValue(glow);

  useEffect(() => {
    glowValue.value = withTiming(glow, { duration: 200 });
  }, [glow, glowValue]);

  const animatedStyle = useAnimatedStyle(() => ({
    shadowColor: mapIntentToColor(theme, intent),
    shadowOpacity: 0.7,
    shadowRadius: theme.elevation[elevation] * glowValue.value,
    shadowOffset: { width: 0, height: 0 },
    borderColor: mapIntentToColor(theme, intent),
    borderWidth: 1,
  }));

  const containerStyle: StyleProp<ViewStyle> = useMemo(
    () => [
      {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.md,
        borderRadius: theme.radii.lg,
      },
      style,
    ],
    [style, theme.colors.surface, theme.radii.lg, theme.spacing.md],
  );

  return (
    <Animated.View
      accessible
      accessibilityRole="summary"
      style={[containerStyle, animatedStyle]}
      {...rest}
    >
      {children}
    </Animated.View>
  );
};

export interface NeonTextProps extends TextProps {
  variant?: TypographyVariant;
  intent?: ThemeIntent;
  weight?: keyof ReturnType<typeof useTheme>['typography']['weights'];
}

export const NeonText: React.FC<PropsWithChildren<NeonTextProps>> = ({
  children,
  variant = 'body',
  intent = 'primary',
  weight = 'regular',
  style,
  ...rest
}) => {
  const theme = useTheme();
  const textStyle = useMemo(
    () => [createTextStyle(theme, variant, intent, weight), style],
    [intent, style, theme, variant, weight],
  );

  return (
    <Text accessibilityRole="text" style={textStyle} {...rest}>
      {children}
    </Text>
  );
};

export interface NeonButtonProps extends AccessibilityProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  intent?: ThemeIntent;
  style?: StyleProp<ViewStyle>;
}

export const NeonButton: React.FC<NeonButtonProps> = ({
  label,
  onPress,
  disabled = false,
  intent = 'primary',
  style,
  ...rest
}) => {
  const theme = useTheme();
  const glow = useSharedValue(disabled ? theme.opacity.disabled : 1);

  const animatedGlow = useAnimatedStyle(() => ({
    shadowColor: mapIntentToColor(theme, intent),
    shadowOpacity: glow.value,
    shadowRadius: theme.elevation.md,
    transform: [
      {
        scale: withTiming(disabled ? 0.98 : 1, { duration: 150 }),
      },
    ],
  }));

  const baseStyle: StyleProp<ViewStyle> = [
    {
      backgroundColor: mapIntentToColor(theme, intent),
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.radii.md,
      alignItems: 'center',
      justifyContent: 'center',
      opacity: disabled ? theme.opacity.disabled : 1,
    },
    style,
  ];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      {...rest}
    >
      <Animated.View style={[baseStyle, animatedGlow]}>
        <NeonText
          variant="bodyLarge"
          weight="medium"
          intent="primary"
          style={{ color: theme.colors.surface }}
        >
          {label}
        </NeonText>
      </Animated.View>
    </Pressable>
  );
};

export interface NeonToolbarProps extends ViewProps {
  title: string;
  actions?: Array<{
    label: string;
    onPress: () => void;
    intent?: ThemeIntent;
    disabled?: boolean;
  }>;
}

export const NeonToolbar: React.FC<NeonToolbarProps> = ({
  title,
  actions,
  style,
  ...rest
}) => {
  const theme = useTheme();
  const toolbarStyles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: theme.spacing.md,
        },
        actionRow: {
          flexDirection: 'row',
        },
      }),
    [theme.spacing.md],
  );

  const actionSpacing = useMemo(
    () =>
      actions?.map((_, index) => ({ marginLeft: index === 0 ? 0 : theme.spacing.sm })) ??
      [],
    [actions, theme.spacing.sm],
  );

  return (
    <View accessibilityRole="header" style={[toolbarStyles.container, style]} {...rest}>
      <NeonText variant="title" weight="bold">
        {title}
      </NeonText>
      <View style={toolbarStyles.actionRow}>
        {actions?.map((action, index) => (
          <View key={action.label} style={actionSpacing[index]}>
            <NeonButton
              label={action.label}
              onPress={action.onPress}
              intent={action.intent ?? 'secondary'}
              disabled={action.disabled}
              accessibilityLabel={action.label}
            />
          </View>
        ))}
      </View>
    </View>
  );
};
