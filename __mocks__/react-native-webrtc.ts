export class RTCPeerConnection {
  constructor() {
    throw new Error('react-native-webrtc mock peer connection should not be instantiated in tests. Provide a connectionFactory.');
  }
}

export type RTCConfiguration = Record<string, never>;
export type RTCDataChannel = unknown;
export type RTCDataChannelEvent = { channel: RTCDataChannel };
export type RTCIceCandidateInit = Record<string, unknown>;
export type RTCSessionDescriptionInit = { type?: string; sdp?: string };
