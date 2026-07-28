import React, { useCallback, useState } from 'react';
import { Image } from 'expo-image';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import {
  AnimatedSignal,
  DisclosureRow,
  PreferenceRow,
  ScreenScaffold,
  SegmentedControl,
  STUDIO_SURFACE_SOURCES,
  StudioButton,
  StudioIcon,
  StudioPanel,
  StudioText,
  type GlowIntensity,
  type InterfaceDensity,
  type StudioAccentPalette,
  type StudioSurface,
  useTheme,
} from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useSessionViewModel } from '../session';
import { useUserPreferences } from '../settings';
import { DEFAULT_USER_PREFERENCES } from '../settings/user-preferences';

const TROUBLESHOOTING_DETAILS_ID = 'troubleshooting-details';

const ACCENT_OPTIONS: ReadonlyArray<{
  color: string;
  label: string;
  value: StudioAccentPalette;
}> = [
  { color: '#5CE5B5', label: 'Mint', value: 'mint' },
  { color: '#58C6E8', label: 'Cyan', value: 'cyan' },
  { color: '#E75DC7', label: 'Magenta', value: 'magenta' },
  { color: '#F3C66B', label: 'Amber', value: 'amber' },
];

const SURFACE_OPTIONS: ReadonlyArray<{
  label: string;
  value: StudioSurface;
}> = [
  { label: 'Carbon', value: 'carbon' },
  { label: 'Grid', value: 'grid' },
  { label: 'Spectral', value: 'spectral' },
];

const DENSITY_OPTIONS: ReadonlyArray<{
  label: string;
  value: InterfaceDensity;
}> = [
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Compact', value: 'compact' },
];

const GLOW_OPTIONS: ReadonlyArray<{
  label: string;
  value: GlowIntensity;
}> = [
  { label: 'Calm', value: 'calm' },
  { label: 'Balanced', value: 'balanced' },
  { label: 'Vivid', value: 'vivid' },
];

interface AccentChoiceProps {
  color: string;
  label: string;
  onPress: () => void;
  selected: boolean;
}

