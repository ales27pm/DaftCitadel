const noop = async () => {};

export const View = 'View';
export const ScrollView = 'ScrollView';
export const SafeAreaView = 'SafeAreaView';
export const Text = 'Text';
export const Pressable = 'Pressable';
export const TouchableOpacity = 'TouchableOpacity';
export const FlatList = 'FlatList';
export const SectionList = 'SectionList';

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
};

export const useColorScheme = (): 'light' | 'dark' => 'dark';

export const useWindowDimensions = () => ({
  width: 1280,
  height: 832,
  scale: 2,
  fontScale: 2,
});

type AccessibilityListener = (enabled: boolean) => void;

const reduceMotionListeners = new Set<AccessibilityListener>();
const screenReaderListeners = new Set<AccessibilityListener>();

let reduceMotionEnabled = false;
let screenReaderEnabled = false;

const isArrayBufferLike = (value: unknown): value is ArrayBuffer => {
  return (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  );
};

const createSubscription = (
  set: Set<AccessibilityListener>,
  listener: AccessibilityListener,
) => {
  set.add(listener);
  return {
    remove: () => {
      set.delete(listener);
    },
  };
};

export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => reduceMotionEnabled,
  isScreenReaderEnabled: async () => screenReaderEnabled,
  addEventListener: (
    event: 'reduceMotionChanged' | 'screenReaderChanged',
    listener: AccessibilityListener,
  ) => {
    if (event === 'reduceMotionChanged') {
      return createSubscription(reduceMotionListeners, listener);
    }
    return createSubscription(screenReaderListeners, listener);
  },
  __setReduceMotionEnabled(value: boolean) {
    reduceMotionEnabled = value;
    reduceMotionListeners.forEach((listener) => listener(value));
  },
  __setScreenReaderEnabled(value: boolean) {
    screenReaderEnabled = value;
    screenReaderListeners.forEach((listener) => listener(value));
  },
};

class MockNativeEventEmitter {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  addListener(
    eventName: string,
    listener: (...args: unknown[]) => void,
  ): { remove: () => void } {
    const existing = this.listeners.get(eventName) ?? new Set();
    existing.add(listener);
    this.listeners.set(eventName, existing);
    return {
      remove: () => existing.delete(listener),
    };
  }

  emit(eventName: string, payload?: unknown): void {
    const listeners = this.listeners.get(eventName);
    if (!listeners) {
      return;
    }
    listeners.forEach((listener) => listener(payload));
  }

  removeAllListeners(eventName: string): void {
    this.listeners.delete(eventName);
  }

  listenerCount(eventName: string): number {
    const listeners = this.listeners.get(eventName);
    return listeners ? listeners.size : 0;
  }
}

type AudioEngineNode = {
  type: string;
  options: Record<string, number | string | boolean>;
};

type AutomationPoint = { frame: number; value: number };

type AudioEngineMockState = {
  initialized: boolean;
  sampleRate: number;
  framesPerBuffer: number;
  nodes: Map<string, AudioEngineNode>;
  connections: Set<string>;
  diagnostics: {
    xruns: number;
    lastRenderDurationMicros: number;
    clipBufferBytes: number;
  };
  automations: Map<string, Map<string, AutomationPoint[]>>;
  clipBuffers: Map<
    string,
    {
      sampleRate: number;
      channels: number;
      frames: number;
      channelData: Float32Array[];
      byteLength: number;
    }
  >;
  transport: {
    frame: number;
    startFrame: number;
    isPlaying: boolean;
    lastUpdatedMs: number;
  };
};

const audioEngineState: AudioEngineMockState = {
  initialized: false,
  sampleRate: 0,
  framesPerBuffer: 0,
  nodes: new Map(),
  connections: new Set(),
  diagnostics: { xruns: 0, lastRenderDurationMicros: 0, clipBufferBytes: 0 },
  automations: new Map(),
  clipBuffers: new Map(),
  transport: {
    frame: 0,
    startFrame: 0,
    isPlaying: false,
    lastUpdatedMs: Date.now(),
  },
};

const recomputeClipBufferBytes = () => {
  let total = 0;
  audioEngineState.clipBuffers.forEach((entry) => {
    total += entry.byteLength;
  });
  audioEngineState.diagnostics.clipBufferBytes = total;
};

export const connectionKey = (source: string, destination: string) =>
  `${source}->${destination}`;

