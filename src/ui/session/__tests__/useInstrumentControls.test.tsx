import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  InMemorySessionStorageAdapter,
  SessionManager,
  type InstrumentMidiEvent,
  type InstrumentParameterChange,
} from '../../../session';
import { demoSession, DEMO_SESSION_ID } from '../../../session/fixtures/demoSession';
import { PassiveAudioEngineBridge } from '../environment';
import {
  SessionViewModelProvider,
  useInstrumentControls,
  type InstrumentControlsHandle,
} from '../SessionViewModelProvider';

class LiveInstrumentBridge extends PassiveAudioEngineBridge {
  public readonly sendInstrumentMidi = jest.fn(
    async (_nodeId: string, _event: InstrumentMidiEvent) => undefined,
  );

  public readonly setInstrumentParameter = jest.fn(
    async (_nodeId: string, _change: InstrumentParameterChange) => undefined,
  );

  public readonly allNotesOff = jest.fn(async (_nodeId: string) => undefined);
}

const renderControls = async (bridge: PassiveAudioEngineBridge) => {
  const storage = new InMemorySessionStorageAdapter();
  await storage.initialize();
  const manager = new SessionManager(storage, bridge);
  await manager.createSession(demoSession);
  let controls: InstrumentControlsHandle | undefined;

  const Harness = () => {
    controls = useInstrumentControls();
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
  if (!renderer || !controls) {
    throw new Error('Instrument controls not initialized');
  }
  return { controls, renderer };
};

describe('useInstrumentControls', () => {
  it('delegates live MIDI, parameter, and all-notes-off operations', async () => {
    const bridge = new LiveInstrumentBridge();
    const { controls, renderer } = await renderControls(bridge);

    expect(controls.isAvailable).toBe(true);
    await act(async () => {
      await controls.sendInstrumentMidi('juno-node', {
        type: 0,
        channel: 0,
        data1: 60,
        data2: 100,
      });
      await controls.setInstrumentParameter('juno-node', {
        parameterId: 0x0003,
        value: 2400,
      });
      await controls.allNotesOff('juno-node');
    });

    expect(bridge.sendInstrumentMidi).toHaveBeenCalledWith('juno-node', {
      type: 0,
      channel: 0,
      data1: 60,
      data2: 100,
    });
    expect(bridge.setInstrumentParameter).toHaveBeenCalledWith('juno-node', {
      parameterId: 0x0003,
      value: 2400,
    });
    expect(bridge.allNotesOff).toHaveBeenCalledWith('juno-node');
    renderer.unmount();
  });

  it('reports a clear unavailable control surface when bridge methods are absent', async () => {
    const { controls, renderer } = await renderControls(new PassiveAudioEngineBridge());

    expect(controls.isAvailable).toBe(false);
    await expect(
      controls.sendInstrumentMidi('juno-node', {
        type: 0,
        channel: 0,
        data1: 60,
        data2: 100,
      }),
    ).rejects.toThrow('Live instrument controls are unavailable');
    renderer.unmount();
  });
});
