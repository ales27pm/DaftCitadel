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

type InstanceBindingRecord = {
  handle: PluginInstanceHandle;
  nativeInstanceId: string;
  restartToken?: string;
  sandboxIdentifier?: string;
  sandboxPath?: string;
};

export class PluginHost {
  private readonly emitter: NativeEventEmitter;
  private readonly sandboxManager: PluginSandboxManager;
  private readonly crashListeners = new Set<CrashListener>();
  private readonly sandboxListeners = new Set<SandboxPermissionListener>();
  private readonly instances = new Map<string, InstanceBindingRecord>();
  private readonly crashedInstances = new Map<string, InstanceBindingRecord>();
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
    const sandboxIdentifier = sandboxContext?.identifier ?? options.sandboxIdentifier;
    const sandboxPath = sandboxContext?.path ?? normalizedHandle.sandboxPath;
    const handleWithSandbox =
      sandboxPath && normalizedHandle.sandboxPath !== sandboxPath
        ? { ...normalizedHandle, sandboxPath }
        : normalizedHandle;
    this.instances.set(normalizedHandle.instanceId, {
      handle: handleWithSandbox,
      nativeInstanceId: normalizedHandle.nativeInstanceId ?? normalizedHandle.instanceId,
      restartToken: normalizedHandle.restartToken,
      sandboxIdentifier,
      sandboxPath,
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
        const binding = this.instances.get(payload.instanceId);
        const acknowledgeId = binding?.nativeInstanceId ?? payload.instanceId;
        await NativePluginHost.acknowledgeCrash(acknowledgeId);
      } catch (error) {
        console.error('Failed to acknowledge plugin crash', error);
      }
      report.recovered = await this.tryRestartInstance(payload);
    }
    this.crashListeners.forEach((listener) => listener(report));
  }

  private mergeCrashPayload(
    binding: InstanceBindingRecord,
    payload: PluginCrashEventPayload,
  ): {
    updated: InstanceBindingRecord;
    proceed: boolean;
    reason?: 'mismatch' | 'missing';
  } {
    const updated: InstanceBindingRecord = {
      ...binding,
      restartToken: payload.restartToken ?? binding.restartToken,
      sandboxIdentifier: payload.sandboxIdentifier ?? binding.sandboxIdentifier,
      sandboxPath:
        payload.sandboxPath ?? binding.sandboxPath ?? binding.handle.sandboxPath,
      handle:
        payload.sandboxPath && binding.handle.sandboxPath !== payload.sandboxPath
          ? { ...binding.handle, sandboxPath: payload.sandboxPath }
          : binding.handle,
    };

    if (
      binding.restartToken &&
      payload.restartToken &&
      payload.restartToken !== binding.restartToken
    ) {
      return { updated, proceed: false, reason: 'mismatch' };
    }

    if (!updated.restartToken) {
      return { updated, proceed: false, reason: 'missing' };
    }

    return { updated, proceed: true };
  }

  private markCrashed(instanceId: string, binding: InstanceBindingRecord): void {
    this.instances.delete(instanceId);
    this.crashedInstances.set(instanceId, binding);
  }

  private async prepareRestart(binding: InstanceBindingRecord): Promise<{
    options: PluginInstanceOptions;
    sandboxContext?: SandboxContext;
    sandboxIdentifier?: string;
  }> {
    const { descriptor, cpuLoadPercent } = binding.handle;
    let { sandboxIdentifier } = binding;
    let sandboxContext: SandboxContext | undefined;

    if (
      descriptor.supportsSandbox &&
      (Platform.OS === 'ios' || Platform.OS === 'android')
    ) {
      const preferredIdentifier = sandboxIdentifier ?? descriptor.identifier;
      try {
        sandboxContext = await this.sandboxManager.ensureSandbox(
          descriptor,
          preferredIdentifier,
        );
        sandboxIdentifier = sandboxContext.identifier;
      } catch (error) {
        console.error('Failed to prepare sandbox for plugin restart', error);
      }
    }

    const instantiateOptions: PluginInstanceOptions = {
      initialPresetId: descriptor.factoryPresets?.[0]?.id,
      cpuBudgetPercent: cpuLoadPercent,
    };

    if (sandboxContext?.identifier || sandboxIdentifier) {
      instantiateOptions.sandboxIdentifier =
        sandboxContext?.identifier ?? sandboxIdentifier;
    }

    if (binding.restartToken) {
      instantiateOptions.restartToken = binding.restartToken;
    }

    return {
      options: instantiateOptions,
      sandboxContext,
      sandboxIdentifier: sandboxContext?.identifier ?? sandboxIdentifier,
    };
  }

  private async tryRestartInstance(payload: PluginCrashEventPayload): Promise<boolean> {
    const binding = this.instances.get(payload.instanceId);
    if (!binding) {
      return false;
    }

    const { updated, proceed, reason } = this.mergeCrashPayload(binding, payload);

    if (!proceed) {
      const message =
        reason === 'mismatch'
          ? 'Restart token mismatch; refusing automatic restart'
          : 'Restart token missing; refusing automatic restart';
      console.warn(message, {
        instanceId: payload.instanceId,
      });
      this.markCrashed(payload.instanceId, updated);
      return false;
    }

    this.instances.set(payload.instanceId, updated);
    return this.reviveBinding(updated, payload.instanceId);
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
    binding: InstanceBindingRecord,
    targetInstanceId: string,
  ): Promise<boolean> {
    const { options, sandboxContext, sandboxIdentifier } =
      await this.prepareRestart(binding);

    try {
      const newHandle = await NativePluginHost.instantiatePlugin(
        binding.handle.descriptor.identifier,
        options,
      );
      const revivedHandle: PluginInstanceHandle = {
        ...newHandle,
        instanceId: targetInstanceId,
        nativeInstanceId: newHandle.nativeInstanceId ?? newHandle.instanceId,
        restartToken: newHandle.restartToken ?? binding.restartToken,
      };
      const resolvedSandboxPath =
        sandboxContext?.path ?? newHandle.sandboxPath ?? binding.sandboxPath;
      const handleWithSandbox =
        resolvedSandboxPath && revivedHandle.sandboxPath !== resolvedSandboxPath
          ? { ...revivedHandle, sandboxPath: resolvedSandboxPath }
          : revivedHandle;
      const nextBinding: InstanceBindingRecord = {
        handle: handleWithSandbox,
        nativeInstanceId:
          handleWithSandbox.nativeInstanceId ?? handleWithSandbox.instanceId,
        restartToken: handleWithSandbox.restartToken ?? binding.restartToken,
        sandboxIdentifier,
        sandboxPath: resolvedSandboxPath ?? binding.sandboxPath,
      };
      if (sandboxContext) {
        this.sandboxManager.recordSandbox(sandboxContext);
      }
      this.instances.set(targetInstanceId, nextBinding);
      this.crashedInstances.delete(targetInstanceId);
      return true;
    } catch (error) {
      console.error('Plugin revive failed', error);
      this.markCrashed(targetInstanceId, { ...binding });
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
