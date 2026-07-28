import React, { PropsWithChildren } from 'react';
import {
  AccessibilityProps,
  PressableProps,
  StyleProp,
  View,
  ViewProps,
  ViewStyle,
} from 'react-native';

import { ThemeIntent } from './tokens';
import { TypographyVariant } from './typography';
import {
  StudioButton,
  StudioHeader,
  StudioPanel,
  StudioText,
  type StudioTextProps,
} from './studio-components';
import { useTheme } from './theme';

const toneForIntent = (intent: ThemeIntent): NonNullable<StudioTextProps['tone']> => {
  switch (intent) {
    case 'secondary':
      return 'secondary';
    case 'tertiary':
      return 'cyan';
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'critical':
      return 'critical';
    case 'primary':
    default:
      return 'primary';
  }
};

const variantForTypography = (
  variant: TypographyVariant,
): NonNullable<StudioTextProps['variant']> => {
  switch (variant) {
    case 'caption':
      return 'caption';
    case 'bodyLarge':
      return 'bodyLarge';
    case 'title':
      return 'sectionTitle';
    case 'headline':
      return 'screenTitle';
    case 'body':
    default:
      return 'body';
  }
};

/**
 * Compatibility adapters for the original Neon API.
 *
 * New surfaces should use the Studio primitives directly. Keeping these adapters
 * lets existing editors inherit the calmer Studio hierarchy while they are
 * migrated incrementally.
 */
export interface NeonSurfaceProps extends ViewProps, AccessibilityProps {
  elevation?: keyof ReturnType<typeof useTheme>['elevation'];
  intent?: ThemeIntent;
  glow?: number;
}

export const NeonSurface: React.FC<PropsWithChildren<NeonSurfaceProps>> = ({
  children,
  style,
  intent = 'primary',
  elevation: _elevation,
  glow: _glow,
  ...rest
}) => (
  <StudioPanel
    variant={intent === 'critical' ? 'critical' : 'default'}
    style={style}
    {...rest}
  >
    {children}
  </StudioPanel>
);

export interface NeonTextProps extends Omit<
  React.ComponentProps<typeof StudioText>,
  'variant' | 'tone' | 'weight'
> {
  variant?: TypographyVariant;
  intent?: ThemeIntent;
  weight?: keyof ReturnType<typeof useTheme>['typography']['weights'];
}

export const NeonText: React.FC<PropsWithChildren<NeonTextProps>> = ({
  children,
  variant = 'body',
  intent = 'primary',
  weight = 'regular',
  ...rest
}) => (
  <StudioText
    tone={toneForIntent(intent)}
    variant={variantForTypography(variant)}
    weight={weight}
    {...rest}
  >
    {children}
  </StudioText>
);

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
}) => (
  <StudioButton
    disabled={disabled}
    label={label}
    onPress={onPress}
    style={style}
    variant={
      intent === 'primary' ? 'primary' : intent === 'critical' ? 'danger' : 'secondary'
    }
    {...rest}
  />
);

export interface NeonToolbarProps extends ViewProps {
  title: string;
  stackActions?: boolean;
  actions?: Array<{
    label: string;
    onPress: () => void;
    intent?: ThemeIntent;
    disabled?: boolean;
  }>;
}

export const NeonToolbar: React.FC<NeonToolbarProps> = ({
  title,
  stackActions = false,
  actions,
  style,
  ...rest
}) => {
  const theme = useTheme();
  const actionViews = actions?.length ? (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.sm,
      }}
    >
      {actions.map((action) => (
        <NeonButton
          key={action.label}
          accessibilityLabel={action.label}
          disabled={action.disabled}
          intent={action.intent ?? 'secondary'}
          label={action.label}
          onPress={action.onPress}
        />
      ))}
    </View>
  ) : undefined;

  return (
    <View
      style={[
        {
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.md,
        },
        style,
      ]}
      {...rest}
    >
      <StudioHeader
        actions={stackActions ? undefined : actionViews}
        title={title}
        compact
      />
      {stackActions ? actionViews : null}
    </View>
  );
};
