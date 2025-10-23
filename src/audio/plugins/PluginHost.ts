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
  private readonly instances = new Map<
    string,
    {
      handle: PluginInstanceHandle;
      nativeInstanceId: string;
      restartToken?: string;
    }
  >();
  private readonly crashedInstances = new Map<
    string,
    {
      handle: PluginInstanceHandle;
      nativeInstanceId: string;
      restartToken?: string;
    }
  >();
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
    const normalizedHandle: PluginInstanceHandle = {
      ...handle,
      nativeInstanceId: handle.nativeInstanceId ?? handle.instanceId,
    };
    if (sandboxContext) {
      this.sandboxManager.recordSandbox(sandboxContext);
    }
    this.instances.set(normalizedHandle.instanceId, {
      handle: normalizedHandle,
      nativeInstanceId: normalizedHandle.nativeInstanceId ?? normalizedHandle.instanceId,
      restartToken: normalizedHandle.restartToken,
    });
    this.crashedInstances.delete(normalizedHandle.instanceId);
    return normalizedHandle;
  }

  async releasePlugin(instanceId: string): Promise<void> {
    const binding = this.instances.get(instanceId);
    await NativePluginHost.releasePlugin(binding?.nativeInstanceId ?? instanceId);
    if (binding) {
      this.instances.delete(instanceId);
    }
    this.crashedInstances.delete(instanceId);
  }

  async loadPreset(instanceId: string, presetId: string): Promise<void> {
    const binding = this.instances.get(instanceId);
    if (!binding) {
      throw new Error(`Unknown plugin instance: ${instanceId}`);
    }
    const preset = binding.handle.descriptor.factoryPresets?.find(
      (candidate) => candidate.id === presetId,
    );
    if (!preset) {
      throw new Error(
        `Preset ${presetId} not found for ${binding.handle.descriptor.identifier}`,
      );
    }
    await NativePluginHost.loadPreset(binding.nativeInstanceId, preset);
  }

  async automateParameter(
    instanceId: string,
    parameterId: string,
    envelope: PluginAutomationEnvelope[],
  ): Promise<void> {
    await this.scheduleAutomation(instanceId, parameterId, envelope);
  }

  async scheduleAutomation(
    instanceId: string,
    parameterId: string,
    envelope: PluginAutomationEnvelope[],
  ): Promise<void> {
    const binding = this.instances.get(instanceId);
    if (!binding) {
      throw new Error(`Cannot automate unknown plugin instance ${instanceId}`);
    }
    await NativePluginHost.scheduleAutomation(
      binding.nativeInstanceId,
      parameterId,
      envelope,
    );
  }

  async setParameter(
    instanceId: string,
    parameterId: string,
    value: number,
  ): Promise<void> {
    const binding = this.instances.get(instanceId);
    if (!binding) {
      throw new Error(`Cannot set parameter on unknown plugin instance ${instanceId}`);
    }
    await NativePluginHost.setParameterValue(
      binding.nativeInstanceId,
      parameterId,
      value,
    );
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
    this.crashedInstances.clear();
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
      report.recovered = await this.tryRestartInstance(report, payload.restartToken);
    }
    this.crashListeners.forEach((listener) => listener(report));
  }

  private async tryRestartInstance(
    report: PluginCrashReport,
    restartToken?: string,
  ): Promise<boolean> {
    const binding = this.instances.get(report.instanceId);
    if (!binding) {
      return false;
    }
    if (!restartToken || restartToken !== binding.restartToken) {
      if (!restartToken) {
        console.warn('Restart token missing; refusing automatic restart', {
          instanceId: report.instanceId,
        });
      } else {
        console.warn('Restart token mismatch; refusing automatic restart', {
          instanceId: report.instanceId,
        });
      }
      this.crashedInstances.set(report.instanceId, {
        handle: binding.handle,
        nativeInstanceId: binding.nativeInstanceId,
        restartToken: binding.restartToken,
      });
      this.instances.delete(report.instanceId);
      return false;
    }
    return this.reviveBinding(binding, report.instanceId);
  }

  getInstanceRuntime(
    instanceId: string,
  ): { handle: PluginInstanceHandle; nativeInstanceId: string } | undefined {
    const binding = this.instances.get(instanceId);
    if (!binding) {
      return undefined;
    }
    return {
      handle: binding.handle,
      nativeInstanceId: binding.nativeInstanceId,
    };
  }

  async retryInstance(instanceId: string): Promise<boolean> {
    const binding =
      this.instances.get(instanceId) ?? this.crashedInstances.get(instanceId);
    if (!binding) {
      return false;
    }
    return this.reviveBinding(binding, instanceId);
  }

  private async reviveBinding(
    binding: {
      handle: PluginInstanceHandle;
      nativeInstanceId: string;
      restartToken?: string;
    },
    targetInstanceId: string,
  ): Promise<boolean> {
    const sandboxContext = binding.handle.sandboxPath
      ? ({
          descriptor: binding.handle.descriptor,
          identifier: binding.handle.descriptor.identifier,
          path: binding.handle.sandboxPath,
        } as SandboxContext)
      : undefined;
    try {
      const newHandle = await NativePluginHost.instantiatePlugin(
        binding.handle.descriptor.identifier,
        {
          sandboxIdentifier: sandboxContext?.identifier,
          initialPresetId: binding.handle.descriptor.factoryPresets?.[0]?.id,
          cpuBudgetPercent: binding.handle.cpuLoadPercent,
        },
      );
      const revivedHandle: PluginInstanceHandle = {
        ...newHandle,
        instanceId: targetInstanceId,
        nativeInstanceId: newHandle.nativeInstanceId ?? newHandle.instanceId,
      };
      this.instances.set(targetInstanceId, {
        handle: revivedHandle,
        nativeInstanceId: revivedHandle.nativeInstanceId ?? newHandle.instanceId,
        restartToken: revivedHandle.restartToken,
      });
      this.crashedInstances.delete(targetInstanceId);
      return true;
    } catch (error) {
      console.error('Plugin revive failed', error);
      this.instances.delete(targetInstanceId);
      this.crashedInstances.set(targetInstanceId, {
        handle: binding.handle,
        nativeInstanceId: binding.nativeInstanceId,
        restartToken: binding.restartToken,
      });
      return false;
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
