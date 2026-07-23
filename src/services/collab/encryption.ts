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
const AUTHENTICATION_DOMAIN = 'daft-citadel-collab-auth-v1';
const ENCRYPTION_DOMAIN = 'daft-citadel-collab-encryption-v1';

const sharedTextEncoder =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;
const sharedTextDecoder =
  typeof TextDecoder !== 'undefined' ? new TextDecoder() : undefined;

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64String(value: string): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error('Invalid base64 value');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Invalid base64 value');
  }
  return new Uint8Array(decoded);
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

function combineLengthPrefixed(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + 4 + part.length, 0);
  const combined = new Uint8Array(totalLength);
  const view = new DataView(combined.buffer);
  let offset = 0;
  parts.forEach((part) => {
    view.setUint32(offset, part.length, false);
    offset += 4;
    combined.set(part, offset);
    offset += part.length;
  });
  return combined;
}

function deriveDomainKey(
  domain: string,
  secret: Uint8Array,
  context?: Uint8Array,
): Uint8Array {
  return hashSharedSecret(
    combineLengthPrefixed([encodeUtf8(domain), secret, context ?? new Uint8Array()]),
  ).slice(0, SYMMETRIC_KEY_SIZE);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.length > 0 && nacl.verify(left, right);
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
  contextBinding?: Uint8Array,
): Uint8Array {
  const remotePublicKey = decodeBase64String(remotePublicKeyBase64);
  if (remotePublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error('Invalid remote public key length');
  }
  // nacl.box.before expects the peer's public key followed by the local secret key.
  const shared = nacl.box.before(remotePublicKey, localSecretKey);
  return deriveDomainKey(
    ENCRYPTION_DOMAIN,
    combineLengthPrefixed(preSharedKey ? [shared, preSharedKey] : [shared]),
    contextBinding,
  );
}

export function createAuthenticationProof(
  claim: string,
  sharedSecret: Uint8Array,
  sessionBinding: Uint8Array,
): Ciphertext {
  const key = deriveDomainKey(AUTHENTICATION_DOMAIN, sharedSecret, sessionBinding);
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const box = nacl.secretbox(encodeUtf8(claim), nonce, key);
  return { nonce: encodeBase64(nonce), box: encodeBase64(box) };
}

export function verifyAuthenticationProof(
  proof: Ciphertext,
  expectedClaim: string,
  sharedSecret: Uint8Array,
  sessionBinding: Uint8Array,
): boolean {
  try {
    const nonce = decodeBase64String(proof.nonce);
    const box = decodeBase64String(proof.box);
    if (nonce.length !== NONCE_LENGTH || box.length < nacl.secretbox.overheadLength) {
      return false;
    }
    const key = deriveDomainKey(AUTHENTICATION_DOMAIN, sharedSecret, sessionBinding);
    const opened = nacl.secretbox.open(box, nonce, key);
    return opened ? constantTimeEqual(opened, encodeUtf8(expectedClaim)) : false;
  } catch (error) {
    return false;
  }
}

export function fingerprintPublicKey(publicKey: string): string {
  const decoded = decodeBase64String(publicKey);
  if (decoded.length !== nacl.box.publicKeyLength) {
    throw new Error('Invalid public key length');
  }
  return encodeBase64(nacl.hash(decoded).slice(0, 16));
}

export class EncryptionContext {
  private readonly key: Uint8Array;

  constructor({
    identityKeyPair,
    remotePublicKey,
    preSharedKey,
    contextBinding,
  }: {
    identityKeyPair: KeyPair;
    remotePublicKey: string;
    preSharedKey?: Uint8Array;
    contextBinding?: Uint8Array;
  }) {
    const sharedSecret = deriveSharedSecret(
      identityKeyPair.secretKey,
      remotePublicKey,
      preSharedKey,
      contextBinding,
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
    if (nonce.length !== NONCE_LENGTH) {
      throw new Error('Invalid collaboration nonce length');
    }
    if (box.length < nacl.secretbox.overheadLength) {
      throw new Error('Invalid collaboration ciphertext length');
    }
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
