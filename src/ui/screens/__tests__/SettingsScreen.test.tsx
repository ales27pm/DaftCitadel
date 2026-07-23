import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

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

describe('SettingsScreen', () => {
  const setPreference = jest.fn();

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

  beforeEach(() => {
    jest.clearAllMocks();
    useUserPreferences.mockReturnValue({
      preferences: { autoPlayScenes: false, showDiagnostics: true },
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
    const collapsed = JSON.stringify(renderer.toJSON());

    expect(collapsed).toContain('Performance preferences');
    expect(collapsed).toContain('Troubleshooting');
    expect(collapsed).not.toContain('Session ID:');
    expect(collapsed).not.toContain('Layout breakpoint');

    const showDetails = renderer.root.findByProps({ label: 'Show details' });
    await act(async () => {
      showDetails.props.onPress();
      await Promise.resolve();
    });

    const expanded = JSON.stringify(renderer.toJSON());
    expect(expanded).toContain('Fixture Session');
    expect(expanded).toContain('Session ID:');
    expect(expanded).toContain('% render load');
    expect(expanded).toContain('Screen reader ');
    expect(expanded).not.toContain('Layout breakpoint');
    renderer.unmount();
  });

  it('updates performance preferences through their accessible switches', async () => {
    const renderer = await renderScreen();
    const autoPlaySwitch = renderer.root.findByProps({
      accessibilityLabel: 'Auto-play scenes',
      value: false,
    });

    await act(async () => {
      autoPlaySwitch.props.onValueChange(true);
      await Promise.resolve();
    });

    expect(setPreference).toHaveBeenCalledWith('autoPlayScenes', true);
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
    expect(JSON.stringify(renderer.toJSON())).toContain('Render load');
    expect(JSON.stringify(renderer.toJSON())).toContain('Unavailable');

    const showDetails = renderer.root.findByProps({ label: 'Show details' });
    await act(async () => {
      showDetails.props.onPress();
      await Promise.resolve();
    });

    const expanded = JSON.stringify(renderer.toJSON());
    expect(expanded).toContain('Render load unavailable');
    expect(expanded).toContain('XRun count unavailable');
    expect(expanded).not.toContain('0 xruns detected');
    renderer.unmount();
  });
});
