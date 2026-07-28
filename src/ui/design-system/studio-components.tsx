import React, { PropsWithChildren, ReactNode, useMemo } from 'react';
import {
  AccessibilityProps,
  ActivityIndicator,
  Platform,
  Pressable,
  PressableProps,
  StyleProp,
  Text,
  TextProps,
  View,
  ViewProps,
  ViewStyle,
} from 'react-native';

import { useTheme } from './theme';
import { parseTimeSignature } from '../utils/timeSignature';

export type StudioTone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'mint'
  | 'cyan'
  | 'magenta'
  | 'success'
  | 'warning'
  | 'critical';

export type StudioIconName =
  | 'arrangement'
  | 'mixer'
  | 'performance'
  | 'settings'
  | 'play'
  | 'stop'
  | 'rewind'
  | 'plus'
  | 'engine'
  | 'waveform'
  | 'midi'
  | 'diagnostics'
  | 'chevronDown'
  | 'chevronUp'
  | 'mute'
  | 'solo';

const ICON_GLYPHS: Record<StudioIconName, string> = {
  arrangement: '≋',
  mixer: '☷',
  performance: '▦',
  settings: '⚙',
  play: '▶',
  stop: '■',
  rewind: '↤',
  plus: '+',
  engine: '◉',
  waveform: '≋',
  midi: '♫',
  diagnostics: '∿',
  chevronDown: '⌄',
  chevronUp: '⌃',
  mute: 'M',
  solo: 'S',
};

const toneColor = (
  colors: ReturnType<typeof useTheme>['colors'],
  tone: StudioTone,
): string => {
  switch (tone) {
    case 'secondary':
      return colors.textSecondary;
    case 'muted':
      return colors.textTertiary;
    case 'mint':
      return colors.accentPrimary;
    case 'cyan':
      return colors.accentTertiary;
    case 'magenta':
      return colors.accentSecondary;
    case 'success':
      return colors.statusSuccess;
    case 'warning':
      return colors.statusWarning;
    case 'critical':
      return colors.statusCritical;
    case 'primary':
    default:
      return colors.textPrimary;
  }
};

export interface StudioIconProps {
  name: StudioIconName;
  color?: string;
  size?: number;
}

export const StudioIcon: React.FC<StudioIconProps> = ({ name, color, size = 18 }) => {
  const theme = useTheme();
  return (
    <Text
      accessible={false}
      style={{
        color: color ?? theme.colors.textSecondary,
        fontFamily: Platform.OS === 'ios' ? 'System' : undefined,
        fontSize: size,
        fontWeight: '700',
        lineHeight: Math.ceil(size * 1.15),
        textAlign: 'center',
        minWidth: size + 2,
      }}
    >
      {ICON_GLYPHS[name]}
    </Text>
  );
};

export type StudioTextVariant =
  'caption' | 'label' | 'body' | 'bodyLarge' | 'sectionTitle' | 'screenTitle' | 'metric';

export interface StudioTextProps extends TextProps {
  variant?: StudioTextVariant;
  tone?: StudioTone;
  weight?: 'regular' | 'medium' | 'bold';
}

const FONT_SIZES: Record<StudioTextVariant, number> = {
  caption: 11,
  label: 14,
  body: 16,
  bodyLarge: 18,
  sectionTitle: 18,
  screenTitle: 20,
  metric: 40,
};

const LINE_HEIGHTS: Record<StudioTextVariant, number> = {
  caption: 15,
  label: 18,
  body: 22,
  bodyLarge: 24,
  sectionTitle: 24,
  screenTitle: 26,
  metric: 44,
};

const FONT_WEIGHTS: Record<NonNullable<StudioTextProps['weight']>, TextProps['style']> = {
  regular: { fontFamily: 'Inter_400Regular' },
  medium: { fontFamily: 'Inter_600SemiBold' },
  bold: { fontFamily: 'Inter_700Bold' },
};

export const StudioText: React.FC<PropsWithChildren<StudioTextProps>> = ({
  children,
  variant = 'body',
  tone = 'primary',
  weight = 'regular',
  style,
  ...rest
}) => {
  const theme = useTheme();
  const isNumeric = variant === 'metric' || variant === 'caption';
  return (
    <Text
      accessibilityRole="text"
      style={[
        {
          color: toneColor(theme.colors, tone),
          fontSize: FONT_SIZES[variant],
          lineHeight: LINE_HEIGHTS[variant],
          letterSpacing: variant === 'screenTitle' ? 2 : variant === 'caption' ? 0.5 : 0,
          fontVariant: isNumeric ? (['tabular-nums'] as const) : undefined,
        },
        FONT_WEIGHTS[weight],
        style,
      ]}
      {...rest}
    >
      {children}
    </Text>
  );
};

