import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { NativeModules, Platform } from 'react-native';

import {
  InMemorySessionStorageAdapter,
  SessionManager,
  type AudioDiagnosticsSnapshot,
  type AudioTransportSnapshot,
} from '../../../session';
import { demoSession, DEMO_SESSION_ID } from '../../../session/fixtures/demoSession';
import { PassiveAudioEngineBridge } from '../../session/environment';
import { SessionViewModelProvider } from '../SessionViewModelProvider';
import { useTransportControls } from '../useTransportControls';
import type { TransportControlsHandle } from '../useTransportControls';

const READY_DIAGNOSTICS: AudioDiagnosticsSnapshot = {
  status: 'ready',
  xruns: 0,
  renderLoad: 0,
};

class ReadyBridge extends PassiveAudioEngineBridge {
  override getDiagnosticsState(): AudioDiagnosticsSnapshot {
    return { ...READY_DIAGNOSTICS };
  }

  override subscribeDiagnostics(
    listener: (snapshot: AudioDiagnosticsSnapshot) => void,
  ): () => void {
    listener({ ...READY_DIAGNOSTICS });
    return () => undefined;
  }
}

class InteractiveBridge extends ReadyBridge {
  public readonly startSpy = jest.fn();
  public readonly stopSpy = jest.fn();
  public readonly locateSpy = jest.fn();
  public readonly loopSpy = jest.fn();

  override async startTransport(): Promise<void> {
    this.startSpy();
    await super.startTransport();
  }

  override async stopTransport(): Promise<void> {
    this.stopSpy();
    await super.stopTransport();
  }

  override async locateTransport(frame: number): Promise<void> {
    this.locateSpy(frame);
    await super.locateTransport(frame);
  }

  async setTransportLoop(
    startFrame: number,
    endFrame: number,
    enabled: boolean,
  ): Promise<void> {
    this.loopSpy(startFrame, endFrame, enabled);
  }
}

class DegradedDiagnosticsBridge extends InteractiveBridge {
  override getDiagnosticsState(): AudioDiagnosticsSnapshot {
    return {
      status: 'error',
      xruns: 1,
      renderLoad: 0,
      error: new Error('Metrics polling failed'),
    };
  }

  override subscribeDiagnostics(
    listener: (snapshot: AudioDiagnosticsSnapshot) => void,
  ): () => void {
    listener(this.getDiagnosticsState());
    return () => undefined;
  }
}

class MissingRuntimeBridge extends InteractiveBridge {
  override getTransportState(): AudioTransportSnapshot | null {
    return null;
  }

  override subscribeTransport(
    _listener: (snapshot: AudioTransportSnapshot) => void,
  ): () => void {
    return () => undefined;
  }
}

class SilentBridge extends ReadyBridge {
  public readonly startSpy = jest.fn();
  public readonly stopSpy = jest.fn();
  public readonly locateSpy = jest.fn();

  override async startTransport(): Promise<void> {
    this.startSpy();
  }

  override async stopTransport(): Promise<void> {
    this.stopSpy();
  }

  override async locateTransport(frame: number): Promise<void> {
    this.locateSpy(frame);
  }
}

class FailingBridge extends ReadyBridge {
  constructor(private readonly failure: Error) {
    super();
  }

  override async startTransport(): Promise<void> {
    throw this.failure;
  }
}

type MockLoggerModule = {
  logWithLevel: jest.Mock;
  __getLogs: () => Array<{
    level: string;
    message: string;
    metadata?: Record<string, unknown>;
  }>;
  __clearLogs: () => void;
};

const resolveLogger = (): MockLoggerModule => {
  const module = (NativeModules as unknown as { DaftCitadelLogger?: MockLoggerModule })
    .DaftCitadelLogger;
  if (!module) {
    throw new Error('DaftCitadelLogger mock not registered');
  }
  return module;
};

