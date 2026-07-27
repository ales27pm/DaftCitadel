import React, { PropsWithChildren, useMemo } from 'react';
import {
  AccessibilityProps,
  Pressable,
  PressableProps,
  StyleProp,
  StyleSheet,
  Text,
  TextProps,
  View,
  ViewProps,
  ViewStyle,
  Platform,
} from 'react-native';

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

  const accentStyle = useMemo(() => {
    const accent = mapIntentToColor(theme, intent);
    const base: ViewStyle = {
      borderColor: accent,
      borderWidth: 1,
    };

    if (Platform.OS === 'android') {
      base.elevation = theme.elevation[elevation];
    } else {
      base.shadowColor = accent;
      base.shadowOpacity = 0.7;
      base.shadowRadius = theme.elevation[elevation] * glow;
      base.shadowOffset = { width: 0, height: 0 };
    }

    return base;
  }, [elevation, glow, intent, theme]);

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
    <View
      accessible
      accessibilityRole="summary"
      style={[containerStyle, accentStyle]}
      {...rest}
    >
      {children}
    </View>
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

export interface NeonButtonProps extends AccessibilityProps, PressableProps {
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

  const buttonEffectStyle = useMemo(
    () => ({
      shadowColor: mapIntentToColor(theme, intent),
      shadowOpacity: disabled ? theme.opacity.disabled : 1,
      shadowRadius: theme.elevation.md,
      transform: [
        {
          scale: disabled ? 0.98 : 1,
        },
      ],
    }),
    [disabled, intent, theme],
  );

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
      <View style={[baseStyle, buttonEffectStyle]}>
        <NeonText
          variant="bodyLarge"
          weight="medium"
          intent="primary"
          style={{ color: theme.colors.surface }}
        >
          {label}
        </NeonText>
      </View>
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
