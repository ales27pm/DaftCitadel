import React from 'react';
import {
  NavigationContainer,
  Theme as NavigationTheme,
  DefaultTheme,
  useIsFocused,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StudioIcon, useTheme } from '../design-system';
import {
  ArrangementScreen,
  MixerScreen,
  PerformanceScreen,
  SettingsScreen,
} from '../screens';
import { useAdaptiveLayout } from '../layout';
import { SessionAppProvider } from '../session';
import { StudioThemeProvider } from '../settings';
import {
  APP_TABS,
  APP_TAB_SEQUENCE as APP_TAB_SEQUENCE_SPEC,
  type AppTabParamList,
  type AppTabName,
} from './tab-spec';
import { resolveNativeTabBarMetrics } from './native-tab-layout';

export type { AppTabParamList } from './tab-spec';

export type ArrangementStackParamList = {
  ArrangementHome: undefined;
};

export const APP_TAB_SEQUENCE = APP_TAB_SEQUENCE_SPEC;

const ArrangementStack = createNativeStackNavigator<ArrangementStackParamList>();
const Tab = createBottomTabNavigator<AppTabParamList>();

const FocusedPerformanceScreen: React.FC = () => {
  const isFocused = useIsFocused();
  return <PerformanceScreen isActive={isFocused} />;
};

const FocusedSettingsScreen: React.FC = () => {
  const isFocused = useIsFocused();
  return <SettingsScreen isActive={isFocused} />;
};

const ArrangementStackNavigator = () => (
  <ArrangementStack.Navigator>
    <ArrangementStack.Screen
      name="ArrangementHome"
      component={ArrangementScreen}
      options={{ headerShown: false }}
    />
  </ArrangementStack.Navigator>
);

const TAB_SCREEN_BY_NAME: Record<AppTabName, React.ComponentType> = {
  Arrangement: ArrangementStackNavigator,
  Mixer: MixerScreen,
  Performance: FocusedPerformanceScreen,
  Settings: FocusedSettingsScreen,
};

const TAB_OPTIONS_BY_NAME = Object.fromEntries(
  APP_TABS.map((spec) => [
    spec.name,
    {
      tabBarAccessibilityLabel: spec.accessibilityLabel,
      tabBarLabel: spec.label,
      tabBarIcon: ({ color, size }: { color: string; size: number }) => (
        <StudioIcon color={color} name={spec.icon} size={size} />
      ),
    },
  ]),
) as Record<
  AppTabName,
  {
    tabBarAccessibilityLabel: string;
    tabBarLabel: string;
    tabBarIcon: (props: { color: string; size: number }) => React.ReactNode;
  }
>;

const TabBarThemeProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const theme = useTheme();
  const adaptive = useAdaptiveLayout();
  const safeAreaInsets = useSafeAreaInsets();
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
    borderTopColor: theme.colors.border,
    ...resolveNativeTabBarMetrics(adaptive.breakpoint, safeAreaInsets.bottom),
  };

  return (
    <NavigationContainer theme={navigationTheme}>
      <Tab.Navigator
        initialRouteName="Performance"
        screenOptions={{
          headerShown: false,
          tabBarStyle,
          tabBarActiveTintColor: theme.colors.accentPrimary,
          tabBarInactiveTintColor: theme.colors.textSecondary,
          tabBarLabelStyle: {
            fontSize: 12,
            fontWeight: '500',
          },
          lazy: true,
        }}
      >
        {APP_TAB_SEQUENCE.map((name) => {
          return (
            <Tab.Screen
              key={name}
              name={name}
              component={TAB_SCREEN_BY_NAME[name]}
              options={TAB_OPTIONS_BY_NAME[name]}
            />
          );
        })}
      </Tab.Navigator>
      {children}
    </NavigationContainer>
  );
};

export const AppNavigator: React.FC = () => (
  <StudioThemeProvider>
    <SessionAppProvider>
      <TabBarThemeProvider>
        {/** Additional portals (e.g., toasts) can be injected as children here. */}
      </TabBarThemeProvider>
    </SessionAppProvider>
  </StudioThemeProvider>
);