export const OUTPUT_BUS_ID = '__output__';

const computeTransportFrame = (now: number): number => {
  if (!audioEngineState.transport.isPlaying) {
    return audioEngineState.transport.frame;
  }
  const elapsedMs = now - audioEngineState.transport.lastUpdatedMs;
  if (elapsedMs <= 0 || audioEngineState.sampleRate <= 0) {
    return audioEngineState.transport.startFrame;
  }
  const framesAdvanced = Math.floor(
    (elapsedMs / 1000) * audioEngineState.sampleRate,
  );
  return audioEngineState.transport.startFrame + framesAdvanced;
};

const audioEngineModule = {
  initialize: async (sampleRate: number, framesPerBuffer: number) => {
    audioEngineState.initialized = true;
    audioEngineState.sampleRate = sampleRate;
    audioEngineState.framesPerBuffer = framesPerBuffer;
    audioEngineState.diagnostics.xruns = 0;
    audioEngineState.diagnostics.lastRenderDurationMicros = 0;
    audioEngineState.diagnostics.clipBufferBytes = 0;
    audioEngineState.transport.frame = 0;
    audioEngineState.transport.startFrame = 0;
    audioEngineState.transport.isPlaying = false;
    audioEngineState.transport.lastUpdatedMs = Date.now();
  },
  shutdown: async () => {
    audioEngineState.initialized = false;
    audioEngineState.nodes.clear();
    audioEngineState.connections.clear();
    audioEngineState.automations.clear();
    audioEngineState.diagnostics.xruns = 0;
    audioEngineState.diagnostics.lastRenderDurationMicros = 0;
    audioEngineState.diagnostics.clipBufferBytes = 0;
    audioEngineState.clipBuffers.clear();
    audioEngineState.transport.frame = 0;
    audioEngineState.transport.startFrame = 0;
    audioEngineState.transport.isPlaying = false;
    audioEngineState.transport.lastUpdatedMs = Date.now();
  },
  addNode: async (
    nodeId: string,
    nodeType: string,
    options: Record<string, number | string | boolean>,
  ) => {
    const trimmedId = nodeId.trim();
    const trimmedType = nodeType.trim();
    if (!trimmedId || !trimmedType) {
      throw new Error('nodeId and nodeType are required');
    }
    if (audioEngineState.nodes.has(trimmedId)) {
      throw new Error(`Node '${trimmedId}' already exists`);
    }
    audioEngineState.nodes.set(trimmedId, {
      type: trimmedType,
      options: { ...options },
    });
  },
  registerClipBuffer: async (
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: Array<ArrayBuffer | ArrayBufferView>,
  ) => {
    const key = bufferKey.trim();
    if (!key) {
      throw new Error('bufferKey is required');
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('sampleRate must be a positive number');
    }
    if (!Number.isInteger(channels) || channels <= 0) {
      throw new Error('channels must be a positive integer');
    }
    if (!Number.isInteger(frames) || frames <= 0) {
      throw new Error('frames must be a positive integer');
    }
    if (channelData.length !== channels) {
      throw new Error('channelData length must equal channels');
    }
    const floatChannels = channelData.map((payload, index) => {
      let source: ArrayBuffer;
      if (isArrayBufferLike(payload)) {
        source = payload;
      } else if (ArrayBuffer.isView(payload)) {
        const view = payload as ArrayBufferView;
        source = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      } else {
        throw new Error(
          `channelData[${index}] must be an ArrayBuffer or ArrayBufferView`,
        );
      }
      const view = new Float32Array(source);
      if (view.length < frames) {
        throw new Error(`channelData[${index}] is shorter than expected`);
      }
      return new Float32Array(view.slice(0, frames));
    });
    const byteLength = frames * channels * Float32Array.BYTES_PER_ELEMENT;
    audioEngineState.clipBuffers.set(key, {
      sampleRate,
      channels,
      frames,
      channelData: floatChannels,
      byteLength,
    });
    recomputeClipBufferBytes();
  },
  unregisterClipBuffer: async (bufferKey: string) => {
    const key = bufferKey.trim();
    if (!key) {
      throw new Error('bufferKey is required');
    }
    if (!audioEngineState.clipBuffers.has(key)) {
      return;
    }
    audioEngineState.clipBuffers.delete(key);
    recomputeClipBufferBytes();
  },
  removeNode: async (nodeId: string) => {
    const trimmedId = nodeId.trim();
    audioEngineState.nodes.delete(trimmedId);
    Array.from(audioEngineState.connections).forEach((key) => {
      if (key.startsWith(`${trimmedId}->`) || key.endsWith(`->${trimmedId}`)) {
        audioEngineState.connections.delete(key);
      }
    });
    audioEngineState.automations.delete(trimmedId);
  },
  connectNodes: async (source: string, destination: string) => {
    const trimmedSource = source.trim();
    const trimmedDestination = destination.trim();
    if (!trimmedSource || !trimmedDestination) {
      throw new Error('source and destination are required');
    }
    if (!audioEngineState.nodes.has(trimmedSource)) {
      throw new Error(`Source node '${trimmedSource}' is not registered`);
    }
    if (
      trimmedDestination !== OUTPUT_BUS_ID &&
      !audioEngineState.nodes.has(trimmedDestination)
    ) {
      throw new Error(`Destination node '${trimmedDestination}' is not registered`);
    }
    const key = connectionKey(trimmedSource, trimmedDestination);
    if (audioEngineState.connections.has(key)) {
      throw new Error(`Connection '${key}' already exists`);
    }
    audioEngineState.connections.add(key);
  },
  disconnectNodes: async (source: string, destination: string) => {
    audioEngineState.connections.delete(connectionKey(source.trim(), destination.trim()));
  },
  startTransport: async () => {
    const now = Date.now();
    audioEngineState.transport.frame = computeTransportFrame(now);
    audioEngineState.transport.startFrame = audioEngineState.transport.frame;
    audioEngineState.transport.isPlaying = true;
    audioEngineState.transport.lastUpdatedMs = now;
  },
  stopTransport: async () => {
    const now = Date.now();
    audioEngineState.transport.frame = computeTransportFrame(now);
    audioEngineState.transport.startFrame = audioEngineState.transport.frame;
    audioEngineState.transport.isPlaying = false;
    audioEngineState.transport.lastUpdatedMs = now;
  },
  locateTransport: async (frame: number) => {
    const sanitized = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
    audioEngineState.transport.frame = sanitized;
    audioEngineState.transport.startFrame = sanitized;
    audioEngineState.transport.lastUpdatedMs = Date.now();
  },
  getTransportState: async () => {
    const now = Date.now();
    const currentFrame = computeTransportFrame(now);
    audioEngineState.transport.frame = currentFrame;
    audioEngineState.transport.lastUpdatedMs = now;
    return {
      currentFrame,
      isPlaying: audioEngineState.transport.isPlaying,
    };
  },
  scheduleParameterAutomation: async (
    nodeId: string,
    parameter: string,
    frame: number,
    value: number,
  ) => {
    const trimmedId = nodeId.trim();
    const trimmedParam = parameter.trim().toLowerCase();
    if (!audioEngineState.nodes.has(trimmedId)) {
      throw new Error(`Node '${trimmedId}' is not registered`);
    }
    if (!trimmedParam) {
      throw new Error('Parameter name is required');
    }
    if (!Number.isFinite(frame) || frame < 0 || !Number.isInteger(frame)) {
      throw new Error('Frame must be a non-negative integer');
    }
    if (!Number.isFinite(value)) {
      throw new Error('Value must be finite');
    }
    let parameterMap = audioEngineState.automations.get(trimmedId);
    if (!parameterMap) {
      parameterMap = new Map<string, AutomationPoint[]>();
      audioEngineState.automations.set(trimmedId, parameterMap);
    }
    const points: AutomationPoint[] = parameterMap.get(trimmedParam) ?? [];
    const nextPoints: AutomationPoint[] = points.filter((point) => point.frame !== frame);
    nextPoints.push({ frame, value });
    nextPoints.sort((lhs, rhs) => lhs.frame - rhs.frame);
    parameterMap.set(trimmedParam, nextPoints);
  },
  getRenderDiagnostics: async () => ({
    xruns: audioEngineState.diagnostics.xruns,
    lastRenderDurationMicros: audioEngineState.diagnostics.lastRenderDurationMicros,
    clipBufferBytes: audioEngineState.diagnostics.clipBufferBytes,
  }),
  __state: audioEngineState,
};

