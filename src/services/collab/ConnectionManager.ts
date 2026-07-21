import { Buffer } from 'buffer';
import type {
  RTCDataChannelInit,
  RTCDataChannel,
  RTCDataChannelEvent,
  RTCIceCandidateInit,
  RTCPeerConnection,
  RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import type { Logger } from './types';

export interface ConnectionManagerOptions {
  connectionFactory: () => RTCPeerConnection;
  logger: Logger;
  onLocalIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void> | void;
  onDataChannel: (channel: RTCDataChannel) => void;
  maxPendingRemoteCandidates?: number;
  maxIceCandidateBytes?: number;
  maxSdpBytes?: number;
}

const DEFAULT_MAX_PENDING_REMOTE_CANDIDATES = 64;
const DEFAULT_MAX_ICE_CANDIDATE_BYTES = 16 * 1024;
const DEFAULT_MAX_SDP_BYTES = 1024 * 1024;

const requirePositiveLimit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export class ConnectionManager {
  private readonly connectionFactory: () => RTCPeerConnection;
  private readonly logger: Logger;
  private readonly onLocalIceCandidate: (
    candidate: RTCIceCandidateInit,
  ) => Promise<void> | void;
  private readonly onDataChannel: (channel: RTCDataChannel) => void;
  private readonly maxPendingRemoteCandidates: number;
  private readonly maxIceCandidateBytes: number;
  private readonly maxSdpBytes: number;

  private peerConnection?: RTCPeerConnection;
  private connectionGeneration = 0;
  private remoteDescriptionSet = false;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];

  constructor(options: ConnectionManagerOptions) {
    this.connectionFactory = options.connectionFactory;
    this.logger = options.logger;
    this.onLocalIceCandidate = options.onLocalIceCandidate;
    this.onDataChannel = options.onDataChannel;
    this.maxPendingRemoteCandidates = requirePositiveLimit(
      options.maxPendingRemoteCandidates ?? DEFAULT_MAX_PENDING_REMOTE_CANDIDATES,
      'Maximum pending remote ICE candidates',
    );
    this.maxIceCandidateBytes = requirePositiveLimit(
      options.maxIceCandidateBytes ?? DEFAULT_MAX_ICE_CANDIDATE_BYTES,
      'Maximum ICE candidate size',
    );
    this.maxSdpBytes = requirePositiveLimit(
      options.maxSdpBytes ?? DEFAULT_MAX_SDP_BYTES,
      'Maximum SDP size',
    );
  }

  getOrCreate(): RTCPeerConnection {
    if (this.peerConnection) {
      return this.peerConnection;
    }
    const connection = this.connectionFactory();
    const generation = ++this.connectionGeneration;
    connection.onicecandidate = (event: { candidate: RTCIceCandidateInit | null }) => {
      if (!this.isCurrentConnection(connection, generation)) {
        return;
      }
      if (!event.candidate) {
        return;
      }
      Promise.resolve(this.onLocalIceCandidate(event.candidate)).catch((error) => {
        this.logger('collab.localIceCandidateError', { error: String(error) });
      });
    };
    connection.ondatachannel = (event: RTCDataChannelEvent) => {
      if (this.isCurrentConnection(connection, generation)) {
        this.onDataChannel(event.channel);
      } else {
        event.channel.close();
      }
    };
    this.peerConnection = connection;
    return connection;
  }

  createDataChannel(label: string, config?: RTCDataChannelInit): RTCDataChannel {
    const connection = this.getOrCreate();
    return connection.createDataChannel(label, config);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const connection = this.getOrCreate();
    return connection.createOffer();
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const connection = this.getOrCreate();
    return connection.createAnswer();
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const connection = this.getOrCreate();
    await connection.setLocalDescription(description);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const connection = this.getOrCreate();
    const generation = this.connectionGeneration;
    if (
      typeof description.sdp !== 'string' ||
      Buffer.byteLength(description.sdp, 'utf8') > this.maxSdpBytes
    ) {
      throw new Error('Remote SDP exceeds the configured size limit');
    }
    await connection.setRemoteDescription(description);
    if (!this.isCurrentConnection(connection, generation)) {
      throw new Error('Peer connection changed while applying the remote description');
    }
    this.remoteDescriptionSet = true;
    if (this.pendingRemoteCandidates.length > 0) {
      const queued = [...this.pendingRemoteCandidates];
      this.pendingRemoteCandidates = [];
      await Promise.all(
        queued.map(async (candidate) => {
          await connection.addIceCandidate(candidate);
        }),
      ).catch((error) => {
        this.logger('collab.flushIceCandidateError', { error: String(error) });
      });
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const connection = this.getOrCreate();
    const candidateValue = candidate.candidate;
    if (
      typeof candidateValue !== 'string' ||
      candidateValue.trim().length === 0 ||
      Buffer.byteLength(candidateValue, 'utf8') > this.maxIceCandidateBytes
    ) {
      throw new Error('Remote ICE candidate exceeds the configured size limit');
    }
    if (!this.remoteDescriptionSet) {
      if (this.pendingRemoteCandidates.length >= this.maxPendingRemoteCandidates) {
        throw new Error('Remote ICE candidate queue is full');
      }
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    await connection.addIceCandidate(candidate);
  }

  close(): void {
    if (!this.peerConnection) {
      return;
    }
    this.peerConnection.onicecandidate = null;
    this.peerConnection.ondatachannel = null;
    ++this.connectionGeneration;
    try {
      this.peerConnection.close();
    } catch (error) {
      this.logger('collab.peerConnectionCloseError', { error: String(error) });
    }
    this.peerConnection = undefined;
    this.remoteDescriptionSet = false;
    this.pendingRemoteCandidates = [];
  }

  private isCurrentConnection(
    connection: RTCPeerConnection,
    generation: number,
  ): boolean {
    return this.peerConnection === connection && this.connectionGeneration === generation;
  }
}
