import {
  RTCPeerConnection as NativeRTCPeerConnection,
  type RTCConfiguration,
  type RTCDataChannel,
  type RTCDataChannelEvent,
  type RTCIceCandidateInit,
  type RTCPeerConnection,
  type RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import {
  EncryptionContext,
  generateIdentityKeyPair,
  type CollabPayload,
  type Ciphertext,
} from './encryption';
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

type Logger = (message: string, context?: Record<string, unknown>) => void;

export interface CollabSessionOptions<T> {
  readonly signalingClient: PeerSignalingClient;
  readonly latencyCompensator?: LatencyCompensator;
  readonly networkDiagnostics?: NetworkDiagnostics;
  readonly schemaVersion?: number;
  readonly preSharedKey?: Uint8Array;
  readonly connectionFactory?: () => RTCPeerConnection;
  readonly logger?: Logger;
  readonly onRemoteUpdate?: (payload: CollabPayload<T>) => void;
}

export type CollabSessionRole = 'initiator' | 'responder';

const CHANNEL_LABEL = 'daft-collab';
const CHANNEL_CONFIG = { ordered: true, maxRetransmits: 2 };

type RTCPeerConnectionConstructor = new (
  configuration?: RTCConfiguration,
) => RTCPeerConnection;

function createDefaultPeerConnection(): RTCPeerConnection {
  return new (NativeRTCPeerConnection as RTCPeerConnectionConstructor)();
}

export class CollabSessionService<T = unknown> {
  private readonly signalingClient: PeerSignalingClient;
  private readonly latencyCompensator: LatencyCompensator;
  private readonly logger: Logger;
  private readonly identityKeyPair = generateIdentityKeyPair();
  private readonly networkDiagnostics: NetworkDiagnostics;
  private readonly schemaVersion: number;
  private readonly preSharedKey?: Uint8Array;
  private readonly connectionFactory: () => RTCPeerConnection;
  private readonly externalUpdateListener?: (payload: CollabPayload<T>) => void;

  private encryptionContext?: EncryptionContext;
  private remotePublicKey?: string;
  private peerConnection?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private unsubscribeNetwork?: () => void;
  private readonly boundOfferHandler: (offer: SignalingOffer) => void;
  private readonly boundAnswerHandler: (answer: SignalingAnswer) => void;
  private readonly boundIceHandler: (candidate: SignalingIceCandidate) => void;
  private readonly boundPublicKeyHandler: (publicKey: string) => void;
  private readonly boundShutdownHandler: () => void;

  constructor(options: CollabSessionOptions<T>) {
    this.signalingClient = options.signalingClient;
    this.latencyCompensator = options.latencyCompensator ?? new LatencyCompensator();
    this.logger = options.logger ?? (() => {});
    this.networkDiagnostics = options.networkDiagnostics ?? createNetworkDiagnostics();
    this.schemaVersion = options.schemaVersion ?? 1;
    this.preSharedKey = options.preSharedKey;
    this.connectionFactory =
      options.connectionFactory ?? (() => createDefaultPeerConnection());
    this.externalUpdateListener = options.onRemoteUpdate;

    this.boundOfferHandler = (offer) => {
      this.handleOffer(offer).catch(() => {});
    };
    this.boundAnswerHandler = (answer) => {
      this.handleAnswer(answer).catch(() => {});
    };
    this.boundIceHandler = (candidate) => {
      this.handleIceCandidate(candidate).catch(() => {});
    };
    this.boundPublicKeyHandler = this.handleRemotePublicKey.bind(this);
    this.boundShutdownHandler = this.stop.bind(this);

    this.registerSignalingListeners();
  }

  getLocalPublicKey(): string {
    return this.identityKeyPair.publicKey;
  }

  async start(role: CollabSessionRole): Promise<void> {
    const connection = this.ensurePeerConnection();
    if (role === 'initiator') {
      this.attachDataChannel(connection.createDataChannel(CHANNEL_LABEL, CHANNEL_CONFIG));
    }

    await this.broadcastPublicKey();
    this.startNetworkSampling();

    if (role === 'initiator') {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await this.signalingClient.sendOffer(this.normalizeOffer(offer));
    }
  }

  async broadcastUpdate(payload: T): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Collaboration channel is not ready');
    }
    const encryption = this.requireEncryptionContext();
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
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = undefined;
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (error) {
        this.logger('collab.dataChannelCloseError', { error: String(error) });
      }
    }
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (error) {
        this.logger('collab.peerConnectionCloseError', { error: String(error) });
      }
    }
    this.peerConnection = undefined;
    this.dataChannel = undefined;
    this.encryptionContext = undefined;
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.peerConnection) {
      return this.peerConnection;
    }
    const connection = this.connectionFactory();
    connection.onicecandidate = (event: { candidate: RTCIceCandidateInit | null }) => {
      if (event.candidate) {
        this.signalingClient
          .sendIceCandidate(this.normalizeIceCandidate(event.candidate))
          .catch(() => {});
      }
    };
    connection.ondatachannel = (event: RTCDataChannelEvent) => {
      this.attachDataChannel(event.channel);
    };
    this.peerConnection = connection;
    return connection;
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    if ('binaryType' in this.dataChannel) {
      (this.dataChannel as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    }
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
    this.dataChannel.bufferedAmountLowThreshold = 256 * 1024;
  }

  private async handleOffer(offer: SignalingOffer): Promise<void> {
    try {
      const connection = this.ensurePeerConnection();
      await connection.setRemoteDescription({
        type: offer.type,
        sdp: offer.sdp,
      });
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.signalingClient.sendAnswer(this.normalizeAnswer(answer));
    } catch (error) {
      this.logger('collab.handleOfferError', { error: String(error) });
    }
  }

  private async handleAnswer(answer: SignalingAnswer): Promise<void> {
    try {
      const connection = this.ensurePeerConnection();
      await connection.setRemoteDescription({
        type: answer.type,
        sdp: answer.sdp,
      });
    } catch (error) {
      this.logger('collab.handleAnswerError', { error: String(error) });
    }
  }

  private async handleIceCandidate(candidate: SignalingIceCandidate): Promise<void> {
    if (!this.peerConnection) {
      return;
    }
    try {
      await this.peerConnection.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      });
    } catch (error) {
      this.logger('collab.handleIceCandidateError', { error: String(error) });
      throw error;
    }
  }

  private handleRemotePublicKey(publicKey: string): void {
    this.remotePublicKey = publicKey;
    try {
      this.encryptionContext = new EncryptionContext({
        identityKeyPair: this.identityKeyPair,
        remotePublicKey: publicKey,
        preSharedKey: this.preSharedKey,
      });
      this.logger('collab.encryptionReady');
    } catch (error) {
      this.logger('collab.encryptionError', { error: String(error) });
    }
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
      const encryption = this.requireEncryptionContext();
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

  private requireEncryptionContext(): EncryptionContext {
    if (this.encryptionContext) {
      return this.encryptionContext;
    }
    if (!this.remotePublicKey) {
      throw new Error('Remote key not available');
    }
    this.encryptionContext = new EncryptionContext({
      identityKeyPair: this.identityKeyPair,
      remotePublicKey: this.remotePublicKey,
      preSharedKey: this.preSharedKey,
    });
    return this.encryptionContext;
  }

  private startNetworkSampling(): void {
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = this.networkDiagnostics.subscribe((metrics) => {
      this.logger('collab.networkMetrics', { ...metrics });
      this.tuneDataChannel(metrics);
    });
    this.networkDiagnostics
      .getCurrentLinkMetrics()
      .then((metrics) => {
        this.logger('collab.networkMetrics.initial', { ...metrics });
        this.tuneDataChannel(metrics);
      })
      .catch((error) => {
        this.logger('collab.networkMetrics.error', { error: String(error) });
      });
  }

  private tuneDataChannel(metrics: LinkMetrics): void {
    if (!this.dataChannel) {
      return;
    }
    if (typeof metrics.linkSpeedMbps === 'number') {
      const bytesPerSecond = (metrics.linkSpeedMbps * 1_000_000) / 8;
      this.dataChannel.bufferedAmountLowThreshold = Math.max(
        16 * 1024,
        Math.min(512 * 1024, Math.round(bytesPerSecond * 0.2)),
      );
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
    await this.signalingClient.sendPublicKey(this.identityKeyPair.publicKey);
  }

  private registerSignalingListeners(): void {
    this.signalingClient.on('offer', this.boundOfferHandler);
    this.signalingClient.on('answer', this.boundAnswerHandler);
    this.signalingClient.on('iceCandidate', this.boundIceHandler);
    this.signalingClient.on('publicKey', this.boundPublicKeyHandler);
    this.signalingClient.on('shutdown', this.boundShutdownHandler);
  }
}
