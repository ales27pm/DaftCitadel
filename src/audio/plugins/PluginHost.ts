import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  type NativeModule,
} from 'react-native';
import type {
  PluginCrashEventPayload,
  SandboxPermissionPayload,
  PluginAutomationPoint,
} from './NativePluginHost';
import { NativePluginHost, isPluginHostAvailable } from './NativePluginHost';
import {
  PluginDescriptor,
  PluginInstanceHandle,
  PluginInstanceOptions,
  PluginCrashReport,
} from './types';
import { PluginSandboxManager, SandboxContext } from './PluginSandbox';

export type CrashListener = (report: PluginCrashReport) => void;
export type SandboxPermissionListener = (payload: SandboxPermissionPayload) => void;

export type PluginAutomationEnvelope = PluginAutomationPoint;

export interface LoadPluginOptions extends PluginInstanceOptions {
  sandboxIdentifier?: string;
}

export class PluginHost {
  private readonly emitter: NativeEventEmitter;
  private readonly sandboxManager: PluginSandboxManager;
  private readonly crashListeners = new Set<CrashListener>();
  private readonly sandboxListeners = new Set<SandboxPermissionListener>();
  private readonly instances = new Map<string, PluginInstanceHandle>();
  private subscriptions: Array<{ remove: () => void }> = [];

  constructor(sandboxManager?: PluginSandboxManager) {
    if (!isPluginHostAvailable()) {
      throw new Error('PluginHostModule is not available on this platform');
    }
    this.sandboxManager = sandboxManager ?? new PluginSandboxManager();
    this.emitter = new NativeEventEmitter(NativeModules.PluginHostModule as NativeModule);
    this.subscribeToEvents();
  }

  async listAvailablePlugins(
    format?: PluginDescriptor['format'],
  ): Promise<PluginDescriptor[]> {
    const plugins = await NativePluginHost.queryAvailablePlugins(format);
    return plugins;
  }

  async loadPlugin(
    descriptor: PluginDescriptor,
    options: LoadPluginOptions = {},
  ): Promise<PluginInstanceHandle> {
    const sandboxContext = await this.prepareSandboxIfNeeded(descriptor, options);
    const handle = await NativePluginHost.instantiatePlugin(descriptor.identifier, {
      ...options,
      sandboxIdentifier: sandboxContext?.identifier ?? options.sandboxIdentifier,
    });
    if (sandboxContext) {
      this.sandboxManager.recordSandbox(sandboxContext);
    }
    this.instances.set(handle.instanceId, handle);
    return handle;
  }

  async releasePlugin(instanceId: string): Promise<void> {
    await NativePluginHost.releasePlugin(instanceId);
    this.instances.delete(instanceId);
  }

  async loadPreset(instanceId: string, presetId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Unknown plugin instance: ${instanceId}`);
    }
    const preset = instance.descriptor.factoryPresets?.find(
      (candidate) => candidate.id === presetId,
    );
    if (!preset) {
      throw new Error(
        `Preset ${presetId} not found for ${instance.descriptor.identifier}`,
      );
    }
    await NativePluginHost.loadPreset(instanceId, preset);
  }

  async automateParameter(
    instanceId: string,
    parameterId: string,
    envelope: PluginAutomationEnvelope[],
  ): Promise<void> {
    if (!this.instances.has(instanceId)) {
      throw new Error(`Cannot automate unknown plugin instance ${instanceId}`);
    }
    await NativePluginHost.scheduleAutomation(instanceId, parameterId, envelope);
  }

  async setParameter(
    instanceId: string,
    parameterId: string,
    value: number,
  ): Promise<void> {
    if (!this.instances.has(instanceId)) {
      throw new Error(`Cannot set parameter on unknown plugin instance ${instanceId}`);
    }
    await NativePluginHost.setParameterValue(instanceId, parameterId, value);
  }

  onCrash(listener: CrashListener): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  onSandboxPermission(listener: SandboxPermissionListener): () => void {
    this.sandboxListeners.add(listener);
    return () => this.sandboxListeners.delete(listener);
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
    this.crashListeners.clear();
    this.sandboxListeners.clear();
    this.instances.clear();
  }

  private subscribeToEvents(): void {
    const crashSubscription = this.emitter.addListener(
      'pluginCrashed',
      (payload: PluginCrashEventPayload) => {
        this.handleCrash(payload).catch((error) => {
          console.error('Unhandled plugin crash handling error', error);
        });
      },
    );
    const sandboxSubscription = this.emitter.addListener(
      'sandboxPermissionRequired',
      (payload: SandboxPermissionPayload) => {
        this.sandboxListeners.forEach((listener) => listener(payload));
      },
    );
    this.subscriptions.push(crashSubscription, sandboxSubscription);
  }

  private async handleCrash(payload: PluginCrashEventPayload): Promise<void> {
    const report: PluginCrashReport = {
      instanceId: payload.instanceId,
      descriptor: payload.descriptor,
      timestamp: payload.timestamp,
      reason: payload.reason,
      recovered: payload.recovered,
    };
    if (!report.recovered) {
      try {
        await NativePluginHost.acknowledgeCrash(report.instanceId);
      } catch (error) {
        console.error('Failed to acknowledge plugin crash', error);
      }
      await this.tryRestartInstance(report, payload.restartToken);
    }
    this.crashListeners.forEach((listener) => listener(report));
  }

  private async tryRestartInstance(
    report: PluginCrashReport,
    restartToken?: string,
  ): Promise<void> {
    const instance = this.instances.get(report.instanceId);
    if (!instance) {
      return;
    }
    try {
      this.instances.delete(report.instanceId);
      const sandboxContext = instance.sandboxPath
        ? ({
            descriptor: instance.descriptor,
            identifier: instance.descriptor.identifier,
            path: instance.sandboxPath,
          } as SandboxContext)
        : undefined;
      if (restartToken) {
        const newHandle = await NativePluginHost.instantiatePlugin(
          instance.descriptor.identifier,
          {
            sandboxIdentifier: sandboxContext?.identifier,
            initialPresetId: instance.descriptor.factoryPresets?.[0]?.id,
            cpuBudgetPercent: instance.cpuLoadPercent,
          },
        );
        this.instances.set(newHandle.instanceId, newHandle);
        this.instances.delete(report.instanceId);
      }
    } catch (error) {
      console.error('Plugin restart failed', error);
    }
  }

  private async prepareSandboxIfNeeded(
    descriptor: PluginDescriptor,
    options: LoadPluginOptions,
  ): Promise<SandboxContext | undefined> {
    if (!descriptor.supportsSandbox) {
      return undefined;
    }
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      return this.sandboxManager.ensureSandbox(descriptor, options.sandboxIdentifier);
    }
    return undefined;
  }
}
