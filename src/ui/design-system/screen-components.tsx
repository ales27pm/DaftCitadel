import React, { PropsWithChildren, ReactNode } from 'react';
import { Image, type ImageSource } from 'expo-image';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  ScrollViewProps,
  StyleSheet,
  StyleProp,
  Switch,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAdaptiveLayout } from '../layout';
import { STUDIO_SURFACE_SOURCES } from './appearance-assets';
import {
  StudioButton,
  StudioHeader,
  StudioIcon,
  StudioIconName,
  StudioPanel,
  StudioText,
  StudioTone,
} from './studio-components';
import { useTheme } from './theme';

export interface ScreenScaffoldProps
  extends
    PropsWithChildren,
    Pick<ScrollViewProps, 'keyboardShouldPersistTaps' | 'refreshControl'> {
  title: string;
  detail?: string;
  actions?: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  scrollViewRef?: React.Ref<ScrollView>;
  testID?: string;
}

export const ScreenScaffold: React.FC<ScreenScaffoldProps> = ({
  actions,
  children,
  contentContainerStyle,
  detail,
  keyboardShouldPersistTaps = 'handled',
  refreshControl,
  scrollViewRef,
  testID,
  title,
}) => {
  const adaptive = useAdaptiveLayout();
  const theme = useTheme();

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={{ backgroundColor: theme.colors.background, flex: 1 }}
      testID={testID}
    >
      <Image
        accessible={false}
        contentFit="cover"
        pointerEvents="none"
        source={STUDIO_SURFACE_SOURCES[theme.appearance.surface]}
        style={[
          StyleSheet.absoluteFillObject,
          { opacity: theme.effects.surfaceTextureOpacity },
        ]}
        testID="studio-surface-background"
        transition={adaptive.prefersReducedMotion ? 0 : theme.motion.standard}
      />
      <ScrollView
        ref={scrollViewRef}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        refreshControl={refreshControl}
        style={{ flex: 1 }}
        contentContainerStyle={[
          {
            alignSelf: 'center',
            gap: theme.spacing.md,
            maxWidth: adaptive.maxContentWidth,
            paddingBottom: theme.spacing.xxl,
            paddingHorizontal: adaptive.contentPadding,
            paddingTop: theme.spacing.md,
            width: '100%',
          },
          contentContainerStyle,
        ]}
      >
        <StudioHeader actions={actions} detail={detail} title={title} compact />
        {children}
      </ScrollView>
    </SafeAreaView>
  );
};

export type ScreenStateKind = 'loading' | 'error' | 'empty';

export interface ScreenStateProps {
  kind: ScreenStateKind;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  illustrationSource?: ImageSource;
}

const STATE_ICON: Record<ScreenStateKind, StudioIconName> = {
  empty: 'instrument',
  error: 'error',
  loading: 'diagnostics',
};

const STATE_TONE: Record<ScreenStateKind, StudioTone> = {
  empty: 'secondary',
  error: 'critical',
  loading: 'cyan',
};

export const ScreenState: React.FC<ScreenStateProps> = ({
  actionLabel,
  kind,
  message,
  onAction,
  title,
  illustrationSource,
}) => {
  const theme = useTheme();
  const tone = STATE_TONE[kind];
  const isLoading = kind === 'loading';

  return (
    <StudioPanel
      accessibilityLiveRegion="polite"
      accessibilityRole={kind === 'error' ? 'alert' : 'summary'}
      style={{ alignItems: 'flex-start', gap: theme.spacing.sm }}
      variant={kind === 'error' ? 'critical' : 'default'}
    >
      {illustrationSource ? (
        <Image
          accessible={false}
          contentFit="contain"
          source={illustrationSource}
          style={{
            alignSelf: 'stretch',
            aspectRatio: 16 / 9,
            maxHeight: 160,
            opacity: 0.92,
          }}
        />
      ) : null}
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.spacing.sm }}>
        {isLoading ? (
          <ActivityIndicator color={theme.colors.accentTertiary} size="small" />
        ) : (
          <StudioIcon
            color={
              tone === 'critical'
                ? theme.colors.statusCritical
                : theme.colors.textSecondary
            }
            name={STATE_ICON[kind]}
            size={20}
          />
        )}
        <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
          {title}
        </StudioText>
      </View>
      <StudioText selectable tone={tone === 'critical' ? 'critical' : 'secondary'}>
        {message}
      </StudioText>
      {actionLabel && onAction ? (
        <StudioButton
          label={actionLabel}
          onPress={onAction}
          variant={kind === 'error' || kind === 'empty' ? 'primary' : 'secondary'}
        />
      ) : null}
    </StudioPanel>
  );
};

export interface SegmentedOption<T extends string> {
  label: string;
  value: T;
  icon?: StudioIconName;
}

export interface SegmentedControlProps<T extends string> {
  accessibilityLabel: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  selectionRole?: 'radio' | 'tabs';
}

