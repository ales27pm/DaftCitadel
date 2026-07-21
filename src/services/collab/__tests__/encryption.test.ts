import { Buffer } from 'buffer';
import { EncryptionContext, generateIdentityKeyPair } from '../encryption';
import { EncryptionManager, EncryptionResetError } from '../EncryptionManager';
import { createPeerEncryptionBinding } from '../protocol';

describe('EncryptionContext', () => {
  it('roundtrips payloads with derived shared secret', () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();

    const aliceContext = new EncryptionContext({
      identityKeyPair: aliceKeys,
      remotePublicKey: bobKeys.publicKey,
    });
    const bobContext = new EncryptionContext({
      identityKeyPair: bobKeys,
      remotePublicKey: aliceKeys.publicKey,
    });

    const cipher = aliceContext.encrypt({
      clock: 123,
      schemaVersion: 1,
      body: { message: 'hi' },
    });

    const decrypted = bobContext.decrypt<{ message: string }>(cipher);
    expect(decrypted.body).toEqual({ message: 'hi' });
    expect(decrypted.clock).toBe(123);
    expect(decrypted.schemaVersion).toBe(1);
  });

  it('rejects tampered ciphertext', () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();

    const aliceContext = new EncryptionContext({
      identityKeyPair: aliceKeys,
      remotePublicKey: bobKeys.publicKey,
    });
    const bobContext = new EncryptionContext({
      identityKeyPair: bobKeys,
      remotePublicKey: aliceKeys.publicKey,
    });

    const cipher = aliceContext.encrypt({
      clock: 1,
      schemaVersion: 1,
      body: { ok: true },
    });

    const tamperedBytes = Buffer.from(cipher.box, 'base64');
    tamperedBytes[0] = (tamperedBytes[0] + 1) % 256;
    const tampered = { ...cipher, box: tamperedBytes.toString('base64') };

    expect(() => bobContext.decrypt(tampered)).toThrow(
      'Unable to decrypt collaboration payload',
    );
  });

  it('requires matching pre-shared keys', () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();
    const sharedPsk = new Uint8Array([1, 2, 3, 4]);

    const aliceContext = new EncryptionContext({
      identityKeyPair: aliceKeys,
      remotePublicKey: bobKeys.publicKey,
      preSharedKey: sharedPsk,
    });
    const bobContext = new EncryptionContext({
      identityKeyPair: bobKeys,
      remotePublicKey: aliceKeys.publicKey,
      preSharedKey: sharedPsk,
    });

    const cipher = aliceContext.encrypt({
      clock: 42,
      schemaVersion: 1,
      body: { ok: true },
    });

    expect(bobContext.decrypt(cipher).body).toEqual({ ok: true });

    const mismatchedContext = new EncryptionContext({
      identityKeyPair: bobKeys,
      remotePublicKey: aliceKeys.publicKey,
      preSharedKey: new Uint8Array([9, 9, 9, 9]),
    });

    expect(() => mismatchedContext.decrypt(cipher)).toThrow(
      'Unable to decrypt collaboration payload',
    );
  });

  it('rejects ciphertext replayed from a previous handshake lifecycle', () => {
    const aliceKeys = generateIdentityKeyPair();
    const bobKeys = generateIdentityKeyPair();
    const sharedSecret = new Uint8Array(32).fill(5);
    const oldBinding = createPeerEncryptionBinding({
      sessionId: 'session-a',
      localSenderId: 'alice',
      localHandshakeId: 'alice-handshake',
      remoteSenderId: 'bob',
      remoteHandshakeId: 'bob-old-handshake',
    });
    const newBinding = createPeerEncryptionBinding({
      sessionId: 'session-a',
      localSenderId: 'alice',
      localHandshakeId: 'alice-handshake',
      remoteSenderId: 'bob',
      remoteHandshakeId: 'bob-new-handshake',
    });
    const oldAliceContext = new EncryptionContext({
      identityKeyPair: aliceKeys,
      remotePublicKey: bobKeys.publicKey,
      preSharedKey: sharedSecret,
      contextBinding: oldBinding,
    });
    const newBobContext = new EncryptionContext({
      identityKeyPair: bobKeys,
      remotePublicKey: aliceKeys.publicKey,
      preSharedKey: sharedSecret,
      contextBinding: newBinding,
    });
    const oldCiphertext = oldAliceContext.encrypt({
      clock: Date.now(),
      schemaVersion: 1,
      body: { stale: true },
    });

    expect(() => newBobContext.decrypt(oldCiphertext)).toThrow(
      'Unable to decrypt collaboration payload',
    );
  });
});

describe('EncryptionManager', () => {
  it('rejects existing readiness waiters when reset and supports a fresh handshake', async () => {
    const manager = new EncryptionManager({ logger: jest.fn() });
    const pendingReadiness = manager.waitUntilReady();

    manager.reset();

    await expect(pendingReadiness).rejects.toBeInstanceOf(EncryptionResetError);

    const nextReadiness = manager.waitUntilReady();
    manager.setRemotePublicKey(generateIdentityKeyPair().publicKey);
    await expect(nextReadiness).resolves.toBeUndefined();
    expect(manager.requireContext()).toBeInstanceOf(EncryptionContext);
  });
});
