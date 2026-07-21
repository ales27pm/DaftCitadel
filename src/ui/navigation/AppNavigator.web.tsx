import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ThemeProvider, useTheme } from '../design-system';
import {
  ArrangementScreen,
  MixerScreen,
  PerformanceScreen,
  SettingsScreen,
} from '../screens';
import { SessionAppProvider } from '../session';

export type ArrangementStackParamList = {
  ArrangementHome: undefined;
};

export type AppTabParamList = {
  Arrangement: undefined;
  Mixer: undefined;
  Performance: undefined;
  Settings: undefined;
};

type AppTabName = keyof AppTabParamList;

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
    backgroundColor: '#03050A',
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
    borderRadius: 12,
    paddingHorizontal: 4,
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '700',
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
        backgroundColor: theme.colors.surfaceVariant,
        borderTopColor: theme.colors.surface,
      },
      tab: { backgroundColor: theme.colors.surface },
      selectedTab: { backgroundColor: theme.colors.accentPrimary },
      tabLabel: { color: theme.colors.textSecondary },
      selectedTabLabel: { color: theme.colors.background },
    }),
    [theme],
  );

  return (
    <View style={styles.root}>
      <View style={styles.screen}>
        <ActiveScreen />
      </View>
      <View style={[styles.tabBar, dynamicStyles.tabBar]}>
        {TABS.map((tab) => {
          const selected = tab.name === activeTab;
          return (
            <Pressable
              key={tab.name}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setActiveTab(tab.name)}
              style={[
                styles.tab,
                dynamicStyles.tab,
                selected && dynamicStyles.selectedTab,
              ]}
            >
              <Text
                style={[
                  styles.tabLabel,
                  dynamicStyles.tabLabel,
                  selected && dynamicStyles.selectedTabLabel,
                ]}
              >
                {tab.name}
              </Text>
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
