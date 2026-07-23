import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { StudioIcon, StudioText, ThemeProvider, useTheme } from '../design-system';
import {
  ArrangementScreen,
  MixerScreen,
  PerformanceScreen,
  SettingsScreen,
} from '../screens';
import { SessionAppProvider } from '../session';
import { APP_TABS, type AppTabName } from './tab-spec';

export type ArrangementStackParamList = {
  ArrangementHome: undefined;
};

const TABS: ReadonlyArray<{
  name: AppTabName;
  component: React.ComponentType;
}> = [
  { name: 'Arrangement', component: ArrangementScreen },
  { name: 'Mixer', component: MixerScreen },
  { name: 'Performance', component: PerformanceScreen },
  { name: 'Settings', component: SettingsScreen },
];

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  screen: {
    flex: 1,
    minHeight: 0,
  },
  tabBar: {
    minHeight: 84,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    maxWidth: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  tabLabel: {
    fontSize: 9,
    letterSpacing: 1,
  },
});

const WebTabNavigator: React.FC = () => {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<AppTabName>('Arrangement');
  const activeScreen = TABS.find((tab) => tab.name === activeTab) ?? TABS[0];
  const ActiveScreen = activeScreen.component;
  const dynamicStyles = useMemo(
    () => ({
      tabBar: {
        backgroundColor: theme.colors.surface,
        borderTopColor: theme.colors.border,
      },
      root: { backgroundColor: theme.colors.background },
      selectedLabel: { color: theme.colors.accentPrimary },
      inactiveLabel: { color: theme.colors.textTertiary },
    }),
    [theme],
  );

  return (
    <View style={[styles.root, dynamicStyles.root]}>
      <View style={styles.screen}>
        <ActiveScreen />
      </View>
      <View style={[styles.tabBar, dynamicStyles.tabBar]}>
        {TABS.map((tab) => {
          const selected = tab.name === activeTab;
          const spec = APP_TABS.find((entry) => entry.name === tab.name) ?? APP_TABS[0];
          return (
            <Pressable
              key={tab.name}
              accessibilityLabel={spec.accessibilityLabel}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.name)}
              style={styles.tab}
            >
              <StudioIcon
                color={selected ? theme.colors.accentPrimary : theme.colors.textTertiary}
                name={spec.icon}
                size={18}
              />
              <StudioText
                variant="caption"
                weight="bold"
                style={[
                  styles.tabLabel,
                  selected ? dynamicStyles.selectedLabel : dynamicStyles.inactiveLabel,
                ]}
              >
                {spec.label}
              </StudioText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

export const AppNavigator: React.FC = () => (
  <ThemeProvider>
    <SessionAppProvider>
      <WebTabNavigator />
    </SessionAppProvider>
  </ThemeProvider>
);
