import { AudioEngine, NodeConfiguration, OUTPUT_BUS } from './AudioEngine';
import { AutomationLane, ClockSyncService } from './Automation';
import {
  Clip,
  InstrumentRoutingNode,
  JUNO106_PARAMETER_NAMES,
  Juno106ParameterName,
  PluginRoutingNode,
  RoutingGraph,
  RoutingNode,
  Session,
  Track,
  TrackEndpointNode,
} from '../session/models';
import {
  InstrumentParameterEvent,
  JunoParameterId,
  MidiEvent,
  MidiEventType,
} from './Instruments';
import type {
  AudioDiagnosticsSnapshot,
  AudioEngineBridge,
  AudioTransportSnapshot,
  InstrumentMidiEvent,
  InstrumentParameterChange,
} from '../session/sessionManager';
import { AsyncMutex } from '../session/util';
import {
  AudioFileLoader,
  ClipBufferCache,
  ClipBufferDescriptor,
  createClipBufferUploader,
} from './bridge/ClipBufferCache';
import {
  AutomationPublisher,
  describeAutomation,
  AutomationRequest,
} from './bridge/AutomationManager';
import { ConnectionKey, GraphReconciler } from './bridge/GraphReconciler';
import type { PluginHost } from './plugins/PluginHost';
import type {
  PluginCrashReport,
  PluginDescriptor,
  PluginInstanceHandle,
} from './plugins/types';
import type { PluginAutomationPoint } from './plugins/NativePluginHost';

type Logger = Pick<typeof console, 'debug' | 'info' | 'warn' | 'error'>;

type TrackNodeId = string;

type SessionState = {
  nodes: Map<string, NodeConfiguration>;
  connections: Set<ConnectionKey>;
  automations: Map<string, AutomationRequest>;
  pluginAutomations: Map<string, PluginAutomationRequest>;
  activePluginInstances: Set<string>;
  clipBuffers: Map<string, ClipBufferDescriptor>;
  pluginNodes: Map<string, PluginRoutingNode>;
  instrumentSchedules: Map<string, InstrumentSchedule>;
  instrumentParameters: Map<string, InstrumentParameterState>;
};

type InstrumentSchedule = {
  midiEvents: MidiEvent[];
  parameterEvents: InstrumentParameterEvent[];
};

type InstrumentParameterState = Map<JunoParameterId, number>;

type RecoverySnapshot = {
  pluginNodes: Map<string, PluginRoutingNode>;
  pluginAutomations: Map<string, PluginAutomationRequest>;
  automationRequests: Map<string, AutomationRequest>;
};

const isTrackEndpointNode = (node: RoutingNode): node is TrackEndpointNode =>
  node.type === 'trackInput' || node.type === 'trackOutput';

const isPluginNode = (node: RoutingNode): node is PluginRoutingNode =>
  node.type === 'plugin';

const isInstrumentNode = (node: RoutingNode): node is InstrumentRoutingNode =>
  node.type === 'instrument';

const JUNO_PARAMETER_IDS: Record<Juno106ParameterName, JunoParameterId> = {
  pulseWidth: JunoParameterId.PulseWidth,
  subLevel: JunoParameterId.SubLevel,
  cutoffHz: JunoParameterId.CutoffHz,
  resonance: JunoParameterId.Resonance,
  attackSeconds: JunoParameterId.AttackSeconds,
  releaseSeconds: JunoParameterId.ReleaseSeconds,
  chorusMode: JunoParameterId.ChorusMode,
  outputGain: JunoParameterId.OutputGain,
  lfoRateHz: JunoParameterId.LfoRateHz,
  lfoDepth: JunoParameterId.LfoDepth,
};