describe('useTransportControls', () => {
  beforeEach(() => {
    resolveLogger().__clearLogs();
  });

  it('invokes audio bridge transport methods', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new InteractiveBridge();
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          bootstrapSession={() => demoSession}
          diagnosticsPollIntervalMs={0}
          audioBridge={bridge}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }
    const activeControls = controls as TransportControlsHandle;

    await act(async () => {
      await activeControls.play();
      await activeControls.stop();
      await activeControls.locateBeats(2);
    });

    const framesPerBeat =
      (demoSession.metadata.sampleRate * 60) / demoSession.metadata.bpm;
    const expectedFrame = Math.floor(framesPerBeat * 2);

    expect(bridge.startSpy).toHaveBeenCalledTimes(1);
    expect(bridge.stopSpy).toHaveBeenCalledTimes(1);
    expect(bridge.locateSpy).toHaveBeenCalledWith(expectedFrame);

    expect(activeControls.isLoopAvailable).toBe(true);
    await act(async () => {
      await activeControls.setLoopBeats(1, 5, true);
      await activeControls.setLoopBeats(0, 0, false);
    });
    expect(bridge.loopSpy).toHaveBeenNthCalledWith(
      1,
      Math.floor(framesPerBeat),
      Math.floor(framesPerBeat * 5),
      true,
    );
    expect(bridge.loopSpy).toHaveBeenNthCalledWith(2, 0, 0, false);

    await expect(activeControls.setLoopBeats(4, 4, true)).rejects.toThrow(
      'Loop end must be after loop start.',
    );

    renderer?.unmount();
  });

  it('marks controls unavailable when audio bridge is missing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new PassiveAudioEngineBridge();
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          bootstrapSession={() => demoSession}
          diagnosticsPollIntervalMs={0}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }

    const activeControls = controls as TransportControlsHandle;

    expect(activeControls.isAvailable).toBe(false);

    await act(async () => {
      await activeControls.locateBeats(0);
    });
    await expect(activeControls.locateBeats(1)).rejects.toThrow(
      'Transport sample rate is unavailable; cannot locate to a nonzero position.',
    );

    renderer?.unmount();
    warnSpy.mockRestore();
  });

  it('keeps bridge transport controls available when diagnostics fail', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new DegradedDiagnosticsBridge();
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          diagnosticsPollIntervalMs={0}
          audioBridge={bridge}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }
    const activeControls = controls as TransportControlsHandle;

    expect(activeControls.isAvailable).toBe(true);
    await act(async () => {
      await activeControls.stop();
    });
    expect(bridge.stopSpy).toHaveBeenCalledTimes(1);

    renderer?.unmount();
  });

  it('rejects nonzero beat locations when runtime sample rate is unavailable', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new MissingRuntimeBridge();
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          bootstrapSession={() => demoSession}
          diagnosticsPollIntervalMs={0}
          audioBridge={bridge}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }
    const activeControls = controls as TransportControlsHandle;

    await expect(activeControls.locateBeats(8)).rejects.toThrow(
      'Transport sample rate is unavailable; cannot locate to a nonzero position.',
    );
    expect(bridge.locateSpy).not.toHaveBeenCalled();

    await act(async () => {
      await activeControls.locateBeats(0);
    });
    expect(bridge.locateSpy).toHaveBeenCalledWith(0);

    renderer?.unmount();
  });

  it('provides optimistic runtime updates when the bridge does not emit state changes', async () => {
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const bridge = new SilentBridge();
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          bootstrapSession={() => demoSession}
          diagnosticsPollIntervalMs={0}
          audioBridge={bridge}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }

    const readControls = (): TransportControlsHandle => {
      if (!controls) {
        throw new Error('Transport controls not initialized');
      }
      return controls as TransportControlsHandle;
    };

    let activeControls = readControls();

    await act(async () => {
      await activeControls.play();
      await Promise.resolve();
    });

    activeControls = readControls();

    expect(activeControls.isPlaying).toBe(true);
    expect(activeControls.transportRuntime?.isPlaying).toBe(true);
    expect(activeControls.transport?.isPlaying).toBe(true);

    await act(async () => {
      await activeControls.locateFrame(2048);
      await Promise.resolve();
    });

    activeControls = readControls();

    expect(activeControls.transportRuntime?.frame).toBe(2048);
    expect(activeControls.transport?.playheadBeats).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await activeControls.stop();
      await Promise.resolve();
    });

    activeControls = readControls();

    expect(activeControls.transportRuntime?.isPlaying).toBe(false);

    renderer?.unmount();
  });

  it('logs transport failures via native logger on iOS', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const failure = new Error('boom');
    const bridge = new FailingBridge(failure);
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          bootstrapSession={() => demoSession}
          diagnosticsPollIntervalMs={0}
          audioBridge={bridge}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }

    const activeControls = controls as TransportControlsHandle;

    await act(async () => {
      await expect(activeControls.play()).rejects.toThrow('boom');
    });

    const logs = resolveLogger().__getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe('error');
    expect(logs[0]?.message).toContain('Failed to start transport');
    expect(logs[0]?.metadata).toMatchObject({
      operation: 'start',
      error: 'boom',
      subsystem: 'com.daftcitadel.transport',
      category: 'transport-controls',
    });

    errorSpy.mockRestore();
    renderer?.unmount();
  });

  it('logs transport failures via native logger on Android', async () => {
    const originalOS = Platform.OS;
    Platform.OS = 'android' as typeof Platform.OS;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage = new InMemorySessionStorageAdapter();
    await storage.initialize();
    const failure = new Error('android failure');
    const bridge = new FailingBridge(failure);
    const manager = new SessionManager(storage, bridge);
    await manager.createSession(demoSession);

    let controls: TransportControlsHandle | null = null;

    const Harness = () => {
      controls = useTransportControls();
      return null;
    };

    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        <SessionViewModelProvider
          manager={manager}
          sessionId={DEMO_SESSION_ID}
          bootstrapSession={() => demoSession}
          diagnosticsPollIntervalMs={0}
          audioBridge={bridge}
        >
          <Harness />
        </SessionViewModelProvider>,
      );
      await Promise.resolve();
    });

    if (!controls) {
      throw new Error('Transport controls not initialized');
    }

    const activeControls = controls as TransportControlsHandle;

    await act(async () => {
      await expect(activeControls.play()).rejects.toThrow('android failure');
    });

    const logs = resolveLogger().__getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.metadata).toMatchObject({
      operation: 'start',
      error: 'android failure',
      tag: 'DaftCitadelTransport',
    });

    Platform.OS = originalOS;
    errorSpy.mockRestore();
    renderer?.unmount();
  });
});
