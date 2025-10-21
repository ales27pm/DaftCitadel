declare module 'tweetnacl' {
  export interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface SecretBox {
    (message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    readonly keyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  }

  export interface Box {
    (
      message: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array;
    open(
      message: Uint8Array,
      nonce: Uint8Array,
      publicKey: Uint8Array,
      secretKey: Uint8Array,
    ): Uint8Array | null;
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    after(message: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array;
    openAfter(
      message: Uint8Array,
      nonce: Uint8Array,
      sharedKey: Uint8Array,
    ): Uint8Array | null;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly sharedKeyLength: number;
    readonly overheadLength: number;
    keyPair: {
      (): BoxKeyPair;
      fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
    };
  }

  export const secretbox: SecretBox;
  export const box: Box;
  export function randomBytes(length: number): Uint8Array;
  export function hash(message: Uint8Array): Uint8Array;
  export const scalarMult: {
    (n: Uint8Array, p: Uint8Array): Uint8Array;
    base(n: Uint8Array): Uint8Array;
    readonly groupElementLength: number;
  };
  export const sign: {
    (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    detached(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    readonly detached: {
      (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
      verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
    };
    keyPair: {
      (): BoxKeyPair;
      fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
      fromSeed(seed: Uint8Array): BoxKeyPair;
    };
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly seedLength: number;
  };
}
