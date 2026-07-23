// React 19 uses this flag to verify that renderer updates are wrapped in act().
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export {};
