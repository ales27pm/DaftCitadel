import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, type PressableProps, StyleSheet, View } from 'react-native';

import { StudioIcon, StudioText, useTheme } from '../design-system';
import {
  ArrangementScreen,
  MixerScreen,
  PerformanceScreen,
  SettingsScreen,
} from '../screens';
import { SessionAppProvider } from '../session';
import { StudioThemeProvider } from '../settings';
import {
  APP_TAB_SEQUENCE as APP_TAB_SEQUENCE_SPEC,
  APP_TABS,
  type AppTabName,
} from './tab-spec';

type BrowserHistory = {
  state?: unknown;
  pushState: (state: unknown, title: string, url?: string | URL | null) => void;
  replaceState: (state: unknown, title: string, url?: string | URL | null) => void;
};

type BrowserLocation = {
  hash: string;
};

type BrowserWindow = {
  history?: BrowserHistory;
  location?: BrowserLocation;
  document?: {
    getElementById?: (id: string) => { focus?: () => void } | null;
  };
  localStorage?: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
  addEventListener?: (
    type: 'popstate',
    listener: (event: { state?: unknown }) => void,
  ) => void;
  removeEventListener?: (
    type: 'popstate',
    listener: (event: { state?: unknown }) => void,
  ) => void;
};

type BrowserPopState = {
  state?: unknown;
};

const WEB_TAB_STORAGE_KEY = 'daftcitadel:web.activeTab';
const WEB_HASH_PREFIX = '#/';

export const DEFAULT_WEB_TAB: AppTabName = 'Performance';

export const isKnownAppTab = (value: unknown): value is AppTabName =>
  typeof value === 'string' &&
  (APP_TAB_SEQUENCE_SPEC as ReadonlyArray<string>).includes(value);

const resolveWindow = (): BrowserWindow | null => {
  const windowValue = (globalThis as { window?: unknown }).window;
  if (typeof windowValue === 'undefined' || windowValue === null) {
    return null;
  }
  return windowValue as BrowserWindow;
};

export const extractTabFromHash = (hash: string): AppTabName | null => {
  const trimmed = hash.trim();
  if (!trimmed.startsWith(WEB_HASH_PREFIX)) {
    return null;
  }
  const candidate = trimmed.slice(WEB_HASH_PREFIX.length);
  return isKnownAppTab(candidate) ? candidate : null;
};

export const extractTabFromState = (state: unknown): AppTabName | null => {
  if (!state || typeof state !== 'object') {
    return null;
  }
  const candidate = (state as { tab?: unknown }).tab;
  return isKnownAppTab(candidate) ? candidate : null;
};

export const readWebTabFromStorage = (
  storage?: BrowserWindow['localStorage'],
): AppTabName | null => {
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(WEB_TAB_STORAGE_KEY);
  return isKnownAppTab(raw) ? raw : null;
};

export const resolveInitialWebTab = (browser?: BrowserWindow | null): AppTabName => {
  const tabFromState = extractTabFromState(browser?.history?.state as unknown);
  if (tabFromState) {
    return tabFromState;
  }

  const tabFromHash = extractTabFromHash(browser?.location?.hash ?? '');
  if (tabFromHash) {
    return tabFromHash;
  }

  const tabFromStorage = readWebTabFromStorage(browser?.localStorage);
  if (tabFromStorage) {
    return tabFromStorage;
  }

  return DEFAULT_WEB_TAB;
};

export const persistWebTab = (
  browser: BrowserWindow | null | undefined,
  tab: AppTabName,
  method: 'push' | 'replace' = 'push',
): void => {
  if (!browser) {
    return;
  }
  browser.localStorage?.setItem(WEB_TAB_STORAGE_KEY, tab);
  const history = browser.history;
  if (!history) {
    return;
  }
  const update = method === 'replace' ? history.replaceState : history.pushState;
  try {
    update.call(history, { tab }, '', `${WEB_HASH_PREFIX}${tab}`);
  } catch {
    // Ignore unsupported history APIs in constrained web containers.
  }
};

export const extractTabFromBrowserState = (
  browser: BrowserWindow | null | undefined,
  state: unknown,
): AppTabName | null =>
  extractTabFromState(state) ?? extractTabFromHash(browser?.location?.hash ?? '') ?? null;

export type ArrangementStackParamList = {
  ArrangementHome: undefined;
};

export const APP_TAB_SEQUENCE = APP_TAB_SEQUENCE_SPEC;

const TAB_SCREEN_BY_NAME: Record<
  AppTabName,
  React.ComponentType<{ isActive?: boolean }>
