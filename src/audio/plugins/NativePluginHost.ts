import type { TurboModule } from 'react-native';
import { NativeModules, TurboModuleRegistry } from 'react-native';
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
  /**
   * Native hosts must set this only after their render callback is connected to
   * the audio engine. Merely linking the discovery/control bridge is not enough.
   */
  readonly runtimeReady?: boolean;
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

type TurboModuleLookup = {
  get?<T extends TurboModule>(name: string): T | null;
};

const resolveNativePluginHost = (): PluginHostSpec | undefined => {
  const registry = TurboModuleRegistry as unknown as TurboModuleLookup | undefined;
  const turboModule = registry?.get?.<PluginHostSpec>(moduleName);
  if (turboModule) {
    return turboModule;
  }

  return (NativeModules as Record<string, unknown> | undefined)?.[moduleName] as
    | PluginHostSpec
    | undefined;
};

const unavailablePluginHost = new Proxy({} as PluginHostSpec, {
  get: (_target, property) => {
    if (typeof property === 'symbol') {
      return undefined;
    }

    return async () => {
      throw new Error(
        `${moduleName}.${property} is unavailable. Use a native development build that includes the plugin host.`,
      );
    };
  },
});

export const NativePluginHost: PluginHostSpec =
  resolveNativePluginHost() ?? unavailablePluginHost;

export const isPluginHostAvailable = (): boolean => {
  return resolveNativePluginHost()?.runtimeReady === true;
};
