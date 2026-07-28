import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import '../../test-support/setupReactAct';
import { ThemeProvider } from '../design-system';
import { ArrangementScreen } from '../screens/ArrangementScreen';
import { MixerScreen } from '../screens/MixerScreen';
import { PerformanceScreen } from '../screens/PerformanceScreen';
import { SessionStoryProvider } from '../session';

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn() }),
}));

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

  const renderedText = (renderer: TestRenderer.ReactTestRenderer): string =>
    renderer.root
      .findAllByType(Text)
      .flatMap((node) =>
        node.children.filter((child): child is string => typeof child === 'string'),
      )
      .join(' ');

  const unmount = async (renderer: TestRenderer.ReactTestRenderer) => {
    await act(async () => {
      renderer.unmount();
      await Promise.resolve();
    });
  };

  it('renders arrangement data from the active session', async () => {
    const tree = await renderWithProviders(React.createElement(ArrangementScreen));
    const text = renderedText(tree);

    expect(text).toContain('Waveform overview');
    expect(text).toContain('Drums');
    expect(text).toContain('MIDI piano roll');

    await unmount(tree);
  });

  it('renders mixer tracks while unavailable diagnostics stay hidden', async () => {
    const tree = await renderWithProviders(React.createElement(MixerScreen));
    const text = renderedText(tree);

    expect(text).toContain('Mixer');
    expect(text).toContain('Drums');
    expect(text).toContain('Bass');
    expect(text).not.toContain('Audio Engine Diagnostics');

    await unmount(tree);
  });

  it('renders performance transport and the scene workspace', async () => {
    const tree = await renderWithProviders(React.createElement(PerformanceScreen));
    const text = renderedText(tree);

    expect(text).toContain('Performance');
    expect(text).toContain('Juno scene launcher');
    expect(text).toContain('Tap an Add Scene pad to start.');
    expect(text).toMatch(/\d+ BPM/);

    await unmount(tree);
  });
});
