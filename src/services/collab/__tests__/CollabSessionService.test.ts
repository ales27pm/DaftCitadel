jest.mock('react-native-webrtc');

import type {
  RTCIceCandidateInit,
  RTCPeerConnection,
  RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import { CollabSessionService } from '../CollabSessionService';
import {
  AbstractPeerSignalingClient,
  type SignalingAnswer,
  type SignalingIceCandidate,
  type SignalingOffer,
} from '../PeerSignalingClient';
import type { CollabPayload } from '../encryption';
import type {
  LinkMetrics,
  NetworkDiagnostics,
  NetworkMetricsListener,
} from '../diagnostics/NetworkDiagnostics';

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

  dispatch(
    event: 'offer' | 'answer' | 'iceCandidate' | 'publicKey' | 'shutdown',
    payload?: unknown,
  ): void {
    this.emitEvent(event, payload as never);
  }
}

class ControlledSignalingClient extends LoopbackSignalingClient {
  autoDeliverPublicKeys = true;
  private pendingPublicKeys: string[] = [];

  override async sendPublicKey(publicKey: string): Promise<void> {
    if (this.autoDeliverPublicKeys) {
      await super.sendPublicKey(publicKey);
      return;
    }
    this.pendingPublicKeys.push(publicKey);
  }

  async flushPublicKeys(): Promise<void> {
    const keys = [...this.pendingPublicKeys];
    this.pendingPublicKeys = [];
    await Promise.all(keys.map((key) => super.sendPublicKey(key)));
  }
}

class TestNetworkDiagnostics implements NetworkDiagnostics {
  private listeners: Set<NetworkMetricsListener> = new Set();
  private failure = false;
  private metrics: LinkMetrics;

  constructor(initialMetrics?: Partial<LinkMetrics>) {
    this.metrics = {
      timestamp: Date.now(),
      category: 'unusable',
      ...initialMetrics,
    } as LinkMetrics;
  }

  setFailure(shouldFail: boolean): void {
    this.failure = shouldFail;
  }

  async getCurrentLinkMetrics(): Promise<LinkMetrics> {
    if (this.failure) {
      throw new Error('diagnostics failure');
    }
    return this.metrics;
  }

  subscribe(listener: NetworkMetricsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(metrics: LinkMetrics): void {
    this.metrics = metrics;
    this.listeners.forEach((listener) => listener(metrics));
  }
}

type ChannelMessageHandler = (data: unknown) => void;

type RTCDataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

class MockRTCDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = 'connecting';
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
  private remoteDescriptionSet = false;

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
    this.remoteDescriptionSet = true;
    if (description.type === 'offer') {
      this.flushPendingChannels();
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionSet) {
      throw new Error('Remote description not set');
    }
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

function pairSignalingClients(): [LoopbackSignalingClient, LoopbackSignalingClient] {
  const a = new LoopbackSignalingClient();
  const b = new LoopbackSignalingClient();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function pairControlledSignalingClients(): [
  ControlledSignalingClient,
  ControlledSignalingClient,
] {
  const a = new ControlledSignalingClient();
  const b = new ControlledSignalingClient();
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
    let resolveFirstUpdate:
      | ((payload: CollabPayload<{ text: string }>) => void)
      | undefined;
    const firstUpdate = new Promise<CollabPayload<{ text: string }>>((resolve) => {
      resolveFirstUpdate = resolve;
    });

    const responderService = new CollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: (payload) => {
        remoteUpdates.push(payload);
        resolveFirstUpdate?.(payload);
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

    await firstUpdate;

    expect(remoteUpdates).toHaveLength(1);
    expect(remoteUpdates[0].body).toEqual({ text: 'Hello' });
    expect(remoteUpdates[0].schemaVersion).toBe(1);

    expect(
      initiatorConnection.lastCreatedChannel?.bufferedAmountLowThreshold,
    ).toBeGreaterThanOrEqual(16 * 1024);

    initiatorService.stop();
    responderService.stop();
  });

  it('buffers ICE candidates until the remote description is applied', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const responderService = new CollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
    });

    const initiatorService = new CollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    await responderService.start('responder');

    const candidate: SignalingIceCandidate = {
      candidate: 'candidate:mock',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };

    expect(() => responderSignaling.dispatch('iceCandidate', candidate)).not.toThrow();
    expect(responderConnection.addedCandidates).toHaveLength(0);

    await initiatorService.start('initiator');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(responderConnection.addedCandidates).toHaveLength(1);
    expect(responderConnection.addedCandidates[0].candidate).toBe('candidate:mock');

