const noop = async () => {};

const mockModule = {
  initialize: noop,
  shutdown: noop,
  addNode: noop,
  removeNode: noop,
  connectNodes: noop,
  disconnectNodes: noop,
  scheduleParameterAutomation: noop,
  getRenderDiagnostics: async () => ({ xruns: 0, lastRenderDurationMicros: 0 }),
};

export const NativeModules: Record<string, unknown> = {
  AudioEngineModule: mockModule,
};

export const TurboModuleRegistry = {
  getEnforcing: <T>(_name: string): T => mockModule as unknown as T,
};

export type TurboModule = unknown;
