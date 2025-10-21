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
});
