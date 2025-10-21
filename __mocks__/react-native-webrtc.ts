export class RTCPeerConnection {
  constructor(_configuration?: unknown) {
    throw new Error(
      'react-native-webrtc mock peer connection should not be instantiated in tests. Provide a connectionFactory.',
    );
  }
}
