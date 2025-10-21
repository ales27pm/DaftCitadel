import nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';

export interface KeyPair {
  publicKey: string;
  secretKey: Uint8Array;
}

export interface HandshakeBundle {
  identityKeyPair: KeyPair;
  preSharedKey?: Uint8Array;
}

export interface CollabPayload<T> {
  clock: number;
  schemaVersion: number;
  body: T;
}

export interface Ciphertext {
  nonce: string;
  box: string;
}

const SYMMETRIC_KEY_SIZE = nacl.secretbox.keyLength;
const NONCE_LENGTH = nacl.secretbox.nonceLength;
const HASH_BYTES = 32;

function hashSharedSecret(sharedSecret: Uint8Array): Uint8Array {
  const hash = nacl.hash(sharedSecret);
  return hash.slice(0, HASH_BYTES);
}

export function generateIdentityKeyPair(): KeyPair {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: naclUtil.encodeBase64(keyPair.publicKey),
    secretKey: keyPair.secretKey,
  };
}

export function deriveSharedSecret(
  localSecretKey: Uint8Array,
  remotePublicKeyBase64: string,
  preSharedKey?: Uint8Array,
): Uint8Array {
  const remotePublicKey = naclUtil.decodeBase64(remotePublicKeyBase64);
  const shared = nacl.box.before(remotePublicKey, localSecretKey);
  if (!preSharedKey) {
    return hashSharedSecret(shared);
  }
  const combined = new Uint8Array(shared.length + preSharedKey.length);
  combined.set(shared, 0);
  combined.set(preSharedKey, shared.length);
  return hashSharedSecret(combined);
}

export class EncryptionContext {
  private readonly key: Uint8Array;

  constructor({
    identityKeyPair,
    remotePublicKey,
    preSharedKey,
  }: {
    identityKeyPair: KeyPair;
    remotePublicKey: string;
    preSharedKey?: Uint8Array;
  }) {
    this.key = deriveSharedSecret(
      identityKeyPair.secretKey,
      remotePublicKey,
      preSharedKey,
    ).slice(0, SYMMETRIC_KEY_SIZE);
  }

  encrypt<T>(payload: CollabPayload<T>): Ciphertext {
    const nonce = nacl.randomBytes(NONCE_LENGTH);
    const messageBytes = naclUtil.decodeUTF8(JSON.stringify(payload));
    const box = nacl.secretbox(messageBytes, nonce, this.key);
    return {
      nonce: naclUtil.encodeBase64(nonce),
      box: naclUtil.encodeBase64(box),
    };
  }

  decrypt<T>(ciphertext: Ciphertext): CollabPayload<T> {
    const nonce = naclUtil.decodeBase64(ciphertext.nonce);
    const box = naclUtil.decodeBase64(ciphertext.box);
    const decrypted = nacl.secretbox.open(box, nonce, this.key);
    if (!decrypted) {
      throw new Error('Unable to decrypt collaboration payload');
    }
    const decoded = naclUtil.encodeUTF8(decrypted);
    return JSON.parse(decoded) as CollabPayload<T>;
  }
}

export function serializeKeyPair(keyPair: KeyPair): {
  publicKey: string;
  secretKey: string;
} {
  return {
    publicKey: keyPair.publicKey,
    secretKey: naclUtil.encodeBase64(keyPair.secretKey),
  };
}

export function deserializeKeyPair(serialized: {
  publicKey: string;
  secretKey: string;
}): KeyPair {
  return {
    publicKey: serialized.publicKey,
    secretKey: naclUtil.decodeBase64(serialized.secretKey),
  };
}
