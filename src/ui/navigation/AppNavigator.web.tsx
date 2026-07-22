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
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 4,
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
    borderRadius: 10,
    gap: 2,
    paddingHorizontal: 4,
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
      selectedTab: { backgroundColor: theme.colors.surfaceVariant },
    }),
    [theme],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
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
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.name)}
              style={[styles.tab, selected && dynamicStyles.selectedTab]}
            >
              <StudioIcon
                color={selected ? theme.colors.accentPrimary : theme.colors.textSecondary}
                name={spec.icon}
                size={18}
              />
              <StudioText
                variant="caption"
                weight="medium"
                style={{
                  color: selected ? theme.colors.textPrimary : theme.colors.textSecondary,
                }}
              >
                {tab.name}
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
