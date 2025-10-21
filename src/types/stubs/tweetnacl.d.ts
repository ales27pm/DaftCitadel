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
    open: {
      (
        message: Uint8Array,
        nonce: Uint8Array,
        publicKey: Uint8Array,
        secretKey: Uint8Array,
      ): Uint8Array | null;
      after(
        message: Uint8Array,
        nonce: Uint8Array,
        sharedKey: Uint8Array,
      ): Uint8Array | null;
    };
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    after(message: Uint8Array, nonce: Uint8Array, sharedKey: Uint8Array): Uint8Array;
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly sharedKeyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
    keyPair: {
      (): BoxKeyPair;
      fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
    };
  }

  export const secretbox: SecretBox;
  export const box: Box;
  export function randomBytes(length: number): Uint8Array;
  export const hash: {
    (message: Uint8Array): Uint8Array;
    readonly hashLength: number;
  };
  export const scalarMult: {
    (n: Uint8Array, p: Uint8Array): Uint8Array;
    base(n: Uint8Array): Uint8Array;
    readonly scalarLength: number;
    readonly groupElementLength: number;
  };
  export interface SignKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }
  export const sign: {
    (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(signedMessage: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
    readonly detached: {
      (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
      verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
    };
    keyPair: {
      (): SignKeyPair;
      fromSecretKey(secretKey: Uint8Array): SignKeyPair;
      fromSeed(seed: Uint8Array): SignKeyPair;
    };
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly seedLength: number;
  };
}
