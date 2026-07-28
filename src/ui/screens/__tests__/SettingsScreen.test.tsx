import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { AccessibilityInfo, Platform, Text } from 'react-native';

import type { SessionManager } from '../../../session';
import { ThemeProvider } from '../../design-system';
import { SettingsScreen } from '../SettingsScreen';

jest.mock('../../session', () => ({
  useSessionViewModel: jest.fn(),
}));

jest.mock('../../settings', () => ({
  useUserPreferences: jest.fn(),
}));

const { useSessionViewModel } = jest.requireMock('../../session');
const { useUserPreferences } = jest.requireMock('../../settings');
const testAccessibilityInfo = AccessibilityInfo as typeof AccessibilityInfo & {
  __setReduceMotionEnabled: (value: boolean) => void;
};

describe('SettingsScreen', () => {
  const setPreference = jest.fn();
  const resetAppearance = jest.fn();
  const defaultPreferences = {
    accentPalette: 'mint',
    autoPlayScenes: false,
    glowIntensity: 'balanced',
    interfaceDensity: 'comfortable',
    showDiagnostics: true,
    studioSurface: 'carbon',
  };

  const renderScreen = async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        <ThemeProvider>
          <SettingsScreen />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    if (!renderer) {
      throw new Error('Renderer not initialized');
    }
    return renderer;
  };

  const flattenText = (value: unknown): string => {
    if (Array.isArray(value)) {
      return value.map(flattenText).join('');
    }
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  };

  const renderedText = (renderer: TestRenderer.ReactTestRenderer): string =>
    renderer.root
      .findAllByType(Text)
      .map((node: ReactTestInstance) => flattenText(node.props.children))
      .join('\n');

  beforeEach(() => {
    jest.clearAllMocks();
    testAccessibilityInfo.__setReduceMotionEnabled(false);
    useUserPreferences.mockReturnValue({
      preferences: defaultPreferences,
      resetAppearance,
      setPreference,
    });
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      tracks: [{ id: 'track-1' }],
      diagnostics: { status: 'ready', xruns: 0, renderLoad: 0.25 },
      error: undefined,
      manager: {} as SessionManager,
      pluginAlerts: [],
      transport: null,
      transportRuntime: null,
      refresh: jest.fn().mockResolvedValue(undefined),
      retryPlugin: jest.fn().mockResolvedValue(true),
    });
  });

  it('keeps real troubleshooting data collapsed until requested', async () => {
    const renderer = await renderScreen();
    const collapsed = renderedText(renderer);

    expect(collapsed).toContain('Performance preferences');
    expect(collapsed).toContain('Studio appearance');
    expect(collapsed).toContain('Troubleshooting');
    expect(collapsed).not.toContain('Session ID ·');
    expect(collapsed).not.toContain('Layout breakpoint');

    const showDetails = renderer.root.findByProps({
      accessibilityLabel: 'Show technical details',
      accessibilityRole: 'button',
    });
    expect(showDetails.props.accessibilityState).toEqual({ expanded: false });
    await act(async () => {
      showDetails.props.onPress();
      await Promise.resolve();
    });

    const expanded = renderedText(renderer);
    expect(expanded).toContain('Fixture Session');
    expect(expanded).toContain('Session ID ·');
    expect(expanded).toContain('% render load');
    expect(expanded).toContain('Screen reader ·');
    expect(expanded).not.toContain('Layout breakpoint');

    const hideDetails = renderer.root.findByProps({
      accessibilityLabel: 'Hide technical details',
      accessibilityRole: 'button',
    });
    expect(hideDetails.props.accessibilityState).toEqual({ expanded: true });
    await act(async () => {
      hideDetails.props.onPress();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).not.toContain('Session ID ·');
    renderer.unmount();
  });

  it('updates performance preferences through their accessible switches', async () => {
    const renderer = await renderScreen();
    const autoPlaySwitch = renderer.root.findByProps({
      accessibilityLabel: 'Auto-play scenes',
      accessibilityRole: 'switch',
    });
    expect(autoPlaySwitch.props.accessibilityState).toEqual({ checked: false });

    await act(async () => {
      autoPlaySwitch.props.onPress();
      await Promise.resolve();
    });

    expect(setPreference).toHaveBeenCalledWith('autoPlayScenes', true);

    useUserPreferences.mockReturnValue({
      preferences: { ...defaultPreferences, autoPlayScenes: true },
      resetAppearance,
      setPreference,
    });
    await act(async () => {
      renderer.update(
        <ThemeProvider>
          <SettingsScreen />
        </ThemeProvider>,
      );
      await Promise.resolve();
    });
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Auto-play scenes',
        accessibilityRole: 'switch',
      }).props.accessibilityState,
    ).toEqual({ checked: true });
    renderer.unmount();
  });

  it('updates every appearance dimension through accessible controls', async () => {
    const renderer = await renderScreen();

    const magenta = renderer.root.findByProps({
      accessibilityLabel: 'Magenta accent',
      accessibilityRole: 'button',
    });
    const spectral = renderer.root.findByProps({
      accessibilityLabel: 'Spectral surface',
      accessibilityRole: 'button',
    });
    const compact = renderer.root.findByProps({
      accessibilityLabel: 'Compact',
      accessibilityRole: 'button',
    });
    const vivid = renderer.root.findByProps({
      accessibilityLabel: 'Vivid',
      accessibilityRole: 'button',
    });
    expect(compact.props.accessibilityState).toEqual({ selected: false });

    await act(async () => {
      magenta.props.onPress();
      spectral.props.onPress();
      compact.props.onPress();
      vivid.props.onPress();
      await Promise.resolve();
    });

    expect(setPreference).toHaveBeenCalledWith('accentPalette', 'magenta');
    expect(setPreference).toHaveBeenCalledWith('studioSurface', 'spectral');
    expect(setPreference).toHaveBeenCalledWith('interfaceDensity', 'compact');
    expect(setPreference).toHaveBeenCalledWith('glowIntensity', 'vivid');

    const reset = renderer.root.findByProps({
      accessibilityLabel: 'Reset',
      accessibilityRole: 'button',
    });
    expect(reset.props.accessibilityState.disabled).toBe(true);
    renderer.unmount();
  });

  it('uses native buttons for actionable selectors and web radio semantics', async () => {
    const originalOS = Platform.OS;
    try {
      Platform.OS = 'web';
      const renderer = await renderScreen();

      expect(
        renderer.root.findByProps({
          accessibilityLabel: 'Interface density',
          accessibilityRole: 'radiogroup',
        }),
      ).toBeDefined();
      expect(
        renderer.root.findByProps({
          accessibilityLabel: 'Compact',
          accessibilityRole: 'radio',
        }).props.accessibilityState,
      ).toEqual({ checked: false });

      renderer.unmount();
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('disables every appearance image crossfade when reduced motion is enabled', async () => {
    testAccessibilityInfo.__setReduceMotionEnabled(true);
    const renderer = await renderScreen();
    const appearanceImages = renderer.root
      .findAllByType('ExpoImage' as never)
      .filter((image) => image.props.transition !== undefined);

    expect(appearanceImages).toHaveLength(5);
    expect(appearanceImages.every((image) => image.props.transition === 0)).toBe(true);
    renderer.unmount();
  });

  it('labels diagnostics values unavailable when metrics collection fails', async () => {
    useSessionViewModel.mockReturnValue({
      status: 'ready',
      sessionId: 'session-1',
      sessionName: 'Fixture Session',
      tracks: [{ id: 'track-1' }],
      diagnostics: {
        status: 'error',
        xruns: 0,
        renderLoad: 0,
        error: new Error('Metrics polling failed'),
      },
      error: undefined,
      manager: {} as SessionManager,
      pluginAlerts: [],
      transport: null,
      transportRuntime: null,
      refresh: jest.fn().mockResolvedValue(undefined),
      retryPlugin: jest.fn().mockResolvedValue(true),
    });

    const renderer = await renderScreen();
    expect(renderedText(renderer)).toContain('Metrics polling failed');

    const showDetails = renderer.root.findByProps({
      accessibilityLabel: 'Show technical details',
      accessibilityRole: 'button',
    });
    await act(async () => {
      showDetails.props.onPress();
      await Promise.resolve();
    });

    const expanded = renderedText(renderer);
    expect(expanded).toContain('Render load unavailable');
    expect(expanded).toContain('XRun count unavailable');
    expect(expanded).not.toContain('0 XRuns detected');
    renderer.unmount();
  });
});
