import {
  RTCPeerConnection as NativeRTCPeerConnection,
  type RTCDataChannel,
  type RTCDataChannelInit,
  type RTCConfiguration,
  type RTCIceCandidateInit,
  type RTCPeerConnection,
  type RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import type { CollabPayload, Ciphertext } from './encryption';
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
import { EncryptionManager } from './EncryptionManager';
import { DiagnosticsManager } from './DiagnosticsManager';
import type { Logger } from './types';

export interface CollabSessionOptions<T> {
  readonly signalingClient: PeerSignalingClient;
  readonly latencyCompensator?: LatencyCompensator;
  readonly networkDiagnostics?: NetworkDiagnostics;
  readonly schemaVersion?: number;
  readonly preSharedKey?: Uint8Array;
  readonly connectionFactory?: () => RTCPeerConnection;
  readonly logger?: Logger;
  readonly onRemoteUpdate?: (payload: CollabPayload<T>) => void;
  readonly channelLabel?: string;
  readonly channelConfig?: RTCDataChannelInit;
  readonly minBufferedAmountLowThreshold?: number;
  readonly maxBufferedAmountLowThreshold?: number;
}

export type CollabSessionRole = 'initiator' | 'responder';

const DEFAULT_CHANNEL_LABEL = 'daft-collab';
const DEFAULT_CHANNEL_CONFIG: RTCDataChannelInit = { ordered: true, maxRetransmits: 2 };
const DEFAULT_MIN_BUFFERED_AMOUNT_LOW_THRESHOLD = 16 * 1024;
const DEFAULT_MAX_BUFFERED_AMOUNT_LOW_THRESHOLD = 512 * 1024;
const INITIAL_BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

type RTCPeerConnectionConstructor = new (
  configuration?: RTCConfiguration,
) => RTCPeerConnection;

function createDefaultPeerConnection(): RTCPeerConnection {
  return new (NativeRTCPeerConnection as unknown as RTCPeerConnectionConstructor)();
}

export class CollabSessionService<T = unknown> {
  private readonly signalingClient: PeerSignalingClient;
  private readonly latencyCompensator: LatencyCompensator;
  private readonly logger: Logger;
  private readonly schemaVersion: number;
  private readonly channelLabel: string;
  private readonly channelConfig: RTCDataChannelInit;
  private readonly minBufferedThreshold: number;
  private readonly maxBufferedThreshold: number;
  private readonly externalUpdateListener?: (payload: CollabPayload<T>) => void;
  private readonly connectionManager: ConnectionManager;
  private readonly encryptionManager: EncryptionManager;
  private readonly diagnosticsManager: DiagnosticsManager;

  private dataChannel?: RTCDataChannel;

  private readonly boundOfferHandler: (offer: SignalingOffer) => void;
  private readonly boundAnswerHandler: (answer: SignalingAnswer) => void;
  private readonly boundIceHandler: (candidate: SignalingIceCandidate) => void;
  private readonly boundPublicKeyHandler: (publicKey: string) => void;
  private readonly boundShutdownHandler: () => void;

  constructor(options: CollabSessionOptions<T>) {
    this.signalingClient = options.signalingClient;
    this.latencyCompensator = options.latencyCompensator ?? new LatencyCompensator();
    this.logger = options.logger ?? (() => {});
    this.schemaVersion = options.schemaVersion ?? 1;
    this.channelLabel = options.channelLabel ?? DEFAULT_CHANNEL_LABEL;
    this.channelConfig = options.channelConfig ?? DEFAULT_CHANNEL_CONFIG;
    this.minBufferedThreshold =
      options.minBufferedAmountLowThreshold ?? DEFAULT_MIN_BUFFERED_AMOUNT_LOW_THRESHOLD;
    this.maxBufferedThreshold =
      options.maxBufferedAmountLowThreshold ?? DEFAULT_MAX_BUFFERED_AMOUNT_LOW_THRESHOLD;
    this.externalUpdateListener = options.onRemoteUpdate;

    const connectionFactory =
      options.connectionFactory ?? (() => createDefaultPeerConnection());

    const networkDiagnostics = options.networkDiagnostics ?? createNetworkDiagnostics();

    this.connectionManager = new ConnectionManager({
      connectionFactory,
      logger: this.logger,
      onLocalIceCandidate: async (candidate) => {
        if (!candidate.candidate || candidate.candidate.trim() === '') {
          this.logger('collab.emptyIceCandidate'); // skip end-of-candidates or malformed
          return;
        }
        await this.signalingClient.sendIceCandidate(
          this.normalizeIceCandidate(candidate),
        );
      },
      onDataChannel: (channel) => this.attachDataChannel(channel),
    });

    this.encryptionManager = new EncryptionManager({
      logger: this.logger,
      preSharedKey: options.preSharedKey,
    });

    this.diagnosticsManager = new DiagnosticsManager({
      diagnostics: networkDiagnostics,
      logger: this.logger,
      onMetrics: (metrics) => this.tuneDataChannel(metrics),
    });

    this.boundOfferHandler = (offer) => {
      this.handleOffer(offer).catch((error) => {
        this.logger('collab.handleOfferUnhandledError', { error: String(error) });
      });
    };
    this.boundAnswerHandler = (answer) => {
      this.handleAnswer(answer).catch((error) => {
        this.logger('collab.handleAnswerUnhandledError', { error: String(error) });
      });
    };
    this.boundIceHandler = (candidate) => {
      this.handleIceCandidate(candidate).catch((error) => {
        this.logger('collab.handleIceCandidateUnhandledError', { error: String(error) });
      });
    };
    this.boundPublicKeyHandler = (publicKey) => {
      try {
        this.encryptionManager.setRemotePublicKey(publicKey);
      } catch (error) {
        // The encryption manager already logs detailed context for failures.
      }
    };
    this.boundShutdownHandler = this.stop.bind(this);

    this.registerSignalingListeners();
  }

  getLocalPublicKey(): string {
    return this.encryptionManager.getLocalPublicKey();
  }

  async start(role: CollabSessionRole): Promise<void> {
    this.connectionManager.getOrCreate();
    if (role === 'initiator') {
      const channel = this.connectionManager.createDataChannel(
        this.channelLabel,
        this.channelConfig,
      );
      this.attachDataChannel(channel);
    }

    await this.broadcastPublicKey();
    this.diagnosticsManager.start();

    if (role === 'initiator') {
      const offer = await this.connectionManager.createOffer();
      await this.connectionManager.setLocalDescription(offer);
      await this.signalingClient.sendOffer(this.normalizeOffer(offer));
    }
  }

  async broadcastUpdate(payload: T): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Collaboration channel is not ready');
    }
    await this.encryptionManager.waitUntilReady();
    const encryption = this.encryptionManager.requireContext();
    const now = Date.now();
    const encrypted = encryption.encrypt<T>({
      clock: now,
      schemaVersion: this.schemaVersion,
      body: payload,
    });
    this.dataChannel.send(JSON.stringify(encrypted));
  }

  stop(): void {
    this.logger('collab.stop');
    this.signalingClient.off('offer', this.boundOfferHandler);
    this.signalingClient.off('answer', this.boundAnswerHandler);
    this.signalingClient.off('iceCandidate', this.boundIceHandler);
    this.signalingClient.off('publicKey', this.boundPublicKeyHandler);
    this.signalingClient.off('shutdown', this.boundShutdownHandler);
    this.signalingClient.disconnect().catch((error) => {
      this.logger('collab.signalingDisconnectError', { error: String(error) });
    });
    this.diagnosticsManager.stop();
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (error) {
        this.logger('collab.dataChannelCloseError', { error: String(error) });
      }
    }
    this.connectionManager.close();
    this.dataChannel = undefined;
    this.encryptionManager.reset();
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.onopen = () => {
      this.logger('collab.dataChannel.open', {
        label: channel.label,
        readyState: channel.readyState,
      });
    };
    channel.onclose = () => {
      this.logger('collab.dataChannel.close');
    };
    channel.onerror = (event: unknown) => {
      this.logger('collab.dataChannel.error', { error: JSON.stringify(event) });
    };
    channel.onmessage = (event: { data: unknown }) => {
      this.handleIncomingFrame(event.data);
    };
    this.configureDataChannelForNetwork();
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

  private async handleOffer(offer: SignalingOffer): Promise<void> {
    const description: RTCSessionDescriptionInit = { type: offer.type, sdp: offer.sdp };
    await this.connectionManager.setRemoteDescription(description);
    const answer = await this.connectionManager.createAnswer();
    await this.connectionManager.setLocalDescription(answer);
    await this.signalingClient.sendAnswer(this.normalizeAnswer(answer));
  }

  private async handleAnswer(answer: SignalingAnswer): Promise<void> {
    const description: RTCSessionDescriptionInit = { type: answer.type, sdp: answer.sdp };
    await this.connectionManager.setRemoteDescription(description);
  }

  private async handleIceCandidate(candidate: SignalingIceCandidate): Promise<void> {
    const rtcCandidate: RTCIceCandidateInit = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
    };
    await this.connectionManager.addIceCandidate(rtcCandidate);
  }

  private handleIncomingFrame(frame: unknown): void {
    if (typeof frame !== 'string') {
      this.logger('collab.invalidFrameType');
      return;
    }
    let ciphertext: Ciphertext;
    try {
      ciphertext = JSON.parse(frame) as Ciphertext;
    } catch (error) {
      this.logger('collab.frameParseError', { error: String(error) });
      return;
    }

    let payload: CollabPayload<T>;
    try {
      const encryption = this.encryptionManager.requireContext();
      payload = encryption.decrypt<T>(ciphertext);
    } catch (error) {
      this.logger('collab.decryptError', { error: String(error) });
      return;
    }

    const receiveTime = Date.now();
    const offset = this.latencyCompensator.update({
      remoteClock: payload.clock,
      receivedAt: receiveTime,
    });
    const compensatedClock = payload.clock - offset;
    const normalizedPayload: CollabPayload<T> = {
      ...payload,
      clock: compensatedClock,
    };

    this.externalUpdateListener?.(normalizedPayload);
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
    }
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

  private async broadcastPublicKey(): Promise<void> {
    await this.signalingClient.sendPublicKey(this.encryptionManager.getLocalPublicKey());
  }

  private registerSignalingListeners(): void {
    this.signalingClient.on('offer', this.boundOfferHandler);
    this.signalingClient.on('answer', this.boundAnswerHandler);
    this.signalingClient.on('iceCandidate', this.boundIceHandler);
    this.signalingClient.on('publicKey', this.boundPublicKeyHandler);
    this.signalingClient.on('shutdown', this.boundShutdownHandler);
  }
}
