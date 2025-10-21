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

const createSubscription = (set: Set<AccessibilityListener>, listener: AccessibilityListener) => {
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
  diagnostics: { xruns: number; lastRenderDurationMicros: number };
  automations: Map<string, Map<string, AutomationPoint[]>>;
};

const audioEngineState: AudioEngineMockState = {
  initialized: false,
  sampleRate: 0,
  framesPerBuffer: 0,
  nodes: new Map(),
  connections: new Set(),
  diagnostics: { xruns: 0, lastRenderDurationMicros: 0 },
  automations: new Map(),
};

export const connectionKey = (source: string, destination: string) =>
  `${source}->${destination}`;

export const OUTPUT_BUS_ID = '__output__';

const audioEngineModule = {
  initialize: async (sampleRate: number, framesPerBuffer: number) => {
    audioEngineState.initialized = true;
    audioEngineState.sampleRate = sampleRate;
    audioEngineState.framesPerBuffer = framesPerBuffer;
    audioEngineState.diagnostics.xruns = 0;
    audioEngineState.diagnostics.lastRenderDurationMicros = 0;
  },
  shutdown: async () => {
    audioEngineState.initialized = false;
    audioEngineState.nodes.clear();
    audioEngineState.connections.clear();
    audioEngineState.automations.clear();
    audioEngineState.diagnostics.xruns = 0;
    audioEngineState.diagnostics.lastRenderDurationMicros = 0;
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

export const NativeModules: Record<string, unknown> = {
  AudioEngineModule: audioEngineModule,
  PluginHostModule: pluginHostModule,
  CollabNetworkDiagnostics: collabNetworkDiagnosticsModule,
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