const resolveJunoParameter = (parameter: string): JunoParameterId | undefined => {
  const normalized = parameter.replace(/^instrument\./, '');
  if (normalized === 'filter.cutoff') {
    return JunoParameterId.CutoffHz;
  }
  return JUNO106_PARAMETER_NAMES.includes(normalized as Juno106ParameterName)
    ? JUNO_PARAMETER_IDS[normalized as Juno106ParameterName]
    : undefined;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

type UnrefableTimer = {
  unref?: () => void;
};

const allowProcessToExit = (handle: ReturnType<typeof setInterval>): void => {
  // Node timers keep Jest, SSR, and command-line consumers alive by default.
  // React Native returns numeric handles, so this is a no-op on devices.
  (handle as unknown as UnrefableTimer).unref?.();
};

const connectionGainNodeId = (trackId: string, connectionId: string): string =>
  `__connection_gain__:${encodeURIComponent(trackId)}:${encodeURIComponent(connectionId)}`;

class PluginRecoveryManager {
  private snapshot: RecoverySnapshot = {
    pluginNodes: new Map(),
    pluginAutomations: new Map(),
    automationRequests: new Map(),
  };

  private crashedSessions = new Set<string>();

  private unsubscribe?: () => void;

  constructor(
    private readonly deps: {
      pluginHost: PluginHost;
      pluginBindings: Map<string, PluginInstanceBinding>;
      pluginAutomationState: Map<string, string>;
      graph: GraphReconciler;
      automationPublisher: AutomationPublisher;
      createNodeConfiguration: (node: PluginRoutingNode) => NodeConfiguration;
      applyPluginAutomations: (
        requests: Map<string, PluginAutomationRequest>,
      ) => Promise<void>;
      logger: Logger;
    },
  ) {
    this.unsubscribe = deps.pluginHost.onCrash((report) => {
      this.handleCrash(report).catch((error) => {
        deps.logger.error('Failed to reconcile plugin after crash', error);
      });
    });
  }

  record(snapshot: RecoverySnapshot): void {
    this.snapshot = {
      pluginNodes: new Map(snapshot.pluginNodes),
      pluginAutomations: new Map(snapshot.pluginAutomations),
      automationRequests: new Map(snapshot.automationRequests),
    };
  }

  forget(sessionInstanceId: string): void {
    this.crashedSessions.delete(sessionInstanceId);
  }

  async retry(sessionInstanceId: string): Promise<boolean> {
    if (!this.deps.pluginHost.retryInstance) {
      this.deps.logger.warn('PluginHost does not expose retryInstance');
      return false;
    }
    const success = await this.deps.pluginHost.retryInstance(sessionInstanceId);
    if (!success) {
      return false;
    }
    try {
      const refreshed = await this.refreshBinding(sessionInstanceId);
      if (!refreshed) {
        this.deps.logger.warn('Plugin retry succeeded but binding refresh failed', {
          instanceId: sessionInstanceId,
        });
      }
      return refreshed;
    } catch (error) {
      this.deps.logger.error(
        'Failed to refresh plugin binding after manual retry',
        error,
      );
      return false;
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.crashedSessions.clear();
    this.snapshot = {
      pluginNodes: new Map(),
      pluginAutomations: new Map(),
      automationRequests: new Map(),
    };
  }

  private async handleCrash(report: PluginCrashReport): Promise<void> {
    const bindingEntry = this.findBindingByHostInstanceId(report.instanceId);
    if (!bindingEntry) {
      return;
    }
    const [sessionInstanceId, binding] = bindingEntry;
    if (!report.recovered) {
      this.deps.logger.warn('Plugin reported crash without automatic recovery', {
        instanceId: report.instanceId,
      });
      this.crashedSessions.add(sessionInstanceId);
      this.deps.pluginBindings.delete(sessionInstanceId);
      this.clearAutomationState(sessionInstanceId);
      return;
    }
    const refreshed = await this.refreshBinding(sessionInstanceId);
    if (!refreshed) {
      this.deps.logger.warn('Plugin restart succeeded but binding refresh failed', {
        instanceId: binding.hostInstanceId,
      });
    }
  }

  private async refreshBinding(sessionInstanceId: string): Promise<boolean> {
    const runtime = this.deps.pluginHost.getInstanceRuntime?.(sessionInstanceId);
    if (!runtime) {
      return false;
    }
    let binding = this.deps.pluginBindings.get(sessionInstanceId);
    if (!binding) {
      binding = {
        descriptor: runtime.handle.descriptor,
        hostInstanceId: runtime.nativeInstanceId,
        handle: runtime.handle,
      };
      this.deps.pluginBindings.set(sessionInstanceId, binding);
    } else {
      binding.handle = runtime.handle;
      binding.descriptor = runtime.handle.descriptor;
      binding.hostInstanceId = runtime.nativeInstanceId;
    }

    const node = this.snapshot.pluginNodes.get(sessionInstanceId);
    if (node) {
      await this.deps.graph.forceConfigureNode(this.deps.createNodeConfiguration(node));
    }

    this.clearAutomationState(sessionInstanceId);

    const updatedAutomations = new Map<string, PluginAutomationRequest>();
    this.snapshot.pluginAutomations.forEach((request, key) => {
      if (request.instanceId === sessionInstanceId) {
        updatedAutomations.set(key, {
          ...request,
          hostInstanceId: binding!.hostInstanceId,
        });
      } else {
        updatedAutomations.set(key, request);
      }
    });

    this.snapshot = {
      pluginNodes: this.snapshot.pluginNodes,
      pluginAutomations: updatedAutomations,
      automationRequests: this.snapshot.automationRequests,
    };

    if (updatedAutomations.size > 0) {
      await this.deps.applyPluginAutomations(updatedAutomations);
    }
    if (this.snapshot.automationRequests.size > 0) {
      await this.deps.automationPublisher.applyChanges(this.snapshot.automationRequests);
    }
    this.crashedSessions.delete(sessionInstanceId);
    return true;
  }

  private clearAutomationState(sessionInstanceId: string): void {
    for (const key of Array.from(this.deps.pluginAutomationState.keys())) {
      if (key.startsWith(`${sessionInstanceId}:`)) {
        this.deps.pluginAutomationState.delete(key);
      }
    }
  }

  private findBindingByHostInstanceId(
    hostInstanceId: string,
  ): [string, PluginInstanceBinding] | undefined {
    for (const entry of this.deps.pluginBindings.entries()) {
      if (entry[1].hostInstanceId === hostInstanceId) {
        return entry;
      }
    }
    return undefined;
  }
}

type PluginAutomationRequest = {
  key: string;
  instanceId: string;
  hostInstanceId: string;
  parameterId: string;
  signature: string;
  points: PluginAutomationPoint[];
};

type PluginInstanceBinding = {
  descriptor: PluginDescriptor;
  hostInstanceId: string;
  handle: PluginInstanceHandle;
};

const DEFAULT_LOGGER: Logger = {
  debug: (...args: unknown[]) => console.debug('[SessionAudioBridge]', ...args),
  info: (...args: unknown[]) => console.info('[SessionAudioBridge]', ...args),
  warn: (...args: unknown[]) => console.warn('[SessionAudioBridge]', ...args),
  error: (...args: unknown[]) => console.error('[SessionAudioBridge]', ...args),
};

const DEFAULT_TRANSPORT_POLL_INTERVAL_MS = 120;
const DEFAULT_DIAGNOSTICS_POLL_INTERVAL_MS = 1500;
const MAX_INSTRUMENT_EVENTS_PER_NODE = 1024;

export interface PluginDescriptorResolver {
  (
    instanceId: string,
    node: PluginRoutingNode,
  ): Promise<PluginDescriptor | undefined> | PluginDescriptor | undefined;
  clearInstance?(instanceId: string): void;
  clearAll?(): void;
}

export interface SessionAudioBridgeOptions {
  fileLoader: AudioFileLoader;
  logger?: Logger;
  pluginHost?: PluginHost;
  resolvePluginDescriptor?: PluginDescriptorResolver;
  transportPollIntervalMs?: number;
  diagnosticsPollIntervalMs?: number;
}

export class SessionAudioBridge implements AudioEngineBridge {
  private readonly clock: ClockSyncService;

  private readonly bufferCache: ClipBufferCache;

  private readonly graph: GraphReconciler;

  private readonly automationPublisher: AutomationPublisher;

  private readonly logger: Logger;

  private readonly pluginHost?: PluginHost;

  private readonly resolvePluginDescriptor?: SessionAudioBridgeOptions['resolvePluginDescriptor'];

  private previousSessionRevision = -1;

  private readonly pluginBindings = new Map<string, PluginInstanceBinding>();

  private readonly pluginAutomationState = new Map<string, string>();

  private readonly activeClipBuffers = new Map<string, ClipBufferDescriptor>();

  private readonly activeInstrumentSchedules = new Map<string, InstrumentSchedule>();

  private readonly activeInstrumentParameters = new Map<
    string,
    InstrumentParameterState
  >();

  private readonly operationMutex = new AsyncMutex();

  private pluginRecovery?: PluginRecoveryManager;

  private readonly transportListeners = new Set<
    (snapshot: AudioTransportSnapshot) => void
  >();

  private readonly diagnosticsListeners = new Set<
    (snapshot: AudioDiagnosticsSnapshot) => void
  >();

  private transportSnapshot: AudioTransportSnapshot | null = null;

  private diagnosticsSnapshot: AudioDiagnosticsSnapshot = {
    status: 'loading',
    xruns: 0,
    renderLoad: 0,
  };

  private transportPollHandle?: ReturnType<typeof setInterval>;

  private diagnosticsPollHandle?: ReturnType<typeof setInterval>;

  private readonly transportPollIntervalMs: number;

  private readonly diagnosticsPollIntervalMs: number;

  private readonly supportsTransport: boolean;

  private readonly supportsTransportLoop: boolean;

  private readonly supportsDiagnostics: boolean;

  private isTransportPolling = false;

  private isDiagnosticsPolling = false;

  private instrumentInputEnabled = true;

  private instrumentInputEpoch = 0;

  constructor(
    private readonly audioEngine: AudioEngine,
    options: SessionAudioBridgeOptions,
  ) {
    if (!options.fileLoader) {
      throw new Error('SessionAudioBridge requires an AudioFileLoader');
    }
    this.clock = audioEngine.getClock();
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.bufferCache = new ClipBufferCache(
      options.fileLoader,
      createClipBufferUploader(audioEngine),
      this.logger,
    );
    this.graph = new GraphReconciler(audioEngine, this.logger);
    this.automationPublisher = new AutomationPublisher((nodeId, lane) =>
      this.audioEngine.publishAutomation(nodeId, lane),
    );
    this.pluginHost = options.pluginHost;
    this.resolvePluginDescriptor = options.resolvePluginDescriptor;
    this.transportPollIntervalMs = Math.max(
      16,
      options.transportPollIntervalMs ?? DEFAULT_TRANSPORT_POLL_INTERVAL_MS,
    );
    this.diagnosticsPollIntervalMs = Math.max(
      250,
      options.diagnosticsPollIntervalMs ?? DEFAULT_DIAGNOSTICS_POLL_INTERVAL_MS,
    );
    this.supportsTransport =
      typeof this.audioEngine.getTransportState === 'function' &&
      typeof this.audioEngine.startTransport === 'function' &&
      typeof this.audioEngine.stopTransport === 'function' &&
      typeof (this.audioEngine as unknown as { locateTransport?: unknown })
        .locateTransport === 'function';
    this.supportsTransportLoop =
      typeof (this.audioEngine as unknown as { setTransportLoop?: unknown })
        .setTransportLoop === 'function';
    this.supportsDiagnostics =
      typeof this.audioEngine.getRenderDiagnostics === 'function';
    if (!this.supportsDiagnostics) {
      this.diagnosticsSnapshot = {
        status: 'unavailable',
        xruns: 0,
        renderLoad: 0,
      };
    }
    if (this.pluginHost) {
      this.pluginRecovery = new PluginRecoveryManager({
        pluginHost: this.pluginHost,
        pluginBindings: this.pluginBindings,
        pluginAutomationState: this.pluginAutomationState,
        graph: this.graph,
        automationPublisher: this.automationPublisher,
        createNodeConfiguration: (node) => this.createNodeConfiguration(node),
        applyPluginAutomations: (requests) => this.applyPluginAutomations(requests),
        logger: this.logger,
      });
    }
  }

  public async resetSession(): Promise<void> {
    await this.runExclusive(() => this.resetSessionLocked());
  }

  private async resetSessionLocked(): Promise<void> {
    const failures: Array<{ phase: string; error: unknown }> = [];
    const attempt = async (
      phase: string,
      operation: () => Promise<void>,
    ): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push({ phase, error });
      }
    };

    if (this.supportsTransport) {
      await attempt('stop transport', () => this.audioEngine.stopTransport());
    }
    await attempt('clear automation', () =>
      this.automationPublisher.applyChanges(new Map<string, AutomationRequest>()),
    );
    await attempt('clear plugin automation', () =>
      this.applyPluginAutomations(new Map<string, PluginAutomationRequest>()),
    );
    await attempt('clear graph', async () => {
      await this.graph.apply(
        new Map<string, NodeConfiguration>(),
        new Set<ConnectionKey>(),
      );
    });
    this.activeInstrumentSchedules.clear();
    this.activeInstrumentParameters.clear();
    await attempt('release plugins', () =>
      this.releaseStalePluginInstances(new Set<string>()),
    );
    await attempt('release clip buffers', () =>
      this.reconcileClipBuffers(new Map<string, ClipBufferDescriptor>()),
    );

    this.pluginRecovery?.record({
      automationRequests: new Map<string, AutomationRequest>(),
      pluginAutomations: new Map<string, PluginAutomationRequest>(),
      pluginNodes: new Map<string, PluginRoutingNode>(),
    });
    this.resolvePluginDescriptor?.clearAll?.();
    this.previousSessionRevision = -1;

    if (this.supportsTransport) {
      this.refreshTransportState().catch((error) => {
        this.logger.warn('Failed to refresh transport state after session reset', error);
      });
    }

    if (failures.length > 0) {
      this.logger.error('Session audio reset was incomplete', {
        phases: failures.map(({ phase }) => phase),
        error: failures[0].error,
      });
      throw failures[0].error;
    }
  }

  public async applySessionUpdate(session: Session): Promise<void> {
    await this.runExclusive(() => this.applySessionUpdateLocked(session));
  }

  private async applySessionUpdateLocked(session: Session): Promise<void> {
    if (session.revision < this.previousSessionRevision) {
      throw new Error('Session revision regressed; refusing to apply update');
    }
    if (session.revision === this.previousSessionRevision) {
      this.logger.debug('Session revision unchanged; skipping update');
      return;
    }

    const engineDescription = this.clock.describe();
    const { sampleRate } = engineDescription;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('AudioEngine clock reports invalid sample rate');
    }

    if (session.metadata.sampleRate !== sampleRate) {
      this.logger.warn(
        `Session sample rate ${session.metadata.sampleRate} does not match engine sample rate ${sampleRate}; resampling clips`,
      );
    }

    const desiredState = await this.buildDesiredState(session, sampleRate);
    this.pluginRecovery?.record({
      automationRequests: desiredState.automations,
      pluginAutomations: desiredState.pluginAutomations,
      pluginNodes: desiredState.pluginNodes,
    });

    const graphRequiresReconciliation = this.graph.hasChanges(
      desiredState.nodes,
      desiredState.connections,
    );
    const schedulesChanged = !this.instrumentSchedulesEqual(
      desiredState.instrumentSchedules,
      this.activeInstrumentSchedules,
    );
    const requiresTransportRebuild = graphRequiresReconciliation || schedulesChanged;
    let resumeFrame: number | null = null;
    if (this.supportsTransport && requiresTransportRebuild) {
      const transport = await this.audioEngine.getTransportState();
      if (transport.isPlaying) {
        await this.audioEngine.stopTransport();
        const stoppedTransport = await this.audioEngine.getTransportState();
        resumeFrame = Math.max(0, Math.floor(stoppedTransport.frame));
      }
    }

    const graphChanges = await this.graph.apply(
      desiredState.nodes,
      desiredState.connections,
    );
    await this.automationPublisher.applyChanges(desiredState.automations, graphChanges);
    await this.applyPluginAutomations(desiredState.pluginAutomations);
    if (resumeFrame !== null) {
      await this.audioEngine.locateTransport(resumeFrame);
    }
    await this.applyInstrumentParameterState(
      desiredState.instrumentParameters,
      graphChanges.replacedNodeIds,
    );
    if (requiresTransportRebuild) {
      await this.applyInstrumentSchedules(desiredState.instrumentSchedules);
    }
    await this.releaseStalePluginInstances(desiredState.activePluginInstances);
    await this.reconcileClipBuffers(desiredState.clipBuffers);
    if (resumeFrame !== null) {
      await this.audioEngine.startTransport();
    }

    if (this.clock.describe().bpm !== session.metadata.bpm) {
      this.clock.updateTempo(session.metadata.bpm);
    }
    this.previousSessionRevision = session.revision;
    if (this.supportsTransport) {
      this.refreshTransportState().catch((error) => {
        this.logger.warn('Failed to refresh transport state after session update', error);
      });
    }
  }

  public getTransportState(): AudioTransportSnapshot | null {
    if (!this.transportSnapshot) {
      return null;
    }
    return { ...this.transportSnapshot };
  }

  public subscribeTransport(
    listener: (snapshot: AudioTransportSnapshot) => void,
  ): () => void {
    this.transportListeners.add(listener);
    const snapshot = this.transportSnapshot;
    if (snapshot) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error('Transport listener threw on subscription', error);
      }
    } else if (!this.supportsTransport) {
      const description = this.clock.describe();
      const initial: AudioTransportSnapshot = {
        frame: 0,
        seconds: 0,
        beats: 0,
        bpm: description.bpm,
        sampleRate: description.sampleRate,
        isPlaying: false,
        updatedAt: Date.now(),
      };
      try {
        listener(initial);
      } catch (error) {
        this.logger.error('Transport listener threw on fallback snapshot', error);
      }
    }
    this.startTransportPolling();
    return () => {
      this.transportListeners.delete(listener);
      if (this.transportListeners.size === 0) {
        this.stopTransportPolling();
      }
    };
  }

  public async startTransport(): Promise<void> {
    await this.runExclusive(() => this.startTransportLocked());
  }

  private async startTransportLocked(): Promise<void> {
    if (!this.supportsTransport) {
      throw new Error('Transport controls unavailable');
    }
    const transport = await this.audioEngine.getTransportState();
    if (transport.isPlaying) {
      // Native start is idempotent and doubles as a device-route health check.
      // Android uses it to rebuild a dead AudioTrack render thread even when
      // the portable transport clock is still marked playing.
      await this.audioEngine.startTransport();
      await this.refreshTransportState();
      return;
    }
    await this.audioEngine.locateTransport(transport.frame);
    await this.applyInstrumentSchedules(this.activeInstrumentSchedules, false);
    await this.audioEngine.startTransport();
    await this.refreshTransportState();
  }

  public async stopTransport(): Promise<void> {
    await this.runExclusive(() => this.stopTransportLocked());
  }

  private async stopTransportLocked(): Promise<void> {
    if (!this.supportsTransport) {
      throw new Error('Transport controls unavailable');
    }
    await this.audioEngine.stopTransport();
    await this.refreshTransportState();
  }

  public async sendInstrumentMidi(
    nodeId: string,
    event: InstrumentMidiEvent,
  ): Promise<void> {
    const inputEpoch = this.instrumentInputEpoch;
    await this.runExclusive(() =>
      this.sendInstrumentMidiLocked(nodeId, event, inputEpoch),
    );
  }

  private async sendInstrumentMidiLocked(
    nodeId: string,
    event: InstrumentMidiEvent,
    inputEpoch: number,
  ): Promise<void> {
    this.assertInstrumentInputEnabled(inputEpoch);
    let startedTransport = false;
    if (
      this.supportsTransport &&
      event.type === MidiEventType.NoteOn &&
      event.data2 > 0
    ) {
      const transport = await this.audioEngine.getTransportState();
      this.assertInstrumentInputEnabled(inputEpoch);
      if (!transport.isPlaying) {
        await this.startTransportLocked();
        this.assertInstrumentInputEnabled(inputEpoch);
        startedTransport = true;
      } else {
        await this.audioEngine.startTransport();
        this.assertInstrumentInputEnabled(inputEpoch);
      }
    }

    try {
      this.assertInstrumentInputEnabled(inputEpoch);
      await this.audioEngine.sendMidiEvent(nodeId, {
        ...event,
        type: event.type as MidiEventType,
      });
    } finally {
      if (startedTransport) {
        await this.refreshTransportState().catch((error) => {
          this.logger.warn(
            'Failed to refresh transport after starting a live instrument',
            error,
          );
        });
      }
    }
  }

  public async setInstrumentParameter(
    nodeId: string,
    change: InstrumentParameterChange,
  ): Promise<void> {
    await this.runExclusive(() =>
      this.audioEngine.setInstrumentParameter(nodeId, change),
    );
  }

  public async allNotesOff(nodeId: string): Promise<void> {
    await this.runExclusive(() => this.audioEngine.allNotesOff(nodeId));
  }

  public setInstrumentInputEnabled(enabled: boolean): void {
    if (this.instrumentInputEnabled !== enabled) {
      this.instrumentInputEpoch += 1;
    }
    this.instrumentInputEnabled = enabled;
  }

  public async locateTransport(frame: number): Promise<void> {
    await this.runExclusive(() => this.locateTransportLocked(frame));
  }

  public async setTransportLoop(
    startFrame: number,
    endFrame: number,
    enabled: boolean,
  ): Promise<void> {
    await this.runExclusive(async () => {
      if (!this.supportsTransportLoop) {
        throw new Error('Native transport loop controls unavailable');
      }
      if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
        throw new Error('Loop start frame must be a non-negative safe integer');
      }
      if (!Number.isSafeInteger(endFrame) || endFrame < 0) {
        throw new Error('Loop end frame must be a non-negative safe integer');
      }
      if (enabled && startFrame >= endFrame) {
        throw new Error(
          'Enabled transport loop requires startFrame to be less than endFrame',
        );
      }
      await this.audioEngine.setTransportLoop(startFrame, endFrame, enabled);
      if (this.supportsTransport) {
        await this.refreshTransportState();
      }
    });
  }

  private async locateTransportLocked(frame: number): Promise<void> {
    if (!this.supportsTransport) {
      throw new Error('Transport controls unavailable');
    }
    if (!Number.isFinite(frame)) {
      throw new Error('Transport frame must be finite');
    }
    const transport = await this.audioEngine.getTransportState();
    if (transport.isPlaying) {
      await this.audioEngine.stopTransport();
    }
    await this.audioEngine.locateTransport(Math.max(0, Math.floor(frame)));
    await this.applyInstrumentSchedules(this.activeInstrumentSchedules, false);
    if (transport.isPlaying) {
      await this.audioEngine.startTransport();
    }
    await this.refreshTransportState();
  }

  public getDiagnosticsState(): AudioDiagnosticsSnapshot {
    return { ...this.diagnosticsSnapshot };
  }

  public subscribeDiagnostics(
    listener: (snapshot: AudioDiagnosticsSnapshot) => void,
  ): () => void {
    this.diagnosticsListeners.add(listener);
    try {
      listener(this.diagnosticsSnapshot);
    } catch (error) {
      this.logger.error('Diagnostics listener threw on subscription', error);
    }
    this.startDiagnosticsPolling();
    return () => {
      this.diagnosticsListeners.delete(listener);
      if (this.diagnosticsListeners.size === 0) {
        this.stopDiagnosticsPolling();
      }
    };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.operationMutex.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private assertInstrumentInputEnabled(expectedEpoch: number): void {
    if (!this.instrumentInputEnabled || expectedEpoch !== this.instrumentInputEpoch) {
      throw new Error('Live instrument input is unavailable while the app is inactive');
    }
  }

  private async buildDesiredState(
    session: Session,
    sampleRate: number,
  ): Promise<SessionState> {
    const nodes = new Map<string, NodeConfiguration>();
    const connections = new Set<ConnectionKey>();
    const automations = new Map<string, AutomationRequest>();
    const pluginAutomations = new Map<string, PluginAutomationRequest>();
    const activePluginInstances = new Set<string>();
    const clipBuffers = new Map<string, ClipBufferDescriptor>();
    const pluginNodes = new Map<string, PluginRoutingNode>();
    const instrumentSchedules = new Map<string, InstrumentSchedule>();
    const instrumentParameters = new Map<string, InstrumentParameterState>();
    const hasSoloTrack = session.tracks.some((track) => track.solo);

    await Promise.all(
      session.tracks.map(async (track) => {
        const graph = this.resolveRoutingGraph(track);
        const trackInput = graph.nodes.find(
          (node): node is TrackEndpointNode => node.type === 'trackInput',
        );
        const trackOutput = graph.nodes.find(
          (node): node is TrackEndpointNode => node.type === 'trackOutput',
        );
        const instrumentNodes = graph.nodes.filter(isInstrumentNode);
        const instrumentNode = instrumentNodes[0];
        if (instrumentNode) {
          instrumentSchedules.set(instrumentNode.id, {
            midiEvents: [],
            parameterEvents: [],
          });
        }
        instrumentNodes.forEach((node) => {
          instrumentParameters.set(
            node.id,
            new Map(
              JUNO106_PARAMETER_NAMES.map((name) => [
                JUNO_PARAMETER_IDS[name],
                node.parameters[name],
              ]),
            ),
          );
        });

        const trackOutputGain =
          track.muted || (hasSoloTrack && !track.solo)
            ? 0
            : Math.pow(10, track.volume / 20);
        graph.nodes.forEach((node) => {
          if (isPluginNode(node)) {
            return;
          }
          nodes.set(
            node.id,
            this.createNodeConfiguration(
              node,
              node.type === 'trackOutput'
                ? { gain: trackOutputGain, pan: track.pan }
                : undefined,
            ),
          );
        });

        await this.preparePluginNodes(
          track,
          graph,
          nodes,
          pluginAutomations,
          activePluginInstances,
          session.revision,
          pluginNodes,
        );

        graph.connections.forEach((connection) => {
          if (connection.enabled === false) {
            return;
          }
          if (connection.signal !== 'audio') {
            this.logger.warn('Skipping unsupported non-audio native graph connection', {
              connectionId: connection.id,
              signal: connection.signal,
            });
            return;
          }
          const gain = connection.gain ?? 1;
          if (!Number.isFinite(gain)) {
            throw new Error(`Routing connection ${connection.id} has invalid gain`);
          }
          if (gain === 1) {
            connections.add(
              this.graph.getConnectionKey(connection.from.nodeId, connection.to.nodeId),
            );
            return;
          }

          const gainNodeId = connectionGainNodeId(track.id, connection.id);
          if (nodes.has(gainNodeId)) {
            throw new Error(
              `Routing connection ${connection.id} generated duplicate gain node ${gainNodeId}`,
            );
          }
          nodes.set(gainNodeId, {
            id: gainNodeId,
            type: 'gain',
            options: { gain },
          });
          connections.add(
            this.graph.getConnectionKey(connection.from.nodeId, gainNodeId),
          );
          connections.add(this.graph.getConnectionKey(gainNodeId, connection.to.nodeId));
        });

        if (trackOutput) {
          connections.add(this.graph.getConnectionKey(trackOutput.id, OUTPUT_BUS));
        } else {
          this.logger.warn(`Track ${track.id} is missing a trackOutput node`);
        }

        if (trackOutput) {
          track.automationCurves.forEach((curve) => {
            const instrumentParameter = instrumentNode
              ? resolveJunoParameter(curve.parameter)
              : undefined;
            if (instrumentNode && instrumentParameter !== undefined) {
              const schedule = instrumentSchedules.get(instrumentNode.id);
              curve.points.forEach((point) => {
                schedule?.parameterEvents.push({
                  frame: this.msToFrames(point.time, sampleRate),
                  parameterId: instrumentParameter,
                  value: point.value,
                });
              });
              return;
            }
            const lane = new AutomationLane(curve.parameter);
            curve.points.forEach((point) => {
              const frame = this.quantizeFrame(this.msToFrames(point.time, sampleRate));
              lane.addPoint({ frame, value: point.value });
            });
            const key = `${trackOutput.id}:${curve.parameter}`;
            automations.set(key, {
              nodeId: trackOutput.id,
              lane,
              signature: describeAutomation(trackOutput.id, lane),
            });
          });
        }

        if (!trackInput) {
          this.logger.warn(`Track ${track.id} is missing a trackInput node`);
          return;
        }

        await Promise.all(
          track.clips.map(async (clip) => {
            if (clip.midi && instrumentNode) {
              this.appendMidiClipEvents(
                clip,
                instrumentNode.id,
                instrumentSchedules,
                sampleRate,
                session.metadata.bpm,
              );
            } else if (clip.midi) {
              this.logger.warn('Skipping MIDI clip on a track without an instrument', {
                clipId: clip.id,
                trackId: track.id,
              });
            }
            if (!clip.audioFile) {
              return;
            }
            try {
              const clipState = await this.prepareClipNode(
                track,
                clip,
                clip.audioFile,
                trackInput.id,
                sampleRate,
              );
              nodes.set(clipState.node.id, clipState.node);
              connections.add(
                this.graph.getConnectionKey(
                  clipState.node.id,
                  clipState.destinationNodeId,
                ),
              );
              clipBuffers.set(clip.id, clipState.bufferDescriptor);
            } catch (error) {
              this.logger.error('Failed to prepare clip node', {
                clipId: clip.id,
                error,
              });
            }
          }),
        );
      }),
    );

    return {
      nodes,
      connections,
      automations,
      pluginAutomations,
      activePluginInstances,
      clipBuffers,
      pluginNodes,
      instrumentSchedules,
      instrumentParameters,
    };
  }

  private resolveRoutingGraph(track: Track): RoutingGraph {
    if (track.routing.graph) {
      return track.routing.graph;
    }
    throw new Error(`Track ${track.id} is missing a routing graph`);
  }

  private createNodeConfiguration(
    node: RoutingNode,
    trackOutputOptions?: { gain: number; pan: number },
  ): NodeConfiguration {
    if (isTrackEndpointNode(node)) {
      return {
        id: node.id,
        type: node.type,
        // Endpoint metadata belongs to the session model. The native DSP nodes
        // only consume gain/pan, so keep the bridge payload minimal and avoid
        // pushing labels or routing identifiers through Objective-C conversion.
        options: node.type === 'trackOutput' ? trackOutputOptions : undefined,
      };
    }
    if (isPluginNode(node)) {
      return {
        id: node.id,
        type: `plugin:${node.slot}`,
        options: {
          instanceId: node.instanceId,
          hostInstanceId:
            this.pluginBindings.get(node.instanceId)?.hostInstanceId ?? node.instanceId,
          order: node.order,
          bypassed: node.bypassed ?? false,
          acceptsAudio: node.accepts.includes('audio'),
          acceptsMidi: node.accepts.includes('midi'),
          acceptsSidechain: node.accepts.includes('sidechain'),
          emitsAudio: node.emits.includes('audio'),
          emitsMidi: node.emits.includes('midi'),
          emitsSidechain: node.emits.includes('sidechain'),
        },
      };
    }
    if (isInstrumentNode(node)) {
      return {
        id: node.id,
        type: node.instrumentType,
        options: {
          ...node.parameters,
        },
      };
    }
    if (node.type === 'send' || node.type === 'return') {
      const options: Record<string, number | string | boolean> = {
        busId: node.busId,
      };
      if (typeof node.preFader === 'boolean') {
        options.preFader = node.preFader;
      }
      if (typeof node.gain === 'number') {
        options.gain = node.gain;
      }
      return {
        id: node.id,
        type: node.type,
        options,
      };
    }
    if (node.type === 'sidechainTap') {
      return {
        id: node.id,
        type: node.type,
        options: {
          sourceTrackId: node.sourceTrackId,
          busId: node.busId,
        },
      };
    }
    throw new Error(`Unsupported routing node type: ${(node as RoutingNode).type}`);
  }

  private async prepareClipNode(
    track: Track,
    clip: Clip,
    audioFile: string,
    destinationNodeId: TrackNodeId,
    sampleRate: number,
  ): Promise<{
    node: NodeConfiguration;
    destinationNodeId: TrackNodeId;
    bufferDescriptor: ClipBufferDescriptor;
  }> {
    const bufferDescriptor = await this.bufferCache.getClipBuffer(audioFile, sampleRate);

    const startFrame = this.quantizeFrame(this.msToFrames(clip.start, sampleRate));
    const requestedFrames = Math.max(1, this.msToFrames(clip.duration, sampleRate));
    const playbackFrames = Math.min(requestedFrames, bufferDescriptor.frames);
    const endFrame = this.quantizeFrame(startFrame + playbackFrames);
    const fadeInFrames = Math.min(
      playbackFrames,
      this.msToFrames(clip.fadeIn, sampleRate),
    );
    const fadeOutFrames = Math.min(
      playbackFrames,
      this.msToFrames(clip.fadeOut, sampleRate),
    );

    const nodeId = `clip:${clip.id}`;
    const node: NodeConfiguration = {
      id: nodeId,
      type: 'clipPlayer',
      options: {
        trackId: track.id,
        bufferKey: bufferDescriptor.bufferKey,
        bufferSampleRate: bufferDescriptor.sampleRate,
        bufferChannels: bufferDescriptor.channels,
        bufferFrames: bufferDescriptor.frames,
        startFrame,
        endFrame,
        gain: clip.gain,
        fadeInFrames,
        fadeOutFrames,
      },
    };

    return {
      node,
      destinationNodeId,
      bufferDescriptor,
    };
  }

  private appendMidiClipEvents(
    clip: Clip,
    instrumentNodeId: string,
    schedules: Map<string, InstrumentSchedule>,
    sampleRate: number,
    bpm: number,
  ): void {
    if (!clip.midi || !Number.isFinite(bpm) || bpm <= 0) {
      return;
    }
    const schedule = schedules.get(instrumentNodeId);
    if (!schedule) {
      throw new Error(`Instrument schedule ${instrumentNodeId} is missing`);
    }
    const clipStartFrame = this.msToFrames(clip.start, sampleRate);
    const framesPerBeat = (sampleRate * 60) / bpm;
    clip.midi.notes.forEach((note) => {
      const noteStart = clipStartFrame + Math.round(note.startBeat * framesPerBeat);
      const noteDuration = Math.max(1, Math.round(note.durationBeats * framesPerBeat));
      schedule.midiEvents.push(
        {
          frame: noteStart,
          type: MidiEventType.NoteOn,
          channel: 0,
          data1: note.pitch,
          data2: note.velocity,
        },
        {
          frame: noteStart + noteDuration,
          type: MidiEventType.NoteOff,
          channel: 0,
          data1: note.pitch,
          data2: 0,
        },
      );
    });
  }

  private async applyInstrumentSchedules(
    schedules: Map<string, InstrumentSchedule>,
    remember = true,
  ): Promise<void> {
    for (const [nodeId, schedule] of schedules) {
      const midiEvents = [...schedule.midiEvents].sort((left, right) => {
        if (left.frame !== right.frame) {
          return left.frame - right.frame;
        }
        if (left.type === right.type) {
          return 0;
        }
        return left.type === MidiEventType.NoteOff ? -1 : 1;
      });
      const parameterEvents = [...schedule.parameterEvents].sort(
        (left, right) => left.frame - right.frame,
      );
      if (midiEvents.length + parameterEvents.length > MAX_INSTRUMENT_EVENTS_PER_NODE) {
        throw new Error(
          `Instrument ${nodeId} exceeds the bounded ${MAX_INSTRUMENT_EVENTS_PER_NODE}-event queue`,
        );
      }
      try {
        await this.audioEngine.sendMidiEvents(nodeId, midiEvents, { replace: true });
        await this.audioEngine.sendInstrumentParameters(nodeId, parameterEvents);
      } catch (error) {
        await this.audioEngine
          .sendMidiEvents(nodeId, [], { replace: true })
          .catch((clearError) => {
            this.logger.error('Failed to clear a partial instrument schedule', {
              nodeId,
              error: clearError,
            });
          });
        throw error;
      }
    }

    if (remember) {
      this.activeInstrumentSchedules.clear();
      schedules.forEach((schedule, nodeId) => {
        this.activeInstrumentSchedules.set(nodeId, {
          midiEvents: schedule.midiEvents.map((event) => ({ ...event })),
          parameterEvents: schedule.parameterEvents.map((event) => ({ ...event })),
        });
      });
    }
  }

  private async applyInstrumentParameterState(
    parameters: Map<string, InstrumentParameterState>,
    replacedNodeIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const [nodeId, next] of parameters) {
      const previous = this.activeInstrumentParameters.get(nodeId);
      // New and replaced nodes already receive the complete parameter map in
      // their configuration. Existing nodes get only the changed values so a
      // persisted knob or preset update does not destroy active voices.
      if (!previous || replacedNodeIds.has(nodeId)) {
        continue;
      }
      for (const [parameterId, value] of next) {
        if (previous.get(parameterId) === value) {
          continue;
        }
        await this.audioEngine.setInstrumentParameter(nodeId, {
          parameterId,
          value,
        });
      }
    }

    this.activeInstrumentParameters.clear();
    parameters.forEach((state, nodeId) => {
      this.activeInstrumentParameters.set(nodeId, new Map(state));
    });
  }

  private instrumentSchedulesEqual(
    left: ReadonlyMap<string, InstrumentSchedule>,
    right: ReadonlyMap<string, InstrumentSchedule>,
  ): boolean {
    if (left.size !== right.size) {
      return false;
    }
    for (const [nodeId, leftSchedule] of left) {
      const rightSchedule = right.get(nodeId);
      if (
        !rightSchedule ||
        leftSchedule.midiEvents.length !== rightSchedule.midiEvents.length ||
        leftSchedule.parameterEvents.length !== rightSchedule.parameterEvents.length
      ) {
        return false;
      }
      if (
        leftSchedule.midiEvents.some((event, index) => {
          const candidate = rightSchedule.midiEvents[index];
          return (
            !candidate ||
            event.frame !== candidate.frame ||
            event.type !== candidate.type ||
            event.channel !== candidate.channel ||
            event.data1 !== candidate.data1 ||
            event.data2 !== candidate.data2
          );
        })
      ) {
        return false;
      }
      if (
        leftSchedule.parameterEvents.some((event, index) => {
          const candidate = rightSchedule.parameterEvents[index];
          return (
            !candidate ||
            event.frame !== candidate.frame ||
            event.parameterId !== candidate.parameterId ||
            event.value !== candidate.value
          );
        })
      ) {
        return false;
      }
    }
    return true;
  }

  private async reconcileClipBuffers(
    nextClipBuffers: Map<string, ClipBufferDescriptor>,
  ): Promise<void> {
    const releaseOperations: Array<Promise<void>> = [];

    nextClipBuffers.forEach((descriptor, clipId) => {
      const previous = this.activeClipBuffers.get(clipId);
      if (!previous) {
        this.bufferCache.retainClipBuffer(descriptor.bufferKey);
        return;
      }
      if (previous.bufferKey !== descriptor.bufferKey) {
        this.bufferCache.retainClipBuffer(descriptor.bufferKey);
        releaseOperations.push(this.bufferCache.releaseClipBuffer(previous.bufferKey));
      }
    });

    this.activeClipBuffers.forEach((descriptor, clipId) => {
      if (!nextClipBuffers.has(clipId)) {
        releaseOperations.push(this.bufferCache.releaseClipBuffer(descriptor.bufferKey));
      }
    });

    if (releaseOperations.length > 0) {
      await Promise.all(releaseOperations);
    }

    this.activeClipBuffers.clear();
    nextClipBuffers.forEach((descriptor, clipId) => {
      this.activeClipBuffers.set(clipId, descriptor);
    });
  }

  private msToFrames(ms: number, sampleRate: number): number {
    if (!Number.isFinite(ms)) {
      throw new Error('Invalid time in milliseconds');
    }
    return Math.max(0, Math.round((ms / 1000) * sampleRate));
  }

  private quantizeFrame(frame: number): number {
    return this.clock.quantizeFrameToBuffer(frame);
  }

  private async preparePluginNodes(
    track: Track,
    graph: RoutingGraph,
    nodes: Map<string, NodeConfiguration>,
    pluginAutomations: Map<string, PluginAutomationRequest>,
    activePluginInstances: Set<string>,
    sessionRevision: number,
    discoveredNodes: Map<string, PluginRoutingNode>,
  ): Promise<void> {
    const pluginNodes = graph.nodes
      .filter(isPluginNode)
      .sort((a, b) => a.order - b.order);

    await Promise.all(
      pluginNodes.map(async (node) => {
        discoveredNodes.set(node.instanceId, node);
        const binding = await this.ensurePluginInstance(node);
        if (!binding) {
          nodes.set(node.id, this.createNodeConfiguration(node));
          return;
        }

        activePluginInstances.add(node.instanceId);
        nodes.set(node.id, {
          id: node.id,
          type: `plugin:${node.slot}`,
          options: {
            instanceId: node.instanceId,
            hostInstanceId: binding.hostInstanceId,
            order: node.order,
            bypassed: node.bypassed ?? false,
            acceptsAudio: node.accepts.includes('audio'),
            acceptsMidi: node.accepts.includes('midi'),
            acceptsSidechain: node.accepts.includes('sidechain'),
            emitsAudio: node.emits.includes('audio'),
            emitsMidi: node.emits.includes('midi'),
            emitsSidechain: node.emits.includes('sidechain'),
          },
        });

        if (!node.automation || node.automation.length === 0) {
          return;
        }

        node.automation.forEach((target) => {
          const curve = track.automationCurves.find(
            (candidate) => candidate.id === target.curveId,
          );
          if (!curve) {
            this.logger.warn(
              `Automation curve ${target.curveId} missing for plugin ${node.instanceId}`,
            );
            return;
          }
          const points = [...curve.points]
            .map<PluginAutomationPoint>((point) => ({
              time: Math.max(0, point.time),
              value: point.value,
            }))
            .sort((a, b) => a.time - b.time);
          const key = `${node.instanceId}:${target.parameterId}`;
          const signature = this.describePluginAutomation(
            sessionRevision,
            node.instanceId,
            target.parameterId,
            points,
          );
          pluginAutomations.set(key, {
            key,
            instanceId: node.instanceId,
            hostInstanceId: binding.hostInstanceId,
            parameterId: target.parameterId,
            signature,
            points,
          });
        });
      }),
    );
  }

  public async retryPluginInstance(sessionInstanceId: string): Promise<boolean> {
    return this.runExclusive(() => this.retryPluginInstanceLocked(sessionInstanceId));
  }

  private async retryPluginInstanceLocked(sessionInstanceId: string): Promise<boolean> {
    if (!this.pluginRecovery) {
      this.logger.warn('Plugin recovery manager unavailable; cannot retry plugin');
      return false;
    }
    return this.pluginRecovery.retry(sessionInstanceId);
  }

  private async ensurePluginInstance(
    node: PluginRoutingNode,
  ): Promise<PluginInstanceBinding | undefined> {
    if (!this.pluginHost) {
      if (this.resolvePluginDescriptor) {
        this.logger.warn(
          `PluginHost unavailable; plugin node ${node.instanceId} will run offline`,
        );
      }
      return undefined;
    }

    if (!this.resolvePluginDescriptor) {
      this.logger.warn(
        `No plugin descriptor resolver configured; skipping plugin ${node.instanceId}`,
      );
      return undefined;
    }

    const existing = this.pluginBindings.get(node.instanceId);

    let descriptor: PluginDescriptor | undefined;
    try {
      descriptor = await this.resolvePluginDescriptor(node.instanceId, node);
    } catch (error) {
      this.logger.error('Failed to resolve plugin descriptor', {
        pluginInstanceId: node.instanceId,
        error,
      });
      return existing;
    }

    if (!descriptor) {
      if (!existing) {
        this.logger.warn(
          `Descriptor resolver returned empty result for plugin ${node.instanceId}`,
        );
        return undefined;
      }
      this.logger.warn(
        `Descriptor resolver returned empty result for plugin ${node.instanceId}; preserving existing binding`,
      );
      return existing;
    }

    if (
      existing &&
      existing.descriptor.identifier === descriptor.identifier &&
      existing.handle.descriptor.version === descriptor.version
    ) {
      existing.descriptor = descriptor;
      return existing;
    }

    const instantiate = async (
      targetDescriptor: PluginDescriptor,
    ): Promise<PluginInstanceBinding> => {
      const handle = await this.pluginHost!.loadPlugin(targetDescriptor, {
        sandboxIdentifier: node.instanceId,
        automationBindings: node.automation?.map((binding) => ({
          parameterId: binding.parameterId,
          curveId: binding.curveId,
        })),
      });
      return {
        descriptor: targetDescriptor,
        hostInstanceId: handle.nativeInstanceId ?? handle.instanceId,
        handle,
      };
    };

    if (!existing) {
      try {
        const binding = await instantiate(descriptor);
        this.pluginBindings.set(node.instanceId, binding);
        return binding;
      } catch (error) {
        this.logger.error('Failed to load plugin instance', {
          pluginInstanceId: node.instanceId,
          error,
        });
        return undefined;
      }
    }

    try {
      const binding = await instantiate(descriptor);
      await this.safeReleasePlugin(existing.hostInstanceId, node.instanceId);
      this.pluginBindings.set(node.instanceId, binding);
      return binding;
    } catch (hotSwapError) {
      this.logger.warn('Plugin hot swap failed; retrying with fresh instance', {
        pluginInstanceId: node.instanceId,
        error: hotSwapError,
      });
    }

    await this.safeReleasePlugin(existing.hostInstanceId, node.instanceId);
    this.pluginBindings.delete(node.instanceId);

    try {
      const binding = await instantiate(descriptor);
      this.pluginBindings.set(node.instanceId, binding);
      return binding;
    } catch (reloadError) {
      this.logger.error('Failed to reload plugin instance', {
        pluginInstanceId: node.instanceId,
        error: reloadError,
      });
      try {
        const restored = await instantiate(existing.descriptor);
        this.pluginBindings.set(node.instanceId, restored);
        return restored;
      } catch (restoreError) {
        this.logger.error('Failed to restore previous plugin instance', {
          pluginInstanceId: node.instanceId,
          error: restoreError,
        });
      }
    }

    return undefined;
  }

  private describePluginAutomation(
    revision: number,
    instanceId: string,
    parameterId: string,
    points: PluginAutomationPoint[],
  ): string {
    const pointSignature = points
      .map((point) => `${Math.round(point.time)}:${point.value.toFixed(6)}`)
      .join('|');
    return `${revision}:${instanceId}:${parameterId}:${pointSignature}`;
  }

  private async applyPluginAutomations(
    requests: Map<string, PluginAutomationRequest>,
  ): Promise<void> {
    const pluginHost = this.pluginHost;
    if (!pluginHost) {
      if (requests.size > 0) {
        this.logger.warn(
          'Plugin automation requests present but PluginHost is unavailable',
        );
      }
      this.pluginAutomationState.clear();
      return;
    }

    const operations: Array<Promise<void>> = [];

    requests.forEach((request) => {
      const previous = this.pluginAutomationState.get(request.key);
      if (previous === request.signature) {
        return;
      }
      operations.push(
        pluginHost
          .scheduleAutomation(request.hostInstanceId, request.parameterId, request.points)
          .then(() => {
            this.pluginAutomationState.set(request.key, request.signature);
          })
          .catch((error) => {
            this.logger.error('Failed to schedule plugin automation', {
              instanceId: request.instanceId,
              parameterId: request.parameterId,
              error,
            });
          }),
      );
    });

    await Promise.all(operations);

    const staleKeys: string[] = [];
    this.pluginAutomationState.forEach((_signature, key) => {
      if (!requests.has(key)) {
        staleKeys.push(key);
      }
    });
    staleKeys.forEach((key) => this.pluginAutomationState.delete(key));
  }

  private async releaseStalePluginInstances(
    activePluginInstances: Set<string>,
  ): Promise<void> {
    const resolver = this.resolvePluginDescriptor;
    const staleBindings = Array.from(this.pluginBindings.entries()).filter(
      ([instanceId]) => !activePluginInstances.has(instanceId),
    );

    staleBindings.forEach(([instanceId]) => {
      resolver?.clearInstance?.(instanceId);
    });

    const releases = staleBindings.map(([instanceId, binding]) =>
      (this.pluginHost
        ? this.safeReleasePlugin(binding.hostInstanceId, instanceId)
        : Promise.resolve()
      ).then(() => {
        this.pluginBindings.delete(instanceId);
        this.pluginRecovery?.forget(instanceId);
      }),
    );

    await Promise.all(releases);

    if (!this.pluginHost) {
      if (activePluginInstances.size === 0) {
        this.pluginBindings.clear();
      }
      return;
    }

    if (activePluginInstances.size === 0) {
      this.pluginAutomationState.clear();
      return;
    }

    for (const key of Array.from(this.pluginAutomationState.keys())) {
      const [instanceId] = key.split(':');
      if (!activePluginInstances.has(instanceId)) {
        this.pluginAutomationState.delete(key);
      }
    }
  }

  private async safeReleasePlugin(
    hostInstanceId: string,
    sessionInstanceId: string,
  ): Promise<void> {
    if (!this.pluginHost) {
      return;
    }
    try {
      await this.pluginHost.releasePlugin(hostInstanceId);
    } catch (error) {
      this.logger.error('Failed to release plugin instance', {
        pluginInstanceId: sessionInstanceId,
        error,
      });
    }
  }

  private startTransportPolling(): void {
    if (!this.supportsTransport || this.transportListeners.size === 0) {
      return;
    }
    if (this.transportPollHandle) {
      return;
    }
    this.refreshTransportState().catch((error) => {
      this.logger.warn('Failed to prime transport state', error);
    });
    if (this.transportPollIntervalMs > 0) {
      this.transportPollHandle = setInterval(() => {
        this.refreshTransportState().catch((error) => {
          this.logger.warn('Transport polling failed', error);
        });
      }, this.transportPollIntervalMs);
      allowProcessToExit(this.transportPollHandle);
    }
  }

  private stopTransportPolling(): void {
    if (!this.transportPollHandle) {
      return;
    }
    clearInterval(this.transportPollHandle);
    this.transportPollHandle = undefined;
  }

  private startDiagnosticsPolling(): void {
    if (!this.supportsDiagnostics || this.diagnosticsListeners.size === 0) {
      return;
    }
    if (this.diagnosticsPollHandle) {
      return;
    }
    this.refreshDiagnosticsState().catch((error) => {
      this.logger.warn('Failed to prime diagnostics state', error);
    });
    if (this.diagnosticsPollIntervalMs > 0) {
      this.diagnosticsPollHandle = setInterval(() => {
        this.refreshDiagnosticsState().catch((error) => {
          this.logger.warn('Diagnostics polling failed', error);
        });
      }, this.diagnosticsPollIntervalMs);
      allowProcessToExit(this.diagnosticsPollHandle);
    }
  }

  private stopDiagnosticsPolling(): void {
    if (!this.diagnosticsPollHandle) {
      return;
    }
    clearInterval(this.diagnosticsPollHandle);
    this.diagnosticsPollHandle = undefined;
  }

  private async refreshTransportState(): Promise<void> {
    if (!this.supportsTransport || this.isTransportPolling) {
      return;
    }
    this.isTransportPolling = true;
    try {
      const state = await this.audioEngine.getTransportState();
      const description = this.clock.describe();
      const seconds = state.frame / description.sampleRate;
      const beats = seconds * (description.bpm / 60);
      const snapshot: AudioTransportSnapshot = {
        frame: state.frame,
        seconds,
        beats,
        bpm: description.bpm,
        sampleRate: description.sampleRate,
        isPlaying: state.isPlaying,
        updatedAt: Date.now(),
      };
      this.commitTransportSnapshot(snapshot);
    } catch (error) {
      this.logger.warn('Failed to refresh transport state', error);
    } finally {
      this.isTransportPolling = false;
    }
  }

  private commitTransportSnapshot(snapshot: AudioTransportSnapshot): void {
    this.transportSnapshot = snapshot;
    this.transportListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error('Transport listener failed', error);
      }
    });
  }

  private async refreshDiagnosticsState(): Promise<void> {
    if (!this.supportsDiagnostics || this.isDiagnosticsPolling) {
      return;
    }
    this.isDiagnosticsPolling = true;
    try {
      const diagnostics = await this.audioEngine.getRenderDiagnostics();
      if (diagnostics.initialized === false) {
        throw new Error('Audio engine is not initialized');
      }
      const renderLoad = clamp(diagnostics.lastRenderDurationMicros / 10_000, 0, 1);
      const snapshot: AudioDiagnosticsSnapshot = {
        status: 'ready',
        xruns: diagnostics.xruns,
        lastRenderDurationMicros: diagnostics.lastRenderDurationMicros,
        clipBufferBytes: diagnostics.clipBufferBytes,
        renderLoad,
        updatedAt: Date.now(),
      };
      this.commitDiagnosticsSnapshot(snapshot);
    } catch (error) {
      this.logger.warn('Failed to refresh audio diagnostics', error);
      const snapshot: AudioDiagnosticsSnapshot = {
        status: 'error',
        xruns: 0,
        renderLoad: 0,
        error: error as Error,
        updatedAt: Date.now(),
      };
      this.commitDiagnosticsSnapshot(snapshot);
    } finally {
      this.isDiagnosticsPolling = false;
    }
  }

  private commitDiagnosticsSnapshot(snapshot: AudioDiagnosticsSnapshot): void {
    this.diagnosticsSnapshot = snapshot;
    this.diagnosticsListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error('Diagnostics listener failed', error);
      }
    });
  }

  public async dispose(): Promise<void> {
    this.setInstrumentInputEnabled(false);
    await this.runExclusive(() => this.disposeLocked());
  }

  private async disposeLocked(): Promise<void> {
    this.stopTransportPolling();
    this.stopDiagnosticsPolling();
    this.transportListeners.clear();
    this.diagnosticsListeners.clear();
    const pending: Array<Promise<void>> = [];
    if (this.pluginHost) {
      this.pluginBindings.forEach((binding, instanceId) => {
        pending.push(this.safeReleasePlugin(binding.hostInstanceId, instanceId));
      });
    }
    this.pluginBindings.clear();
    this.pluginAutomationState.clear();
    this.resolvePluginDescriptor?.clearAll?.();

    this.pluginRecovery?.dispose();
    this.pluginRecovery = undefined;

    this.activeClipBuffers.forEach((descriptor) => {
      pending.push(this.bufferCache.releaseClipBuffer(descriptor.bufferKey));
    });
    this.activeClipBuffers.clear();

    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }
}

export type { AudioFileLoader, AudioFileData } from './bridge/ClipBufferCache';
