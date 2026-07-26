import { Buffer } from 'buffer';
import { EncryptionContext, generateIdentityKeyPair } from '../encryption';

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
});
