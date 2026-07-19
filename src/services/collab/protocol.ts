import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import {
  createAuthenticationProof,
  fingerprintPublicKey,
  type Ciphertext,
  verifyAuthenticationProof,
} from './encryption';

export const COLLAB_PROTOCOL_VERSION = 1 as const;

export type CollabProtocolRole = 'initiator' | 'responder';

export interface AuthenticatedPublicKeySignal {
  readonly protocolVersion: typeof COLLAB_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly senderId: string;
  readonly handshakeId: string;
  readonly role: CollabProtocolRole;
  readonly publicKey: string;
  readonly authenticationMode: 'shared-secret' | 'verified-key';
  readonly proof?: Ciphertext;
}

interface WireMessageBase {
  readonly protocolVersion: typeof COLLAB_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly senderId: string;
}

export interface UpdateWireMessage<T> extends WireMessageBase {
  readonly kind: 'update';
  readonly messageId: string;
  readonly sequence: number;
  readonly payload: T;
  readonly resync?: boolean;
}

export interface AckWireMessage extends WireMessageBase {
  readonly kind: 'ack';
  readonly messageId: string;
  readonly sequence: number;
}

export interface ResyncRequestWireMessage extends WireMessageBase {
  readonly kind: 'resync-request';
  readonly expectedSequence: number;
}

/**
 * Encrypted transcript confirmation. Successfully opening this message proves
 * that the sender possesses the private key for the advertised public key;
 * merely replaying an allowlisted public key signal is insufficient.
 */
export interface KeyConfirmationWireMessage extends WireMessageBase {
  readonly kind: 'key-confirmation';
  readonly handshakeId: string;
  readonly peerHandshakeId: string;
}

export type CollabWireMessage<T> =
  | UpdateWireMessage<T>
  | AckWireMessage
  | ResyncRequestWireMessage
  | KeyConfirmationWireMessage;

const MAX_SIGNAL_LENGTH = 16 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new Error(`Invalid collaboration ${name}`);
  }
  return value;
}

