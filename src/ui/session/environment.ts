import { NativeModules, Platform } from 'react-native';

import type { PluginRoutingNode, Session } from '../../session/models';
import { demoSession, DEMO_SESSION_ID } from '../../session/fixtures/demoSession';
import { InMemorySessionStorageAdapter } from '../../session/storage/memoryAdapter';
import type { SessionStorageAdapter } from '../../session/storage';
import { SessionManager } from '../../session/sessionManager';
import type { AudioEngineBridge } from '../../session/sessionManager';
import {
  AudioEngine,
  NativeAudioFileLoader,
  PluginHost,
  SessionAudioBridge,
  isNativeModuleAvailable,
  isNativeAudioFileLoaderAvailable,
  isPluginHostAvailable,
  type AudioFileLoader,
  type PluginDescriptor,
  type PluginFormat,
  type SessionAudioBridgeOptions,
} from '../../audio';
import { createSessionStorageAdapter } from './storageAdapter';

class PassiveAudioEngineBridge implements AudioEngineBridge {
  private lastSession: Session | null = null;

  async applySessionUpdate(session: Session): Promise<void> {
    this.lastSession = session;
  }

  getSnapshot(): Session | null {
    return this.lastSession;
  }
}

export class NativeAudioUnavailableError extends Error {}

export interface SessionEnvironment {
  manager: SessionManager;
  audioBridge: AudioEngineBridge;
  sessionId: string;
  pluginHost?: PluginHost;
  dispose?: () => Promise<void> | void;
}

interface ProductionEnvironmentOptions {
  sessionId?: string;
  storageDirectory?: string;
  sampleRate?: number;
  framesPerBuffer?: number;
  bpm?: number;
  fileLoader?: AudioFileLoader;
}

interface PassiveEnvironmentOptions {
  sessionId?: string;
  storageDirectory?: string;
}

const DEFAULT_SAMPLE_RATE = demoSession.metadata.sampleRate;
const DEFAULT_FRAMES_PER_BUFFER = 256;
const DEFAULT_BPM = demoSession.metadata.bpm;

export const createDemoSessionEnvironment = async (): Promise<SessionEnvironment> => {
  const storage = new InMemorySessionStorageAdapter();
  await storage.initialize();
  const audioBridge = new PassiveAudioEngineBridge();
  const manager = new SessionManager(storage, audioBridge);
  await manager.createSession(cloneDemoSession(DEMO_SESSION_ID));
  return { manager, audioBridge, sessionId: DEMO_SESSION_ID };
};

export const createPassiveSessionEnvironment = async (
  options: PassiveEnvironmentOptions = {},
): Promise<SessionEnvironment> => {
  const sessionId = options.sessionId ?? DEMO_SESSION_ID;
  const storage = createSessionStorageAdapter(
    resolveStorageDirectory(options.storageDirectory),
  );
  await storage.initialize();
  const audioBridge = new PassiveAudioEngineBridge();
  const manager = new SessionManager(storage, audioBridge);
  await bootstrapSessionIfNeeded(manager, storage, sessionId);
  return { manager, audioBridge, sessionId };
};

export const createProductionSessionEnvironment = async (
  options: ProductionEnvironmentOptions = {},
): Promise<SessionEnvironment> => {
  if (!isNativeModuleAvailable()) {
    throw new NativeAudioUnavailableError('AudioEngine native module is unavailable');
  }
  if (!isNativeAudioFileLoaderAvailable()) {
    throw new Error('Audio sample loader native module is unavailable');
  }

  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const framesPerBuffer = options.framesPerBuffer ?? DEFAULT_FRAMES_PER_BUFFER;
  const bpm = options.bpm ?? DEFAULT_BPM;
  const sessionId = options.sessionId ?? DEMO_SESSION_ID;

  const audioEngine = new AudioEngine({ sampleRate, framesPerBuffer, bpm });
  await audioEngine.init();
  const fileLoader = options.fileLoader ?? new NativeAudioFileLoader();
  const pluginHost = instantiatePluginHost();
  const resolvePluginDescriptor = pluginHost
    ? createPluginDescriptorResolver(pluginHost)
    : undefined;
  const bridge = new SessionAudioBridge(audioEngine, {
    fileLoader,
    pluginHost: pluginHost ?? undefined,
    resolvePluginDescriptor,
  });
  const storage = createSessionStorageAdapter(
    resolveStorageDirectory(options.storageDirectory),
  );
  await storage.initialize();
  const manager = new SessionManager(storage, bridge);
  await bootstrapSessionIfNeeded(manager, storage, sessionId);

  const dispose = async () => {
    try {
      pluginHost?.dispose();
    } catch (error) {
      console.error('Failed to dispose plugin host', error);
    }
    try {
      await audioEngine.dispose();
    } catch (error) {
      console.error('Failed to dispose audio engine', error);
    }
  };

  return {
    manager,
    audioBridge: bridge,
    sessionId,
    pluginHost: pluginHost ?? undefined,
    dispose,
  };
};

