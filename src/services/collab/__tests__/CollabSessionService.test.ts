jest.mock('react-native-webrtc');

import type {
  RTCIceCandidateInit,
  RTCPeerConnection,
  RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import { CollabSessionService, type CollabSessionOptions } from '../CollabSessionService';
import {
  AbstractPeerSignalingClient,
  type SignalingAnswer,
  type SignalingIceCandidate,
  type SignalingOffer,
} from '../PeerSignalingClient';
import { generateIdentityKeyPair, type CollabPayload } from '../encryption';
import type {
  LinkMetrics,
  NetworkDiagnostics,
  NetworkMetricsListener,
} from '../diagnostics/NetworkDiagnostics';
import {
  createHandshakeId,
  createPublicKeySignal,
  serializePublicKeySignal,
} from '../protocol';

const TEST_SHARED_SECRET = new Uint8Array([
  0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed,
  0xfe, 0x0f, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
  0xdd, 0xee, 0xff, 0x00,
]);

function createCollabSessionService<T = unknown>(
  options: Omit<CollabSessionOptions<T>, 'authentication'>,
): CollabSessionService<T> {
  return new CollabSessionService<T>({
    ...options,
    authentication: {
      mode: 'shared-secret',
      sessionId: 'test-session',
      sharedSecret: TEST_SHARED_SECRET,
    },
  });
}

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

type RTCPeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

type RTCIceConnectionState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'disconnected'
  | 'closed';

class MockRTCDataChannel {
  readonly label: string;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmountLowThreshold = 0;
  bufferedAmount = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: (event: unknown) => void;
  onmessage?: ChannelMessageHandler;
  onbufferedamountlow?: () => void;
  readonly sentFrames: string[] = [];
  dropNextMessages = 0;
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
    this.sentFrames.push(data);
    if (this.dropNextMessages > 0) {
      this.dropNextMessages -= 1;
      return;
    }
    this.peer?.onmessage?.({ data });
  }

  replayFrame(index: number): void {
    const frame = this.sentFrames[index];
    if (frame !== undefined) {
      this.peer?.onmessage?.({ data: frame });
    }
  }

  simulateBufferedAmountLow(): void {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.();
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
  onconnectionstatechange?: () => void;
  oniceconnectionstatechange?: () => void;
  public readonly addedCandidates: RTCIceCandidateInit[] = [];
  public lastCreatedChannel?: MockRTCDataChannel;
  public lastReceivedChannel?: MockRTCDataChannel;
  private peer?: MockPeerConnection;
  private pendingRemoteChannels: MockRTCDataChannel[] = [];
  private remoteDescriptionSet = false;
  private currentConnectionState: RTCPeerConnectionState = 'new';
  private currentIceState: RTCIceConnectionState = 'new';

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

  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.currentConnectionState = state;
    this.onconnectionstatechange?.();
  }

  simulateIceConnectionState(state: RTCIceConnectionState): void {
    this.currentIceState = state;
    this.oniceconnectionstatechange?.();
  }

  get connectionState(): RTCPeerConnectionState {
    return this.currentConnectionState;
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.currentIceState;
  }

  private enqueueRemoteChannel(channel: MockRTCDataChannel): void {
    this.lastReceivedChannel = channel;
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

class DeferredOfferPeerConnection extends MockPeerConnection {
  private resolveOffer?: (offer: RTCSessionDescriptionInit) => void;

  override createOffer(): Promise<RTCSessionDescriptionInit> {
    return new Promise((resolve) => {
      this.resolveOffer = resolve;
    });
  }

  releaseOffer(): void {
    this.resolveOffer?.({ type: 'offer', sdp: 'deferred-offer' });
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

    const responderService = createCollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: (payload) => {
        remoteUpdates.push(payload);
        resolveFirstUpdate?.(payload);
      },
    });

    const initiatorService = createCollabSessionService<{ text: string }>({
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

    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
    });

    const initiatorService = createCollabSessionService({
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

    const responderService = createCollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: (payload) => {
        remoteUpdates.push(payload);
        resolveFirstUpdate?.();
      },
    });

    const initiatorService = createCollabSessionService<{ text: string }>({
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

    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
      logger,
    });

    const initiatorService = createCollabSessionService({
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

  it('invokes onRemoteUpdateApplied and emits latency-aware diagnostics logs', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const diagnostics = new TestNetworkDiagnostics({
      linkSpeedMbps: 42,
      rssi: -65,
    });

    const onRemoteUpdateApplied = jest.fn().mockResolvedValue(undefined);
    const logger = jest.fn();

    const responderService = createCollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdateApplied,
      logger,
      networkDiagnostics: diagnostics,
    });

    const initiatorService = createCollabSessionService<{ text: string }>({
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

    expect(onRemoteUpdateApplied).toHaveBeenCalledTimes(1);
    const payload = onRemoteUpdateApplied.mock.calls[0][0];
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

  it('exposes health snapshots covering connection, diagnostics, and latency', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const diagnostics = new TestNetworkDiagnostics({
      linkSpeedMbps: 32,
      rssi: -50,
    });

    const responderService = createCollabSessionService<{ text: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
    });

    const initiatorService = createCollabSessionService<{ text: string }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    const healthEvents: Array<ReturnType<typeof responderService.getHealthSnapshot>> = [];
    const unsubscribe = responderService.subscribeHealth((snapshot) => {
      healthEvents.push(snapshot);
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');

    await new Promise((resolve) => setImmediate(resolve));
    responderConnection.simulateConnectionState('connected');
    responderConnection.simulateIceConnectionState('connected');

    diagnostics.emit({
      timestamp: Date.now(),
      category: 'excellent',
      linkSpeedMbps: 96,
      rssi: -48,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await initiatorService.broadcastUpdate({ text: 'health-check' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const latest = responderService.getHealthSnapshot();
    expect(
      latest.connectionState === 'connected' || latest.connectionState === 'reconnecting',
    ).toBe(true);
    expect(latest.dataChannelState).toBe('open');
    expect(latest.lastMetrics).toMatchObject({ linkSpeedMbps: 96, rssi: -48 });
    expect(typeof latest.lastLatencyMs === 'number').toBe(true);
    expect(typeof latest.averageLatencyMs === 'number').toBe(true);

    expect(healthEvents.some((event) => event.connectionState === 'connecting')).toBe(
      true,
    );
    expect(healthEvents.some((event) => event.connectionState === 'connected')).toBe(
      true,
    );

    unsubscribe();
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

    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      networkDiagnostics: diagnostics,
      logger,
    });

    const initiatorService = createCollabSessionService({
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

  it('rejects malformed authenticated public-key signals', async () => {
    const responderSignaling = new LoopbackSignalingClient();
    const logger = jest.fn();

    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      logger,
    });

    await responderService.start('responder');
    responderSignaling.dispatch('publicKey', 'not-json');
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger).toHaveBeenCalledWith(
      'collab.publicKeyRejected',
      expect.objectContaining({ error: expect.any(String) }),
    );

    responderService.stop();
  });

  it('discards malformed and wrong-session public keys queued before startup', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const logger = jest.fn();
    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      logger,
    });
    const initiatorService = createCollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    responderSignaling.dispatch('publicKey', 'not-json');
    responderSignaling.dispatch(
      'publicKey',
      serializePublicKeySignal(
        createPublicKeySignal({
          sessionId: 'another-session',
          role: 'initiator',
          publicKey: initiatorService.getLocalPublicKey(),
          sharedSecret: TEST_SHARED_SECRET,
          handshakeId: createHandshakeId(),
        }),
      ),
    );

    await expect(responderService.start('responder')).resolves.toBeUndefined();
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    expect(responderService.getHealthSnapshot().authenticatedPeerId).toBeDefined();
    expect(logger).toHaveBeenCalledWith(
      'collab.publicKeyRejected',
      expect.objectContaining({ error: expect.stringContaining('signal JSON') }),
    );
    expect(logger).toHaveBeenCalledWith(
      'collab.publicKeyRejected',
      expect.objectContaining({ error: expect.stringContaining('different session') }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('does not block startup on a queued key with a hanging verifier', async () => {
    const signaling = new LoopbackSignalingClient();
    const verifierStarted = jest.fn();
    const service = new CollabSessionService({
      signalingClient: signaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      authentication: {
        mode: 'verified-key',
        sessionId: 'hanging-verifier-session',
        verifyRemotePublicKey: () => {
          verifierStarted();
          return new Promise<boolean>(() => {});
        },
      },
    });
    signaling.dispatch(
      'publicKey',
      serializePublicKeySignal(
        createPublicKeySignal({
          sessionId: 'hanging-verifier-session',
          role: 'initiator',
          publicKey: generateIdentityKeyPair().publicKey,
          handshakeId: createHandshakeId(),
        }),
      ),
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      service.start('responder').then(() => 'started' as const),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed-out'), 100);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }

    expect(outcome).toBe('started');
    expect(verifierStarted).toHaveBeenCalledTimes(1);
    service.stop();
    expect(service.getHealthSnapshot().connectionState).toBe('disconnected');
  });

  it('does not let concurrent key verifiers overwrite a claimed handshake', async () => {
    const signaling = new LoopbackSignalingClient();
    const logger = jest.fn();
    const verifierResolutions = new Map<string, (accepted: boolean) => void>();
    const firstSignal = createPublicKeySignal({
      sessionId: 'deferred-verifier-session',
      role: 'initiator',
      publicKey: generateIdentityKeyPair().publicKey,
      handshakeId: createHandshakeId(),
    });
    const secondSignal = createPublicKeySignal({
      sessionId: 'deferred-verifier-session',
      role: 'initiator',
      publicKey: generateIdentityKeyPair().publicKey,
      handshakeId: createHandshakeId(),
    });
    const service = new CollabSessionService({
      signalingClient: signaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      authentication: {
        mode: 'verified-key',
        sessionId: 'deferred-verifier-session',
        verifyRemotePublicKey: ({ senderId }) =>
          new Promise<boolean>((resolve) => {
            verifierResolutions.set(senderId, resolve);
          }),
      },
      logger,
    });
    signaling.dispatch('publicKey', serializePublicKeySignal(firstSignal));
    signaling.dispatch('publicKey', serializePublicKeySignal(secondSignal));

    await service.start('responder');
    await new Promise((resolve) => setImmediate(resolve));
    expect(verifierResolutions.size).toBe(2);

    verifierResolutions.get(firstSignal.senderId)?.(true);
    verifierResolutions.get(secondSignal.senderId)?.(true);
    await new Promise((resolve) => setImmediate(resolve));
    const handshakeState = service as unknown as {
      pendingRemoteSenderId?: string;
      pendingRemoteHandshakeId?: string;
    };
    expect(handshakeState.pendingRemoteSenderId).toBe(firstSignal.senderId);
    expect(handshakeState.pendingRemoteHandshakeId).toBe(firstSignal.handshakeId);
    expect(logger).toHaveBeenCalledWith(
      'collab.publicKeyRejected',
      expect.objectContaining({
        error: expect.stringContaining('changed before key confirmation'),
      }),
    );
    service.stop();
  });

  it('rejects broadcasts when the channel is not ready', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);

    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
    });

    const initiatorService = createCollabSessionService({
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

  it('requires session-bound authentication configuration', () => {
    const signaling = new LoopbackSignalingClient();

    expect(
      () =>
        new CollabSessionService({
          signalingClient: signaling,
          connectionFactory: () =>
            new MockPeerConnection() as unknown as RTCPeerConnection,
        }),
    ).toThrow(/requires a session-bound shared secret/);
  });

  it('discards queued public keys with invalid authentication proofs', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorLogger = jest.fn();
    const responderService = new CollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      authentication: {
        mode: 'shared-secret',
        sessionId: 'authenticated-session',
        sharedSecret: new Uint8Array(32).fill(1),
      },
    });
    const initiatorService = new CollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      authentication: {
        mode: 'shared-secret',
        sessionId: 'authenticated-session',
        sharedSecret: new Uint8Array(32).fill(2),
      },
      logger: initiatorLogger,
    });

    await responderService.start('responder');
    await expect(initiatorService.start('initiator')).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(initiatorService.getHealthSnapshot().authenticatedPeerId).toBeUndefined();
    expect(responderService.getHealthSnapshot().authenticatedPeerId).toBeUndefined();
    expect(initiatorLogger).toHaveBeenCalledWith(
      'collab.publicKeyRejected',
      expect.objectContaining({
        error: expect.stringContaining('authentication failed'),
      }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('supports session-bound out-of-band public-key verification', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    let expectedInitiatorKey = '';
    let expectedResponderKey = '';
    const onRemoteUpdate = jest.fn();
    const responderService = new CollabSessionService<{ verified: boolean }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      authentication: {
        mode: 'verified-key',
        sessionId: 'verified-session',
        verifyRemotePublicKey: ({ sessionId, publicKey }) =>
          sessionId === 'verified-session' && publicKey === expectedInitiatorKey,
      },
      onRemoteUpdate,
    });
    const initiatorService = new CollabSessionService<{ verified: boolean }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      authentication: {
        mode: 'verified-key',
        sessionId: 'verified-session',
        verifyRemotePublicKey: ({ sessionId, publicKey }) =>
          sessionId === 'verified-session' && publicKey === expectedResponderKey,
      },
    });
    expectedInitiatorKey = initiatorService.getLocalPublicKey();
    expectedResponderKey = responderService.getLocalPublicKey();

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    await initiatorService.broadcastUpdate({ verified: true });

    expect(onRemoteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ body: { verified: true } }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('does not authenticate an allowlisted public key without possession proof', async () => {
    const signaling = new LoopbackSignalingClient();
    const trustedPeer = new CollabSessionService({
      signalingClient: new LoopbackSignalingClient(),
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      authentication: {
        mode: 'verified-key',
        sessionId: 'proof-session',
        verifyRemotePublicKey: () => false,
      },
    });
    const trustedPublicKey = trustedPeer.getLocalPublicKey();
    const service = new CollabSessionService({
      signalingClient: signaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      authentication: {
        mode: 'verified-key',
        sessionId: 'proof-session',
        verifyRemotePublicKey: ({ publicKey }) => publicKey === trustedPublicKey,
      },
    });
    await service.start('responder');

    signaling.dispatch(
      'publicKey',
      serializePublicKeySignal(
        createPublicKeySignal({
          sessionId: 'proof-session',
          role: 'initiator',
          publicKey: trustedPublicKey,
          handshakeId: createHandshakeId(),
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getHealthSnapshot().authenticatedPeerId).toBeUndefined();
    service.stop();
    trustedPeer.stop();
  });

  it('rejects a valid but unsolicited re-handshake after key confirmation', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const logger = jest.fn();
    const responderService = createCollabSessionService({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
    });
    const initiatorService = createCollabSessionService({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      logger,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    const authenticatedPeerId = initiatorService.getHealthSnapshot().authenticatedPeerId;
    expect(authenticatedPeerId).toBeDefined();

    initiatorSignaling.dispatch(
      'publicKey',
      serializePublicKeySignal(
        createPublicKeySignal({
          sessionId: 'test-session',
          role: 'responder',
          publicKey: responderService.getLocalPublicKey(),
          sharedSecret: TEST_SHARED_SECRET,
          handshakeId: createHandshakeId(),
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(initiatorService.getHealthSnapshot().authenticatedPeerId).toBe(
      authenticatedPeerId,
    );
    expect(logger).toHaveBeenCalledWith(
      'collab.publicKeyRejected',
      expect.objectContaining({ error: expect.stringContaining('unsolicited') }),
    );
    initiatorService.stop();
    responderService.stop();
  });

  it('suppresses replayed encrypted updates while acknowledging the duplicate', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const onRemoteUpdate = jest.fn();
    const logger = jest.fn();
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate,
      logger,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    await initiatorService.broadcastUpdate({ value: 1 });

    const sentFrames = initiatorConnection.lastCreatedChannel?.sentFrames ?? [];
    initiatorConnection.lastCreatedChannel?.replayFrame(sentFrames.length - 1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      'collab.replayIgnored',
      expect.objectContaining({ sequence: 1 }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('retransmits unacknowledged updates without applying them twice', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const onRemoteUpdate = jest.fn();
    const responderLogger = jest.fn();
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate,
      logger: responderLogger,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 10,
      maxAcknowledgementRetries: 2,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    if (!responderConnection.lastReceivedChannel) {
      throw new Error('Expected responder data channel');
    }
    responderConnection.lastReceivedChannel.dropNextMessages = 1;

    await initiatorService.broadcastUpdate({ value: 7 });

    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
    expect(responderLogger).toHaveBeenCalledWith(
      'collab.replayIgnored',
      expect.objectContaining({ sequence: 1 }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('requests and replays bounded history when updates arrive out of order', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const applied: number[] = [];
    const logger = jest.fn();
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: ({ body }) => applied.push(body.value),
      logger,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 100,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    if (!initiatorConnection.lastCreatedChannel) {
      throw new Error('Expected initiator data channel');
    }
    initiatorConnection.lastCreatedChannel.dropNextMessages = 1;

    await Promise.all([
      initiatorService.broadcastUpdate({ value: 1 }),
      initiatorService.broadcastUpdate({ value: 2 }),
    ]);

    expect(applied).toEqual([1, 2]);
    expect(logger).toHaveBeenCalledWith(
      'collab.resyncRequested',
      expect.objectContaining({ expectedSequence: 1 }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('does not reserve sequence numbers for unserializable or oversized updates', async () => {
    type ReliabilityPayload = {
      value: number | string;
      self?: ReliabilityPayload;
    };
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const applied: Array<number | string> = [];
    const responderService = createCollabSessionService<ReliabilityPayload>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: ({ body }) => applied.push(body.value),
    });
    const initiatorService = createCollabSessionService<ReliabilityPayload>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      maxFrameBytes: 4_096,
      acknowledgementTimeoutMs: 20,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    const circular: ReliabilityPayload = { value: 1 };
    circular.self = circular;
    await expect(initiatorService.broadcastUpdate(circular)).rejects.toThrow();
    expect(initiatorService.getHealthSnapshot().pendingAcknowledgements).toBe(0);

    await expect(
      initiatorService.broadcastUpdate({ value: 'x'.repeat(10_000) }),
    ).rejects.toThrow(/frame exceeds/);
    expect(initiatorService.getHealthSnapshot().pendingAcknowledgements).toBe(0);

    await initiatorService.broadcastUpdate({ value: 3 });
    expect(applied).toEqual([3]);

    initiatorService.stop();
    responderService.stop();
  });

  it('snapshots caller-owned payloads before retrying an update', async () => {
    type SnapshotPayload = {
      value: number;
      serialization?: number;
      toJSON?: () => { value: number; serialization: number };
    };
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const applied: Array<{ value: number; serialization?: number }> = [];
    const responderService = createCollabSessionService<SnapshotPayload>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate: ({ body }) => {
        applied.push({ value: body.value, serialization: body.serialization });
      },
    });
    const initiatorService = createCollabSessionService<SnapshotPayload>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 50,
      maxAcknowledgementRetries: 1,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    const channel = initiatorConnection.lastCreatedChannel;
    if (!channel) {
      throw new Error('Expected initiator data channel');
    }
    channel.dropNextMessages = 1;
    let serializationCount = 0;
    const payload: SnapshotPayload = {
      value: 1,
      toJSON() {
        serializationCount += 1;
        return { value: this.value, serialization: serializationCount };
      },
    };
    const sentFrameCount = channel.sentFrames.length;

    const broadcast = initiatorService.broadcastUpdate(payload);
    await new Promise((resolve) => setImmediate(resolve));
    expect(channel.sentFrames.length).toBe(sentFrameCount + 1);
    payload.value = 99;
    await broadcast;

    expect(serializationCount).toBe(1);
    expect(applied).toEqual([{ value: 1, serialization: 1 }]);
    initiatorService.stop();
    responderService.stop();
  });

  it('waits for bufferedAmount backpressure before sending', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const onRemoteUpdate = jest.fn();
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      backpressureTimeoutMs: 1_000,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    const channel = initiatorConnection.lastCreatedChannel;
    if (!channel) {
      throw new Error('Expected initiator data channel');
    }
    const handshakeFrameCount = channel.sentFrames.length;
    channel.bufferedAmount = 600 * 1024;
    const broadcast = initiatorService.broadcastUpdate({ value: 3 });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(channel.sentFrames).toHaveLength(handshakeFrameCount);
    channel.simulateBufferedAmountLow();
    await broadcast;

    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);

    initiatorService.stop();
    responderService.stop();
  });

  it('hard-caps queued inbound frames while an application callback is blocked', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const logger = jest.fn();
    let releaseApply: (() => void) | undefined;
    let markApplyStarted: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => {
      markApplyStarted = resolve;
    });
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const onRemoteUpdateApplied = jest.fn(async () => {
      markApplyStarted?.();
      await applyGate;
    });
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      maxQueuedInboundFrames: 1,
      onRemoteUpdateApplied,
      logger,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    const broadcast = initiatorService.broadcastUpdate({ value: 1 });
    await applyStarted;
    const channel = initiatorConnection.lastCreatedChannel;
    if (!channel) {
      throw new Error('Expected initiator data channel');
    }
    const updateFrame = channel.sentFrames.length - 1;
    channel.replayFrame(updateFrame);
    channel.replayFrame(updateFrame);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger).toHaveBeenCalledWith(
      'collab.incomingQueueOverflow',
      expect.objectContaining({ generation: expect.any(Number) }),
    );

    releaseApply?.();
    await broadcast;
    expect(onRemoteUpdateApplied).toHaveBeenCalledTimes(1);
    initiatorService.stop();
    responderService.stop();
  });

  it('hard-caps queued inbound bytes before retaining an oversized frame', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const logger = jest.fn();
    const responderService = createCollabSessionService<{ value: string }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      maxQueuedInboundBytes: 1024,
      logger,
    });
    const initiatorService = createCollabSessionService<{ value: string }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 10,
      maxAcknowledgementRetries: 0,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      initiatorService.broadcastUpdate({ value: 'x'.repeat(2_000) }),
    ).rejects.toThrow(/not acknowledged/);
    expect(logger).toHaveBeenCalledWith(
      'collab.incomingQueueOverflow',
      expect.objectContaining({ frameBytes: expect.any(Number) }),
    );
    initiatorService.stop();
    responderService.stop();
  });

  it('rejects outbound admission when the pending acknowledgement window is full', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      maxPendingAcknowledgements: 1,
      acknowledgementTimeoutMs: 1_000,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    const responderChannel = responderConnection.lastReceivedChannel;
    if (!responderChannel) {
      throw new Error('Expected responder data channel');
    }
    responderChannel.dropNextMessages = 1;

    const firstResult = initiatorService
      .broadcastUpdate({ value: 1 })
      .then(() => undefined)
      .catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(initiatorService.broadcastUpdate({ value: 2 })).rejects.toThrow(
      /window is full/,
    );
    expect(initiatorService.getHealthSnapshot().pendingAcknowledgements).toBe(1);

    initiatorService.stop();
    expect(await firstResult).toBeInstanceOf(Error);
    responderService.stop();
  });

  it('withholds acknowledgements when the application callback fails', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const onRemoteUpdate = jest
      .fn()
      .mockRejectedValue(new Error('application rejected update'));
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 10,
      maxAcknowledgementRetries: 0,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    await expect(initiatorService.broadcastUpdate({ value: 1 })).rejects.toThrow(
      /not acknowledged/,
    );
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
    initiatorService.stop();
    responderService.stop();
  });

  it('acknowledges an authoritative apply when its observer fails', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const logger = jest.fn();
    const onRemoteUpdateApplied = jest.fn().mockResolvedValue(undefined);
    const onRemoteUpdate = jest
      .fn()
      .mockRejectedValue(new Error('observer rejected update'));
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdateApplied,
      onRemoteUpdate,
      logger,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 10,
      maxAcknowledgementRetries: 2,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    const responderChannel = responderConnection.lastReceivedChannel;
    if (!responderChannel) {
      throw new Error('Expected responder data channel');
    }
    responderChannel.dropNextMessages = 1;

    await expect(initiatorService.broadcastUpdate({ value: 1 })).resolves.toBeUndefined();

    expect(onRemoteUpdateApplied).toHaveBeenCalledTimes(1);
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      'collab.remoteUpdate.listenerError',
      expect.objectContaining({ error: expect.stringContaining('observer rejected') }),
    );
    initiatorService.stop();
    responderService.stop();
  });

  it('does not hold an authoritative acknowledgement for a pending observer', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    let markObserverStarted: (() => void) | undefined;
    let releaseObserver: (() => void) | undefined;
    let observerFinished = false;
    const observerStarted = new Promise<void>((resolve) => {
      markObserverStarted = resolve;
    });
    const observerGate = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const onRemoteUpdateApplied = jest.fn().mockResolvedValue(undefined);
    const onRemoteUpdate = jest.fn(async () => {
      markObserverStarted?.();
      await observerGate;
      observerFinished = true;
    }) as unknown as jest.MockedFunction<
      (payload: CollabPayload<{ value: number }>) => void
    >;
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdateApplied,
      onRemoteUpdate,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      acknowledgementTimeoutMs: 10,
      maxAcknowledgementRetries: 0,
    });
    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    const broadcast = initiatorService.broadcastUpdate({ value: 1 });
    await observerStarted;
    await expect(broadcast).resolves.toBeUndefined();

    expect(observerFinished).toBe(false);
    expect(onRemoteUpdateApplied).toHaveBeenCalledTimes(1);
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1);
    releaseObserver?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(observerFinished).toBe(true);
    initiatorService.stop();
    responderService.stop();
  });

  it('caps staged ICE candidates and rejects oversized signaling payloads', async () => {
    const signaling = new LoopbackSignalingClient();
    const logger = jest.fn();
    const service = createCollabSessionService({
      signalingClient: signaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
      maxPendingIceCandidates: 1,
      maxIceCandidateBytes: 8,
      maxSdpBytes: 8,
      logger,
    });
    await service.start('responder');

    signaling.dispatch('iceCandidate', { candidate: 'first' });
    signaling.dispatch('iceCandidate', { candidate: 'second' });
    signaling.dispatch('iceCandidate', { candidate: 'candidate-too-large' });
    signaling.dispatch('offer', { type: 'offer', sdp: 'sdp-too-large' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger).toHaveBeenCalledWith(
      'collab.handleIceCandidateUnhandledError',
      expect.objectContaining({ error: expect.stringContaining('queue is full') }),
    );
    expect(logger).toHaveBeenCalledWith(
      'collab.handleIceCandidateUnhandledError',
      expect.objectContaining({ error: expect.stringContaining('size limit') }),
    );
    expect(logger).toHaveBeenCalledWith(
      'collab.handleOfferUnhandledError',
      expect.objectContaining({ error: expect.stringContaining('size limit') }),
    );
    service.stop();
  });

  it('rejects schema-mismatched updates without acknowledging them', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const logger = jest.fn();
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      schemaVersion: 1,
      logger,
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
      schemaVersion: 2,
      acknowledgementTimeoutMs: 10,
      maxAcknowledgementRetries: 0,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));

    await expect(initiatorService.broadcastUpdate({ value: 4 })).rejects.toThrow(
      /was not acknowledged/,
    );
    expect(logger).toHaveBeenCalledWith(
      'collab.incomingFrameError',
      expect.objectContaining({
        error: expect.stringContaining('schema version 2'),
      }),
    );

    initiatorService.stop();
    responderService.stop();
  });

  it('cancels a deferred start before it can send an offer', async () => {
    const signaling = new LoopbackSignalingClient();
    const connection = new DeferredOfferPeerConnection();
    const service = createCollabSessionService({
      signalingClient: signaling,
      connectionFactory: () => connection as unknown as RTCPeerConnection,
    });
    const sendOffer = jest.spyOn(signaling, 'sendOffer');

    const start = service.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    service.stop();
    connection.releaseOffer();

    await expect(start).rejects.toThrow(/lifecycle was cancelled/);
    expect(sendOffer).not.toHaveBeenCalled();
  });

  it('aborts an in-flight remote application and skips post-stop listeners', async () => {
    const [initiatorSignaling, responderSignaling] = pairSignalingClients();
    const initiatorConnection = new MockPeerConnection();
    const responderConnection = new MockPeerConnection();
    initiatorConnection.linkPeer(responderConnection);
    const onRemoteUpdate = jest.fn();
    let observedSignal: AbortSignal | undefined;
    let resolveApplyStarted: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => {
      resolveApplyStarted = resolve;
    });
    const responderService = createCollabSessionService<{ value: number }>({
      signalingClient: responderSignaling,
      connectionFactory: () => responderConnection as unknown as RTCPeerConnection,
      onRemoteUpdate,
      onRemoteUpdateApplied: (_payload, { signal }) =>
        new Promise<void>((resolve) => {
          observedSignal = signal;
          resolveApplyStarted?.();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const initiatorService = createCollabSessionService<{ value: number }>({
      signalingClient: initiatorSignaling,
      connectionFactory: () => initiatorConnection as unknown as RTCPeerConnection,
    });

    await responderService.start('responder');
    await initiatorService.start('initiator');
    await new Promise((resolve) => setImmediate(resolve));
    const broadcast = initiatorService.broadcastUpdate({ value: 5 });
    await applyStarted;
    responderService.stop();

    await expect(broadcast).rejects.toThrow(/channel closed/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(observedSignal?.aborted).toBe(true);
    expect(onRemoteUpdate).not.toHaveBeenCalled();

    initiatorService.stop();
  });

  it('re-registers signaling listeners when restarted', async () => {
    const signaling = new LoopbackSignalingClient();
    const service = createCollabSessionService({
      signalingClient: signaling,
      connectionFactory: () => new MockPeerConnection() as unknown as RTCPeerConnection,
    });

    expect(signaling.listenerCount('publicKey')).toBe(1);
    service.stop();
    expect(signaling.listenerCount('publicKey')).toBe(0);

    await service.start('responder');
    expect(signaling.listenerCount('publicKey')).toBe(1);
    service.stop();
  });
});