const pluginHostEmitter = new MockNativeEventEmitter();

const pluginHostModule = {
  queryAvailablePlugins: async () => [],
  instantiatePlugin: async () => ({
    instanceId: 'mock-instance',
    descriptor: {
      identifier: 'mock',
      name: 'Mock',
      format: 'auv3',
      manufacturer: 'Mock Inc',
      version: '1.0.0',
      supportsSandbox: true,
      audioInputChannels: 2,
      audioOutputChannels: 2,
      midiInput: true,
      midiOutput: true,
      parameters: [],
    },
    cpuLoadPercent: 0,
    latencySamples: 0,
  }),
  releasePlugin: noop,
  loadPreset: noop,
  setParameterValue: noop,
  scheduleAutomation: noop,
  ensureSandbox: async () => ({ sandboxPath: '/mock' }),
  acknowledgeCrash: noop,
  __emitter: pluginHostEmitter,
};

const collabDiagnosticsEmitter = new MockNativeEventEmitter();

const collabNetworkDiagnosticsModule = {
  getCurrentLinkMetrics: async () => ({
    interface: 'en0',
    rssi: -58,
    noise: -95,
    linkSpeedMbps: 420,
  }),
  startObserving: () => {},
  stopObserving: () => {},
  __emitter: collabDiagnosticsEmitter,
};