function requireSequence(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid collaboration ${name}`);
  }
  return value as number;
}

function isCiphertext(value: unknown): value is Ciphertext {
  return (
    isRecord(value) && typeof value.nonce === 'string' && typeof value.box === 'string'
  );
}

export function createSessionBinding(sessionId: string): Uint8Array {
  const normalized = requireIdentifier(sessionId, 'session id');
  return new Uint8Array(
    Buffer.from(
      `daft-citadel-collaboration:${COLLAB_PROTOCOL_VERSION}:${normalized}`,
      'utf8',
    ),
  );
}

export function createPeerEncryptionBinding({
  sessionId,
  localSenderId,
  localHandshakeId,
  remoteSenderId,
  remoteHandshakeId,
}: {
  sessionId: string;
  localSenderId: string;
  localHandshakeId: string;
  remoteSenderId: string;
  remoteHandshakeId: string;
}): Uint8Array {
  const peers = [
    {
      senderId: requireIdentifier(localSenderId, 'local sender id'),
      handshakeId: requireIdentifier(localHandshakeId, 'local handshake id'),
    },
    {
      senderId: requireIdentifier(remoteSenderId, 'remote sender id'),
      handshakeId: requireIdentifier(remoteHandshakeId, 'remote handshake id'),
    },
  ].sort((left, right) => left.senderId.localeCompare(right.senderId));
  return new Uint8Array(
    Buffer.from(
      JSON.stringify({
        sessionBinding: Buffer.from(createSessionBinding(sessionId)).toString('base64'),
        peers,
      }),
      'utf8',
    ),
  );
}

export function createHandshakeClaim(
  signal: Omit<AuthenticatedPublicKeySignal, 'proof'>,
): string {
  return JSON.stringify({
    protocolVersion: signal.protocolVersion,
    sessionId: signal.sessionId,
    senderId: signal.senderId,
    handshakeId: signal.handshakeId,
    role: signal.role,
    publicKey: signal.publicKey,
    authenticationMode: signal.authenticationMode,
  });
}

export function createPublicKeySignal({
  sessionId,
  role,
  publicKey,
  sharedSecret,
  handshakeId,
}: {
  sessionId: string;
  role: CollabProtocolRole;
  publicKey: string;
  sharedSecret?: Uint8Array;
  handshakeId: string;
}): AuthenticatedPublicKeySignal {
  const senderId = fingerprintPublicKey(publicKey);
  const signalWithoutProof: Omit<AuthenticatedPublicKeySignal, 'proof'> = {
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sessionId: requireIdentifier(sessionId, 'session id'),
    senderId,
    handshakeId: requireIdentifier(handshakeId, 'handshake id'),
    role,
    publicKey,
    authenticationMode: sharedSecret ? 'shared-secret' : 'verified-key',
  };
  return {
    ...signalWithoutProof,
    proof: sharedSecret
      ? createAuthenticationProof(
          createHandshakeClaim(signalWithoutProof),
          sharedSecret,
          createSessionBinding(sessionId),
        )
      : undefined,
  };
}

export function serializePublicKeySignal(signal: AuthenticatedPublicKeySignal): string {
  return JSON.stringify(signal);
}

export function parsePublicKeySignal(value: string): AuthenticatedPublicKeySignal {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SIGNAL_LENGTH
  ) {
    throw new Error('Invalid collaboration public-key signal');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Invalid collaboration public-key signal JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('Invalid collaboration public-key signal payload');
  }
  if (parsed.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
    throw new Error('Unsupported collaboration handshake protocol version');
  }
  if (parsed.role !== 'initiator' && parsed.role !== 'responder') {
    throw new Error('Invalid collaboration peer role');
  }
  if (
    parsed.authenticationMode !== 'shared-secret' &&
    parsed.authenticationMode !== 'verified-key'
  ) {
    throw new Error('Invalid collaboration authentication mode');
  }

  const publicKey = requireIdentifier(parsed.publicKey, 'public key');
  const signal: AuthenticatedPublicKeySignal = {
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sessionId: requireIdentifier(parsed.sessionId, 'session id'),
    senderId: requireIdentifier(parsed.senderId, 'sender id'),
    handshakeId: requireIdentifier(parsed.handshakeId, 'handshake id'),
    role: parsed.role,
    publicKey,
    authenticationMode: parsed.authenticationMode,
    proof: parsed.proof === undefined ? undefined : (parsed.proof as Ciphertext),
  };
  if (signal.senderId !== fingerprintPublicKey(publicKey)) {
    throw new Error('Collaboration sender id does not match its public key');
  }
  if (signal.proof !== undefined && !isCiphertext(signal.proof)) {
    throw new Error('Invalid collaboration authentication proof');
  }
  return signal;
}

export function createHandshakeId(): string {
  return Buffer.from(nacl.randomBytes(16)).toString('base64');
}

export function verifySharedSecretPublicKeySignal(
  signal: AuthenticatedPublicKeySignal,
  sharedSecret: Uint8Array,
): boolean {
  if (signal.authenticationMode !== 'shared-secret' || !signal.proof) {
    return false;
  }
  const { proof, ...claim } = signal;
  return verifyAuthenticationProof(
    proof,
    createHandshakeClaim(claim),
    sharedSecret,
    createSessionBinding(signal.sessionId),
  );
}

export function createMessageId(senderId: string, sequence: number): string {
  return `${requireIdentifier(senderId, 'sender id')}:${requireSequence(
    sequence,
    'sequence',
  )}`;
}

export function validateWireMessage<T>(value: unknown): CollabWireMessage<T> {
  if (!isRecord(value)) {
    throw new Error('Invalid collaboration wire message');
  }
  if (value.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
    throw new Error('Unsupported collaboration wire protocol version');
  }
  const base = {
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sessionId: requireIdentifier(value.sessionId, 'session id'),
    senderId: requireIdentifier(value.senderId, 'sender id'),
  } as const;

  if (value.kind === 'update') {
    if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
      throw new Error('Collaboration update is missing its payload');
    }
    const sequence = requireSequence(value.sequence, 'update sequence');
    const messageId = requireIdentifier(value.messageId, 'message id');
    if (messageId !== createMessageId(base.senderId, sequence)) {
      throw new Error('Collaboration update message id is not sender-bound');
    }
    if (value.resync !== undefined && typeof value.resync !== 'boolean') {
      throw new Error('Invalid collaboration resync flag');
    }
    return {
      ...base,
      kind: 'update',
      messageId,
      sequence,
      payload: value.payload as T,
      resync: value.resync,
    };
  }

  if (value.kind === 'ack') {
    return {
      ...base,
      kind: 'ack',
      messageId: requireIdentifier(value.messageId, 'acknowledgement message id'),
      sequence: requireSequence(value.sequence, 'acknowledgement sequence'),
    };
  }

  if (value.kind === 'resync-request') {
    return {
      ...base,
      kind: 'resync-request',
      expectedSequence: requireSequence(
        value.expectedSequence,
        'resynchronization sequence',
      ),
    };
  }

  if (value.kind === 'key-confirmation') {
    return {
      ...base,
      kind: 'key-confirmation',
      handshakeId: requireIdentifier(value.handshakeId, 'key-confirmation handshake id'),
      peerHandshakeId: requireIdentifier(
        value.peerHandshakeId,
        'key-confirmation peer handshake id',
      ),
    };
  }

  throw new Error('Unsupported collaboration wire message kind');
}