const bootstrapSessionIfNeeded = async (
  manager: SessionManager,
  storage: SessionStorageAdapter,
  sessionId: string,
) => {
  const existing = await storage.read(sessionId);
  if (existing) {
    await manager.loadSession(sessionId);
    return;
  }
  const seed = cloneDemoSession(sessionId);
  await manager.createSession(seed);
};

const cloneDemoSession = (sessionId: string): Session => {
  const cloned = JSON.parse(JSON.stringify(demoSession)) as Session;
  return sessionId === cloned.id ? cloned : { ...cloned, id: sessionId };
};

const resolveStorageDirectory = (override?: string): string => {
  if (override) {
    return override;
  }
  const envOverride =
    (typeof process !== 'undefined' && process.env?.DAFT_CITADEL_SESSION_DIR) ||
    undefined;
  if (envOverride) {
    return envOverride;
  }
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    const directoryModule = NativeModules.DaftCitadelDirectories as
      | { sessionDirectory?: string }
      | undefined;
    const baseDirectory =
      directoryModule?.sessionDirectory ??
      `${Platform.OS === 'ios' ? '/tmp' : '/data/local/tmp'}/daft-citadel`;
    return joinPath(baseDirectory, 'sessions');
  }
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    return joinPath(process.cwd(), 'var', 'sessions');
  }
  return 'sessions';
};

const joinPath = (...segments: Array<string | undefined>): string => {
  const parts = segments
    .filter((segment): segment is string => Boolean(segment && segment.length > 0))
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    return '';
  }
  const hasRoot = segments.some((segment) => segment?.startsWith('/'));
  const joined = parts.join('/');
  return hasRoot ? `/${joined}` : joined;
};

const instantiatePluginHost = (): PluginHost | null => {
  if (!isPluginHostAvailable()) {
    return null;
  }
  try {
    const host = new PluginHost();
    host.onCrash((report) => {
      console.error('Plugin crash detected', report);
    });
    return host;
  } catch (error) {
    console.error('Failed to instantiate PluginHost', error);
    return null;
  }
};

type PluginDescriptorResolver = NonNullable<
  SessionAudioBridgeOptions['resolvePluginDescriptor']
>;

