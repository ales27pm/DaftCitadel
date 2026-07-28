import React, { PropsWithChildren, ReactNode, useEffect, useMemo } from 'react';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import {
  AccessibilityInfo,
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
  | 'chevronRight'
  | 'refresh'
  | 'instrument'
  | 'scenes'
  | 'warning'
  | 'success'
  | 'error'
  | 'mute'
  | 'solo';

type MaterialIconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const ICONS: Record<StudioIconName, { sf: SFSymbol; material: MaterialIconName }> = {
  arrangement: { sf: 'list.bullet.rectangle', material: 'view-list-outline' },
  mixer: { sf: 'slider.horizontal.3', material: 'tune-vertical' },
  performance: { sf: 'pianokeys', material: 'piano' },
  settings: { sf: 'gearshape', material: 'cog-outline' },
  play: { sf: 'play.fill', material: 'play' },
  stop: { sf: 'stop.fill', material: 'stop' },
  rewind: { sf: 'backward.end.fill', material: 'skip-backward' },
  plus: { sf: 'plus', material: 'plus' },
  engine: { sf: 'waveform.path.ecg', material: 'waveform' },
  waveform: { sf: 'waveform', material: 'waveform' },
  midi: { sf: 'music.note', material: 'music-note' },
  diagnostics: { sf: 'gauge', material: 'gauge' },
  chevronDown: { sf: 'chevron.down', material: 'chevron-down' },
  chevronUp: { sf: 'chevron.up', material: 'chevron-up' },
  chevronRight: { sf: 'chevron.right', material: 'chevron-right' },
  refresh: { sf: 'arrow.clockwise', material: 'refresh' },
  instrument: { sf: 'pianokeys', material: 'piano' },
  scenes: { sf: 'square.grid.2x2', material: 'view-grid-outline' },
  warning: { sf: 'exclamationmark.triangle', material: 'alert-outline' },
  success: { sf: 'checkmark.circle.fill', material: 'check-circle-outline' },
  error: { sf: 'xmark.circle.fill', material: 'close-circle-outline' },
  mute: { sf: 'speaker.slash.fill', material: 'volume-mute' },
  solo: { sf: 'headphones', material: 'headphones' },
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

const colorWithOpacity = (color: string, opacity: number): string => {
  if (!/^#[\da-f]{6}$/i.test(color)) {
    return color;
  }
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${alpha}`;
};

export interface StudioIconProps {
  name: StudioIconName;
  color?: string;
  size?: number;
}

export const StudioIcon: React.FC<StudioIconProps> = ({ name, color, size = 18 }) => {
  const theme = useTheme();
  const tintColor = color ?? theme.colors.textSecondary;
  const icon = ICONS[name];
  return (
    <SymbolView
      accessible={false}
      fallback={
        <MaterialCommunityIcons
          accessibilityElementsHidden
          color={tintColor}
          importantForAccessibility="no"
          name={icon.material}
          size={size}
        />
      }
      name={icon.sf}
      resizeMode="scaleAspectFit"
      size={size}
      style={{
        height: size,
        width: size,
      }}
      tintColor={tintColor}
      weight="semibold"
    />
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
  caption: 12,
  label: 14,
  body: 16,
  bodyLarge: 18,
  sectionTitle: 20,
  screenTitle: 34,
  metric: 40,
};

const LINE_HEIGHTS: Record<StudioTextVariant, number> = {
  caption: 16,
  label: 18,
  body: 22,
  bodyLarge: 24,
  sectionTitle: 26,
  screenTitle: 40,
  metric: 44,
};

const FONT_WEIGHTS: Record<NonNullable<StudioTextProps['weight']>, TextProps['style']> = {
  regular: { fontWeight: '400' },
  medium: { fontWeight: '600' },
  bold: { fontWeight: '700' },
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
      style={[
        {
          color: toneColor(theme.colors, tone),
          fontSize: FONT_SIZES[variant],
          lineHeight: LINE_HEIGHTS[variant],
          letterSpacing:
            variant === 'screenTitle' ? -0.6 : variant === 'caption' ? 0.2 : 0,
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

export type StudioAlertTextProps = Omit<
  StudioTextProps,
  | 'accessibilityLabel'
  | 'accessibilityLiveRegion'
  | 'accessibilityRole'
  | 'accessible'
  | 'role'
> & {
  announcement: string;
};

export const StudioAlertText: React.FC<PropsWithChildren<StudioAlertTextProps>> = ({
  announcement,
  children,
  ...rest
}) => {
  useEffect(() => {
    if (Platform.OS === 'ios' && announcement) {
      AccessibilityInfo.announceForAccessibilityWithOptions(announcement, {
        queue: true,
      });
    }
  }, [announcement]);

  return (
    <StudioText
      {...rest}
      accessible
      accessibilityLabel={announcement}
      accessibilityLiveRegion="assertive"
      accessibilityRole={Platform.OS === 'ios' ? 'text' : 'alert'}
    >
      {children ?? announcement}
    </StudioText>
  );
};

export interface StudioPanelProps extends ViewProps, AccessibilityProps {
  variant?: 'default' | 'raised' | 'subtle' | 'critical';
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
      : variant === 'subtle' || variant === 'critical'
        ? theme.colors.surfaceVariant
        : theme.colors.surface;
  const borderColor =
    variant === 'critical' ? theme.colors.statusCritical : theme.colors.border;
  const glowOpacity =
    variant === 'critical'
      ? 0
      : variant === 'raised'
        ? theme.effects.glowOpacity
        : theme.effects.glowOpacity * 0.45;
  const glowRadius =
    variant === 'raised' ? theme.effects.glowRadius : theme.effects.glowRadius * 0.65;
  return (
    <View
      style={[
        {
          backgroundColor,
          borderColor,
          borderCurve: 'continuous',
          borderRadius: theme.radii.sm,
          borderWidth: 1,
          boxShadow:
            glowOpacity > 0
              ? [
                  {
                    blurRadius: glowRadius,
                    color: colorWithOpacity(theme.colors.accentPrimary, glowOpacity),
                    offsetX: 0,
                    offsetY: 0,
                  },
                ]
              : undefined,
          padding: padding ?? theme.spacing.md,
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
  iconOnly?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const StudioButton: React.FC<StudioButtonProps> = ({
  label,
  onPress,
  icon,
  variant = 'secondary',
  compact = false,
  iconOnly = false,
  loading = false,
  disabled = false,
  style,
  accessibilityState,
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
      accessibilityState={{
        ...accessibilityState,
        busy: loading || accessibilityState?.busy,
        disabled: isDisabled,
      }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          alignItems: 'center',
          alignSelf: 'flex-start',
          backgroundColor: palette.background,
          borderColor: palette.border,
          borderCurve: 'continuous',
          borderRadius: theme.radii.sm,
          borderWidth: 1,
          flexDirection: 'row',
          gap: 8,
          justifyContent: 'center',
          minHeight: 44,
          minWidth: iconOnly ? 44 : undefined,
          opacity: isDisabled ? 0.5 : pressed ? 0.82 : 1,
          paddingHorizontal: iconOnly ? 0 : compact ? 12 : 16,
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
      {!iconOnly ? (
        <StudioText
          selectable={false}
          variant="label"
          weight="bold"
          style={{ color: palette.foreground }}
        >
          {label}
        </StudioText>
      ) : null}
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
      flexWrap: compact ? 'wrap' : 'nowrap',
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
        style={compact ? { fontSize: 28, lineHeight: 34 } : undefined}
      >
        {title}
      </StudioText>
      {detail ? (
        <StudioText selectable variant="caption" tone="secondary">
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
  bpm?: number;
  timeSignature?: string;
  positionBeats?: number;
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
  const theme = useTheme();
  const safePositionBeats =
    typeof positionBeats === 'number' && Number.isFinite(positionBeats)
      ? Math.max(0, positionBeats)
      : 0;
  const { denominator, numerator } = parseTimeSignature(timeSignature ?? '4/4');
  const signatureBeats = safePositionBeats * (denominator / 4);
  const bar = Math.floor((signatureBeats + Number.EPSILON) / numerator) + 1;
  const beat = Math.floor((signatureBeats + Number.EPSILON) % numerator) + 1;
  const tick = Math.floor((signatureBeats % 1) * 100);
  const position = `${bar}.${beat}.${tick.toString().padStart(2, '0')}`;

  if (compact) {
    return (
      <StudioPanel
        accessibilityLabel="Transport controls"
        padding={8}
        variant="subtle"
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: 8,
          justifyContent: 'space-between',
        }}
      >
        <View
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            flexShrink: 1,
            gap: 10,
            minWidth: 0,
          }}
        >
          <StudioIcon
            color={
              isAvailable
                ? isPlaying
                  ? theme.colors.accentPrimary
                  : theme.colors.statusSuccess
                : theme.colors.statusWarning
            }
            name="engine"
            size={16}
          />
          <View>
            <StudioText variant="caption" tone="muted">
              TEMPO
            </StudioText>
            <StudioText selectable variant="label" weight="bold">
              {Number.isFinite(bpm) ? `${Math.round(bpm ?? 0)} BPM` : '—'}
            </StudioText>
          </View>
          <View>
            <StudioText variant="caption" tone="muted">
              METER
            </StudioText>
            <StudioText selectable variant="label" weight="bold">
              {timeSignature ?? '—'}
            </StudioText>
          </View>
        </View>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 6 }}>
          <StudioButton
            compact
            iconOnly
            accessibilityHint={`Returns the playhead to the start from ${position}`}
            icon="rewind"
            label="Rewind"
            disabled={!isAvailable}
            onPress={onRewind}
            variant="ghost"
          />
          <StudioButton
            compact
            icon="play"
            label={isPlaying ? 'Playing' : 'Play'}
            variant="primary"
            disabled={!isAvailable || isPlaying}
            onPress={onPlay}
          />
          <StudioButton
            compact
            iconOnly
            icon="stop"
            label="Stop"
            disabled={!isAvailable || !isPlaying}
            onPress={onStop}
          />
        </View>
      </StudioPanel>
    );
  }

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
            {Number.isFinite(bpm) ? `${Math.round(bpm ?? 0)} BPM` : '—'}
          </StudioText>
        </View>
        {!compact ? (
          <View>
            <StudioText variant="caption" tone="muted">
              METER
            </StudioText>
            <StudioText selectable variant="label" weight="bold">
              {timeSignature ?? '—'}
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
