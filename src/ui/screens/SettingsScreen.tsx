import React, { useMemo } from 'react';
import { SafeAreaView, ScrollView, Switch, View } from 'react-native';

import { NeonSurface, NeonText, NeonToolbar } from '../design-system';
import { useAdaptiveLayout } from '../layout';

const SETTINGS = [
  {
    key: 'adaptive',
    label: 'Adaptive Layout',
    description: 'Automatically adapt to phone, tablet, or desktop form factors.',
  },
  {
    key: 'accessibility',
    label: 'Accessibility Checks',
    description: 'Run screen reader and motion audits before performances.',
  },
  {
    key: 'cloud',
    label: 'Cloud Sync',
    description: 'Persist arrangement data with encrypted cloud storage.',
  },
];

export const SettingsScreen: React.FC = () => {
  const adaptive = useAdaptiveLayout();
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
                value={setting.key === 'adaptive'}
                onValueChange={() => undefined}
                accessibilityLabel={setting.label}
              />
            </NeonSurface>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};
