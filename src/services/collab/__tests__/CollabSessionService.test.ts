jest.mock('react-native-webrtc');

import type {
  RTCIceCandidateInit,
  RTCPeerConnection,
  RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import { CollabSessionService } from '../CollabSessionService';
import {
  AbstractPeerSignalingClient,
  type PeerSignalingClient,
  type SignalingAnswer,
  type SignalingIceCandidate,
  type SignalingOffer,
} from '../PeerSignalingClient';
import type { CollabPayload } from '../encryption';

class LoopbackSignalingClient extends AbstractPeerSignalingClient {
  peer?: LoopbackSignalingClient;

  async sendOffer(offer: SignalingOffer): Promise<void> {
    this.peer?.emitEvent('offer', offer);
  }

  async sendAnswer(answer: SignalingAnswer): Promise<void> {
    this.peer?.emitEvent('answer', answer);
  }

  async sendIceCandidate(candidate: SignalingIceCandidate): Promise<void> {
    this.peer?.emitEvent('iceCandidate', {
      candidate: candidate.candidate ?? '',
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    });
  }

  async sendPublicKey(publicKey: string): Promise<void> {
    this.peer?.emitEvent('publicKey', publicKey);
  }

  async disconnect(): Promise<void> {
    this.emitEvent('shutdown');
  }
}

type ChannelMessageHandler = (data: unknown) => void;

type RTCDataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

class MockRTCDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = 'open';
  bufferedAmountLowThreshold = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: (event: unknown) => void;
  onmessage?: ChannelMessageHandler;
  private peer?: MockRTCDataChannel;

  constructor(label: string) {
    this.label = label;
  }

  connect(peer: MockRTCDataChannel): void {
    this.peer = peer;
    peer.peer = this;
  }

  simulateOpen(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  send(data: string): void {
    this.peer?.onmessage?.({ data });
  }

  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
    this.peer?.notifyRemoteClose();
  }

  private notifyRemoteClose(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

type IceCandidateHandler = (event: { candidate: RTCIceCandidateInit | null }) => void;

type DataChannelEventHandler = (event: { channel: MockRTCDataChannel }) => void;

class MockPeerConnection {
  onicecandidate?: IceCandidateHandler;
  ondatachannel?: DataChannelEventHandler;
  public readonly addedCandidates: RTCIceCandidateInit[] = [];
  public lastCreatedChannel?: MockRTCDataChannel;
  private peer?: MockPeerConnection;
  private pendingRemoteChannels: MockRTCDataChannel[] = [];

  linkPeer(peer: MockPeerConnection): void {
    this.peer = peer;
    peer.peer = this;
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'mock-offer' });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'answer', sdp: 'mock-answer' });
  }

  async setLocalDescription(_description: RTCSessionDescriptionInit): Promise<void> {
    // no-op for mock
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'offer') {
      this.flushPendingChannels();
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  createDataChannel(label: string): MockRTCDataChannel {
    const channel = new MockRTCDataChannel(label);
    this.lastCreatedChannel = channel;
    if (this.peer) {
      const remoteChannel = new MockRTCDataChannel(label);
      channel.connect(remoteChannel);
      this.peer.enqueueRemoteChannel(remoteChannel);
      queueMicrotask(() => {
        channel.simulateOpen();
      });
    }
    return channel;
  }

  close(): void {
    this.lastCreatedChannel?.close();
  }

  triggerIceCandidate(candidate: RTCIceCandidateInit): void {
    this.onicecandidate?.({ candidate });
  }

  private enqueueRemoteChannel(channel: MockRTCDataChannel): void {
    if (this.ondatachannel) {
      this.ondatachannel({ channel });
      queueMicrotask(() => channel.simulateOpen());
    } else {
      this.pendingRemoteChannels.push(channel);
    }
  }

  private flushPendingChannels(): void {
    const channels = [...this.pendingRemoteChannels];
    this.pendingRemoteChannels = [];
    channels.forEach((channel) => {
      this.ondatachannel?.({ channel });
      queueMicrotask(() => channel.simulateOpen());
    });
  }
}

function pairSignalingClients(): [PeerSignalingClient, PeerSignalingClient] {
  const a = new LoopbackSignalingClient();
  const b = new LoopbackSignalingClient();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('CollabSessionService', () => {
  it('establishes encrypted data channel and delivers updates', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const remoteUpdates: CollabPayload<{ text: string }>[] = [];

    const responderService = new CollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: (payload) => {
        remoteUpdates.push(payload);
      },
    });

    const initiatorService = new CollabSessionService<{ text: string }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');

    await new Promise((resolve) => setTimeout(resolve, 0));

    await initiatorService.broadcastUpdate({ text: 'Hello' });

    await waitForCondition(() => remoteUpdates.length > 0);

    expect(remoteUpdates).toHaveLength(1);
    expect(remoteUpdates[0].body).toEqual({ text: 'Hello' });
    expect(remoteUpdates[0].schemaVersion).toBe(1);

    expect(
      initiatorConnection.lastCreatedChannel?.bufferedAmountLowThreshold,
    ).toBeGreaterThanOrEqual(16 * 1024);

    initiatorService.stop();
    responderService.stop();
  });
});

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 200,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}
