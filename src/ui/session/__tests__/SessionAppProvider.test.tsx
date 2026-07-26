import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';

import {
  NativeAudioUnavailableError,
  PassiveAudioEngineBridge,
  type SessionEnvironment,
} from '../environment';
import { SessionAppProvider } from '../SessionAppProvider';
import { useSessionViewModel } from '../SessionViewModelProvider';
import { InMemorySessionStorageAdapter, SessionManager } from '../../../session';
import { demoSession } from '../../../session/fixtures/demoSession';
import * as environmentModule from '../environment';

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

  afterEach(() => {
    jest.resetAllMocks();
    Platform.OS = originalPlatform;
    setDevFlag(originalDev);
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
          SessionAppProvider,
          null,
          React.createElement(Consumer, null),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    return { renderer: renderer!, status, name };
  };

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

  it('prefers the passive environment when running in development', async () => {
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

  it('falls back to passive environment when native audio is unavailable', async () => {
    setDevFlag(false);
    Platform.OS = 'android';
    const fallbackEnvironment = await createTestEnvironment('fallback-session');
    const passiveSpy = jest
      .spyOn(environmentModule, 'createPassiveSessionEnvironment')
      .mockResolvedValue(fallbackEnvironment);
    const productionSpy = jest
      .spyOn(environmentModule, 'createProductionSessionEnvironment')
      .mockRejectedValue(new NativeAudioUnavailableError('Audio unavailable'));

    const { status, name } = await renderWithConsumer();

    expect(productionSpy).toHaveBeenCalledTimes(1);
    expect(passiveSpy).toHaveBeenCalledTimes(1);
    expect(status).toBe('ready');
    expect(name).toBe('Demo Performance');
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
      renderer = TestRenderer.create(React.createElement(SessionAppProvider, null, null));
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