export interface StudioPanelProps extends ViewProps, AccessibilityProps {
  variant?: 'default' | 'raised' | 'subtle';
  padding?: number;
}

export const StudioPanel: React.FC<PropsWithChildren<StudioPanelProps>> = ({
  children,
  variant = 'default',
  padding,
  style,
  ...rest
}) => {
  const theme = useTheme();
  const backgroundColor =
    variant === 'raised'
      ? theme.colors.surfaceElevated
      : variant === 'subtle'
        ? theme.colors.surfaceVariant
        : theme.colors.surface;
  return (
    <View
      style={[
        {
          backgroundColor,
          borderColor: theme.colors.border,
          borderCurve: 'continuous',
          borderRadius: theme.radii.lg,
          borderWidth: 1,
          padding: padding ?? 16,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
};

export interface StudioButtonProps extends Omit<PressableProps, 'children'> {
  label: string;
  onPress: () => void;
  icon?: StudioIconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  compact?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const StudioButton: React.FC<StudioButtonProps> = ({
  label,
  onPress,
  icon,
  variant = 'secondary',
  compact = false,
  loading = false,
  disabled = false,
  style,
  ...rest
}) => {
  const theme = useTheme();
  const isDisabled = disabled || loading;
  const palette = useMemo(() => {
    if (variant === 'primary') {
      return {
        background: theme.colors.accentPrimary,
        border: theme.colors.accentPrimary,
        foreground: theme.colors.accentPrimaryInk,
      };
    }
    if (variant === 'danger') {
      return {
        background: theme.colors.statusCritical,
        border: theme.colors.statusCritical,
        foreground: theme.colors.background,
      };
    }
    if (variant === 'ghost') {
      return {
        background: 'transparent',
        border: 'transparent',
        foreground: theme.colors.textSecondary,
      };
    }
    return {
      background: theme.colors.surfaceElevated,
      border: theme.colors.border,
      foreground: theme.colors.textPrimary,
    };
  }, [theme, variant]);

  return (
    <Pressable
      accessibilityLabel={rest.accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          alignItems: 'center',
          alignSelf: 'flex-start',
          backgroundColor: palette.background,
          borderColor: palette.border,
          borderCurve: 'continuous',
          borderRadius: theme.radii.md,
          borderWidth: 1,
          flexDirection: 'row',
          gap: 8,
          justifyContent: 'center',
          minHeight: 44,
          opacity: isDisabled ? 0.5 : pressed ? 0.82 : 1,
          paddingHorizontal: compact ? 12 : 16,
          paddingVertical: 9,
        },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={palette.foreground} size="small" />
      ) : (
        icon && <StudioIcon color={palette.foreground} name={icon} size={16} />
      )}
      <StudioText
        selectable={false}
        variant="label"
        weight="bold"
        style={{ color: palette.foreground }}
      >
        {label}
      </StudioText>
    </Pressable>
  );
};

export interface StudioHeaderProps {
  title: string;
  eyebrow?: string;
  detail?: string;
  actions?: ReactNode;
  compact?: boolean;
}

export const StudioHeader: React.FC<StudioHeaderProps> = ({
  title,
  eyebrow,
  detail,
  actions,
  compact = false,
}) => (
  <View
    accessibilityRole="header"
    style={{
      alignItems: compact ? 'center' : 'flex-start',
      flexDirection: compact ? 'row' : 'column',
      gap: compact ? 16 : 4,
      justifyContent: 'space-between',
      minWidth: 0,
    }}
  >
    <View style={{ flex: 1, minWidth: 0 }}>
      {eyebrow ? (
        <StudioText variant="caption" tone="mint" weight="bold">
          {eyebrow.toUpperCase()}
        </StudioText>
      ) : null}
      <StudioText
        selectable
        variant="screenTitle"
        weight="bold"
        numberOfLines={compact ? 1 : undefined}
        style={compact ? { fontSize: 24, lineHeight: 30 } : undefined}
      >
        {title}
      </StudioText>
      {detail ? (
        <StudioText selectable variant="caption" tone="secondary" numberOfLines={1}>
          {detail}
        </StudioText>
      ) : null}
    </View>
    {actions ? <View style={{ flexDirection: 'row', gap: 8 }}>{actions}</View> : null}
  </View>
);

export interface StatusBadgeProps {
  label: string;
  tone?: StudioTone;
  icon?: StudioIconName;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  label,
  tone = 'secondary',
  icon,
}) => {
  const theme = useTheme();
  const color = toneColor(theme.colors, tone);
  return (
    <View
      style={{
        alignItems: 'center',
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceElevated,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        flexDirection: 'row',
        gap: 6,
        minHeight: 28,
        paddingHorizontal: 10,
        paddingVertical: 4,
      }}
    >
      {icon ? <StudioIcon color={color} name={icon} size={12} /> : null}
      <StudioText variant="caption" weight="medium" style={{ color }}>
        {label}
      </StudioText>
    </View>
  );
};

export interface TransportBarProps {
  sessionName?: string;
  bpm: number;
  timeSignature: string;
  positionBeats: number;
  isPlaying: boolean;
  isAvailable: boolean;
  onPlay: () => void;
  onStop: () => void;
  onRewind: () => void;
  compact?: boolean;
}

export const TransportBar: React.FC<TransportBarProps> = ({
  sessionName,
  bpm,
  timeSignature,
  positionBeats,
  isPlaying,
  isAvailable,
  onPlay,
  onStop,
  onRewind,
  compact = false,
}) => {
  const safePositionBeats = Number.isFinite(positionBeats)
    ? Math.max(0, positionBeats)
    : 0;
  const { denominator, numerator } = parseTimeSignature(timeSignature);
  const signatureBeats = safePositionBeats * (denominator / 4);
  const bar = Math.floor((signatureBeats + Number.EPSILON) / numerator) + 1;
  const beat = Math.floor((signatureBeats + Number.EPSILON) % numerator) + 1;
  const tick = Math.floor((signatureBeats % 1) * 100);
  const position = `${bar}.${beat}.${tick.toString().padStart(2, '0')}`;
  return (
    <StudioPanel
      padding={compact ? 10 : 12}
      variant="subtle"
      accessibilityLabel="Transport controls"
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        flexWrap: compact ? 'wrap' : 'nowrap',
        gap: 10,
        justifyContent: 'space-between',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <StatusBadge
          icon="engine"
          label={
            isAvailable ? (isPlaying ? 'Playing' : 'Engine ready') : 'Engine offline'
          }
          tone={isAvailable ? 'mint' : 'warning'}
        />
        {!compact && sessionName ? (
          <StudioText variant="label" weight="bold" numberOfLines={1}>
            {sessionName}
          </StudioText>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View>
          <StudioText variant="caption" tone="muted">
            POSITION
          </StudioText>
          <StudioText selectable variant="label" weight="bold">
            {position}
          </StudioText>
        </View>
        <View>
          <StudioText variant="caption" tone="muted">
            TEMPO
          </StudioText>
          <StudioText selectable variant="label" weight="bold">
            {Math.round(bpm)} BPM
          </StudioText>
        </View>
        {!compact ? (
          <View>
            <StudioText variant="caption" tone="muted">
              METER
            </StudioText>
            <StudioText selectable variant="label" weight="bold">
              {timeSignature}
            </StudioText>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <StudioButton
          compact
          label="Rewind"
          icon="rewind"
          variant="ghost"
          disabled={!isAvailable}
          onPress={onRewind}
        />
        <StudioButton
          compact
          label={isPlaying ? 'Playing' : 'Play'}
          icon="play"
          variant="primary"
          disabled={!isAvailable || isPlaying}
          onPress={onPlay}
        />
        <StudioButton
          compact
          label="Stop"
          icon="stop"
          disabled={!isAvailable || !isPlaying}
          onPress={onStop}
        />
      </View>
    </StudioPanel>
  );
};

export interface SectionHeaderProps {
  title: string;
  detail?: string;
  accessory?: ReactNode;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  detail,
  accessory,
}) => (
  <View
    style={{
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      minWidth: 0,
    }}
  >
    <View style={{ flex: 1, minWidth: 0 }}>
      <StudioText variant="sectionTitle" weight="bold">
        {title}
      </StudioText>
      {detail ? (
        <StudioText variant="caption" tone="secondary">
          {detail}
        </StudioText>
      ) : null}
    </View>
    {accessory}
  </View>
);
