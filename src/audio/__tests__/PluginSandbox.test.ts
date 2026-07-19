import { PermissionsAndroid, Platform } from 'react-native';

import { NativePluginHost } from '../plugins/NativePluginHost';
import { PluginSandboxManager, type SandboxStorage } from '../plugins/PluginSandbox';
import type { PluginDescriptor } from '../plugins/types';

const descriptor: PluginDescriptor = {
  identifier: 'com.daftcitadel.test',
  name: 'Test Unit',
  format: 'vst3',
  manufacturer: 'Daft Labs',
  version: '1.0.0',
  supportsSandbox: true,
  audioInputChannels: 2,
  audioOutputChannels: 2,
  midiInput: false,
  midiOutput: false,
  parameters: [],
};

describe('PluginSandboxManager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses app-specific native storage without requesting broad Android permission', async () => {
    Platform.OS = 'android';
    Platform.Version = 28;
    const storage: SandboxStorage = {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    };
    const permissionSpy = jest.spyOn(PermissionsAndroid, 'request');
    jest
      .spyOn(NativePluginHost, 'ensureSandbox')
      .mockResolvedValue({ sandboxPath: '/data/user/0/app/files/plugin-sandboxes/test' });

    const context = await new PluginSandboxManager(storage).ensureSandbox(descriptor);

    expect(context.path).toContain('/data/user/0/app/files/');
    expect(permissionSpy).not.toHaveBeenCalled();
  });
});
