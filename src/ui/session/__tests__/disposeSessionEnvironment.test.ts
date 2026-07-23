import { disposeSessionEnvironment, type SessionEnvironment } from '../environment';
import type { SessionManager } from '../../../session';
import type { DisposableAudioEngineBridge } from '../environment';

describe('disposeSessionEnvironment', () => {
  const createEnvironment = (
    overrides: Partial<SessionEnvironment> = {},
  ): SessionEnvironment => {
    const { audioBridge: overrideBridge, ...rest } = overrides;
    const audioBridge: DisposableAudioEngineBridge = {
      applySessionUpdate: jest.fn(),
      resetSession: jest.fn(),
      ...(overrideBridge ?? {}),
    } as DisposableAudioEngineBridge;

    const environment: SessionEnvironment = {
      manager: {} as SessionManager,
      sessionId: 'env',
      audioBridge,
      ...rest,
    } as SessionEnvironment;
    return environment;
  };

  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('calls the environment dispose hook when provided', async () => {
    const dispose = jest.fn().mockResolvedValue(undefined);
    const bridgeDispose = jest.fn();
    const environment = createEnvironment({
      dispose,
      audioBridge: {
        applySessionUpdate: jest.fn(),
        resetSession: jest.fn(),
        dispose: bridgeDispose,
      },
    });

    await disposeSessionEnvironment(environment, 'unit test environment');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(bridgeDispose).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('falls back to disposing the audio bridge when the environment lacks dispose', async () => {
    const bridgeDispose = jest.fn().mockResolvedValue(undefined);
    const environment = createEnvironment({
      audioBridge: {
        applySessionUpdate: jest.fn(),
        resetSession: jest.fn(),
        dispose: bridgeDispose,
      },
    });

    await disposeSessionEnvironment(environment, 'fallback environment');

    expect(bridgeDispose).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs an error when environment dispose rejects', async () => {
    const dispose = jest.fn().mockRejectedValue(new Error('failed to dispose'));
    const environment = createEnvironment({ dispose });

    await disposeSessionEnvironment(environment, 'erroring environment');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('Failed to dispose erroring environment');
  });

  it('logs an error when audio bridge disposal throws', async () => {
    const bridgeDispose = jest.fn().mockRejectedValue(new Error('bridge failure'));
    const environment = createEnvironment({
      audioBridge: {
        applySessionUpdate: jest.fn(),
        resetSession: jest.fn(),
        dispose: bridgeDispose,
      },
    });

    await disposeSessionEnvironment(environment, 'bridge environment');

    expect(bridgeDispose).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain(
      'Failed to dispose session audio bridge (bridge environment)',
    );
  });
});
