import { __mockPluginHostEmitter, Platform } from 'react-native';
import { PluginHost } from '../plugins/PluginHost';
import { NativePluginHost } from '../plugins/NativePluginHost';
import type { PluginDescriptor, PluginInstanceHandle } from '../plugins/types';
import { PluginSandboxManager } from '../plugins/PluginSandbox';

class FakeSandboxManager extends PluginSandboxManager {
  public ensureSandbox = jest.fn(
    async (pluginDescriptor: PluginDescriptor, preferredId?: string) =>
      super.ensureSandbox(pluginDescriptor, preferredId),
  );

  public recordSandbox = jest.fn(
    (context: Parameters<PluginSandboxManager['recordSandbox']>[0]) => {
      super.recordSandbox(context);
    },
  );
}

const descriptor: PluginDescriptor = {
  identifier: 'com.daftcitadel.echo',
  name: 'Echo Unit',
  format: 'auv3',
  manufacturer: 'Daft Labs',
  version: '1.2.3',
  supportsSandbox: true,
  audioInputChannels: 2,
  audioOutputChannels: 2,
  midiInput: false,
  midiOutput: false,
  parameters: [],
  factoryPresets: [
    {
      id: 'default',
      name: 'Default',
      data: 'ZGF0YQ==',
      format: 'base64',
    },
  ],
};

const instanceHandle: PluginInstanceHandle = {
  instanceId: 'instance-1',
  descriptor,
  cpuLoadPercent: 3,
  latencySamples: 64,
  sandboxPath: '/mock/echo',
  nativeInstanceId: 'native-instance-1',
  restartToken: 'token-1',
};

const restartedHandle: PluginInstanceHandle = {
  ...instanceHandle,
  instanceId: 'instance-2',
  cpuLoadPercent: 5,
  nativeInstanceId: 'native-instance-2',
  restartToken: 'token-2',
};

describe('PluginHost', () => {
  let instantiateMock: jest.SpiedFunction<typeof NativePluginHost.instantiatePlugin>;

  beforeEach(() => {
    Platform.OS = 'ios';
    jest.spyOn(NativePluginHost, 'queryAvailablePlugins').mockResolvedValue([descriptor]);
    instantiateMock = jest
      .spyOn(NativePluginHost, 'instantiatePlugin')
      .mockResolvedValue(instanceHandle);
    jest.spyOn(NativePluginHost, 'releasePlugin').mockResolvedValue();
    jest.spyOn(NativePluginHost, 'loadPreset').mockResolvedValue();
    jest.spyOn(NativePluginHost, 'scheduleAutomation').mockResolvedValue();
    jest.spyOn(NativePluginHost, 'setParameterValue').mockResolvedValue();
    jest
      .spyOn(NativePluginHost, 'ensureSandbox')
      .mockResolvedValue({ sandboxPath: instanceHandle.sandboxPath! });
    jest.spyOn(NativePluginHost, 'acknowledgeCrash').mockResolvedValue();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('instantiates plugins with sandbox support', async () => {
    const sandboxManager = new FakeSandboxManager();
    const host = new PluginHost(sandboxManager);
    const handle = await host.loadPlugin(descriptor, { cpuBudgetPercent: 45 });

    expect(NativePluginHost.ensureSandbox).toHaveBeenCalledWith(descriptor.identifier);
    expect(NativePluginHost.instantiatePlugin).toHaveBeenCalledWith(
      descriptor.identifier,
      {
        cpuBudgetPercent: 45,
        sandboxIdentifier: descriptor.identifier,
      },
    );
    expect(handle).toEqual(instanceHandle);
    expect(sandboxManager.recordSandbox).toHaveBeenCalled();
  });

  it('loads presets by id', async () => {
    const host = new PluginHost(new FakeSandboxManager());
    await host.loadPlugin(descriptor);
    await host.loadPreset(instanceHandle.instanceId, 'default');

    expect(NativePluginHost.loadPreset).toHaveBeenCalledWith(
      instanceHandle.nativeInstanceId,
      descriptor.factoryPresets![0],
    );
  });

  it('propagates crash events to listeners and restarts plugins', async () => {
    const host = new PluginHost(new FakeSandboxManager());
    await host.loadPlugin(descriptor);

    const listener = jest.fn();
    host.onCrash(listener);

    __mockPluginHostEmitter.emit('pluginCrashed', {
      instanceId: instanceHandle.instanceId,
      descriptor,
      timestamp: new Date().toISOString(),
      reason: 'Test crash',
      recovered: false,
      restartToken: 'token-1',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(NativePluginHost.acknowledgeCrash).toHaveBeenCalledWith(
      instanceHandle.instanceId,
    );
    expect(NativePluginHost.instantiatePlugin).toHaveBeenCalledWith(
      descriptor.identifier,
      expect.objectContaining({
        initialPresetId: 'default',
      }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: instanceHandle.instanceId,
        reason: 'Test crash',
      }),
    );
  });

  it('schedules automation envelopes', async () => {
    const host = new PluginHost(new FakeSandboxManager());
    await host.loadPlugin(descriptor);
    await host.scheduleAutomation(instanceHandle.instanceId, 'mix', [
      { time: 0, value: 0.2 },
      { time: 120, value: 0.8 },
    ]);

    expect(NativePluginHost.scheduleAutomation).toHaveBeenCalledWith(
      instanceHandle.nativeInstanceId,
      'mix',
      [
        { time: 0, value: 0.2 },
        { time: 120, value: 0.8 },
      ],
    );
  });

  it('reuses the logical instance id after a crash restart', async () => {
    let callCount = 0;
    instantiateMock.mockImplementation(async () => {
      callCount += 1;
      return callCount === 1 ? instanceHandle : restartedHandle;
    });

    const host = new PluginHost(new FakeSandboxManager());
    await host.loadPlugin(descriptor);

    __mockPluginHostEmitter.emit('pluginCrashed', {
      instanceId: instanceHandle.instanceId,
      descriptor,
      timestamp: new Date().toISOString(),
      reason: 'Test crash',
      recovered: false,
      restartToken: 'token-1',
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(instantiateMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    const binding = (
      host as unknown as { instances: Map<string, { nativeInstanceId: string }> }
    ).instances.get(instanceHandle.instanceId);

    expect(binding?.nativeInstanceId).toBe(restartedHandle.nativeInstanceId);

    await host.setParameter(instanceHandle.instanceId, 'mix', 0.5);

    expect(NativePluginHost.setParameterValue).toHaveBeenLastCalledWith(
      restartedHandle.nativeInstanceId,
      'mix',
      0.5,
    );
  });

  it('refuses to restart when the restart token mismatches', async () => {
    const host = new PluginHost(new FakeSandboxManager());
    await host.loadPlugin(descriptor);

    __mockPluginHostEmitter.emit('pluginCrashed', {
      instanceId: instanceHandle.instanceId,
      descriptor,
      timestamp: new Date().toISOString(),
      reason: 'Test crash',
      recovered: false,
      restartToken: 'token-mismatch',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(instantiateMock).toHaveBeenCalledTimes(1);
  });

  it('supports manual retry of plugin instances', async () => {
    instantiateMock.mockResolvedValueOnce(instanceHandle);
    instantiateMock.mockResolvedValueOnce(restartedHandle);

    const host = new PluginHost(new FakeSandboxManager());
    await host.loadPlugin(descriptor);

    const retried = await host.retryInstance(instanceHandle.instanceId);

    expect(retried).toBe(true);
    expect(instantiateMock).toHaveBeenCalledTimes(2);
  });
});
