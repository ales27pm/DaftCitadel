declare module 'react-native-webrtc' {
  export interface RTCDataChannelInit {
    ordered?: boolean;
    maxPacketLifeTime?: number;
    maxRetransmits?: number;
  }

  export interface RTCIceCandidateInit {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }

  export interface RTCSessionDescriptionInit {
    type?: 'offer' | 'answer' | 'pranswer' | 'rollback';
    sdp?: string;
  }

  export interface RTCDataChannel {
    readonly label: string;
    readyState: 'connecting' | 'open' | 'closing' | 'closed';
    bufferedAmountLowThreshold: number;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    close(): void;
    send(data: string | ArrayBuffer | ArrayBufferView): void;
  }

  export interface RTCDataChannelEvent {
    channel: RTCDataChannel;
  }

  export interface RTCPeerConnection {
    createOffer(): Promise<RTCSessionDescriptionInit>;
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
    createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
    close(): void;
    onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null;
    ondatachannel: ((event: RTCDataChannelEvent) => void) | null;
  }

  export interface RTCConfiguration {
    iceServers?: Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
    }>;
    iceTransportPolicy?: 'all' | 'relay';
    bundlePolicy?: 'balanced' | 'max-compat' | 'max-bundle';
    [key: string]: unknown;
  }

  export const RTCPeerConnection: new (
    configuration?: RTCConfiguration,
  ) => RTCPeerConnection;
}
