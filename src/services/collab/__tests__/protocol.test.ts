import {
  COLLAB_PROTOCOL_VERSION,
  createHandshakeId,
  createMessageId,
  createPeerEncryptionBinding,
  createPublicKeySignal,
  parsePublicKeySignal,
  serializePublicKeySignal,
  validateWireMessage,
  verifySharedSecretPublicKeySignal,
} from '../protocol';
import { generateIdentityKeyPair } from '../encryption';

describe('collaboration protocol validation', () => {
  it('uses protocol v2 and rejects legacy wire frames explicitly', () => {
    expect(COLLAB_PROTOCOL_VERSION).toBe(2);
    const legacySignal = createPublicKeySignal({
      sessionId: 'session-a',
      role: 'initiator',
      publicKey: generateIdentityKeyPair().publicKey,
      sharedSecret: new Uint8Array(32).fill(9),
      handshakeId: createHandshakeId(),
    });
    expect(() =>
      parsePublicKeySignal(JSON.stringify({ ...legacySignal, protocolVersion: 1 })),
    ).toThrow(/Unsupported collaboration handshake protocol version/);
    expect(() =>
      validateWireMessage({
        protocolVersion: 1,
        sessionId: 'session-a',
        senderId: 'legacy-peer',
        kind: 'ack',
        messageId: 'legacy-peer:1',
        sequence: 1,
      }),
    ).toThrow(/Unsupported collaboration wire protocol version/);
  });

  it('binds authenticated key proofs to the session and full handshake claim', () => {
    const sharedSecret = new Uint8Array(32).fill(7);
    const signal = createPublicKeySignal({
      sessionId: 'session-a',
      role: 'initiator',
      publicKey: generateIdentityKeyPair().publicKey,
      sharedSecret,
      handshakeId: createHandshakeId(),
    });

    expect(verifySharedSecretPublicKeySignal(signal, sharedSecret)).toBe(true);
    expect(
      verifySharedSecretPublicKeySignal(
        { ...signal, sessionId: 'session-b' },
        sharedSecret,
      ),
    ).toBe(false);
    expect(
      verifySharedSecretPublicKeySignal({ ...signal, role: 'responder' }, sharedSecret),
    ).toBe(false);
  });

  it('orders encryption transcript peers by deterministic code-unit order', () => {
    const binding = createPeerEncryptionBinding({
      sessionId: 'session-a',
      localSenderId: 'a-peer',
      localHandshakeId: 'handshake-a',
      remoteSenderId: 'B-peer',
      remoteHandshakeId: 'handshake-b',
    });
    const transcript = JSON.parse(Buffer.from(binding).toString('utf8')) as {
      peers: Array<{ senderId: string; handshakeId: string }>;
    };

    expect(transcript.peers).toEqual([
      { senderId: 'B-peer', handshakeId: 'handshake-b' },
      { senderId: 'a-peer', handshakeId: 'handshake-a' },
    ]);

    const collisionForward = createPeerEncryptionBinding({
      sessionId: 'session-a',
      localSenderId: 'same-peer',
      localHandshakeId: 'handshake-b',
      remoteSenderId: 'same-peer',
      remoteHandshakeId: 'handshake-a',
    });
    const collisionReverse = createPeerEncryptionBinding({
      sessionId: 'session-a',
      localSenderId: 'same-peer',
      localHandshakeId: 'handshake-a',
      remoteSenderId: 'same-peer',
      remoteHandshakeId: 'handshake-b',
    });

    expect(collisionForward).toEqual(collisionReverse);
  });

  it('rejects a signaling sender id that is not derived from the public key', () => {
    const signal = createPublicKeySignal({
      sessionId: 'session-a',
      role: 'responder',
      publicKey: generateIdentityKeyPair().publicKey,
      sharedSecret: new Uint8Array(32).fill(3),
      handshakeId: createHandshakeId(),
    });

    expect(() =>
      parsePublicKeySignal(
        serializePublicKeySignal({ ...signal, senderId: 'substituted-peer' }),
      ),
    ).toThrow(/sender id does not match/);
  });

  it('rejects unsafe sequence values and sender-unbound message ids', () => {
    const senderId = 'authenticated-peer';
    const valid = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: 'session-a',
      senderId,
      kind: 'update' as const,
      messageId: createMessageId(senderId, 1),
      sequence: 1,
      payload: { ok: true },
    };

    expect(validateWireMessage(valid)).toMatchObject({ sequence: 1 });
    expect(() =>
      validateWireMessage({ ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(/update sequence/);
    expect(() => validateWireMessage({ ...valid, messageId: 'another-peer:1' })).toThrow(
      /not sender-bound/,
    );
  });

  it('validates both sides of an encrypted key-confirmation transcript', () => {
    const confirmation = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: 'session-a',
      senderId: 'authenticated-peer',
      kind: 'key-confirmation' as const,
      handshakeId: createHandshakeId(),
      peerHandshakeId: createHandshakeId(),
    };

    expect(validateWireMessage(confirmation)).toEqual(confirmation);
    expect(() => validateWireMessage({ ...confirmation, peerHandshakeId: '' })).toThrow(
      /peer handshake id/,
    );
  });
});
