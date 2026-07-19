import { Buffer } from 'buffer';
import {
  RTCPeerConnection as NativeRTCPeerConnection,
  type RTCDataChannel,
  type RTCDataChannelInit,
  type RTCConfiguration,
  type RTCIceCandidateInit,
  type RTCPeerConnection,
  type RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import type { Ciphertext, CollabPayload } from './encryption';
import { LatencyCompensator } from './LatencyCompensator';
import {
  type PeerSignalingClient,
  type SignalingAnswer,
  type SignalingIceCandidate,
  type SignalingOffer,
} from './PeerSignalingClient';
import {
  createNetworkDiagnostics,
  type LinkMetrics,
  type NetworkDiagnostics,
} from './diagnostics/NetworkDiagnostics';
import { ConnectionManager } from './ConnectionManager';
import { EncryptionManager, EncryptionResetError } from './EncryptionManager';
import { DiagnosticsManager } from './DiagnosticsManager';
import {
  COLLAB_PROTOCOL_VERSION,
  createHandshakeId,
  createMessageId,
  createPeerEncryptionBinding,
  createPublicKeySignal,
  createSessionBinding,
  parsePublicKeySignal,
  serializePublicKeySignal,
  type AckWireMessage,
  type AuthenticatedPublicKeySignal,
  type CollabProtocolRole,
  type CollabWireMessage,
  type KeyConfirmationWireMessage,
  type ResyncRequestWireMessage,
  type UpdateWireMessage,
  validateWireMessage,
  verifySharedSecretPublicKeySignal,
} from './protocol';
import type { Logger } from './types';

export interface SharedSecretCollabAuthentication {
  readonly mode: 'shared-secret';
  readonly sessionId: string;
  readonly sharedSecret: Uint8Array;
}

export interface RemotePublicKeyVerificationContext {
  readonly sessionId: string;
  readonly senderId: string;
  readonly role: CollabSessionRole;
  readonly publicKey: string;
}

export interface VerifiedKeyCollabAuthentication {
  readonly mode: 'verified-key';
  readonly sessionId: string;
  readonly verifyRemotePublicKey: (
    context: RemotePublicKeyVerificationContext,
  ) => boolean | Promise<boolean>;
}

export type CollabAuthentication =
  | SharedSecretCollabAuthentication
  | VerifiedKeyCollabAuthentication;

export interface RemoteUpdateContext {
  readonly signal: AbortSignal;
}

export interface ResyncRequestContext extends RemoteUpdateContext {
  readonly expectedSequence: number;
}

export interface CollabSessionOptions<T> {
  readonly signalingClient: PeerSignalingClient;
  readonly authentication?: CollabAuthentication;
  /** @deprecated Use authentication.mode = 'shared-secret'. */
  readonly preSharedKey?: Uint8Array;
  /** @deprecated Required only when using the legacy preSharedKey option. */
  readonly sessionId?: string;
  readonly latencyCompensator?: LatencyCompensator;
  readonly networkDiagnostics?: NetworkDiagnostics;
  readonly schemaVersion?: number;
  readonly connectionFactory?: () => RTCPeerConnection;
  readonly logger?: Logger;
  readonly onRemoteUpdate?: (payload: CollabPayload<T>) => void;
  readonly onRemoteUpdateApplied?: (
    payload: CollabPayload<T>,
    context: RemoteUpdateContext,
  ) => Promise<void> | void;
  readonly onResyncRequested?: (
    context: ResyncRequestContext,
  ) => Promise<T | undefined> | T | undefined;
  readonly channelLabel?: string;
  readonly channelConfig?: RTCDataChannelInit;
  readonly minBufferedAmountLowThreshold?: number;
  readonly maxBufferedAmountLowThreshold?: number;
  readonly backpressureTimeoutMs?: number;
  readonly acknowledgementTimeoutMs?: number;
  readonly maxAcknowledgementRetries?: number;
  readonly maxPendingAcknowledgements?: number;
  readonly resyncHistorySize?: number;
  readonly maxBufferedInboundUpdates?: number;
  readonly maxQueuedInboundFrames?: number;
  readonly maxQueuedInboundBytes?: number;
  readonly maxPendingIceCandidates?: number;
  readonly maxIceCandidateBytes?: number;
  readonly maxSdpBytes?: number;
  readonly maxClockSkewMs?: number;
  readonly maxFrameBytes?: number;
}

export type CollabSessionRole = CollabProtocolRole;

export type CollaborationConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export interface CollabSessionHealthSnapshot {
  readonly role: CollabSessionRole | null;
  readonly connectionState: CollaborationConnectionState;
  readonly dataChannelState: RTCDataChannel['readyState'] | 'unknown';
  readonly authenticatedPeerId?: string;
  readonly pendingAcknowledgements: number;
  readonly lastAcknowledgedSequence?: number;
  readonly lastMetrics?: LinkMetrics;
  readonly lastUpdateReceivedAt?: number;
  readonly lastRemoteClock?: number;
  readonly lastLatencyMs?: number;
  readonly averageLatencyMs?: number;
}

type HealthListener = (snapshot: CollabSessionHealthSnapshot) => void;

type PeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

type IceConnectionState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'closed';

type ExtendedPeerConnection = RTCPeerConnection & {
  onconnectionstatechange?: (() => void) | null;
  oniceconnectionstatechange?: (() => void) | null;
  connectionState?: PeerConnectionState;
  iceConnectionState?: IceConnectionState;
};

type BackpressureDataChannel = RTCDataChannel & {
  readonly bufferedAmount?: number;
  onbufferedamountlow?: (() => void) | null;
};

interface ResolvedAuthentication {
  readonly mode: CollabAuthentication['mode'];
  readonly sessionId: string;
  readonly sharedSecret?: Uint8Array;
  readonly verifyRemotePublicKey?: VerifiedKeyCollabAuthentication['verifyRemotePublicKey'];
}

interface PendingAcknowledgement<T> {
  readonly message: UpdateWireMessage<T>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  attempts: number;
  timeout?: ReturnType<typeof setTimeout>;
}

interface BufferedInboundUpdate<T> {
  readonly message: UpdateWireMessage<T>;
  readonly clock: number;
  readonly receiveTime: number;
}

interface BackpressureWaiter {
  readonly generation: number;
  readonly channel: BackpressureDataChannel;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PeerAuthenticationDeferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface InboundQueueUsage {
  frames: number;
  bytes: number;
}

const DEFAULT_CHANNEL_LABEL = 'daft-collab';
const DEFAULT_CHANNEL_CONFIG: RTCDataChannelInit = { ordered: true };
const DEFAULT_MIN_BUFFERED_AMOUNT_LOW_THRESHOLD = 16 * 1024;
const DEFAULT_MAX_BUFFERED_AMOUNT_LOW_THRESHOLD = 512 * 1024;
const INITIAL_BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;
const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 10_000;
const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_ACKNOWLEDGEMENT_RETRIES = 3;
const DEFAULT_MAX_PENDING_ACKNOWLEDGEMENTS = 64;
const DEFAULT_RESYNC_HISTORY_SIZE = 128;
const DEFAULT_MAX_BUFFERED_INBOUND_UPDATES = 128;
const DEFAULT_MAX_QUEUED_INBOUND_FRAMES = 256;
const DEFAULT_MAX_QUEUED_INBOUND_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_ICE_CANDIDATES = 64;
const DEFAULT_MAX_ICE_CANDIDATE_BYTES = 16 * 1024;
const DEFAULT_MAX_SDP_BYTES = 1024 * 1024;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MINIMUM_SHARED_SECRET_BYTES = 16;
const MAX_PENDING_PUBLIC_KEY_SIGNALS = 8;
const MAX_PUBLIC_KEY_SIGNAL_BYTES = 16 * 1024;

type RTCPeerConnectionConstructor = new (
  configuration?: RTCConfiguration,
) => RTCPeerConnection;

function createDefaultPeerConnection(): RTCPeerConnection {
  return new (NativeRTCPeerConnection as unknown as RTCPeerConnectionConstructor)();
}

function requireNonEmptyIdentifier(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0 || value.length > 256) {
    throw new Error(`Collaboration ${name} must be a non-empty identifier`);
  }
  return value.trim();
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Collaboration ${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Collaboration ${name} must be a non-negative integer`);
  }
  return value;
}

function resolveAuthentication<T>(
  options: CollabSessionOptions<T>,
): ResolvedAuthentication {
  const configured = options.authentication;
  if (configured) {
    const sessionId = requireNonEmptyIdentifier(configured.sessionId, 'session id');
    if (configured.mode === 'shared-secret') {
      if (configured.sharedSecret.length < MINIMUM_SHARED_SECRET_BYTES) {
        throw new Error(
          `Collaboration shared secret must contain at least ${MINIMUM_SHARED_SECRET_BYTES} bytes`,
        );
      }
      return {
        mode: 'shared-secret',
        sessionId,
        sharedSecret: new Uint8Array(configured.sharedSecret),
      };
    }
    return {
      mode: 'verified-key',
      sessionId,
      verifyRemotePublicKey: configured.verifyRemotePublicKey,
    };
  }

  if (options.preSharedKey) {
    const sessionId = requireNonEmptyIdentifier(options.sessionId, 'session id');
    if (options.preSharedKey.length < MINIMUM_SHARED_SECRET_BYTES) {
      throw new Error(
        `Collaboration shared secret must contain at least ${MINIMUM_SHARED_SECRET_BYTES} bytes`,
      );
    }
    return {
      mode: 'shared-secret',
      sessionId,
      sharedSecret: new Uint8Array(options.preSharedKey),
    };
  }

  throw new Error(
    'Collaboration requires a session-bound shared secret or an explicit remote public-key verifier',
  );
}

function createPendingAcknowledgement<T>(
  message: UpdateWireMessage<T>,
): PendingAcknowledgement<T> {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    rejectPromise = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
  });
  promise.catch(() => {});
  return {
    message,
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    attempts: 0,
  };
}

function createPeerAuthenticationDeferred(): PeerAuthenticationDeferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    rejectPromise = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
  });
  promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function isCiphertext(value: unknown): value is Ciphertext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.nonce === 'string' && typeof record.box === 'string';
}

export class CollaborationLifecycleError extends Error {
  constructor(message = 'Collaboration lifecycle was cancelled') {
    super(message);
    this.name = 'CollaborationLifecycleError';
  }
}

export class CollaborationAcknowledgementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationAcknowledgementError';
  }
}

export class CollabSessionService<T = unknown> {
  private readonly signalingClient: PeerSignalingClient;
  private readonly authentication: ResolvedAuthentication;
  private readonly latencyCompensator: LatencyCompensator;
  private readonly logger: Logger;
  private readonly schemaVersion: number;
  private readonly channelLabel: string;
  private readonly channelConfig: RTCDataChannelInit;
  private readonly minBufferedThreshold: number;
  private readonly maxBufferedThreshold: number;
  private readonly backpressureTimeoutMs: number;
  private readonly acknowledgementTimeoutMs: number;
  private readonly maxAcknowledgementRetries: number;
  private readonly maxPendingAcknowledgements: number;
  private readonly resyncHistorySize: number;
  private readonly maxBufferedInboundUpdates: number;
  private readonly maxQueuedInboundFrames: number;
  private readonly maxQueuedInboundBytes: number;
  private readonly maxPendingIceCandidates: number;
  private readonly maxIceCandidateBytes: number;
  private readonly maxSdpBytes: number;
  private readonly maxClockSkewMs: number;
  private readonly maxFrameBytes: number;
  private readonly externalUpdateListener?: (payload: CollabPayload<T>) => void;
  private readonly remoteUpdateAppliedHandler?: (
    payload: CollabPayload<T>,
    context: RemoteUpdateContext,
  ) => Promise<void> | void;
  private readonly resyncRequestedHandler?: (
    context: ResyncRequestContext,
  ) => Promise<T | undefined> | T | undefined;
  private readonly connectionManager: ConnectionManager;
  private readonly encryptionManager: EncryptionManager;
  private readonly diagnosticsManager: DiagnosticsManager;
  private readonly localSenderId: string;

  private dataChannel?: RTCDataChannel;
  private peerConnection?: RTCPeerConnection;
  private role: CollabSessionRole | null = null;
  private active = false;
  private lifecycleGeneration = 0;
  private lifecycleAbortController?: AbortController;
  private signalingListenersRegistered = false;
  private handshakeId = createHandshakeId();
  private publicKeyBroadcastGeneration?: number;
  private authenticatedRemoteSenderId?: string;
  private authenticatedRemoteHandshakeId?: string;
  private pendingRemoteSenderId?: string;
  private pendingRemoteHandshakeId?: string;
  private keyConfirmationSentFor?: string;
  private peerAuthentication = createPeerAuthenticationDeferred();
  private readonly seenRemoteHandshakeIds = new Set<string>();
  private readonly pendingPublicKeySignals: string[] = [];

  private nextOutboundSequence = 1;
  private nextExpectedInboundSequence = 1;
  private lastAcknowledgedSequence?: number;
  private resyncRequestedSequence?: number;
  private readonly pendingAcknowledgements = new Map<string, PendingAcknowledgement<T>>();
  private readonly outboundHistory = new Map<number, UpdateWireMessage<T>>();
  private readonly bufferedInboundUpdates = new Map<number, BufferedInboundUpdate<T>>();
  private incomingQueue: Promise<void> = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();
  private readonly backpressureWaiters = new Set<BackpressureWaiter>();
  private readonly inboundQueueUsage = new Map<number, InboundQueueUsage>();

  private readonly healthListeners = new Set<HealthListener>();
  private health: CollabSessionHealthSnapshot = {
    role: null,
    connectionState: 'idle',
    dataChannelState: 'unknown',
    pendingAcknowledgements: 0,
  };
  private lastLatencyMs?: number;
  private averageLatencyMs?: number;

  private readonly boundOfferHandler: (offer: SignalingOffer) => void;
  private readonly boundAnswerHandler: (answer: SignalingAnswer) => void;
  private readonly boundIceHandler: (candidate: SignalingIceCandidate) => void;
  private readonly boundPublicKeyHandler: (publicKeySignal: string) => void;
  private readonly boundShutdownHandler: () => void;

  constructor(options: CollabSessionOptions<T>) {
    this.signalingClient = options.signalingClient;
    this.authentication = resolveAuthentication(options);
    this.latencyCompensator = options.latencyCompensator ?? new LatencyCompensator();
    this.logger = options.logger ?? (() => {});
    this.schemaVersion = requirePositiveInteger(
      options.schemaVersion ?? 1,
      'schema version',
    );
    this.channelLabel = options.channelLabel ?? DEFAULT_CHANNEL_LABEL;
    this.channelConfig = options.channelConfig ?? DEFAULT_CHANNEL_CONFIG;
    this.minBufferedThreshold = requirePositiveInteger(
      options.minBufferedAmountLowThreshold ?? DEFAULT_MIN_BUFFERED_AMOUNT_LOW_THRESHOLD,
      'minimum buffered-amount threshold',
    );
    this.maxBufferedThreshold = requirePositiveInteger(
      options.maxBufferedAmountLowThreshold ?? DEFAULT_MAX_BUFFERED_AMOUNT_LOW_THRESHOLD,
      'maximum buffered-amount threshold',
    );
    if (this.minBufferedThreshold > this.maxBufferedThreshold) {
      throw new Error(
        'Collaboration minimum buffered-amount threshold exceeds its maximum',
      );
    }
    this.backpressureTimeoutMs = requirePositiveInteger(
      options.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS,
      'backpressure timeout',
    );
    this.acknowledgementTimeoutMs = requirePositiveInteger(
      options.acknowledgementTimeoutMs ?? DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS,
      'acknowledgement timeout',
    );
    this.maxAcknowledgementRetries = requireNonNegativeInteger(
      options.maxAcknowledgementRetries ?? DEFAULT_MAX_ACKNOWLEDGEMENT_RETRIES,
      'maximum acknowledgement retries',
    );
    this.maxPendingAcknowledgements = requirePositiveInteger(
      options.maxPendingAcknowledgements ?? DEFAULT_MAX_PENDING_ACKNOWLEDGEMENTS,
      'maximum pending acknowledgements',
    );
    this.resyncHistorySize = requirePositiveInteger(
      options.resyncHistorySize ?? DEFAULT_RESYNC_HISTORY_SIZE,
      'resynchronization history size',
    );
    this.maxBufferedInboundUpdates = requirePositiveInteger(
      options.maxBufferedInboundUpdates ?? DEFAULT_MAX_BUFFERED_INBOUND_UPDATES,
      'maximum buffered inbound updates',
    );
    this.maxQueuedInboundFrames = requirePositiveInteger(
      options.maxQueuedInboundFrames ?? DEFAULT_MAX_QUEUED_INBOUND_FRAMES,
      'maximum queued inbound frames',
    );
    this.maxQueuedInboundBytes = requirePositiveInteger(
      options.maxQueuedInboundBytes ?? DEFAULT_MAX_QUEUED_INBOUND_BYTES,
      'maximum queued inbound bytes',
    );
    this.maxPendingIceCandidates = requirePositiveInteger(
      options.maxPendingIceCandidates ?? DEFAULT_MAX_PENDING_ICE_CANDIDATES,
      'maximum pending ICE candidates',
    );
    this.maxIceCandidateBytes = requirePositiveInteger(
      options.maxIceCandidateBytes ?? DEFAULT_MAX_ICE_CANDIDATE_BYTES,
      'maximum ICE candidate size',
    );
    this.maxSdpBytes = requirePositiveInteger(
      options.maxSdpBytes ?? DEFAULT_MAX_SDP_BYTES,
      'maximum SDP size',
    );
    this.maxClockSkewMs = requirePositiveInteger(
      options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS,
      'maximum clock skew',
    );
    this.maxFrameBytes = requirePositiveInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      'maximum frame size',
    );
    this.externalUpdateListener = options.onRemoteUpdate;
    this.remoteUpdateAppliedHandler = options.onRemoteUpdateApplied;
    this.resyncRequestedHandler = options.onResyncRequested;

    const connectionFactory =
      options.connectionFactory ?? (() => createDefaultPeerConnection());
    const networkDiagnostics = options.networkDiagnostics ?? createNetworkDiagnostics();

    this.connectionManager = new ConnectionManager({
      connectionFactory,
      logger: this.logger,
      onLocalIceCandidate: async (candidate) => {
        if (!this.active || !candidate.candidate || candidate.candidate.trim() === '') {
          if (!candidate.candidate || candidate.candidate.trim() === '') {
            this.logger('collab.emptyIceCandidate');
          }
          return;
        }
        await this.signalingClient.sendIceCandidate(
          this.normalizeIceCandidate(candidate),
        );
      },
      onDataChannel: (channel) => this.attachDataChannel(channel),
      maxPendingRemoteCandidates: this.maxPendingIceCandidates,
      maxIceCandidateBytes: this.maxIceCandidateBytes,
      maxSdpBytes: this.maxSdpBytes,
    });

    this.encryptionManager = new EncryptionManager({
      logger: this.logger,
      preSharedKey: this.authentication.sharedSecret,
      contextBinding: createSessionBinding(this.authentication.sessionId),
    });
    this.localSenderId = this.getLocalPublicKeyFingerprint();

    this.diagnosticsManager = new DiagnosticsManager({
      diagnostics: networkDiagnostics,
      logger: this.logger,
      onMetrics: (metrics) => {
        if (!this.active) {
          return;
        }
        this.tuneDataChannel(metrics);
        this.updateHealth({ lastMetrics: metrics });
      },
    });

    this.boundOfferHandler = (offer) => {
      const generation = this.lifecycleGeneration;
      if (!this.isGenerationActive(generation)) {
        return;
      }
      this.handleOffer(offer, generation).catch((error) => {
        this.logger('collab.handleOfferUnhandledError', { error: String(error) });
      });
    };
    this.boundAnswerHandler = (answer) => {
      const generation = this.lifecycleGeneration;
      if (!this.isGenerationActive(generation)) {
        return;
      }
      this.handleAnswer(answer, generation).catch((error) => {
        this.logger('collab.handleAnswerUnhandledError', { error: String(error) });
      });
    };
    this.boundIceHandler = (candidate) => {
      const generation = this.lifecycleGeneration;
      if (!this.isGenerationActive(generation)) {
        return;
      }
      this.handleIceCandidate(candidate, generation).catch((error) => {
        this.logger('collab.handleIceCandidateUnhandledError', {
          error: String(error),
        });
      });
    };
    this.boundPublicKeyHandler = (publicKeySignal) => {
      if (
        typeof publicKeySignal !== 'string' ||
        Buffer.byteLength(publicKeySignal, 'utf8') > MAX_PUBLIC_KEY_SIGNAL_BYTES
      ) {
        this.logger('collab.publicKeyRejected', {
          error: 'Collaboration public-key signal exceeds the size limit',
        });
        return;
      }
      if (!this.active) {
        if (this.pendingPublicKeySignals.length >= MAX_PENDING_PUBLIC_KEY_SIGNALS) {
          this.pendingPublicKeySignals.shift();
        }
        this.pendingPublicKeySignals.push(publicKeySignal);
        return;
      }
      const generation = this.lifecycleGeneration;
      this.handlePublicKeySignal(publicKeySignal, generation, true).catch((error) => {
        this.logger('collab.publicKeyRejected', { error: String(error) });
      });
    };
    this.boundShutdownHandler = () => this.stop();

    this.registerSignalingListeners();
  }

  getLocalPublicKey(): string {
    return this.encryptionManager.getLocalPublicKey();
  }

  getLocalSenderId(): string {
    return this.localSenderId;
  }

  async start(role: CollabSessionRole): Promise<void> {
    if (this.active) {
      throw new Error('Collaboration session is already active');
    }
    this.registerSignalingListeners();
    const generation = ++this.lifecycleGeneration;
    this.active = true;
    this.role = role;
    this.handshakeId = createHandshakeId();
    this.publicKeyBroadcastGeneration = undefined;
    this.authenticatedRemoteSenderId = undefined;
    this.authenticatedRemoteHandshakeId = undefined;
    this.pendingRemoteSenderId = undefined;
    this.pendingRemoteHandshakeId = undefined;
    this.keyConfirmationSentFor = undefined;
    this.peerAuthentication.reject(
      new CollaborationLifecycleError('Collaboration restarted'),
    );
    this.peerAuthentication = createPeerAuthenticationDeferred();
    this.seenRemoteHandshakeIds.clear();
    this.lifecycleAbortController = new AbortController();
    this.resetReliabilityState(
      new CollaborationLifecycleError('Collaboration restarted'),
    );

    try {
      const connection = this.connectionManager.getOrCreate();
      this.assertGenerationActive(generation);
      this.peerConnection = connection;
      this.attachConnectionObservers(connection, generation);
      this.updateHealth({
        role,
        connectionState: 'connecting',
        dataChannelState: this.dataChannel?.readyState ?? 'unknown',
        authenticatedPeerId: undefined,
        pendingAcknowledgements: 0,
      });

      const queuedSignals = this.pendingPublicKeySignals.splice(0);
      for (const signal of queuedSignals) {
        try {
          await this.handlePublicKeySignal(signal, generation, false);
        } catch (error) {
          this.logger('collab.publicKeyRejected', { error: String(error) });
          throw error;
        }
      }
      this.assertGenerationActive(generation);

      if (role === 'initiator') {
        const channel = this.connectionManager.createDataChannel(
          this.channelLabel,
          this.channelConfig,
        );
        this.attachDataChannel(channel);
      }

      await this.broadcastPublicKey(generation);
      this.assertGenerationActive(generation);
      this.diagnosticsManager.start();

      if (role === 'initiator') {
        const offer = await this.connectionManager.createOffer();
        this.assertGenerationActive(generation);
        await this.connectionManager.setLocalDescription(offer);
        this.assertGenerationActive(generation);
        await this.signalingClient.sendOffer(this.normalizeOffer(offer));
        this.assertGenerationActive(generation);
      }
    } catch (error) {
      if (this.isGenerationActive(generation)) {
        this.stop();
      }
      throw error;
    }
  }

  async broadcastUpdate(payload: T): Promise<void> {
    if (!this.active || !this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Collaboration channel is not ready');
    }
    const generation = this.requireActiveGeneration();
    return this.queueOutboundUpdate(payload, false, generation);
  }

  stop(): void {
    const wasActive = this.active;
    ++this.lifecycleGeneration;
    this.active = false;
    this.lifecycleAbortController?.abort();
    this.lifecycleAbortController = undefined;
    this.logger('collab.stop', { wasActive });
    this.unregisterSignalingListeners();
    this.signalingClient.disconnect().catch((error) => {
      this.logger('collab.signalingDisconnectError', { error: String(error) });
    });
    this.diagnosticsManager.stop();
    this.detachAndCloseDataChannel();
    this.detachConnectionObservers();
    this.connectionManager.close();
    this.peerConnection = undefined;
    this.encryptionManager.reset(new EncryptionResetError('Collaboration stopped'));
    this.peerAuthentication.reject(
      new CollaborationLifecycleError('Collaboration stopped'),
    );
    this.rejectBackpressureWaiters(
      new CollaborationLifecycleError('Collaboration stopped'),
    );
    this.resetReliabilityState(new CollaborationLifecycleError('Collaboration stopped'));
    this.authenticatedRemoteSenderId = undefined;
    this.authenticatedRemoteHandshakeId = undefined;
    this.pendingRemoteSenderId = undefined;
    this.pendingRemoteHandshakeId = undefined;
    this.keyConfirmationSentFor = undefined;
    this.seenRemoteHandshakeIds.clear();
    this.publicKeyBroadcastGeneration = undefined;
    this.pendingPublicKeySignals.splice(0);
    this.lastLatencyMs = undefined;
    this.averageLatencyMs = undefined;
    this.sendQueue = Promise.resolve();
    this.incomingQueue = Promise.resolve();
    this.inboundQueueUsage.clear();
    this.updateHealth({
      connectionState: 'disconnected',
      dataChannelState: 'closed',
      authenticatedPeerId: undefined,
      pendingAcknowledgements: 0,
    });
  }

  getHealthSnapshot(): CollabSessionHealthSnapshot {
    return this.cloneHealth();
  }

  subscribeHealth(listener: HealthListener): () => void {
    this.healthListeners.add(listener);
    try {
      listener(this.cloneHealth());
    } catch (error) {
      this.logger('collab.healthListenerError', { error: String(error) });
    }
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  private getLocalPublicKeyFingerprint(): string {
    return createPublicKeySignal({
      sessionId: this.authentication.sessionId,
      role: 'initiator',
      publicKey: this.encryptionManager.getLocalPublicKey(),
      sharedSecret: this.authentication.sharedSecret,
      handshakeId: this.handshakeId,
    }).senderId;
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (!this.active) {
      try {
        channel.close();
      } catch (error) {
        this.logger('collab.staleDataChannelCloseError', { error: String(error) });
      }
      return;
    }
    if (this.dataChannel && this.dataChannel !== channel) {
      this.detachAndCloseDataChannel();
    }
    const generation = this.lifecycleGeneration;
    this.dataChannel = channel;
    const extendedChannel = channel as BackpressureDataChannel;
    channel.onopen = () => {
      if (!this.isCurrentChannel(channel, generation)) {
        return;
      }
      this.logger('collab.dataChannel.open', {
        label: channel.label,
        readyState: channel.readyState,
      });
      this.updateHealth({
        connectionState: 'connected',
        dataChannelState: channel.readyState,
      });
      this.sendKeyConfirmationIfReady(generation).catch((error) => {
        this.keyConfirmationSentFor = undefined;
        this.logger('collab.keyConfirmationSendError', { error: String(error) });
      });
    };
    channel.onclose = () => {
      if (!this.isCurrentChannel(channel, generation)) {
        return;
      }
      this.logger('collab.dataChannel.close');
      this.rejectPendingAcknowledgements(
        new CollaborationLifecycleError('Collaboration data channel closed'),
      );
      this.rejectBackpressureWaiters(
        new CollaborationLifecycleError('Collaboration data channel closed'),
        channel,
      );
      this.updateHealth({
        connectionState: 'disconnected',
        dataChannelState: channel.readyState,
      });
    };
    channel.onerror = (event: unknown) => {
      if (this.isCurrentChannel(channel, generation)) {
        this.logger('collab.dataChannel.error', { error: JSON.stringify(event) });
      }
    };
    channel.onmessage = (event: { data: unknown }) => {
      if (!this.isCurrentChannel(channel, generation)) {
        return;
      }
      const frameBytes =
        typeof event.data === 'string'
          ? Buffer.byteLength(event.data, 'utf8')
          : this.maxFrameBytes + 1;
      if (!this.reserveInboundQueueCapacity(generation, frameBytes)) {
        this.logger('collab.incomingQueueOverflow', {
          frameBytes,
          generation,
        });
        return;
      }
      const processing = this.incomingQueue.then(() =>
        this.handleIncomingFrame(event.data, generation),
      );
      this.incomingQueue = processing
        .catch((error) => {
          this.logger('collab.incomingFrameError', { error: String(error) });
        })
        .finally(() => {
          this.releaseInboundQueueCapacity(generation, frameBytes);
        });
    };
    extendedChannel.onbufferedamountlow = () => {
      if (this.isCurrentChannel(channel, generation)) {
        this.releaseBackpressureWaiters(channel);
      }
    };
    this.configureDataChannelForNetwork();
    this.updateHealth({ dataChannelState: channel.readyState });
  }

  private detachAndCloseDataChannel(): void {
    if (!this.dataChannel) {
      return;
    }
    const channel = this.dataChannel;
    this.dataChannel = undefined;
    channel.onopen = null;
    channel.onclose = null;
    channel.onerror = null;
    channel.onmessage = null;
    (channel as BackpressureDataChannel).onbufferedamountlow = null;
    try {
      channel.close();
    } catch (error) {
      this.logger('collab.dataChannelCloseError', { error: String(error) });
    }
  }

  private configureDataChannelForNetwork(): void {
    if (!this.dataChannel) {
      return;
    }
    const initial = Math.min(
      this.maxBufferedThreshold,
      Math.max(this.minBufferedThreshold, INITIAL_BUFFERED_AMOUNT_LOW_THRESHOLD),
    );
    this.dataChannel.bufferedAmountLowThreshold = initial;
  }

  private async handleOffer(offer: SignalingOffer, generation: number): Promise<void> {
    this.assertGenerationActive(generation);
    if (this.role !== 'responder') {
      throw new Error('Only a collaboration responder may accept an offer');
    }
    if (
      !offer ||
      offer.type !== 'offer' ||
      typeof offer.sdp !== 'string' ||
      offer.sdp.length === 0 ||
      Buffer.byteLength(offer.sdp, 'utf8') > this.maxSdpBytes
    ) {
      throw new Error('Collaboration offer SDP exceeds the configured size limit');
    }
    const description: RTCSessionDescriptionInit = { type: offer.type, sdp: offer.sdp };
    await this.connectionManager.setRemoteDescription(description);
    this.assertGenerationActive(generation);
    const answer = await this.connectionManager.createAnswer();
    this.assertGenerationActive(generation);
    await this.connectionManager.setLocalDescription(answer);
    this.assertGenerationActive(generation);
    await this.signalingClient.sendAnswer(this.normalizeAnswer(answer));
    this.assertGenerationActive(generation);
  }

  private async handleAnswer(answer: SignalingAnswer, generation: number): Promise<void> {
    this.assertGenerationActive(generation);
    if (this.role !== 'initiator') {
      throw new Error('Only a collaboration initiator may accept an answer');
    }
    if (
      !answer ||
      answer.type !== 'answer' ||
      typeof answer.sdp !== 'string' ||
      answer.sdp.length === 0 ||
      Buffer.byteLength(answer.sdp, 'utf8') > this.maxSdpBytes
    ) {
      throw new Error('Collaboration answer SDP exceeds the configured size limit');
    }
    const description: RTCSessionDescriptionInit = {
      type: answer.type,
      sdp: answer.sdp,
    };
    await this.connectionManager.setRemoteDescription(description);
    this.assertGenerationActive(generation);
  }

  private async handleIceCandidate(
    candidate: SignalingIceCandidate,
    generation: number,
  ): Promise<void> {
    this.assertGenerationActive(generation);
    if (
      !candidate ||
      typeof candidate.candidate !== 'string' ||
      candidate.candidate.trim().length === 0 ||
      Buffer.byteLength(candidate.candidate, 'utf8') > this.maxIceCandidateBytes ||
      (candidate.sdpMid !== undefined &&
        candidate.sdpMid !== null &&
        (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 256)) ||
      (candidate.sdpMLineIndex !== undefined &&
        candidate.sdpMLineIndex !== null &&
        (!Number.isSafeInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0))
    ) {
      throw new Error('Collaboration ICE candidate exceeds the configured size limit');
    }
    const rtcCandidate: RTCIceCandidateInit = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
    };
    await this.connectionManager.addIceCandidate(rtcCandidate);
    this.assertGenerationActive(generation);
  }

  private async handlePublicKeySignal(
    value: string,
    generation: number,
    respondToNewHandshake: boolean,
  ): Promise<void> {
    this.assertGenerationActive(generation);
    const signal = parsePublicKeySignal(value);
    if (signal.sessionId !== this.authentication.sessionId) {
      throw new Error('Collaboration public key was bound to a different session');
    }
    if (signal.senderId === this.localSenderId) {
      throw new Error('Collaboration rejected a reflected local public key');
    }
    if (!this.role || signal.role === this.role) {
      throw new Error('Collaboration public key has an invalid peer role');
    }

    if (this.authenticatedRemoteSenderId || this.authenticatedRemoteHandshakeId) {
      if (
        this.authenticatedRemoteSenderId === signal.senderId &&
        this.authenticatedRemoteHandshakeId === signal.handshakeId
      ) {
        return;
      }
      throw new Error(
        'Collaboration rejected an unsolicited peer re-handshake; restart the lifecycle first',
      );
    }
    if (this.pendingRemoteSenderId || this.pendingRemoteHandshakeId) {
      if (
        this.pendingRemoteSenderId === signal.senderId &&
        this.pendingRemoteHandshakeId === signal.handshakeId
      ) {
        await this.sendKeyConfirmationIfReady(generation);
        return;
      }
      throw new Error('Collaboration peer handshake changed before key confirmation');
    }
    if (this.seenRemoteHandshakeIds.has(signal.handshakeId)) {
      throw new Error('Collaboration rejected a stale peer handshake');
    }

    await this.verifyPublicKeySignal(signal);
    this.assertGenerationActive(generation);

    this.pendingRemoteSenderId = signal.senderId;
    this.pendingRemoteHandshakeId = signal.handshakeId;
    this.keyConfirmationSentFor = undefined;
    this.encryptionManager.setRemotePublicKey(
      signal.publicKey,
      createPeerEncryptionBinding({
        sessionId: this.authentication.sessionId,
        localSenderId: this.localSenderId,
        localHandshakeId: this.handshakeId,
        remoteSenderId: signal.senderId,
        remoteHandshakeId: signal.handshakeId,
      }),
    );
    this.resetInboundReliabilityState();

    if (respondToNewHandshake && this.publicKeyBroadcastGeneration === generation) {
      await this.broadcastPublicKey(generation);
    }
    await this.sendKeyConfirmationIfReady(generation);
  }

  private async sendKeyConfirmationIfReady(generation: number): Promise<void> {
    const remoteSenderId = this.pendingRemoteSenderId;
    const remoteHandshakeId = this.pendingRemoteHandshakeId;
    if (
      !remoteSenderId ||
      !remoteHandshakeId ||
      !this.dataChannel ||
      this.dataChannel.readyState !== 'open'
    ) {
      return;
    }
    const confirmationKey = `${remoteSenderId}:${remoteHandshakeId}:${this.handshakeId}`;
    if (this.keyConfirmationSentFor === confirmationKey) {
      return;
    }
    this.keyConfirmationSentFor = confirmationKey;
    const confirmation: KeyConfirmationWireMessage = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: this.authentication.sessionId,
      senderId: this.localSenderId,
      kind: 'key-confirmation',
      handshakeId: this.handshakeId,
      peerHandshakeId: remoteHandshakeId,
    };
    try {
      await this.sendWireMessage(confirmation, generation);
    } catch (error) {
      if (this.keyConfirmationSentFor === confirmationKey) {
        this.keyConfirmationSentFor = undefined;
      }
      throw error;
    }
  }

  private async processKeyConfirmation(
    message: KeyConfirmationWireMessage,
    generation: number,
  ): Promise<void> {
    this.assertGenerationActive(generation);
    if (this.authenticatedRemoteSenderId || this.authenticatedRemoteHandshakeId) {
      if (
        message.senderId === this.authenticatedRemoteSenderId &&
        message.handshakeId === this.authenticatedRemoteHandshakeId &&
        message.peerHandshakeId === this.handshakeId
      ) {
        return;
      }
      throw new Error('Collaboration key confirmation changed after authentication');
    }
    if (
      message.senderId !== this.pendingRemoteSenderId ||
      message.handshakeId !== this.pendingRemoteHandshakeId ||
      message.peerHandshakeId !== this.handshakeId
    ) {
      throw new Error(
        'Collaboration key confirmation does not match the active transcript',
      );
    }
    // The peer may have sent its first confirmation before our key signal was
    // delivered. Echo once after receiving proof so both sides can finish.
    this.keyConfirmationSentFor = undefined;
    await this.sendKeyConfirmationIfReady(generation);
    this.assertGenerationActive(generation);
    const remoteSenderId = this.pendingRemoteSenderId;
    const remoteHandshakeId = this.pendingRemoteHandshakeId;
    if (!remoteSenderId || !remoteHandshakeId) {
      throw new Error('Collaboration key confirmation has no pending peer');
    }
    this.authenticatedRemoteSenderId = remoteSenderId;
    this.authenticatedRemoteHandshakeId = remoteHandshakeId;
    this.seenRemoteHandshakeIds.add(remoteHandshakeId);
    this.pendingRemoteSenderId = undefined;
    this.pendingRemoteHandshakeId = undefined;
    this.peerAuthentication.resolve();
    this.logger('collab.peerAuthenticated', {
      peerId: remoteSenderId,
      sessionId: this.authentication.sessionId,
    });
    this.updateHealth({ authenticatedPeerId: remoteSenderId });
  }

  private async verifyPublicKeySignal(
    signal: AuthenticatedPublicKeySignal,
  ): Promise<void> {
    if (this.authentication.mode === 'shared-secret') {
      if (
        !this.authentication.sharedSecret ||
        !verifySharedSecretPublicKeySignal(signal, this.authentication.sharedSecret)
      ) {
        throw new Error('Collaboration public-key authentication failed');
      }
      return;
    }
    if (signal.authenticationMode !== 'verified-key') {
      throw new Error('Collaboration peer used an unexpected authentication mode');
    }
    const verifier = this.authentication.verifyRemotePublicKey;
    if (!verifier) {
      throw new Error('Collaboration public-key verifier is unavailable');
    }
    const accepted = await verifier({
      sessionId: signal.sessionId,
      senderId: signal.senderId,
      role: signal.role,
      publicKey: signal.publicKey,
    });
    if (!accepted) {
      throw new Error('Collaboration remote public key was not verified');
    }
  }

  private async queueOutboundUpdate(
    payload: T,
    resync: boolean,
    generation: number,
  ): Promise<void> {
    this.assertChannelReady(generation);
    await this.encryptionManager.waitUntilReady();
    await this.peerAuthentication.promise;
    this.assertChannelReady(generation);
    if (this.pendingAcknowledgements.size >= this.maxPendingAcknowledgements) {
      throw new CollaborationAcknowledgementError(
        'Collaboration outbound acknowledgement window is full',
      );
    }
    const sequence = this.nextOutboundSequence;
    this.nextOutboundSequence += 1;
    const message: UpdateWireMessage<T> = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: this.authentication.sessionId,
      senderId: this.localSenderId,
      kind: 'update',
      messageId: createMessageId(this.localSenderId, sequence),
      sequence,
      payload,
      resync: resync || undefined,
    };
    const pending = createPendingAcknowledgement(message);
    this.pendingAcknowledgements.set(message.messageId, pending);
    this.outboundHistory.set(message.sequence, message);
    this.pruneOutboundHistory();
    this.updateHealth({ pendingAcknowledgements: this.pendingAcknowledgements.size });

    try {
      await this.sendPendingAcknowledgement(pending, generation);
      await pending.promise;
    } catch (error) {
      this.removePendingAcknowledgement(message.messageId);
      throw error;
    }
  }

  private async sendPendingAcknowledgement(
    pending: PendingAcknowledgement<T>,
    generation: number,
  ): Promise<void> {
    if (!this.pendingAcknowledgements.has(pending.message.messageId)) {
      return;
    }
    this.assertChannelReady(generation);
    pending.attempts += 1;
    await this.sendWireMessage(pending.message, generation);
    if (!this.pendingAcknowledgements.has(pending.message.messageId)) {
      return;
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.timeout = setTimeout(() => {
      if (!this.pendingAcknowledgements.has(pending.message.messageId)) {
        return;
      }
      if (pending.attempts > this.maxAcknowledgementRetries) {
        const error = new CollaborationAcknowledgementError(
          `Collaboration update ${pending.message.messageId} was not acknowledged`,
        );
        this.removePendingAcknowledgement(pending.message.messageId, error);
        this.logger('collab.acknowledgementTimeout', {
          messageId: pending.message.messageId,
          attempts: pending.attempts,
        });
        return;
      }
      this.sendPendingAcknowledgement(pending, generation).catch((error) => {
        this.removePendingAcknowledgement(
          pending.message.messageId,
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }, this.acknowledgementTimeoutMs);
  }

  private async sendWireMessage(
    message: CollabWireMessage<T>,
    generation: number,
    clock = Date.now(),
  ): Promise<void> {
    await this.encryptionManager.waitUntilReady();
    this.assertChannelReady(generation);
    const encrypted = this.encryptionManager.requireContext().encrypt({
      clock,
      schemaVersion: this.schemaVersion,
      body: message,
    });
    const serialized = JSON.stringify(encrypted);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxFrameBytes) {
      throw new Error('Collaboration frame exceeds the configured size limit');
    }
    const sendOperation = this.sendQueue.then(async () => {
      this.assertChannelReady(generation);
      const channel = this.dataChannel as BackpressureDataChannel;
      await this.waitForBackpressure(channel, serialized, generation);
      this.assertChannelReady(generation);
      channel.send(serialized);
    });
    this.sendQueue = sendOperation.catch(() => {});
    await sendOperation;
  }

  private async waitForBackpressure(
    channel: BackpressureDataChannel,
    serialized: string,
    generation: number,
  ): Promise<void> {
    const frameBytes = Buffer.byteLength(serialized, 'utf8');
    const deadline = Date.now() + this.backpressureTimeoutMs;
    while (true) {
      this.assertChannelReady(generation);
      const bufferedAmount =
        typeof channel.bufferedAmount === 'number' ? channel.bufferedAmount : 0;
      if (
        bufferedAmount === 0 ||
        bufferedAmount + frameBytes <= this.maxBufferedThreshold
      ) {
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Collaboration data-channel backpressure timed out');
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = {} as BackpressureWaiter;
        const timeout = setTimeout(
          () => {
            this.backpressureWaiters.delete(waiter);
            resolve();
          },
          Math.min(50, remaining),
        );
        Object.assign(waiter, {
          generation,
          channel,
          timeout,
          resolve: () => {
            clearTimeout(timeout);
            this.backpressureWaiters.delete(waiter);
            resolve();
          },
          reject: (error: Error) => {
            clearTimeout(timeout);
            this.backpressureWaiters.delete(waiter);
            reject(error);
          },
        });
        this.backpressureWaiters.add(waiter);
      });
    }
  }

  private releaseBackpressureWaiters(channel: RTCDataChannel): void {
    [...this.backpressureWaiters].forEach((waiter) => {
      if (waiter.channel === channel) {
        waiter.resolve();
      }
    });
  }

  private rejectBackpressureWaiters(error: Error, channel?: RTCDataChannel): void {
    [...this.backpressureWaiters].forEach((waiter) => {
      if (!channel || waiter.channel === channel) {
        waiter.reject(error);
      }
    });
  }

  private reserveInboundQueueCapacity(generation: number, frameBytes: number): boolean {
    if (frameBytes > this.maxFrameBytes || frameBytes > this.maxQueuedInboundBytes) {
      return false;
    }
    const usage = this.inboundQueueUsage.get(generation) ?? { frames: 0, bytes: 0 };
    if (
      usage.frames >= this.maxQueuedInboundFrames ||
      usage.bytes + frameBytes > this.maxQueuedInboundBytes
    ) {
      return false;
    }
    usage.frames += 1;
    usage.bytes += frameBytes;
    this.inboundQueueUsage.set(generation, usage);
    return true;
  }

  private releaseInboundQueueCapacity(generation: number, frameBytes: number): void {
    const usage = this.inboundQueueUsage.get(generation);
    if (!usage) {
      return;
    }
    usage.frames = Math.max(0, usage.frames - 1);
    usage.bytes = Math.max(0, usage.bytes - frameBytes);
    if (usage.frames === 0) {
      this.inboundQueueUsage.delete(generation);
    }
  }

  private async handleIncomingFrame(frame: unknown, generation: number): Promise<void> {
    this.assertGenerationActive(generation);
    if (typeof frame !== 'string') {
      throw new Error('Collaboration frame must be a string');
    }
    if (Buffer.byteLength(frame, 'utf8') > this.maxFrameBytes) {
      throw new Error('Collaboration frame exceeds the configured size limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch (error) {
      throw new Error(`Unable to parse collaboration frame: ${String(error)}`);
    }
    if (!isCiphertext(parsed)) {
      throw new Error('Invalid collaboration ciphertext envelope');
    }

    let decrypted: CollabPayload<unknown>;
    try {
      decrypted = this.encryptionManager.requireContext().decrypt(parsed);
    } catch (error) {
      throw new Error(`Unable to decrypt collaboration frame: ${String(error)}`);
    }
    this.assertGenerationActive(generation);
    const receiveTime = Date.now();
    this.validatePayloadEnvelope(decrypted, receiveTime);
    const message = validateWireMessage<T>(decrypted.body);
    if (
      message.kind !== 'key-confirmation' &&
      decrypted.schemaVersion !== this.schemaVersion
    ) {
      throw new Error(
        `Unsupported collaboration schema version ${decrypted.schemaVersion}`,
      );
    }
    if (message.sessionId !== this.authentication.sessionId) {
      throw new Error('Collaboration frame targeted a different session');
    }
    const expectedSenderId =
      message.kind === 'key-confirmation'
        ? (this.pendingRemoteSenderId ?? this.authenticatedRemoteSenderId)
        : this.authenticatedRemoteSenderId;
    if (!expectedSenderId || message.senderId !== expectedSenderId) {
      throw new Error('Collaboration frame sender is not the authenticated peer');
    }
    await this.processWireMessage(message, decrypted.clock, receiveTime, generation);
  }

  private validatePayloadEnvelope(
    payload: CollabPayload<unknown>,
    receiveTime: number,
  ): void {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid collaboration payload envelope');
    }
    if (!Number.isSafeInteger(payload.clock) || payload.clock <= 0) {
      throw new Error('Invalid collaboration payload clock');
    }
    if (Math.abs(receiveTime - payload.clock) > this.maxClockSkewMs) {
      throw new Error('Collaboration payload clock is outside the accepted window');
    }
    if (!Number.isSafeInteger(payload.schemaVersion) || payload.schemaVersion <= 0) {
      throw new Error('Invalid collaboration payload schema version');
    }
  }

  private async processWireMessage(
    message: CollabWireMessage<T>,
    clock: number,
    receiveTime: number,
    generation: number,
  ): Promise<void> {
    this.assertGenerationActive(generation);
    switch (message.kind) {
      case 'ack':
        this.processAcknowledgement(message);
        return;
      case 'resync-request':
        await this.processResyncRequest(message, generation);
        return;
      case 'key-confirmation':
        await this.processKeyConfirmation(message, generation);
        return;
      case 'update':
        await this.processInboundUpdate({ message, clock, receiveTime }, generation);
        return;
    }
  }

  private processAcknowledgement(message: AckWireMessage): void {
    const pending = this.pendingAcknowledgements.get(message.messageId);
    if (!pending || pending.message.sequence !== message.sequence) {
      this.logger('collab.acknowledgementIgnored', {
        messageId: message.messageId,
        sequence: message.sequence,
      });
      return;
    }
    this.lastAcknowledgedSequence = Math.max(
      this.lastAcknowledgedSequence ?? 0,
      message.sequence,
    );
    this.removePendingAcknowledgement(message.messageId);
    this.updateHealth({
      lastAcknowledgedSequence: this.lastAcknowledgedSequence,
      pendingAcknowledgements: this.pendingAcknowledgements.size,
    });
  }

  private async processInboundUpdate(
    inbound: BufferedInboundUpdate<T>,
    generation: number,
  ): Promise<void> {
    const { message } = inbound;
    if (message.resync) {
      if (
        this.resyncRequestedSequence === undefined ||
        message.sequence < this.resyncRequestedSequence
      ) {
        this.logger('collab.unsolicitedResyncRejected', {
          sequence: message.sequence,
        });
        return;
      }
      if (await this.applyInboundUpdate(inbound, generation)) {
        this.nextExpectedInboundSequence = message.sequence + 1;
        this.resyncRequestedSequence = undefined;
        this.bufferedInboundUpdates.clear();
        await this.sendAcknowledgement(message, generation);
      }
      return;
    }

    if (message.sequence < this.nextExpectedInboundSequence) {
      this.logger('collab.replayIgnored', {
        messageId: message.messageId,
        sequence: message.sequence,
      });
      await this.sendAcknowledgement(message, generation);
      return;
    }
    if (message.sequence > this.nextExpectedInboundSequence) {
      if (this.bufferedInboundUpdates.size >= this.maxBufferedInboundUpdates) {
        this.logger('collab.inboundBufferFull', {
          expectedSequence: this.nextExpectedInboundSequence,
          receivedSequence: message.sequence,
        });
      } else {
        this.bufferedInboundUpdates.set(message.sequence, inbound);
      }
      await this.requestResynchronization(generation);
      return;
    }

    if (!(await this.applyInboundUpdate(inbound, generation))) {
      return;
    }
    this.nextExpectedInboundSequence += 1;
    await this.sendAcknowledgement(message, generation);
    await this.drainBufferedInboundUpdates(generation);
  }

  private async drainBufferedInboundUpdates(generation: number): Promise<void> {
    while (true) {
      this.assertGenerationActive(generation);
      const buffered = this.bufferedInboundUpdates.get(this.nextExpectedInboundSequence);
      if (!buffered) {
        return;
      }
      this.bufferedInboundUpdates.delete(this.nextExpectedInboundSequence);
      if (!(await this.applyInboundUpdate(buffered, generation))) {
        this.bufferedInboundUpdates.set(buffered.message.sequence, buffered);
        return;
      }
      this.nextExpectedInboundSequence += 1;
      await this.sendAcknowledgement(buffered.message, generation);
    }
  }

  private async applyInboundUpdate(
    inbound: BufferedInboundUpdate<T>,
    generation: number,
  ): Promise<boolean> {
    this.assertGenerationActive(generation);
    const { message, clock, receiveTime } = inbound;
    const offset = this.latencyCompensator.update({
      remoteClock: clock,
      receivedAt: receiveTime,
    });
    const compensatedClock = clock - offset;
    const normalizedPayload: CollabPayload<T> = {
      clock: compensatedClock,
      schemaVersion: this.schemaVersion,
      body: message.payload,
    };
    const latencyMs = Math.max(0, receiveTime - clock);
    const diagnosticsContext = this.diagnosticsManager.getLatestSanitizedMetrics();
    const baseLogContext: Record<string, unknown> = {
      messageId: message.messageId,
      sequence: message.sequence,
      remoteClock: clock,
      compensatedClock,
      latencyMs,
      schemaVersion: this.schemaVersion,
    };
    if (diagnosticsContext) {
      baseLogContext.diagnostics = diagnosticsContext;
    }
    this.logger('collab.remoteUpdate.received', baseLogContext);

    const signal = this.lifecycleAbortController?.signal;
    if (!signal || signal.aborted) {
      return false;
    }
    if (this.remoteUpdateAppliedHandler) {
      const applyStart = Date.now();
      try {
        await this.remoteUpdateAppliedHandler(normalizedPayload, { signal });
        this.assertGenerationActive(generation);
        if (signal.aborted) {
          return false;
        }
        this.logger('collab.remoteUpdate.applied', {
          ...baseLogContext,
          applyDurationMs: Date.now() - applyStart,
        });
      } catch (error) {
        if (signal.aborted || !this.isGenerationActive(generation)) {
          this.logger('collab.remoteUpdate.cancelled', baseLogContext);
          return false;
        }
        this.logger('collab.remoteUpdate.applyError', {
          ...baseLogContext,
          error: String(error),
        });
        return false;
      }
    }

    this.assertGenerationActive(generation);
    if (this.externalUpdateListener) {
      try {
        await this.externalUpdateListener(normalizedPayload);
        this.assertGenerationActive(generation);
        if (signal.aborted) {
          return false;
        }
      } catch (error) {
        this.logger('collab.remoteUpdate.listenerError', {
          ...baseLogContext,
          error: String(error),
        });
        return false;
      }
    }
    this.recordLatency(latencyMs, receiveTime, clock);
    return true;
  }

  private async sendAcknowledgement(
    message: UpdateWireMessage<T>,
    generation: number,
  ): Promise<void> {
    const acknowledgement: AckWireMessage = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: this.authentication.sessionId,
      senderId: this.localSenderId,
      kind: 'ack',
      messageId: message.messageId,
      sequence: message.sequence,
    };
    await this.sendWireMessage(acknowledgement, generation);
  }

  private async requestResynchronization(generation: number): Promise<void> {
    const expectedSequence = this.nextExpectedInboundSequence;
    this.resyncRequestedSequence = expectedSequence;
    const request: ResyncRequestWireMessage = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: this.authentication.sessionId,
      senderId: this.localSenderId,
      kind: 'resync-request',
      expectedSequence,
    };
    try {
      await this.sendWireMessage(request, generation);
      this.logger('collab.resyncRequested', { expectedSequence });
    } catch (error) {
      this.resyncRequestedSequence = undefined;
      throw error;
    }
  }

  private async processResyncRequest(
    request: ResyncRequestWireMessage,
    generation: number,
  ): Promise<void> {
    if (request.expectedSequence >= this.nextOutboundSequence) {
      this.logger('collab.resyncRequestAheadOfSender', {
        expectedSequence: request.expectedSequence,
        nextOutboundSequence: this.nextOutboundSequence,
      });
      return;
    }
    const history = [...this.outboundHistory.values()]
      .filter((message) => message.sequence >= request.expectedSequence)
      .sort((left, right) => left.sequence - right.sequence);
    if (history[0]?.sequence === request.expectedSequence) {
      for (const message of history) {
        this.assertGenerationActive(generation);
        await this.sendWireMessage(message, generation);
      }
      this.logger('collab.resyncHistoryReplayed', {
        expectedSequence: request.expectedSequence,
        replayedMessages: history.length,
      });
      return;
    }

    const signal = this.lifecycleAbortController?.signal;
    if (!this.resyncRequestedHandler || !signal || signal.aborted) {
      this.logger('collab.resyncUnavailable', {
        expectedSequence: request.expectedSequence,
      });
      return;
    }
    const payload = await this.resyncRequestedHandler({
      expectedSequence: request.expectedSequence,
      signal,
    });
    this.assertGenerationActive(generation);
    if (payload === undefined || signal.aborted) {
      this.logger('collab.resyncUnavailable', {
        expectedSequence: request.expectedSequence,
      });
      return;
    }
    this.queueOutboundUpdate(payload, true, generation).catch((error) => {
      this.logger('collab.resyncSendError', { error: String(error) });
    });
  }

  private removePendingAcknowledgement(messageId: string, error?: Error): void {
    const pending = this.pendingAcknowledgements.get(messageId);
    if (!pending) {
      return;
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pendingAcknowledgements.delete(messageId);
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve();
    }
    this.pruneOutboundHistory();
    this.updateHealth({ pendingAcknowledgements: this.pendingAcknowledgements.size });
  }

  private rejectPendingAcknowledgements(error: Error): void {
    [...this.pendingAcknowledgements.keys()].forEach((messageId) => {
      this.removePendingAcknowledgement(messageId, error);
    });
  }

  private pruneOutboundHistory(): void {
    if (this.outboundHistory.size <= this.resyncHistorySize) {
      return;
    }
    const sequences = [...this.outboundHistory.keys()].sort((a, b) => a - b);
    for (const sequence of sequences) {
      if (this.outboundHistory.size <= this.resyncHistorySize) {
        break;
      }
      const message = this.outboundHistory.get(sequence);
      if (message && !this.pendingAcknowledgements.has(message.messageId)) {
        this.outboundHistory.delete(sequence);
      }
    }
  }

  private resetInboundReliabilityState(): void {
    this.nextExpectedInboundSequence = 1;
    this.resyncRequestedSequence = undefined;
    this.bufferedInboundUpdates.clear();
  }

  private resetReliabilityState(error: Error): void {
    this.rejectPendingAcknowledgements(error);
    this.nextOutboundSequence = 1;
    this.lastAcknowledgedSequence = undefined;
    this.outboundHistory.clear();
    this.resetInboundReliabilityState();
  }

  private tuneDataChannel(metrics: LinkMetrics): void {
    if (!this.dataChannel) {
      return;
    }
    if (typeof metrics.linkSpeedMbps === 'number') {
      const bytesPerSecond = (metrics.linkSpeedMbps * 1_000_000) / 8;
      const threshold = Math.max(
        this.minBufferedThreshold,
        Math.min(this.maxBufferedThreshold, Math.round(bytesPerSecond * 0.2)),
      );
      this.dataChannel.bufferedAmountLowThreshold = threshold;
      this.releaseBackpressureWaiters(this.dataChannel);
    }
  }

  private attachConnectionObservers(
    connection: RTCPeerConnection,
    generation: number,
  ): void {
    const extended = connection as ExtendedPeerConnection;
    extended.onconnectionstatechange = () => {
      if (!this.isGenerationActive(generation)) {
        return;
      }
      const state = extended.connectionState ?? 'new';
      this.updateHealth({
        connectionState: this.mapConnectionState(state),
        dataChannelState: this.dataChannel?.readyState ?? 'unknown',
      });
    };
    extended.oniceconnectionstatechange = () => {
      if (!this.isGenerationActive(generation)) {
        return;
      }
      const iceState = extended.iceConnectionState ?? 'new';
      if (iceState === 'disconnected' || iceState === 'failed') {
        this.updateHealth({ connectionState: 'reconnecting' });
      } else if (iceState === 'connected' || iceState === 'completed') {
        this.updateHealth({ connectionState: 'connected' });
      }
    };
  }

  private detachConnectionObservers(): void {
    if (!this.peerConnection) {
      return;
    }
    const extended = this.peerConnection as ExtendedPeerConnection;
    extended.onconnectionstatechange = null;
    extended.oniceconnectionstatechange = null;
  }

  private mapConnectionState(
    state: PeerConnectionState | undefined,
  ): CollaborationConnectionState {
    switch (state) {
      case 'connected':
        return 'connected';
      case 'connecting':
      case 'new':
        return 'connecting';
      case 'closed':
        return 'disconnected';
      case 'disconnected':
      case 'failed':
        return 'reconnecting';
      default:
        return this.health.connectionState;
    }
  }

  private recordLatency(
    latencyMs: number,
    receivedAt: number,
    remoteClock: number,
  ): void {
    if (!Number.isFinite(latencyMs)) {
      return;
    }
    const normalizedLatency = Math.max(0, latencyMs);
    this.lastLatencyMs = normalizedLatency;
    const smoothing = 0.2;
    if (typeof this.averageLatencyMs === 'number') {
      this.averageLatencyMs =
        this.averageLatencyMs * (1 - smoothing) + normalizedLatency * smoothing;
    } else {
      this.averageLatencyMs = normalizedLatency;
    }
    this.updateHealth({
      lastLatencyMs: this.lastLatencyMs,
      averageLatencyMs: this.averageLatencyMs,
      lastUpdateReceivedAt: receivedAt,
      lastRemoteClock: remoteClock,
    });
  }

  private updateHealth(patch: Partial<CollabSessionHealthSnapshot>): void {
    const resolvedRole =
      patch.role !== undefined ? patch.role : (this.role ?? this.health.role ?? null);
    const hasNewMetrics = Object.prototype.hasOwnProperty.call(patch, 'lastMetrics');
    const hasAuthenticatedPeer = Object.prototype.hasOwnProperty.call(
      patch,
      'authenticatedPeerId',
    );
    let resolvedMetrics: LinkMetrics | undefined;
    if (hasNewMetrics) {
      resolvedMetrics = patch.lastMetrics ? { ...patch.lastMetrics } : undefined;
    } else if (this.health.lastMetrics) {
      resolvedMetrics = { ...this.health.lastMetrics };
    }

    this.health = {
      role: resolvedRole,
      connectionState: patch.connectionState ?? this.health.connectionState,
      dataChannelState: patch.dataChannelState ?? this.health.dataChannelState,
      authenticatedPeerId: hasAuthenticatedPeer
        ? patch.authenticatedPeerId
        : this.health.authenticatedPeerId,
      pendingAcknowledgements:
        patch.pendingAcknowledgements ?? this.health.pendingAcknowledgements,
      lastAcknowledgedSequence:
        patch.lastAcknowledgedSequence ??
        this.health.lastAcknowledgedSequence ??
        undefined,
      lastMetrics: resolvedMetrics,
      lastUpdateReceivedAt:
        patch.lastUpdateReceivedAt ?? this.health.lastUpdateReceivedAt ?? undefined,
      lastRemoteClock: patch.lastRemoteClock ?? this.health.lastRemoteClock ?? undefined,
      lastLatencyMs: patch.lastLatencyMs ?? this.health.lastLatencyMs ?? undefined,
      averageLatencyMs:
        patch.averageLatencyMs ?? this.health.averageLatencyMs ?? undefined,
    };
    this.notifyHealthListeners();
  }

  private cloneHealth(): CollabSessionHealthSnapshot {
    return {
      ...this.health,
      lastMetrics: this.health.lastMetrics ? { ...this.health.lastMetrics } : undefined,
    };
  }

  private notifyHealthListeners(): void {
    const snapshot = this.cloneHealth();
    this.healthListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger('collab.healthListenerError', { error: String(error) });
      }
    });
  }

  private normalizeOffer(offer: RTCSessionDescriptionInit): SignalingOffer {
    if (offer.type !== 'offer' || !offer.sdp) {
      throw new Error('Invalid offer');
    }
    return { sdp: offer.sdp, type: 'offer' };
  }

  private normalizeAnswer(answer: RTCSessionDescriptionInit): SignalingAnswer {
    if (answer.type !== 'answer' || !answer.sdp) {
      throw new Error('Invalid answer');
    }
    return { sdp: answer.sdp, type: 'answer' };
  }

  private normalizeIceCandidate(candidate: RTCIceCandidateInit): SignalingIceCandidate {
    return {
      candidate: candidate.candidate ?? '',
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    };
  }

  private async broadcastPublicKey(generation: number): Promise<void> {
    this.assertGenerationActive(generation);
    if (!this.role) {
      throw new Error('Collaboration role is unavailable');
    }
    const signal = createPublicKeySignal({
      sessionId: this.authentication.sessionId,
      role: this.role,
      publicKey: this.encryptionManager.getLocalPublicKey(),
      sharedSecret: this.authentication.sharedSecret,
      handshakeId: this.handshakeId,
    });
    await this.signalingClient.sendPublicKey(serializePublicKeySignal(signal));
    this.assertGenerationActive(generation);
    this.publicKeyBroadcastGeneration = generation;
  }

  private registerSignalingListeners(): void {
    if (this.signalingListenersRegistered) {
      return;
    }
    this.signalingClient.on('offer', this.boundOfferHandler);
    this.signalingClient.on('answer', this.boundAnswerHandler);
    this.signalingClient.on('iceCandidate', this.boundIceHandler);
    this.signalingClient.on('publicKey', this.boundPublicKeyHandler);
    this.signalingClient.on('shutdown', this.boundShutdownHandler);
    this.signalingListenersRegistered = true;
  }

  private unregisterSignalingListeners(): void {
    if (!this.signalingListenersRegistered) {
      return;
    }
    this.signalingClient.off('offer', this.boundOfferHandler);
    this.signalingClient.off('answer', this.boundAnswerHandler);
    this.signalingClient.off('iceCandidate', this.boundIceHandler);
    this.signalingClient.off('publicKey', this.boundPublicKeyHandler);
    this.signalingClient.off('shutdown', this.boundShutdownHandler);
    this.signalingListenersRegistered = false;
  }

  private requireActiveGeneration(): number {
    const generation = this.lifecycleGeneration;
    this.assertGenerationActive(generation);
    return generation;
  }

  private assertGenerationActive(generation: number): void {
    if (!this.isGenerationActive(generation)) {
      throw new CollaborationLifecycleError();
    }
  }

  private assertChannelReady(generation: number): void {
    this.assertGenerationActive(generation);
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Collaboration channel is not ready');
    }
  }

  private isGenerationActive(generation: number): boolean {
    return this.active && generation === this.lifecycleGeneration;
  }

  private isCurrentChannel(channel: RTCDataChannel, generation: number): boolean {
    return this.isGenerationActive(generation) && this.dataChannel === channel;
  }
}
