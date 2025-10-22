import type { PluginRoutingNode } from '../../../session/models';
import type { PluginDescriptor, PluginHost } from '../../../audio';
import { createPluginDescriptorResolver } from '../environment';

type TestPluginNode = PluginRoutingNode & {
  metadata?: Record<string, unknown>;
  descriptorId?: string;
};

type ListPluginsMock = jest.Mock<
  ReturnType<PluginHost['listAvailablePlugins']>,
  Parameters<PluginHost['listAvailablePlugins']>
>;

describe('createPluginDescriptorResolver', () => {
  const createDescriptor = (overrides: Partial<PluginDescriptor>): PluginDescriptor => ({
    identifier: 'com.daftcitadel.echo',
    name: 'Echo Chamber',
    format: 'auv3',
    manufacturer: 'Daft Citadel',
    version: '1.0.0',
    supportsSandbox: true,
    audioInputChannels: 2,
    audioOutputChannels: 2,
    midiInput: false,
    midiOutput: false,
    parameters: [],
    ...overrides,
  });

  const createPluginNode = (overrides: Partial<TestPluginNode> = {}): TestPluginNode =>
    ({
      id: 'track:plugin:1',
      type: 'plugin',
      slot: 'insert',
      instanceId: 'session-plugin-1',
      order: 0,
      accepts: ['audio'],
      emits: ['audio'],
      automation: [],
      ...overrides,
    }) as TestPluginNode;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves descriptors using explicit metadata identifiers', async () => {
    const descriptor = createDescriptor({
      identifier: 'com.daftcitadel.galaxy',
      name: 'Galaxy Verb',
    });
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => [descriptor]);
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const node = createPluginNode({
      metadata: { descriptorId: descriptor.identifier },
      label: 'Galaxy Verb',
      instanceId: 'session-plugin-verb',
    });

    await expect(resolver(node.instanceId, node)).resolves.toBe(descriptor);
    expect(listAvailablePlugins).toHaveBeenCalledTimes(1);
  });

  it('falls back to matching by label and format', async () => {
    const descriptors: PluginDescriptor[] = [
      createDescriptor({
        identifier: 'com.daftcitadel.echo',
        name: 'Echo Chamber',
        format: 'auv3',
      }),
      createDescriptor({
        identifier: 'com.daftcitadel.reverb',
        name: 'Space Verb',
        format: 'vst3',
      }),
    ];
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => descriptors);
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const node = createPluginNode({
      metadata: { format: 'vst3' },
      label: 'Space Verb',
      instanceId: 'session-plugin-space-verb',
    });

    await expect(resolver(node.instanceId, node)).resolves.toEqual(descriptors[1]);
  });

  it('matches descriptors by instance identifier fragments and caches results', async () => {
    const descriptor = createDescriptor({
      identifier: 'com.daftcitadel.shaper',
      name: 'Spectral Shaper',
    });
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => [descriptor]);
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const node = createPluginNode({
      instanceId: 'session-instance-com.daftcitadel.shaper-001',
      label: 'Spectral Shaper',
    });

    await expect(resolver(node.instanceId, node)).resolves.toBe(descriptor);
    await expect(resolver(node.instanceId, node)).resolves.toBe(descriptor);
    expect(listAvailablePlugins).toHaveBeenCalledTimes(1);
  });

  it('refreshes cached descriptors when metadata targets a different identifier', async () => {
    const descriptorA = createDescriptor({
      identifier: 'com.daftcitadel.echo',
      name: 'Echo Chamber',
      format: 'auv3',
    });
    const descriptorB = createDescriptor({
      identifier: 'com.daftcitadel.echo.v2',
      name: 'Echo Chamber MkII',
      format: 'vst3',
    });
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => [
      descriptorA,
      descriptorB,
    ]);
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const instanceId = 'session-plugin-echo';
    const initialNode = createPluginNode({
      instanceId,
      metadata: {
        descriptorId: descriptorA.identifier,
        format: descriptorA.format,
      },
      label: 'Echo Chamber',
    });

    await expect(resolver(instanceId, initialNode)).resolves.toBe(descriptorA);

    const swappedNode = {
      ...initialNode,
      metadata: {
        descriptorId: descriptorB.identifier,
        format: descriptorB.format,
      },
      label: 'Echo Chamber MkII',
    } as TestPluginNode;

    await expect(resolver(instanceId, swappedNode)).resolves.toBe(descriptorB);
    expect(listAvailablePlugins).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached descriptors when metadata format changes without an identifier change', async () => {
    const identifier = 'com.daftcitadel.echo';
    const descriptorA = createDescriptor({
      identifier,
      name: 'Echo Chamber AUv3',
      format: 'auv3',
    });
    const descriptorB = createDescriptor({
      identifier,
      name: 'Echo Chamber VST3',
      format: 'vst3',
    });
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => [
      descriptorA,
      descriptorB,
    ]);
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const instanceId = 'session-plugin-echo';
    const initialNode = createPluginNode({
      instanceId,
      metadata: {
        descriptorId: descriptorA.identifier,
        format: descriptorA.format,
      },
      label: 'Echo Chamber',
    });

    await expect(resolver(instanceId, initialNode)).resolves.toBe(descriptorA);

    const updatedNode = {
      ...initialNode,
      metadata: {
        descriptorId: descriptorB.identifier,
        format: descriptorB.format,
      },
      label: 'Echo Chamber VST3',
    } as TestPluginNode;

    await expect(resolver(instanceId, updatedNode)).resolves.toBe(descriptorB);
    expect(listAvailablePlugins).toHaveBeenCalledTimes(1);
  });

  it('warns once when a descriptor cannot be resolved', async () => {
    const descriptors: PluginDescriptor[] = [
      createDescriptor({ identifier: 'com.daftcitadel.echo', name: 'Echo Chamber' }),
    ];
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => descriptors);
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const node = createPluginNode({
      instanceId: 'unmatched-instance',
      label: 'Unknown Plugin',
    });

    await expect(resolver(node.instanceId, node)).resolves.toBeUndefined();
    await expect(resolver(node.instanceId, node)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('No matching plugin descriptor found', {
      instanceId: 'unmatched-instance',
      label: 'Unknown Plugin',
      slot: 'insert',
    });
  });

  it('recovers after a catalog query failure', async () => {
    const descriptor = createDescriptor({
      identifier: 'com.daftcitadel.delay',
      name: 'Deep Delay',
    });
    const listAvailablePlugins: ListPluginsMock = jest.fn(async () => [descriptor]);
    listAvailablePlugins.mockRejectedValueOnce(new Error('offline'));
    const resolver = createPluginDescriptorResolver({
      listAvailablePlugins,
    } as unknown as PluginHost);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const node = createPluginNode({
      label: 'Deep Delay',
      instanceId: 'session-delay',
      metadata: { descriptorId: descriptor.identifier },
    });

    await expect(resolver(node.instanceId, node)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to query available plugins',
      expect.any(Error),
    );

    await expect(resolver(node.instanceId, node)).resolves.toBe(descriptor);
    expect(listAvailablePlugins).toHaveBeenCalledTimes(2);
  });
});
