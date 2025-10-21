const noop = async () => {};

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

const audioEngineModule = {
  initialize: noop,
  shutdown: noop,
  addNode: noop,
  removeNode: noop,
  connectNodes: noop,
  disconnectNodes: noop,
  scheduleParameterAutomation: noop,
  getRenderDiagnostics: async () => ({ xruns: 0, lastRenderDurationMicros: 0 }),
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
