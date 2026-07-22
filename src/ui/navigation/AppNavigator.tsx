import React from 'react';
import {
  NavigationContainer,
  Theme as NavigationTheme,
  DefaultTheme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StudioIcon, ThemeProvider, useTheme } from '../design-system';
import {
  ArrangementScreen,
  MixerScreen,
  PerformanceScreen,
  SettingsScreen,
} from '../screens';
import { useAdaptiveLayout } from '../layout';
import { SessionAppProvider } from '../session';
import { APP_TABS, type AppTabParamList } from './tab-spec';

export type ArrangementStackParamList = {
  ArrangementHome: undefined;
};

const ArrangementStack = createNativeStackNavigator<ArrangementStackParamList>();
const Tab = createBottomTabNavigator<AppTabParamList>();

interface TabIconProps {
  color: string;
  focused: boolean;
  size: number;
}

const ArrangementTabIcon = ({ color, size }: TabIconProps): React.ReactElement => (
  <StudioIcon color={color} name={APP_TABS[0].icon} size={size} />
);

const MixerTabIcon = ({ color, size }: TabIconProps): React.ReactElement => (
  <StudioIcon color={color} name={APP_TABS[1].icon} size={size} />
);

const PerformanceTabIcon = ({ color, size }: TabIconProps): React.ReactElement => (
  <StudioIcon color={color} name={APP_TABS[2].icon} size={size} />
);

const SettingsTabIcon = ({ color, size }: TabIconProps): React.ReactElement => (
  <StudioIcon color={color} name={APP_TABS[3].icon} size={size} />
);

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
  const insets = useSafeAreaInsets();
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
    backgroundColor: theme.colors.surface,
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    height: (adaptive.workspaceMode === 'deck' ? 58 : 54) + insets.bottom,
    paddingBottom: Math.max(insets.bottom, 6),
    paddingHorizontal: adaptive.contentPadding,
    paddingTop: 6,
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle,
          tabBarActiveTintColor: theme.colors.accentPrimary,
          tabBarInactiveTintColor: theme.colors.textSecondary,
          tabBarActiveBackgroundColor: theme.colors.surfaceVariant,
          tabBarItemStyle: {
            borderRadius: theme.radii.md,
            minWidth: 0,
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
          },
          tabBarIconStyle: { marginBottom: -2 },
          tabBarHideOnKeyboard: true,
          lazy: true,
        }}
      >
        <Tab.Screen
          name="Arrangement"
          component={ArrangementStackNavigator}
          options={{
            tabBarAccessibilityLabel: APP_TABS[0].accessibilityLabel,
            tabBarIcon: ArrangementTabIcon,
          }}
        />
        <Tab.Screen
          name="Mixer"
          component={MixerScreen}
          options={{
            tabBarAccessibilityLabel: APP_TABS[1].accessibilityLabel,
            tabBarIcon: MixerTabIcon,
          }}
        />
        <Tab.Screen
          name="Performance"
          component={PerformanceScreen}
          options={{
            tabBarAccessibilityLabel: APP_TABS[2].accessibilityLabel,
            tabBarIcon: PerformanceTabIcon,
          }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            tabBarAccessibilityLabel: APP_TABS[3].accessibilityLabel,
            tabBarIcon: SettingsTabIcon,
          }}
        />
      </Tab.Navigator>
      {children}
    </NavigationContainer>
  );
};

export const AppNavigator: React.FC = () => (
  <ThemeProvider>
    <SessionAppProvider>
      <TabBarThemeProvider>
        {/** Additional portals (e.g., toasts) can be injected as children here. */}
      </TabBarThemeProvider>
    </SessionAppProvider>
  </ThemeProvider>
);