    initiatorService.stop();
    responderService.stop();
  });

  it('waits for encryption readiness before sending payloads', async () => {
    const [initiatorSignaling, responderSignaling] = pairControlledSignalingClients();
    responderSignaling.autoDeliverPublicKeys = false;
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const remoteUpdates: CollabPayload<{ text: string }>[] = [];
    let resolveFirstUpdate: (() => void) | undefined;
    const firstUpdate = new Promise<void>((resolve) => {
      resolveFirstUpdate = resolve;
    });

    const responderService = new CollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: (payload) => {
        remoteUpdates.push(payload);
        resolveFirstUpdate?.();
      },
    });

    const initiatorService = new CollabSessionService<{ text: string }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');

    await new Promise((resolve) => setTimeout(resolve, 0));

    const broadcastPromise = initiatorService.broadcastUpdate({ text: 'delayed' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remoteUpdates).toHaveLength(0);

    await responderSignaling.flushPublicKeys();
    await initiatorSignaling.flushPublicKeys();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await broadcastPromise;
    await firstUpdate;

    expect(remoteUpdates).toHaveLength(1);
    expect(remoteUpdates[0].body).toEqual({ text: 'delayed' });

    initiatorService.stop();
    responderService.stop();
  });

  it('updates bufferedAmountLowThreshold in response to diagnostics events', async () => {
    const diagnostics = new TestNetworkDiagnostics({
      linkSpeedMbps: 5,
      category: 'good',
      timestamp: Date.now(),
    });
    const logger = jest.fn();
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const responderService = new CollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
      logger,
    });

    const initiatorService = new CollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
      logger,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const newMetrics: LinkMetrics = {
      timestamp: Date.now(),
      category: 'excellent',
      linkSpeedMbps: 200,
      interfaceName: 'en0',
    };
    diagnostics.emit(newMetrics);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const threshold =
      initiatorConnection.lastCreatedChannel?.bufferedAmountLowThreshold ?? 0;
    expect(threshold).toBe(512 * 1024);

    const loggedContexts = logger.mock.calls
      .filter(
        ([message]) =>
          message === 'collab.networkMetrics' ||
          message === 'collab.networkMetrics.initial',
      )
      .map(([, context]) => context ?? {});
    loggedContexts.forEach((context) => {
      expect(context).not.toHaveProperty('interfaceName');
    });

    initiatorService.stop();
    responderService.stop();
  });

  it('invokes applyRemoteUpdate and emits latency-aware diagnostics logs', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const diagnostics = new TestNetworkDiagnostics({
      linkSpeedMbps: 42,
      rssi: -65,
    });

    const applyRemoteUpdate = jest.fn().mockResolvedValue(undefined);
    const logger = jest.fn();

    const responderService = new CollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      applyRemoteUpdate,
      logger,
      networkDiagnostics: diagnostics,
    });

    const initiatorService = new CollabSessionService<{ text: string }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      logger,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');

    await new Promise((resolve) => setImmediate(resolve));

    diagnostics.emit({
      timestamp: Date.now(),
      category: 'excellent',
      linkSpeedMbps: 84,
      rssi: -60,
    });

    await new Promise((resolve) => setImmediate(resolve));

    await initiatorService.broadcastUpdate({ text: 'diagnostics' });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(applyRemoteUpdate).toHaveBeenCalledTimes(1);
    const payload = applyRemoteUpdate.mock.calls[0][0];
    expect(payload.body).toEqual({ text: 'diagnostics' });

    const receivedLog = logger.mock.calls.find(
      ([event]) => event === 'collab.remoteUpdate.received',
    );
    expect(receivedLog).toBeDefined();
    expect(receivedLog?.[1]).toMatchObject({
      schemaVersion: 1,
    });
    expect(receivedLog?.[1]?.diagnostics).toMatchObject({ linkSpeedMbps: 84, rssi: -60 });

    const appliedLog = logger.mock.calls.find(
      ([event]) => event === 'collab.remoteUpdate.applied',
    );
    expect(appliedLog?.[1]).toHaveProperty('applyDurationMs');

    initiatorService.stop();
    responderService.stop();
  });

  it('logs diagnostics retrieval failures', async () => {
    const diagnostics = new TestNetworkDiagnostics();
    diagnostics.setFailure(true);
    const logger = jest.fn();
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const responderService = new CollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
      logger,
    });

    const initiatorService = new CollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
      logger,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger).toHaveBeenCalledWith(
      'collab.networkMetrics.error',
      expect.objectContaining({ error: expect.stringContaining('diagnostics failure') }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('logs encryption errors when remote keys are malformed', () => {
    const responderSignaling = new LoopbackSignalingClient();
    const logger = jest.fn();

    const responderService = new CollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      logger,
    });

    responderSignaling.dispatch('publicKey', 'not-base64');

    expect(logger).toHaveBeenCalledWith(
      'collab.encryptionError',
      expect.objectContaining({ error: expect.any(String) }),
    );

    responderService.stop();
  });

  it('rejects broadcasts when the channel is not ready', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const responderService = new CollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
    });

    const initiatorService = new CollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setTimeout(resolve, 0));

    initiatorService.stop();

    await expect(
      initiatorService.broadcastUpdate({ text: 'should fail' }),
    ).rejects.toThrow('Collaboration channel is not ready');

    responderService.stop();
  });
});
