import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { NativeModules, Platform, Text } from 'react-native';

import {
  NativeAudioUnavailableError,
  PassiveAudioEngineBridge,
  type SessionEnvironment,
} from '../environment';
import { SessionAppProvider } from '../SessionAppProvider';
import { useSessionViewModel } from '../SessionViewModelProvider';
import { InMemorySessionStorageAdapter, SessionManager } from '../../../session';
import { demoSession } from '../../../session/fixtures/demoSession';
import { ThemeProvider } from '../../design-system';
import * as environmentModule from '../environment';

jest.mock('react-native', () => ({
  ...jest.requireActual('react-native'),
  ActivityIndicator: 'ActivityIndicator',
}));

const setDevFlag = (value: boolean) => {
  Object.defineProperty(globalThis, '__DEV__', {
    value,
    configurable: true,
    writable: true,
  });
};

describe('SessionAppProvider', () => {
  const originalDev = Boolean((globalThis as { __DEV__?: boolean }).__DEV__);
  const originalPlatform = Platform.OS;
  const originalNativeBridgePref = process.env.EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE;
  const nativeModules = NativeModules as Record<string, unknown>;
  const originalAudioEngineModule = nativeModules.AudioEngineModule;

  const setNativeAudioModuleAvailable = (available: boolean) => {
    if (available) {
      nativeModules.AudioEngineModule = originalAudioEngineModule;
      return;
    }
    delete nativeModules.AudioEngineModule;
  };

  const createDeferred = <T,>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      promise,
      resolve,
      reject,
    };
  };

  const createTestEnvironment = async (
    sessionId: string,
  ): Promise<SessionEnvironment> => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const audioBridge = new PassiveAudioEngineBridge();
    const manager = new SessionManager(storage, audioBridge);
    await manager.createSession({ ...demoSession, id: sessionId });
    return {
      manager,
      audioBridge,
      sessionId,
      dispose: jest.fn(),
    };
  };

  const setNativeBridgePreference = (value: string | undefined) => {
    if (value === undefined) {
      delete process.env.EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE;
      return;
    }
    process.env.EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE = value;
  };

  beforeEach(() => {
    setNativeAudioModuleAvailable(false);
  });

  afterEach(() => {
    jest.resetAllMocks();
    Platform.OS = originalPlatform;
    setDevFlag(originalDev);
    setNativeBridgePreference(originalNativeBridgePref);
    setNativeAudioModuleAvailable(true);
  });

  const renderWithConsumer = async () => {
    let status: string | undefined;
    let name: string | undefined;

    const Consumer = () => {
      const viewModel = useSessionViewModel();
      status = viewModel.status;
      name = viewModel.sessionName;
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            SessionAppProvider,
            null,
            React.createElement(Consumer, null),
          ),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    return { renderer: renderer!, status, name };
  };

  const renderedText = (renderer: TestRenderer.ReactTestRenderer): string =>
    renderer.root
      .findAllByType(Text)
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === 'string')
      .join(' ');

  it('bootstraps the production environment on mobile release builds', async () => {
    setDevFlag(false);
    Platform.OS = 'ios';
    const environment = await createTestEnvironment('prod-session');
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockResolvedValue(environment);
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Passive environment should not be used');
      });

    const { status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('bootstraps the production environment in a native development client', async () => {
    setDevFlag(true);
    Platform.OS = 'ios';
    setNativeAudioModuleAvailable(true);
    const environment = await createTestEnvironment('dev-client-session');
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockResolvedValue(environment);
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Passive environment should not be used');
      });

    const { status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('allows an explicit passive preview in a native development client', async () => {
    setDevFlag(true);
    Platform.OS = 'ios';
    setNativeAudioModuleAvailable(true);
    setNativeBridgePreference('false');
    const environment = await createTestEnvironment('native-passive-preview');
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockResolvedValue(environment);
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Production environment should not be used');
      });

    const { status, name } = await renderWithConsumer();

    expect(passiveSpy).toHaveBeenCalledTimes(1);
    expect(productionSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('uses the passive environment in Expo Go without the native audio module', async () => {
    setDevFlag(true);
    Platform.OS = 'ios';
    const passiveEnvironment = await createTestEnvironment('dev-session');
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockResolvedValue(passiveEnvironment);
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Production environment should not be initialised');
      });

    const { status, name } = await renderWithConsumer();

    expect(passiveSpy).toHaveBeenCalledTimes(1);
    expect(productionSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('keeps web development passive when the native test host exposes the module', async () => {
    setDevFlag(true);
    Platform.OS = 'web';
    setNativeAudioModuleAvailable(true);
    setNativeBridgePreference('true');
    const passiveEnvironment = await createTestEnvironment('web-dev-session');
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockResolvedValue(passiveEnvironment);
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Production environment should not be used');
      });

    const { status, name } = await renderWithConsumer();

    expect(passiveSpy).toHaveBeenCalledTimes(1);
    expect(productionSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('bootstraps the production environment on web release builds', async () => {
    setDevFlag(false);
    Platform.OS = 'web';
    setNativeBridgePreference('true');
    const productionEnvironment = await createTestEnvironment('web-prod-session');
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockResolvedValue(productionEnvironment);
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Passive environment should not be used');
      });

    const { status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('forces the passive environment on web when native bridge is explicitly disabled', async () => {
    setDevFlag(false);
    Platform.OS = 'web';
    setNativeBridgePreference('false');
    const passiveEnvironment = await createTestEnvironment('web-passive-disabled-flag');
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockResolvedValue(passiveEnvironment);
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Production environment should not be used');
      });

    const { status, name } = await renderWithConsumer();

    expect(passiveSpy).toHaveBeenCalledTimes(1);
    expect(productionSpy).not.toHaveBeenCalled();
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
  });

  it('surfaces a release error when native audio is unavailable', async () => {
    setDevFlag(false);
    Platform.OS = 'android';
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Passive environment should not be used');
      });
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockRejectedValue(new NativeAudioUnavailableError('Audio unavailable'));

    const { renderer, status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).not.toHaveBeenCalled();
    expect(status).toBeUndefined();
    expect(name).toBeUndefined();
    expect(renderedText(renderer)).toContain('Session unavailable');
    expect(renderedText(renderer)).toContain(
      'Native audio engine is required for release builds: Audio unavailable',
    );
    expect(renderedText(renderer)).toContain('Try again');
  });

  it('surfaces an unexpected production bootstrap error', async () => {
    setDevFlag(false);
    Platform.OS = 'ios';
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Passive environment should not be used');
      });
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockRejectedValue(new Error('Audio sample loader native module is unavailable'));

    const { renderer, status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).not.toHaveBeenCalled();
    expect(status).toBeUndefined();
    expect(name).toBeUndefined();
    expect(renderedText(renderer)).toContain('Session unavailable');
    expect(renderedText(renderer)).toContain(
      'Audio sample loader native module is unavailable',
    );
    expect(renderedText(renderer)).toContain('Try again');
  });

  it('surfaces a release error when web audio is unavailable', async () => {
    setDevFlag(false);
    Platform.OS = 'web';
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Passive environment should not be used');
      });
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockRejectedValue(
        new NativeAudioUnavailableError('Web Audio API is not available'),
      );

    const { renderer, status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).not.toHaveBeenCalled();
    expect(status).toBeUndefined();
    expect(name).toBeUndefined();
    expect(renderedText(renderer)).toContain('Session unavailable');
    expect(renderedText(renderer)).toContain(
      'Native audio engine is required for release builds: Web Audio API is not available',
    );
    expect(renderedText(renderer)).toContain('Try again');
  });

  it('disposes the active environment when the provider unmounts', async () => {
    setDevFlag(true);
    Platform.OS = 'ios';
    const environment = await createTestEnvironment('teardown-session');
    const dispose = jest.fn().mockResolvedValue(undefined);
    environment.dispose = dispose;
    jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockResolvedValue(environment);

    const { renderer } = await renderWithConsumer();

    await act(async () => {
      renderer.unmount();
      await Promise.resolve();
    });

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('runs the end-session system when bootstrap resolves after unmount', async () => {
    setDevFlag(true);
    Platform.OS = 'ios';
    const environment = await createTestEnvironment('cancelled-session');
    const deferred = createDeferred<SessionEnvironment>();
    const disposeSpy = jest
      .spyOn(environmentModule, 'disposeSessionEnvironment')
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockReturnValue(deferred.promise);
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockImplementation(() => {
        throw new Error('Production environment should not be initialised');
      });

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(SessionAppProvider, null, null),
        ),
      );
      await Promise.resolve();
    });

    expect(renderer).not.toBeNull();

    await act(async () => {
      renderer!.unmount();
    });

    await act(async () => {
      deferred.resolve(environment);
      await Promise.resolve();
    });

    expect(productionSpy).not.toHaveBeenCalled();
    expect(passiveSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledWith(environment, 'app session environment');
  });
});