type PluginNodeMetadata = {
  descriptorId?: string;
  identifier?: string;
  pluginIdentifier?: string;
  pluginName?: string;
  name?: string;
  manufacturer?: string;
  format?: PluginFormat;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asPluginFormat = (value: unknown): PluginFormat | undefined => {
  if (value === 'auv3' || value === 'vst3') {
    return value;
  }
  return undefined;
};

const extractMetadata = (node: PluginRoutingNode): PluginNodeMetadata => {
  const baseRecord = node as PluginRoutingNode & {
    descriptorId?: unknown;
    metadata?: unknown;
  };

  const metadataRecord = isRecord(baseRecord.metadata)
    ? (baseRecord.metadata as Record<string, unknown>)
    : undefined;

  const descriptorId =
    asString(baseRecord.descriptorId) ||
    asString(metadataRecord?.descriptorId) ||
    asString(metadataRecord?.identifier) ||
    asString(metadataRecord?.pluginIdentifier);

  return {
    descriptorId,
    identifier: asString(metadataRecord?.identifier),
    pluginIdentifier: asString(metadataRecord?.pluginIdentifier),
    pluginName: asString(metadataRecord?.pluginName) || asString(metadataRecord?.name),
    name: asString(metadataRecord?.name),
    manufacturer: asString(metadataRecord?.manufacturer),
    format: asPluginFormat(metadataRecord?.format),
  };
};

const normalize = (value: string | undefined): string | undefined =>
  value ? value.trim().toLowerCase() : undefined;

function createPluginDescriptorResolver(
  pluginHost: Pick<PluginHost, 'listAvailablePlugins'>,
): PluginDescriptorResolver {
  let catalogPromise: Promise<PluginDescriptor[]> | null = null;
  const descriptorCache = new Map<string, PluginDescriptor>();
  const instanceCache = new Map<string, PluginDescriptor>();
  const slotAssociations = new Map<string, PluginDescriptor>();
  const warnedMissing = new Set<string>();
  let catalogFailureLogged = false;

  const registerDescriptors = (descriptors: PluginDescriptor[]) => {
    descriptors.forEach((descriptor) => {
      descriptorCache.set(descriptor.identifier, descriptor);
    });
  };

  const ensureCatalog = async (): Promise<PluginDescriptor[]> => {
    if (!catalogPromise) {
      catalogPromise = pluginHost
        .listAvailablePlugins()
        .then((descriptors) => {
          registerDescriptors(descriptors);
          return descriptors;
        })
        .catch((error) => {
          catalogPromise = null;
          if (!catalogFailureLogged) {
            catalogFailureLogged = true;
            console.error('Failed to query available plugins', error);
          }
          throw error;
        });
    }
    return catalogPromise;
  };

  const matchByIdentifier = (
    descriptors: PluginDescriptor[],
    identifiers: Array<string | undefined>,
  ): PluginDescriptor | undefined => {
    for (const identifier of identifiers) {
      if (!identifier) {
        continue;
      }
      const descriptor =
        descriptorCache.get(identifier) ||
        descriptors.find((candidate) => candidate.identifier === identifier);
      if (descriptor) {
        return descriptor;
      }
    }
    return undefined;
  };

  const matchByName = (
    descriptors: PluginDescriptor[],
    names: Array<string | undefined>,
    manufacturer?: string,
  ): PluginDescriptor | undefined => {
    const normalizedNames = names
      .map((name) => normalize(name))
      .filter((value): value is string => Boolean(value));
    if (normalizedNames.length === 0) {
      return undefined;
    }
    const normalizedManufacturer = normalize(manufacturer);
    return descriptors.find((descriptor) => {
      const descriptorName = normalize(descriptor.name);
      const descriptorIdentifier = normalize(descriptor.identifier);
      const manufacturerMatch =
        !normalizedManufacturer ||
        normalize(descriptor.manufacturer) === normalizedManufacturer ||
        normalize(descriptor.manufacturer)?.includes(normalizedManufacturer);
      if (!manufacturerMatch) {
        return false;
      }
      return normalizedNames.some(
        (name) =>
          descriptorName === name ||
          descriptorIdentifier === name ||
          descriptorName?.includes(name) ||
          descriptorIdentifier?.includes(name),
      );
    });
  };

  const matchByInstanceId = (
    descriptors: PluginDescriptor[],
    instanceId: string,
  ): PluginDescriptor | undefined => {
    const normalizedInstance = normalize(instanceId);
    if (!normalizedInstance) {
      return undefined;
    }
    return descriptors.find((descriptor) => {
      const identifier = normalize(descriptor.identifier);
      const name = normalize(descriptor.name);
      return (
        (identifier && normalizedInstance.includes(identifier)) ||
        (name && normalizedInstance.includes(name))
      );
    });
  };

  const filterByFormat = (
    descriptors: PluginDescriptor[],
    format?: PluginFormat,
  ): PluginDescriptor[] => {
    if (!format) {
      return descriptors;
    }
    const matches = descriptors.filter((descriptor) => descriptor.format === format);
    return matches.length > 0 ? matches : descriptors;
  };

  const cacheDescriptor = (
    instanceId: string,
    slot: string,
    descriptor: PluginDescriptor,
  ): PluginDescriptor => {
    descriptorCache.set(descriptor.identifier, descriptor);
    instanceCache.set(instanceId, descriptor);
    if (!slotAssociations.has(slot)) {
      slotAssociations.set(slot, descriptor);
    }
    return descriptor;
  };

  return async (instanceId, node) => {
    const cached = instanceCache.get(instanceId);
    if (cached) {
      return cached;
    }

    let descriptors: PluginDescriptor[];
    try {
      descriptors = await ensureCatalog();
    } catch (_error) {
      return undefined;
    }

    const metadata = extractMetadata(node);
    const descriptorsByFormat = filterByFormat(descriptors, metadata.format);

    const descriptor =
      matchByIdentifier(descriptorsByFormat, [
        metadata.descriptorId,
        metadata.pluginIdentifier,
        metadata.identifier,
      ]) ||
      matchByName(
        descriptorsByFormat,
        [metadata.pluginName, metadata.name, node.label],
        metadata.manufacturer,
      ) ||
      matchByInstanceId(descriptorsByFormat, instanceId) ||
      slotAssociations.get(node.slot);

    if (!descriptor) {
      if (!warnedMissing.has(instanceId)) {
        warnedMissing.add(instanceId);
        console.warn('No matching plugin descriptor found', {
          instanceId,
          label: node.label,
          slot: node.slot,
        });
      }
      return undefined;
    }

    warnedMissing.delete(instanceId);
    return cacheDescriptor(instanceId, node.slot, descriptor);
  };
}

export { PassiveAudioEngineBridge, createPluginDescriptorResolver };
