import React from 'react';
import {
  NavigationContainer,
  Theme as NavigationTheme,
  DefaultTheme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Platform } from 'react-native';

import { ThemeProvider, useTheme } from '../design-system';
import {
  ArrangementScreen,
  MixerScreen,
  PerformanceScreen,
  SettingsScreen,
} from '../screens';
import { useAdaptiveLayout } from '../layout';

export type ArrangementStackParamList = {
  ArrangementHome: undefined;
};

export type AppTabParamList = {
  Arrangement: undefined;
  Mixer: undefined;
  Performance: undefined;
  Settings: undefined;
};

const ArrangementStack = createNativeStackNavigator<ArrangementStackParamList>();
const Tab = createBottomTabNavigator<AppTabParamList>();

const ArrangementStackNavigator = () => (
  <ArrangementStack.Navigator>
    <ArrangementStack.Screen
      name="ArrangementHome"
      component={ArrangementScreen}
      options={{ headerShown: false }}
    />
  </ArrangementStack.Navigator>
);

const TabBarThemeProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const navigationTheme: NavigationTheme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: theme.colors.background,
      primary: theme.colors.accentPrimary,
      card: theme.colors.surface,
      text: theme.colors.textPrimary,
      border: theme.colors.surfaceVariant,
    },
  };

  const tabBarStyle = {
    backgroundColor: theme.colors.surfaceVariant,
    borderTopColor: theme.colors.surfaceVariant,
    height: adaptive.breakpoint === 'phone' ? 64 : 72,
    paddingBottom: Platform.OS === 'ios' ? 16 : 10,
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle,
          tabBarActiveTintColor: theme.colors.accentPrimary,
          tabBarInactiveTintColor: theme.colors.textSecondary,
          lazy: true,
        }}
      >
        <Tab.Screen name="Arrangement" component={ArrangementStackNavigator} />
        <Tab.Screen name="Mixer" component={MixerScreen} />
        <Tab.Screen name="Performance" component={PerformanceScreen} />
        <Tab.Screen name="Settings" component={SettingsScreen} />
      </Tab.Navigator>
      {children}
    </NavigationContainer>
  );
};

export const AppNavigator: React.FC = () => (
  <ThemeProvider>
    <TabBarThemeProvider>
      {/** Additional portals (e.g., toasts) can be injected as children here. */}
    </TabBarThemeProvider>
  </ThemeProvider>
);
