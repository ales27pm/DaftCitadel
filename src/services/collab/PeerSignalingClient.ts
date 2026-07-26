import { EventEmitter } from 'events';

export interface SignalingOffer {
  readonly sdp: string;
  readonly type: 'offer';
}

export interface SignalingAnswer {
  readonly sdp: string;
  readonly type: 'answer';
}

export interface SignalingIceCandidate {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

export interface SignalingEventMap {
  offer: (offer: SignalingOffer) => void;
  answer: (answer: SignalingAnswer) => void;
  iceCandidate: (candidate: SignalingIceCandidate) => void;
  publicKey: (publicKey: string) => void;
  shutdown: () => void;
}

type EventKey = keyof SignalingEventMap;

type Listener<K extends EventKey> = SignalingEventMap[K];

export interface PeerSignalingClient {
  sendOffer(offer: SignalingOffer): Promise<void>;
  sendAnswer(answer: SignalingAnswer): Promise<void>;
  sendIceCandidate(candidate: SignalingIceCandidate): Promise<void>;
  sendPublicKey(publicKey: string): Promise<void>;
  disconnect(): Promise<void>;
  on<K extends EventKey>(event: K, listener: Listener<K>): this;
  off<K extends EventKey>(event: K, listener: Listener<K>): this;
}

export abstract class AbstractPeerSignalingClient
  extends EventEmitter
  implements PeerSignalingClient
{
  constructor() {
    super();
  }

  abstract sendOffer(offer: SignalingOffer): Promise<void>;

  abstract sendAnswer(answer: SignalingAnswer): Promise<void>;

  abstract sendIceCandidate(candidate: SignalingIceCandidate): Promise<void>;

  abstract sendPublicKey(publicKey: string): Promise<void>;

  abstract disconnect(): Promise<void>;

  on<K extends EventKey>(event: K, listener: Listener<K>): this {
    super.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends EventKey>(event: K, listener: Listener<K>): this {
    super.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  protected emitEvent<K extends EventKey>(
    event: K,
    ...payload: Parameters<SignalingEventMap[K]>
  ): void {
    super.emit(event, ...payload);
  }
}
