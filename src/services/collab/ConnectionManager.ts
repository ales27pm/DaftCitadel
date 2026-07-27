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
}

export class ConnectionManager {
  private readonly connectionFactory: () => RTCPeerConnection;
  private readonly logger: Logger;
  private readonly onLocalIceCandidate: (
    candidate: RTCIceCandidateInit,
  ) => Promise<void> | void;
  private readonly onDataChannel: (channel: RTCDataChannel) => void;
  private readonly maxPendingRemoteCandidates: number;

  private peerConnection?: RTCPeerConnection;
  private remoteDescriptionSet = false;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private connectionGeneration = 0;

  constructor(options: ConnectionManagerOptions) {
    this.connectionFactory = options.connectionFactory;
    this.logger = options.logger;
    this.onLocalIceCandidate = options.onLocalIceCandidate;
    this.onDataChannel = options.onDataChannel;
    this.maxPendingRemoteCandidates = options.maxPendingRemoteCandidates ?? 64;
  }

  getOrCreate(): RTCPeerConnection {
    if (this.peerConnection) {
      return this.peerConnection;
    }
    this.connectionGeneration += 1;
    const connection = this.connectionFactory();
    connection.onicecandidate = (event: { candidate: RTCIceCandidateInit | null }) => {
      if (!event.candidate) {
        return;
      }
      Promise.resolve(this.onLocalIceCandidate(event.candidate)).catch((error) => {
        this.logger('collab.localIceCandidateError', { error: String(error) });
      });
    };
    connection.ondatachannel = (event: RTCDataChannelEvent) => {
      this.onDataChannel(event.channel);
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
    await connection.setRemoteDescription(description);
    if (generation !== this.connectionGeneration || connection !== this.peerConnection) {
      throw new Error('Peer connection changed before remote description completed');
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
    if (!this.remoteDescriptionSet) {
      if (this.pendingRemoteCandidates.length >= this.maxPendingRemoteCandidates) {
        this.pendingRemoteCandidates.shift();
        this.logger('collab.pendingIceCandidateDropped', {
          maxPendingRemoteCandidates: this.maxPendingRemoteCandidates,
        });
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
    try {
      this.peerConnection.close();
    } catch (error) {
      this.logger('collab.peerConnectionCloseError', { error: String(error) });
    }
    this.peerConnection = undefined;
    this.remoteDescriptionSet = false;
    this.pendingRemoteCandidates = [];
    this.connectionGeneration += 1;
  }
}
