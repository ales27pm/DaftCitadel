import { DiagnosticsManager } from '../DiagnosticsManager';
import type {
  LinkMetrics,
  NetworkDiagnostics,
  NetworkMetricsListener,
} from '../diagnostics/NetworkDiagnostics';

describe('DiagnosticsManager', () => {
  const baseMetrics: LinkMetrics = {
    interfaceName: 'en0',
    rssi: -55,
    noise: -92,
    linkSpeedMbps: 480,
    transmitRateMbps: 520,
    timestamp: 1700000000000,
    category: 'excellent',
  };

  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('subscribes to metrics and logs sanitized payloads', async () => {
    const logger = jest.fn();
    const onMetrics = jest.fn();
    const unsubscribe = jest.fn();
    let capturedListener: NetworkMetricsListener | undefined;

    const subscribeMock = jest.fn((listener: NetworkMetricsListener) => {
      capturedListener = listener;
      return unsubscribe;
    });

    const diagnostics: NetworkDiagnostics = {
      subscribe: subscribeMock,
      getCurrentLinkMetrics: jest.fn().mockResolvedValue(baseMetrics),
    };

    const manager = new DiagnosticsManager({ diagnostics, logger, onMetrics });

    manager.start();

    expect(subscribeMock).toHaveBeenCalledTimes(1);

    capturedListener?.({ ...baseMetrics, rssi: -60 });

    await flushMicrotasks();

    expect(onMetrics).toHaveBeenCalledTimes(2);
    expect(onMetrics).toHaveBeenCalledWith({ ...baseMetrics, rssi: -60 });
    expect(onMetrics).toHaveBeenCalledWith(baseMetrics);

    const [eventKey, payload] = logger.mock.calls.find(
      ([key]) => key === 'collab.networkMetrics',
    ) ?? ['', {}];

    expect(eventKey).toBe('collab.networkMetrics');
    expect(payload).not.toHaveProperty('interfaceName');
    expect(payload).toMatchObject({ rssi: -60, linkSpeedMbps: 480 });

    const initialCall = logger.mock.calls.find(
      ([key]) => key === 'collab.networkMetrics.initial',
    );
    expect(initialCall?.[1]).not.toHaveProperty('interfaceName');
    expect(initialCall?.[1]).toMatchObject({ rssi: -55 });
  });

  it('invokes the unsubscribe handle when stopped', () => {
    const logger = jest.fn();
    const onMetrics = jest.fn();
    const unsubscribe = jest.fn();

    const diagnostics: NetworkDiagnostics = {
      subscribe: () => unsubscribe,
      getCurrentLinkMetrics: jest.fn().mockResolvedValue(baseMetrics),
    };

    const manager = new DiagnosticsManager({ diagnostics, logger, onMetrics });

    manager.start();
    manager.stop();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('logs errors when metrics cannot be retrieved', async () => {
    const logger = jest.fn();
    const onMetrics = jest.fn();

    let capturedListener: NetworkMetricsListener | undefined;

    const diagnostics: NetworkDiagnostics = {
      subscribe: (listener) => {
        capturedListener = listener;
        listener({ ...baseMetrics, category: 'unusable' });
        return () => {};
      },
      getCurrentLinkMetrics: jest.fn().mockRejectedValue(new Error('module unavailable')),
    };

    const manager = new DiagnosticsManager({ diagnostics, logger, onMetrics });

    manager.start();
    await flushMicrotasks();

    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith('collab.networkMetrics.error', {
      error: 'Error: module unavailable',
    });

    capturedListener?.({ ...baseMetrics, rssi: -90 });
    expect(onMetrics).toHaveBeenCalledWith({ ...baseMetrics, rssi: -90 });
  });
});
