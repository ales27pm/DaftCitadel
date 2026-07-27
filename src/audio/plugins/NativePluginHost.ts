import type { TurboModule } from 'react-native';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';
import type {
  PluginDescriptor,
  PluginInstanceHandle,
  PluginInstanceOptions,
  PluginPreset,
  PluginCrashReport,
} from './types';

export interface PluginAutomationPoint {
  time: number; // in milliseconds relative to transport
  value: number;
}

export interface PluginHostSpec extends TurboModule {
  queryAvailablePlugins(format?: string): Promise<PluginDescriptor[]>;
  instantiatePlugin(
    identifier: string,
    options: PluginInstanceOptions,
  ): Promise<PluginInstanceHandle>;
  releasePlugin(instanceId: string): Promise<void>;
  loadPreset(instanceId: string, preset: PluginPreset): Promise<void>;
  setParameterValue(
    instanceId: string,
    parameterId: string,
    value: number,
  ): Promise<void>;
  scheduleAutomation(
    instanceId: string,
    parameterId: string,
    curve: PluginAutomationPoint[],
  ): Promise<void>;
  ensureSandbox(identifier: string): Promise<{ sandboxPath: string }>;
  acknowledgeCrash(instanceId: string): Promise<void>;
}

export type PluginHostEvent = 'pluginCrashed' | 'sandboxPermissionRequired';

export interface PluginCrashEventPayload extends PluginCrashReport {
  restartToken?: string;
  sandboxIdentifier?: string;
  sandboxPath?: string;
}

export interface SandboxPermissionPayload {
  identifier: string;
  requiredEntitlements: string[];
  reason: string;
}

export type PluginHostEventPayloads = {
  pluginCrashed: PluginCrashEventPayload;
  sandboxPermissionRequired: SandboxPermissionPayload;
};

const moduleName = 'PluginHostModule';

const REQUIRED_PLUGIN_HOST_METHODS = [
  'queryAvailablePlugins',
  'instantiatePlugin',
  'releasePlugin',
  'loadPreset',
  'setParameterValue',
  'scheduleAutomation',
  'ensureSandbox',
  'acknowledgeCrash',
] as const satisfies ReadonlyArray<keyof PluginHostSpec>;

const hasNativePluginHostMethods = (candidate: unknown): candidate is PluginHostSpec => {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const module = candidate as Record<string, unknown>;
  return REQUIRED_PLUGIN_HOST_METHODS.every(
    (method) => typeof module[method] === 'function',
  );
};

const getTurboModuleSafely = (): PluginHostSpec | null => {
  try {
    return TurboModuleRegistry.get<PluginHostSpec>(moduleName);
  } catch (error) {
    console.warn(`${moduleName} TurboModule lookup failed`, error);
    return null;
  }
};

const getNativePluginHostModule = (): PluginHostSpec | null => {
  if (Platform.OS === 'web') {
    return null;
  }
  const bridgeModule = NativeModules[moduleName] as PluginHostSpec | undefined;
  return bridgeModule ?? getTurboModuleSafely();
};

const requireNativePluginHostModule = (): PluginHostSpec => {
  const module = getNativePluginHostModule();
  if (!hasNativePluginHostMethods(module)) {
    throw new Error(`${moduleName} is not available on this platform`);
  }
  return module;
};

export const NativePluginHost: PluginHostSpec = {
  queryAvailablePlugins(format?: string): Promise<PluginDescriptor[]> {
    return requireNativePluginHostModule().queryAvailablePlugins(format);
  },
  instantiatePlugin(
    identifier: string,
    options: PluginInstanceOptions,
  ): Promise<PluginInstanceHandle> {
    return requireNativePluginHostModule().instantiatePlugin(identifier, options);
  },
  releasePlugin(instanceId: string): Promise<void> {
    return requireNativePluginHostModule().releasePlugin(instanceId);
  },
  loadPreset(instanceId: string, preset: PluginPreset): Promise<void> {
    return requireNativePluginHostModule().loadPreset(instanceId, preset);
  },
  setParameterValue(
    instanceId: string,
    parameterId: string,
    value: number,
  ): Promise<void> {
    return requireNativePluginHostModule().setParameterValue(
      instanceId,
      parameterId,
      value,
    );
  },
  scheduleAutomation(
    instanceId: string,
    parameterId: string,
    curve: PluginAutomationPoint[],
  ): Promise<void> {
    return requireNativePluginHostModule().scheduleAutomation(
      instanceId,
      parameterId,
      curve,
    );
  },
  ensureSandbox(identifier: string): Promise<{ sandboxPath: string }> {
    return requireNativePluginHostModule().ensureSandbox(identifier);
  },
  acknowledgeCrash(instanceId: string): Promise<void> {
    return requireNativePluginHostModule().acknowledgeCrash(instanceId);
  },
} as PluginHostSpec;

export const isPluginHostAvailable = (): boolean => {
  const module = getNativePluginHostModule() as
    (PluginHostSpec & { runtimeReady?: boolean }) | null;
  return module?.runtimeReady === true && hasNativePluginHostMethods(module);
};
