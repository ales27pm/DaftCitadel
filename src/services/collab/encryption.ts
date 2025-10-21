import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

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

const sharedTextEncoder =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
const sharedTextDecoder =
  typeof TextDecoder !== 'undefined' ? new TextDecoder() : undefined;

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64String(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function encodeUtf8(value: string): Uint8Array {
  if (sharedTextEncoder) {
    return sharedTextEncoder.encode(value);
  }
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

function decodeUtf8(bytes: Uint8Array): string {
  if (sharedTextDecoder) {
    return sharedTextDecoder.decode(bytes);
  }
  return Buffer.from(bytes).toString('utf8');
}

function hashSharedSecret(sharedSecret: Uint8Array): Uint8Array {
  const hash = nacl.hash(sharedSecret);
  return hash.slice(0, HASH_BYTES);
}

export function generateIdentityKeyPair(): KeyPair {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(keyPair.publicKey),
    secretKey: keyPair.secretKey,
  };
}

export function deriveSharedSecret(
  localSecretKey: Uint8Array,
  remotePublicKeyBase64: string,
  preSharedKey?: Uint8Array,
): Uint8Array {
  const remotePublicKey = decodeBase64String(remotePublicKeyBase64);
  if (remotePublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error('Invalid remote public key length');
  }
  // nacl.box.before expects the peer's public key followed by the local secret key.
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
    const sharedSecret = deriveSharedSecret(
      identityKeyPair.secretKey,
      remotePublicKey,
      preSharedKey,
    );
    if (sharedSecret.length < SYMMETRIC_KEY_SIZE) {
      throw new Error(
        `Derived shared secret length (${sharedSecret.length}) is less than required symmetric key size (${SYMMETRIC_KEY_SIZE}). This may reduce entropy and weaken security.`,
      );
    }
    // The derived shared secret uses nacl.hash (SHA-512) to expand entropy. Truncating to
    // SYMMETRIC_KEY_SIZE bytes is safe because the hash output is larger than the requested key.
    this.key = sharedSecret.slice(0, SYMMETRIC_KEY_SIZE);
  }

  encrypt<T>(payload: CollabPayload<T>): Ciphertext {
    const nonce = nacl.randomBytes(NONCE_LENGTH);
    const messageBytes = encodeUtf8(JSON.stringify(payload));
    const box = nacl.secretbox(messageBytes, nonce, this.key);
    return {
      nonce: encodeBase64(nonce),
      box: encodeBase64(box),
    };
  }

  decrypt<T>(ciphertext: Ciphertext): CollabPayload<T> {
    const nonce = decodeBase64String(ciphertext.nonce);
    const box = decodeBase64String(ciphertext.box);
    const decrypted = nacl.secretbox.open(box, nonce, this.key);
    if (!decrypted) {
      throw new Error('Unable to decrypt collaboration payload');
    }
    const decoded = decodeUtf8(decrypted);
    return JSON.parse(decoded) as CollabPayload<T>;
  }
}

export function serializeKeyPair(keyPair: KeyPair): {
  publicKey: string;
  secretKey: string;
} {
  return {
    publicKey: keyPair.publicKey,
    secretKey: encodeBase64(keyPair.secretKey),
  };
}

export function deserializeKeyPair(serialized: {
  publicKey: string;
  secretKey: string;
}): KeyPair {
  return {
    publicKey: serialized.publicKey,
    secretKey: decodeBase64String(serialized.secretKey),
  };
}