const audioSampleLoaderModule = {
  decode: async (filePath: string) => {
    const channels = filePath.includes('mono') ? 1 : 2;
    const frames = 48000;
    const sampleRate = 48000;
    const channelData = Array.from({ length: channels }, (_, channelIndex) => {
      const waveform = Float32Array.from({ length: frames }, (_, frameIndex) =>
        Math.sin((frameIndex + channelIndex) / 64),
      );
      return Array.from(waveform);
    });
    return { sampleRate, channels, frames, channelData };
  },
};

export const NativeModules: Record<string, unknown> = {
  AudioEngineModule: audioEngineModule,
  PluginHostModule: pluginHostModule,
  CollabNetworkDiagnostics: collabNetworkDiagnosticsModule,
  AudioSampleLoaderModule: audioSampleLoaderModule,
  DaftCitadelDirectories: {
    sessionDirectory: '/tmp/daft-citadel',
    getSessionDirectory: async () => '/tmp/daft-citadel',
    getDirectories: async () => ({ sessionDirectory: '/tmp/daft-citadel' }),
  },
};

export class NativeEventEmitter extends MockNativeEventEmitter {
  private readonly delegate?: MockNativeEventEmitter;

  constructor(module?: unknown) {
    super();
    if (module === pluginHostModule) {
      this.delegate = pluginHostEmitter;
    } else if (module === collabNetworkDiagnosticsModule) {
      this.delegate = collabDiagnosticsEmitter;
    }
  }

  override addListener(
    eventName: string,
    listener: (...args: unknown[]) => void,
  ): { remove: () => void } {
    if (this.delegate) {
      return this.delegate.addListener(eventName, listener);
    }
    return super.addListener(eventName, listener);
  }

  override emit(eventName: string, payload?: unknown): void {
    if (this.delegate) {
      this.delegate.emit(eventName, payload);
      return;
    }
    super.emit(eventName, payload);
  }

  override removeAllListeners(eventName: string): void {
    if (this.delegate) {
      this.delegate.removeAllListeners(eventName);
      return;
    }
    super.removeAllListeners(eventName);
  }

  override listenerCount(eventName: string): number {
    if (this.delegate) {
      return this.delegate.listenerCount(eventName);
    }
    return super.listenerCount(eventName);
  }
}

export const TurboModuleRegistry = {
  getEnforcing: <T>(name: string): T => NativeModules[name] as T,
};

export const Platform = {
  OS: 'ios',
  Version: 17,
};

export const PermissionsAndroid = {
  PERMISSIONS: {
    WRITE_EXTERNAL_STORAGE: 'android.permission.WRITE_EXTERNAL_STORAGE',
  },
  RESULTS: {
    GRANTED: 'granted',
    DENIED: 'denied',
  },
  check: async () => true,
  request: async () => 'granted',
};

export type TurboModule = unknown;

export const __mockPluginHostEmitter = pluginHostEmitter;
export const __mockCollabDiagnosticsEmitter = collabDiagnosticsEmitter;
export const __mockAudioEngineState = audioEngineState;
