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
  instanceId: string;
  descriptor: PluginDescriptor;
  sandboxPath?: string;
  cpuLoadPercent: number;
  latencySamples: number;
}

export interface PluginCrashReport {
  instanceId: string;
  descriptor: PluginDescriptor;
  timestamp: string;
  reason: string;
  recovered: boolean;
}
