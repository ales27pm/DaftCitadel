import * as WebNavigator from '../AppNavigator.web';
import { APP_TABS, APP_TAB_SEQUENCE as SHARED_TAB_SEQUENCE } from '../tab-spec';

const createMockStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => {
      const value = store.get(key);
      return value === undefined ? null : value;
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
};

const createMockBrowser = (
  options: {
    tabFromState?: string;
    hash?: string;
    storedTab?: string;
  } = {},
) => {
  const storage = createMockStorage();
  const pushState = jest.fn();
  const replaceState = jest.fn();
  const listeners: Array<(event: { state?: unknown }) => void> = [];
  if (options.storedTab) {
    storage.setItem('daftcitadel:web.activeTab', options.storedTab);
  }

  return {
    storage,
    localStorage: storage,
    history: {
      state: options.tabFromState ? { tab: options.tabFromState } : {},
      pushState,
      replaceState,
    },
    location: { hash: options.hash ?? '#/Arrangement' },
    listeners,
    addEventListener: (_: 'popstate', listener: (event: { state?: unknown }) => void) => {
      listeners.push(listener);
    },
    removeEventListener: (
      _: 'popstate',
      listener: (event: { state?: unknown }) => void,
    ) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
  };
};

describe('AppNavigator parity', () => {
  it('uses the same tab ordering on native and web entry points', () => {
    expect(WebNavigator.APP_TAB_SEQUENCE).toEqual(SHARED_TAB_SEQUENCE);
  });

  it('includes the settings tab in all route lists', () => {
    expect(WebNavigator.APP_TAB_SEQUENCE).toContain('Settings');
  });

  it('defines a distinct icon and accessibility label for every native tab', () => {
    expect(new Set(APP_TABS.map((tab) => tab.icon)).size).toBe(APP_TABS.length);
    expect(APP_TABS.every((tab) => tab.accessibilityLabel.length > 0)).toBe(true);
  });
});

describe('Web tab helpers', () => {
  it('prefers browser history state over hash and storage when resolving initial tab', () => {
    const mockBrowser = {
      history: { state: { tab: 'Mixer' }, pushState: jest.fn(), replaceState: jest.fn() },
      location: { hash: '#/Settings' },
      localStorage: createMockStorage(),
    };
    mockBrowser.localStorage.setItem('daftcitadel:web.activeTab', 'Settings');
    const resolved = WebNavigator.resolveInitialWebTab(mockBrowser);
    expect(resolved).toBe('Mixer');
  });

  it('falls back from history and hash to localStorage and defaults for unknown values', () => {
    const mockStorage = createMockStorage();
    mockStorage.setItem('daftcitadel:web.activeTab', 'Arrangement');
    const mockBrowser = {
      history: {
        state: { tab: 'Unknown' },
        pushState: jest.fn(),
        replaceState: jest.fn(),
      },
      location: { hash: '#/also-unknown' },
      localStorage: mockStorage,
    };
    const resolved = WebNavigator.resolveInitialWebTab(mockBrowser);
    expect(resolved).toBe('Arrangement');
  });

  it('extracts known tabs from web hashes', () => {
    expect(WebNavigator.extractTabFromHash('#/Performance')).toBe('Performance');
    expect(WebNavigator.extractTabFromHash('#/not-real')).toBeNull();
    expect(WebNavigator.extractTabFromHash('/Performance')).toBeNull();
  });

  it('persists tab selection via selected history method and localStorage', () => {
    const mockBrowser = createMockBrowser();
    const { storage, history } = mockBrowser;
    WebNavigator.persistWebTab(mockBrowser, 'Settings', 'push');
    expect(storage.getItem('daftcitadel:web.activeTab')).toBe('Settings');
    expect(history.pushState).toHaveBeenCalledWith({ tab: 'Settings' }, '', '#/Settings');
    expect(history.replaceState).not.toHaveBeenCalled();
    WebNavigator.persistWebTab(mockBrowser, 'Mixer', 'replace');
    expect(storage.getItem('daftcitadel:web.activeTab')).toBe('Mixer');
    expect(history.replaceState).toHaveBeenCalledWith({ tab: 'Mixer' }, '', '#/Mixer');
  });

  it('derives back-stack state from popstate events with hash fallback', () => {
    const mockBrowser = createMockBrowser({
      tabFromState: 'Settings',
      hash: '#/Mixer',
    });
    expect(
      WebNavigator.extractTabFromBrowserState(mockBrowser, { tab: 'Performance' }),
    ).toBe('Performance');
    expect(WebNavigator.extractTabFromBrowserState(mockBrowser, { tab: 'Unknown' })).toBe(
      'Mixer',
    );
    expect(WebNavigator.extractTabFromBrowserState(mockBrowser, {})).toBe('Mixer');
  });

  it('restores the Settings tab consistently for route and storage paths', () => {
    const fromHash = createMockBrowser({ hash: '#/Settings' });
    expect(WebNavigator.resolveInitialWebTab(fromHash)).toBe('Settings');
    const fromStorage = createMockBrowser({ storedTab: 'Settings', hash: '' });
    expect(WebNavigator.resolveInitialWebTab(fromStorage)).toBe('Settings');
    const fromHistory = createMockBrowser({
      tabFromState: 'Settings',
      storedTab: 'Arrangement',
      hash: '#/Performance',
    });
    expect(WebNavigator.resolveInitialWebTab(fromHistory)).toBe('Settings');
  });
});
