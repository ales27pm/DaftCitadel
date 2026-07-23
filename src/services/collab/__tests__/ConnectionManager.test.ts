import type {
  RTCDataChannel,
  RTCDataChannelInit,
  RTCIceCandidateInit,
  RTCPeerConnection,
  RTCSessionDescriptionInit,
} from 'react-native-webrtc';
import { ConnectionManager } from '../ConnectionManager';

class DeferredRemoteDescriptionConnection implements RTCPeerConnection {
  onicecandidate: RTCPeerConnection['onicecandidate'] = null;
  ondatachannel: RTCPeerConnection['ondatachannel'] = null;
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  private resolveRemoteDescription?: () => void;
  private deferRemoteDescription = false;

  setDeferred(value: boolean): void {
    this.deferRemoteDescription = value;
  }

  releaseRemoteDescription(): void {
    this.resolveRemoteDescription?.();
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'offer' });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'answer', sdp: 'answer' });
  }

  setLocalDescription(_description: RTCSessionDescriptionInit): Promise<void> {
    return Promise.resolve();
  }

  setRemoteDescription(_description: RTCSessionDescriptionInit): Promise<void> {
    if (!this.deferRemoteDescription) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.resolveRemoteDescription = resolve;
    });
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  createDataChannel(_label: string, _options?: RTCDataChannelInit): RTCDataChannel {
    throw new Error('Data channel not used by this test');
  }

  close(): void {
    // no-op
  }
}

describe('ConnectionManager lifecycle isolation', () => {
  it('does not let an old remote-description continuation drain new ICE candidates', async () => {
    const oldConnection = new DeferredRemoteDescriptionConnection();
    oldConnection.setDeferred(true);
    const newConnection = new DeferredRemoteDescriptionConnection();
    const connections = [oldConnection, newConnection];
    const manager = new ConnectionManager({
      connectionFactory: () => connections.shift() as unknown as RTCPeerConnection,
      logger: jest.fn(),
      onDataChannel: jest.fn(),
      onLocalIceCandidate: jest.fn(),
      maxPendingRemoteCandidates: 2,
    });

    const oldDescription = manager.setRemoteDescription({
      type: 'offer',
      sdp: 'old-offer',
    });
    manager.close();
    manager.getOrCreate();
    await manager.addIceCandidate({ candidate: 'candidate:new' });

    oldConnection.releaseRemoteDescription();
    await expect(oldDescription).rejects.toThrow(/connection changed/);
    expect(oldConnection.addedCandidates).toHaveLength(0);
    expect(newConnection.addedCandidates).toHaveLength(0);

    await manager.setRemoteDescription({ type: 'offer', sdp: 'new-offer' });
    expect(newConnection.addedCandidates).toEqual([{ candidate: 'candidate:new' }]);
    manager.close();
  });
});
