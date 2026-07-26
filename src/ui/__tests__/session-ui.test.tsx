import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ThemeProvider } from '../design-system';
import { ArrangementScreen } from '../screens/ArrangementScreen';
import { MixerScreen } from '../screens/MixerScreen';
import { PerformanceScreen } from '../screens/PerformanceScreen';
import { SessionStoryProvider } from '../session';

describe('Session-integrated screens', () => {
  const renderWithProviders = async (element: React.ReactElement) => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(SessionStoryProvider, null, element),
        ),
      );
      await Promise.resolve();
    });
    if (!renderer) {
      throw new Error('Renderer failed to initialize');
    }
    return renderer;
  };

  it('renders arrangement data from the active session', async () => {
    const tree = await renderWithProviders(React.createElement(ArrangementScreen));
    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('Waveform Overview');
    expect(serialized).toContain('Drums');
    expect(serialized).toContain('MIDI Piano Roll');
  });

  it('renders mixer diagnostics and track meters', async () => {
    const tree = await renderWithProviders(React.createElement(MixerScreen));
    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('Audio Engine Diagnostics');
    expect(serialized).toContain('Mixer');
    expect(serialized).toMatch(/Render load/);
  });

  it('renders performance transport and scenes', async () => {
    const tree = await renderWithProviders(React.createElement(PerformanceScreen));
    const serialized = JSON.stringify(tree.toJSON());
    expect(serialized).toContain('Scene Launcher');
    expect(serialized).toContain('Pad Bed');
    expect(serialized).toMatch(/BPM/);
  });
});
