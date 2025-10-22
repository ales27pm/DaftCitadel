import { NativeModules, Platform } from 'react-native';

import type { Session } from '../../session/models';
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
  const bridge = new SessionAudioBridge(audioEngine, {
    fileLoader,
    pluginHost: pluginHost ?? undefined,
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

export { PassiveAudioEngineBridge };
