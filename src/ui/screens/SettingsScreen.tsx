import React, { useMemo } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';
import { useUserPreferences, type UserPreferences } from '../settings';

const SETTINGS: ReadonlyArray<{
  key: keyof UserPreferences;
  label: string;
  description: string;
}> = [
  {
    key: 'autoPlayScenes',
    label: 'Auto-play scenes',
    description: 'Start transport immediately after locating a scene.',
  },
  {
    key: 'showDiagnostics',
    label: 'Show diagnostics',
    description: 'Display audio load and xrun metrics on performance surfaces.',
  },
];

export const SettingsScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
  const { preferences, setPreference } = useUserPreferences();
  const safeAreaStyle = useMemo(() => ({ flex: 1 }), []);
  const contentStyle = useMemo(
    () => ({ padding: adaptive.breakpoint === 'phone' ? 12 : 32 }),
    [adaptive.breakpoint],
  );
  const diagnosticsCardStyle = useMemo(() => ({ marginBottom: 24 }), []);
  const diagnosticsPrimarySpacing = useMemo(() => ({ marginTop: 12 }), []);
  const diagnosticsSecondarySpacing = useMemo(() => ({ marginTop: 8 }), []);
  const settingsRowStyle = useMemo(
    () => ({
      marginBottom: 16,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    }),
    [],
  );
  const settingTextWrapperStyle = useMemo(() => ({ flex: 1, paddingRight: 12 }), []);
  const descriptionStyle = useMemo(() => ({ marginTop: 4 }), []);

  return (
    <SafeAreaView style={safeAreaStyle}>
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <NeonToolbar title="Settings" />
        <View style={contentStyle}>
          <NeonSurface style={diagnosticsCardStyle}>
            <NeonText variant="title" weight="medium">
              Runtime Diagnostics
            </NeonText>
            <NeonText variant="body" style={diagnosticsPrimarySpacing}>
              {`Screen reader enabled: ${adaptive.screenReaderEnabled ? 'Yes' : 'No'}\nPrefers reduced motion: ${
                adaptive.prefersReducedMotion ? 'Yes' : 'No'
              }`}
            </NeonText>
            <NeonText variant="body" style={diagnosticsSecondarySpacing}>
              Layout breakpoint detected: {adaptive.breakpoint.toUpperCase()}
            </NeonText>
          </NeonSurface>
          {SETTINGS.map((setting) => (
            <NeonSurface key={setting.key} style={settingsRowStyle}>
              <View style={settingTextWrapperStyle}>
                <NeonText variant="bodyLarge" weight="medium">
                  {setting.label}
                </NeonText>
                <NeonText variant="body" intent="secondary" style={descriptionStyle}>
                  {setting.description}
                </NeonText>
              </View>
              <Switch
                value={preferences[setting.key]}
                onValueChange={(value) => setPreference(setting.key, value)}
                accessibilityLabel={setting.label}
              />
            </NeonSurface>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
