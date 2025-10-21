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

export const NativePluginHost: PluginHostSpec =
  TurboModuleRegistry.getEnforcing<PluginHostSpec>(moduleName);

export const isPluginHostAvailable = (): boolean => {
  return NativeModules[moduleName] != null;
};
