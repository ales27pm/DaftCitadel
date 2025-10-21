export const NativeModules: Record<string, unknown> = {
  AudioEngineModule: {},
};

const noop = async () => {};

const mockModule = {
  initialize: noop,
  shutdown: noop,
  createSceneGraph: noop,
  destroySceneGraph: noop,
  addNode: noop,
  connectNodes: noop,
  disconnectNodes: noop,
  start: noop,
  stop: noop,
  setTransportState: noop,
  setTempo: noop,
  scheduleAutomation: noop,
  cancelAutomation: noop,
  getRenderDiagnostics: async () => ({ xruns: 0, lastRenderDurationMicros: 0 }),
};

NativeModules.AudioEngineModule = mockModule;

export const TurboModuleRegistry = {
  getEnforcing: <T>(_name: string): T => mockModule as unknown as T,
};

export type TurboModule = unknown;