const AccentChoice: React.FC<AccentChoiceProps> = ({
  color,
  label,
  onPress,
  selected,
}) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${label} accent`}
      accessibilityRole={Platform.OS === 'web' ? 'radio' : 'button'}
      accessibilityState={Platform.OS === 'web' ? { checked: selected } : { selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.accentChoice,
        {
          backgroundColor: selected
            ? theme.colors.surfaceElevated
            : theme.colors.surfaceVariant,
          borderColor: selected ? theme.colors.accentPrimary : theme.colors.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <View style={[styles.accentSwatch, { backgroundColor: color }]}>
        {selected ? (
          <StudioIcon color={theme.colors.accentPrimaryInk} name="success" size={18} />
        ) : null}
      </View>
      <StudioText
        selectable={false}
        tone={selected ? 'mint' : 'secondary'}
        variant="caption"
        weight={selected ? 'bold' : 'medium'}
      >
        {label}
      </StudioText>
    </Pressable>
  );
};

interface SurfaceChoiceProps {
  label: string;
  onPress: () => void;
  transitionDuration: number;
  selected: boolean;
  value: StudioSurface;
}

const SurfaceChoice: React.FC<SurfaceChoiceProps> = ({
  label,
  onPress,
  transitionDuration,
  selected,
  value,
}) => {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${label} surface`}
      accessibilityRole={Platform.OS === 'web' ? 'radio' : 'button'}
      accessibilityState={Platform.OS === 'web' ? { checked: selected } : { selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.surfaceChoice,
        {
          borderColor: selected ? theme.colors.accentPrimary : theme.colors.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Image
        accessible={false}
        contentFit="cover"
        source={STUDIO_SURFACE_SOURCES[value]}
        style={styles.surfaceThumbnail}
        transition={transitionDuration}
      />
      <View
        style={[
          styles.surfaceChoiceLabel,
          { backgroundColor: theme.colors.surfaceElevated },
        ]}
      >
        <StudioText
          selectable={false}
          tone={selected ? 'mint' : 'secondary'}
          variant="caption"
          weight={selected ? 'bold' : 'medium'}
        >
          {label}
        </StudioText>
      </View>
    </Pressable>
  );
};

export interface SettingsScreenProps {
  isActive?: boolean;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({ isActive = true }) => {
  const adaptive = useAdaptiveLayout();
  const theme = useTheme();
  const { preferences, resetAppearance, setPreference } = useUserPreferences();
  const {
    diagnostics,
    error: sessionError,
    sessionId,
    sessionName,
    status,
    tracks,
  } = useSessionViewModel();
  const [detailsVisible, setDetailsVisible] = useState(false);
  const appearanceIsDefault =
    preferences.accentPalette === DEFAULT_USER_PREFERENCES.accentPalette &&
    preferences.glowIntensity === DEFAULT_USER_PREFERENCES.glowIntensity &&
    preferences.interfaceDensity === DEFAULT_USER_PREFERENCES.interfaceDensity &&
    preferences.studioSurface === DEFAULT_USER_PREFERENCES.studioSurface;

  const diagnosticsSummary =
    diagnostics.status === 'ready'
      ? `${Math.round(diagnostics.renderLoad * 100)}% render load · ${
          diagnostics.xruns
        } XRuns`
      : diagnostics.status === 'error'
        ? `Diagnostics error · ${
            diagnostics.error?.message ?? 'Audio diagnostics failed'
          }`
        : diagnostics.status === 'loading'
          ? 'Gathering audio diagnostics'
          : 'Audio diagnostics unavailable';

  const diagnosticsTone =
    diagnostics.status === 'error'
      ? ('critical' as const)
      : diagnostics.status === 'ready'
        ? ('success' as const)
        : ('secondary' as const);

  const toggleDetails = useCallback(() => {
    setDetailsVisible((visible) => !visible);
  }, []);

  return (
    <ScreenScaffold title="Settings">
      <StudioPanel
        accessibilityLabel="Studio appearance customization"
        style={{ gap: theme.spacing.lg }}
      >
        <View style={styles.sectionHeading}>
          <View style={styles.sectionHeadingCopy}>
            <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
              Studio appearance
            </StudioText>
            <StudioText selectable tone="secondary">
              Personalize the palette, surface, density, and live signal effects.
            </StudioText>
          </View>
          <StudioButton
            compact
            disabled={appearanceIsDefault}
            label="Reset"
            onPress={resetAppearance}
            variant="ghost"
          />
        </View>

        <View
          accessibilityLabel={`${preferences.accentPalette} accent, ${preferences.studioSurface} surface, ${preferences.interfaceDensity} density, ${preferences.glowIntensity} glow`}
          style={[
            styles.appearancePreview,
            {
              backgroundColor: theme.colors.surfaceVariant,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Image
            accessible={false}
            contentFit="cover"
            source={STUDIO_SURFACE_SOURCES[preferences.studioSurface]}
            style={[
              StyleSheet.absoluteFillObject,
              { opacity: Math.min(0.48, theme.effects.surfaceTextureOpacity * 3) },
            ]}
            transition={adaptive.prefersReducedMotion ? 0 : theme.motion.standard}
          />
          <View style={styles.previewHeader}>
            <StudioText variant="caption" tone="muted" weight="bold">
              LIVE PREVIEW
            </StudioText>
            <StudioText variant="caption" tone="mint" weight="bold">
              {preferences.accentPalette.toUpperCase()}
            </StudioText>
          </View>
          <AnimatedSignal
            enabled={isActive}
            height={72}
            testID="settings-appearance-signal"
          />
          <StudioText variant="caption" tone="secondary">
            {`${preferences.studioSurface} · ${preferences.interfaceDensity} · ${preferences.glowIntensity}`}
          </StudioText>
        </View>

        <View style={styles.customizationGroup}>
          <StudioText variant="caption" tone="muted" weight="bold">
            ACCENT
          </StudioText>
          <View
            accessibilityLabel={Platform.OS === 'web' ? 'Accent color' : undefined}
            accessibilityRole={Platform.OS === 'web' ? 'radiogroup' : undefined}
            style={styles.accentChoices}
          >
            {ACCENT_OPTIONS.map((option) => (
              <AccentChoice
                key={option.value}
                color={option.color}
                label={option.label}
                onPress={() => setPreference('accentPalette', option.value)}
                selected={preferences.accentPalette === option.value}
              />
            ))}
          </View>
        </View>

        <View style={styles.customizationGroup}>
          <StudioText variant="caption" tone="muted" weight="bold">
            SURFACE
          </StudioText>
          <View
            accessibilityLabel={Platform.OS === 'web' ? 'Studio surface' : undefined}
            accessibilityRole={Platform.OS === 'web' ? 'radiogroup' : undefined}
            style={styles.surfaceChoices}
          >
            {SURFACE_OPTIONS.map((option) => (
              <SurfaceChoice
                key={option.value}
                label={option.label}
                onPress={() => setPreference('studioSurface', option.value)}
                selected={preferences.studioSurface === option.value}
                transitionDuration={adaptive.prefersReducedMotion ? 0 : theme.motion.fast}
                value={option.value}
              />
            ))}
          </View>
        </View>

        <View style={styles.customizationGroup}>
          <StudioText variant="caption" tone="muted" weight="bold">
            DENSITY
          </StudioText>
          <SegmentedControl
            accessibilityLabel="Interface density"
            onChange={(value) => setPreference('interfaceDensity', value)}
            options={DENSITY_OPTIONS}
            selectionRole="radio"
            value={preferences.interfaceDensity}
          />
        </View>

        <View style={styles.customizationGroup}>
          <StudioText variant="caption" tone="muted" weight="bold">
            GLOW & MOTION
          </StudioText>
          <SegmentedControl
            accessibilityLabel="Glow and motion intensity"
            onChange={(value) => setPreference('glowIntensity', value)}
            options={GLOW_OPTIONS}
            selectionRole="radio"
            value={preferences.glowIntensity}
          />
          <StudioText selectable tone="secondary" variant="caption">
            System reduced-motion settings always take priority.
          </StudioText>
        </View>
      </StudioPanel>

      <StudioPanel style={{ gap: theme.spacing.sm }}>
        <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
          Performance preferences
        </StudioText>
        <PreferenceRow
          description="Start transport when a performance scene is launched."
          onValueChange={(value) => setPreference('autoPlayScenes', value)}
          title="Auto-play scenes"
          value={preferences.autoPlayScenes}
        />
        <View
          accessible={false}
          style={{ backgroundColor: theme.colors.border, height: 1 }}
        />
        <PreferenceRow
          description="Show render load and XRun status on Performance."
          onValueChange={(value) => setPreference('showDiagnostics', value)}
          title="Show diagnostics"
          value={preferences.showDiagnostics}
        />
      </StudioPanel>

      <StudioPanel style={{ gap: theme.spacing.md }}>
        <View style={{ gap: theme.spacing.xs }}>
          <StudioText accessibilityRole="header" variant="sectionTitle" weight="bold">
            Troubleshooting
          </StudioText>
          <StudioText selectable tone={diagnosticsTone}>
            {diagnosticsSummary}
          </StudioText>
          <StudioText selectable tone="secondary">
            {`Audio session · ${status}`}
          </StudioText>
        </View>

        <DisclosureRow
          controls={TROUBLESHOOTING_DETAILS_ID}
          expanded={detailsVisible}
          label={detailsVisible ? 'Hide technical details' : 'Show technical details'}
          onPress={toggleDetails}
        />

        {detailsVisible ? (
          <View
            accessibilityLabel="Technical diagnostics"
            nativeID={TROUBLESHOOTING_DETAILS_ID}
            style={{
              backgroundColor: theme.colors.surfaceVariant,
              borderCurve: 'continuous',
              borderRadius: theme.radii.md,
              gap: theme.spacing.sm,
              padding: theme.spacing.md,
            }}
          >
            <StudioText selectable variant="label" weight="bold">
              {sessionName || 'Unnamed session'}
            </StudioText>
            <StudioText selectable tone="secondary">
              {`Session ID · ${sessionId || 'Unavailable'}`}
            </StudioText>
            <StudioText selectable tone="secondary">
              {`Tracks · ${tracks.length}`}
            </StudioText>
            <StudioText selectable tone="secondary">
              {diagnostics.status === 'ready'
                ? `${Math.round(diagnostics.renderLoad * 100)}% render load`
                : 'Render load unavailable'}
            </StudioText>
            <StudioText selectable tone="secondary">
              {diagnostics.status === 'ready'
                ? `${diagnostics.xruns} XRuns detected`
                : 'XRun count unavailable'}
            </StudioText>
            <StudioText selectable tone="secondary">
              {`Screen reader · ${adaptive.screenReaderEnabled ? 'Enabled' : 'Disabled'}`}
            </StudioText>
            <StudioText selectable tone="secondary">
              {`Reduced motion · ${
                adaptive.prefersReducedMotion ? 'Enabled' : 'Disabled'
              }`}
            </StudioText>
            {sessionError ? (
              <StudioText accessibilityRole="alert" selectable tone="critical">
                {`Session error · ${sessionError.message}`}
              </StudioText>
            ) : null}
          </View>
        ) : null}
      </StudioPanel>
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  sectionHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  sectionHeadingCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  appearancePreview: {
    borderCurve: 'continuous',
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
    minHeight: 150,
    overflow: 'hidden',
    padding: 12,
  },
  previewHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  customizationGroup: {
    gap: 8,
  },
  accentChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  accentChoice: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    gap: 6,
    minHeight: 88,
    minWidth: 70,
    padding: 8,
  },
  accentSwatch: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 9,
    height: 48,
    justifyContent: 'center',
    width: '100%',
  },
  surfaceChoices: {
    flexDirection: 'row',
    gap: 8,
  },
  surfaceChoice: {
    borderCurve: 'continuous',
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    minHeight: 92,
    minWidth: 0,
    overflow: 'hidden',
  },
  surfaceThumbnail: {
    flex: 1,
    minHeight: 58,
    width: '100%',
  },
  surfaceChoiceLabel: {
    alignItems: 'center',
    minHeight: 32,
    paddingHorizontal: 4,
    paddingVertical: 7,
  },
});