> = {
  Arrangement: ArrangementScreen,
  Mixer: MixerScreen,
  Performance: PerformanceScreen,
  Settings: SettingsScreen,
};

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
    minHeight: 76,
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
    fontSize: 12,
    lineHeight: 16,
  },
  tabText: {
    marginTop: 2,
  },
});

type WebPressableProps = PressableProps & {
  onKeyDown?: (event: React.KeyboardEvent) => void;
};

const WebPressable = Pressable as React.ComponentType<WebPressableProps>;

const WebTabNavigator: React.FC = () => {
  const theme = useTheme();
  const browser = useMemo(() => resolveWindow(), []);
  const [activeTab, setActiveTab] = useState<AppTabName>(() =>
    resolveInitialWebTab(browser),
  );
  const activeTabRef = useRef<AppTabName>(activeTab);
  const dynamicStyles = useMemo(
    () => ({
      tabBar: {
        backgroundColor: theme.colors.surface,
        borderTopColor: theme.colors.surfaceVariant,
      },
      root: { backgroundColor: theme.colors.background },
      selectedLabel: { color: theme.colors.accentPrimary },
      inactiveLabel: { color: theme.colors.textSecondary },
    }),
    [theme],
  );

  const handleTabPress = (tabName: AppTabName) => {
    if (tabName === activeTab) {
      return;
    }
    setActiveTab(tabName);
    persistWebTab(browser, tabName, 'push');
  };

  const handleTabKeyDown = (tabName: AppTabName, event: React.KeyboardEvent): void => {
    const currentIndex = APP_TAB_SEQUENCE.indexOf(tabName);
    const lastIndex = APP_TAB_SEQUENCE.length - 1;
    let nextIndex: number | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = lastIndex;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = APP_TAB_SEQUENCE[nextIndex];
    handleTabPress(nextTab);
    browser?.document?.getElementById?.(`app-tab-${nextTab}`)?.focus?.();
  };

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    persistWebTab(browser, activeTab, 'replace');
    const popStateHandler = (event: BrowserPopState) => {
      const nextTab = extractTabFromBrowserState(browser, event.state);
      if (nextTab && nextTab !== activeTabRef.current) {
        setActiveTab(nextTab);
      }
    };
    browser?.addEventListener?.('popstate', popStateHandler);
    return () => {
      browser?.removeEventListener?.('popstate', popStateHandler);
    };
  }, [browser]);

  return (
    <View style={[styles.root, dynamicStyles.root]}>
      <View style={styles.screen}>
        {APP_TAB_SEQUENCE.map((tabName) => {
          const Screen = TAB_SCREEN_BY_NAME[tabName];
          const selected = tabName === activeTab;
          return (
            <View
              key={tabName}
              aria-hidden={!selected}
              importantForAccessibility={selected ? 'auto' : 'no-hide-descendants'}
              style={[styles.screen, { display: selected ? 'flex' : 'none' }]}
            >
              <Screen isActive={selected} />
            </View>
          );
        })}
      </View>
      <View
        accessibilityLabel="Primary navigation"
        accessibilityRole="tablist"
        style={[styles.tabBar, dynamicStyles.tabBar]}
      >
        {APP_TAB_SEQUENCE.map((tabName) => {
          const selected = tabName === activeTab;
          const spec = APP_TABS.find((entry) => entry.name === tabName) ?? APP_TABS[0];
          return (
            <WebPressable
              key={tabName}
              accessibilityLabel={spec.accessibilityLabel}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              nativeID={`app-tab-${tabName}`}
              onKeyDown={(event) => handleTabKeyDown(tabName, event)}
              onPress={() => handleTabPress(tabName)}
              style={styles.tab}
              tabIndex={selected ? 0 : -1}
            >
              <StudioIcon
                color={selected ? theme.colors.accentPrimary : theme.colors.textSecondary}
                name={spec.icon}
                size={20}
              />
              <StudioText
                selectable={false}
                variant="caption"
                weight={selected ? 'bold' : 'medium'}
                style={[
                  styles.tabLabel,
                  styles.tabText,
                  selected ? dynamicStyles.selectedLabel : dynamicStyles.inactiveLabel,
                ]}
              >
                {spec.label}
              </StudioText>
            </WebPressable>
          );
        })}
      </View>
    </View>
  );
};

export const AppNavigator: React.FC = () => (
  <StudioThemeProvider>
    <SessionAppProvider>
      <WebTabNavigator />
    </SessionAppProvider>
  </StudioThemeProvider>
);