export function SegmentedControl<T extends string>({
  accessibilityLabel,
  onChange,
  options,
  selectionRole = 'tabs',
  value,
}: SegmentedControlProps<T>): React.ReactElement {
  const theme = useTheme();

  return (
    <View
      accessibilityLabel={
        selectionRole === 'tabs' || Platform.OS === 'web' ? accessibilityLabel : undefined
      }
      accessibilityRole={
        selectionRole === 'radio'
          ? Platform.OS === 'web'
            ? 'radiogroup'
            : undefined
          : 'tablist'
      }
      style={{
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.border,
        borderCurve: 'continuous',
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        flexDirection: 'row',
        overflow: 'hidden',
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityLabel={option.label}
            accessibilityRole={
              selectionRole === 'radio'
                ? Platform.OS === 'web'
                  ? 'radio'
                  : 'button'
                : 'tab'
            }
            accessibilityState={
              selectionRole === 'radio' && Platform.OS === 'web'
                ? { checked: selected }
                : { selected }
            }
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              alignItems: 'center',
              backgroundColor: selected ? theme.colors.surfaceElevated : 'transparent',
              borderLeftColor: theme.colors.border,
              borderLeftWidth: index === 0 ? 0 : 1,
              flex: 1,
              flexDirection: 'row',
              gap: theme.spacing.sm,
              justifyContent: 'center',
              minHeight: 52,
              opacity: pressed ? 0.8 : 1,
              paddingHorizontal: theme.spacing.md,
            })}
          >
            {option.icon ? (
              <StudioIcon
                color={selected ? theme.colors.accentPrimary : theme.colors.textSecondary}
                name={option.icon}
                size={18}
              />
            ) : null}
            <StudioText
              selectable={false}
              tone={selected ? 'mint' : 'secondary'}
              variant="label"
              weight={selected ? 'bold' : 'medium'}
            >
              {option.label}
            </StudioText>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface PreferenceRowProps {
  title: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}

export const PreferenceRow: React.FC<PreferenceRowProps> = ({
  description,
  onValueChange,
  title,
  value,
}) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityHint={description}
      accessibilityLabel={title}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => ({
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.spacing.md,
        minHeight: 64,
        opacity: pressed ? 0.82 : 1,
        paddingVertical: theme.spacing.sm,
      })}
    >
      <View style={{ flex: 1, gap: theme.spacing.xs }}>
        <StudioText selectable={false} variant="bodyLarge" weight="medium">
          {title}
        </StudioText>
        <StudioText selectable={false} tone="secondary">
          {description}
        </StudioText>
      </View>
      <View pointerEvents="none">
        <Switch
          accessible={false}
          onValueChange={onValueChange}
          trackColor={{
            false: theme.colors.surfaceElevated,
            true: theme.colors.statusSuccess,
          }}
          value={value}
        />
      </View>
    </Pressable>
  );
};

export interface DisclosureRowProps {
  label: string;
  expanded: boolean;
  controls?: string;
  onPress: () => void;
  icon?: StudioIconName;
}

export const DisclosureRow: React.FC<DisclosureRowProps> = ({
  controls,
  expanded,
  icon = 'diagnostics',
  label,
  onPress,
}) => {
  const theme = useTheme();
  return (
    <Pressable
      aria-controls={controls}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: 'center',
        borderColor: theme.colors.border,
        borderCurve: 'continuous',
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.spacing.md,
        minHeight: 52,
        opacity: pressed ? 0.82 : 1,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
      })}
    >
      <StudioIcon color={theme.colors.textSecondary} name={icon} size={20} />
      <StudioText selectable={false} style={{ flex: 1 }} tone="secondary">
        {label}
      </StudioText>
      <StudioIcon
        color={theme.colors.textTertiary}
        name={expanded ? 'chevronUp' : 'chevronRight'}
        size={16}
      />
    </Pressable>
  );
};

export interface LevelMeterProps {
  label: string;
  value: number;
  minimum?: number;
  maximum?: number;
}

export const LevelMeter: React.FC<LevelMeterProps> = ({
  label,
  maximum = 1,
  minimum = 0,
  value,
}) => {
  const theme = useTheme();
  const safeValue = Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : minimum;
  const ratio = maximum > minimum ? (safeValue - minimum) / (maximum - minimum) : 0;

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{
        max: 100,
        min: 0,
        now: Math.round(ratio * 100),
        text: `${Math.round(ratio * 100)}%`,
      }}
      style={{
        backgroundColor: theme.colors.surfaceElevated,
        borderCurve: 'continuous',
        borderRadius: theme.radii.pill,
        height: 8,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <View
        style={{
          backgroundColor: theme.colors.accentPrimary,
          borderRadius: theme.radii.pill,
          height: '100%',
          width: `${ratio * 100}%`,
        }}
      />
    </View>
  );
};
