import type { AutomationCurveID } from '../../session/models';

export type PluginFormat = 'auv3' | 'vst3';

export interface PluginParameterDescriptor {
  id: string;
  name: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  unit?: string;
  automationRate: 'audio' | 'control';
}

export interface PluginPreset {
  id: string;
  name: string;
  data: string; // base64 encoded preset blob
  format: 'base64';
}

export interface PluginDescriptor {
  identifier: string;
  name: string;
  format: PluginFormat;
  manufacturer: string;
  version: string;
  supportsSandbox: boolean;
  audioInputChannels: number;
  audioOutputChannels: number;
  midiInput: boolean;
  midiOutput: boolean;
  parameters: PluginParameterDescriptor[];
  factoryPresets?: PluginPreset[];
}

export interface PluginAutomationBinding {
  parameterId: string;
  curveId: AutomationCurveID;
}

export interface PluginInstanceOptions {
  initialPresetId?: string;
  sandboxIdentifier?: string;
  automationBindings?: PluginAutomationBinding[];
  cpuBudgetPercent?: number;
}

export interface PluginInstanceHandle {
  /**
   * Logical instance identifier used by JavaScript callers when
   * addressing plugin instances through the host facade. This value
   * remains stable across crash recoveries so routing graphs retain
   * their bindings.
   */
  instanceId: string;
  descriptor: PluginDescriptor;
  sandboxPath?: string;
  cpuLoadPercent: number;
  latencySamples: number;
  /**
   * Native instance identifier produced by the underlying host. On
   * some platforms this differs from {@link instanceId} after a crash
   * recovery; keeping it explicit allows the audio engine bridge to
   * re-bind render callbacks without mutating session state.
   */
  nativeInstanceId?: string;
  /**
   * Restart token supplied by the native host. Crash recovery requires
   * callers to echo this token back so the platform can guarantee the
   * previous process acknowledged the failure.
   */
  restartToken?: string;
}

export interface PluginCrashReport {
  instanceId: string;
  descriptor: PluginDescriptor;
  timestamp: string;
  reason: string;
  recovered: boolean;
}
