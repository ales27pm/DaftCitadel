import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  InMemorySessionStorageAdapter,
  SessionManager,
  type AudioTransportSnapshot,
} from '../../../session';
import { demoSession, DEMO_SESSION_ID } from '../../../session/fixtures/demoSession';
import { PassiveAudioEngineBridge } from '../../session/environment';
import { SessionViewModelProvider } from '../SessionViewModelProvider';
import { useTransportControls } from '../useTransportControls';
import type { TransportControlsHandle } from '../useTransportControls';

class InteractiveBridge extends PassiveAudioEngineBridge {
  public readonly startSpy = jest.fn();
  public readonly stopSpy = jest.fn();
  public readonly locateSpy = jest.fn();

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

describe('useTransportControls', () => {
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
      await activeControls.locateBeats(1);
    });

    renderer?.unmount();
    warnSpy.mockRestore();
  });

  it('rewinds to start when transport runtime sample rate is unavailable', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
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

    await act(async () => {
      await activeControls.locateBeats(8);
    });

    expect(bridge.locateSpy).toHaveBeenCalledWith(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'Transport runtime missing sample rate; rewinding to start.',
    );

    renderer?.unmount();
    warnSpy.mockRestore();
  });
});
