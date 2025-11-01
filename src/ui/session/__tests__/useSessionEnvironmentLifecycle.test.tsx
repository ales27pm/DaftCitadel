import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import type { SessionEnvironment } from '../environment';
import type { SessionManager } from '../../../session';
import * as environmentModule from '../environment';

const { useSessionEnvironmentLifecycle } = environmentModule;

describe('useSessionEnvironmentLifecycle', () => {
  const createEnvironment = (id: string): SessionEnvironment => ({
    manager: {} as SessionManager,
    audioBridge: {
      applySessionUpdate: jest.fn(),
    },
    sessionId: id,
  });

  const Harness: React.FC<{
    environment: SessionEnvironment | null;
    context?: string;
  }> = ({ environment, context = 'lifecycle test context' }) => {
    useSessionEnvironmentLifecycle(environment, { context });
    return null;
  };

  let disposeSpy: jest.SpiedFunction<typeof environmentModule.disposeSessionEnvironment>;

  const flushAsyncEffects = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    disposeSpy = jest
      .spyOn(environmentModule, 'disposeSessionEnvironment')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    disposeSpy.mockRestore();
  });

  it('disposes the previous environment when a new environment is provided', async () => {
    const first = createEnvironment('first');
    const second = createEnvironment('second');
    let renderer: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      renderer = TestRenderer.create(<Harness environment={first} />);
    });
    expect(renderer).not.toBeNull();

    await act(async () => {
      renderer!.update(<Harness environment={second} />);
    });
    await flushAsyncEffects();

    expect(disposeSpy).toHaveBeenCalled();
    expect(
      disposeSpy.mock.calls.some(
        ([env, context]) => env === first && context === 'lifecycle test context',
      ),
    ).toBe(true);

    await act(async () => {
      renderer!.unmount();
    });
    await flushAsyncEffects();

    const disposalCallsAfterUnmount = disposeSpy.mock.calls.filter(
      ([env, context]) => env === second && context === 'lifecycle test context',
    );
    expect(disposalCallsAfterUnmount.length).toBeGreaterThanOrEqual(1);
  });

  it('disposes the active environment when it transitions to null', async () => {
    const environment = createEnvironment('transient');
    let renderer: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      renderer = TestRenderer.create(<Harness environment={environment} />);
    });
    expect(renderer).not.toBeNull();

    await act(async () => {
      renderer!.update(<Harness environment={null} />);
    });
    await flushAsyncEffects();

    expect(disposeSpy).toHaveBeenCalled();
    expect(
      disposeSpy.mock.calls.some(
        ([env, context]) => env === environment && context === 'lifecycle test context',
      ),
    ).toBe(true);

    await act(async () => {
      renderer!.unmount();
    });
    await flushAsyncEffects();

    const cleanupCalls = disposeSpy.mock.calls.filter(
      ([env, context]) => env === environment && context === 'lifecycle test context',
    );
    expect(cleanupCalls.length).toBe(1);
  });
});
