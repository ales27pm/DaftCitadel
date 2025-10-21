import { EncryptionContext, generateIdentityKeyPair, type KeyPair } from './encryption';
import type { Logger } from './types';

function createReadyDeferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Prevent unhandled rejection warnings when errors are intentionally swallowed
  // by higher-level handlers.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export interface EncryptionManagerOptions {
  logger: Logger;
  preSharedKey?: Uint8Array;
}

export class EncryptionManager {
  private readonly logger: Logger;
  private readonly preSharedKey?: Uint8Array;
  private readonly identityKeyPair: KeyPair;
  private encryptionContext?: EncryptionContext;
  private remotePublicKey?: string;
  private readyState = createReadyDeferred();

  constructor(options: EncryptionManagerOptions) {
    this.logger = options.logger;
    this.preSharedKey = options.preSharedKey;
    this.identityKeyPair = generateIdentityKeyPair();
  }

  getLocalPublicKey(): string {
    return this.identityKeyPair.publicKey;
  }

  setRemotePublicKey(publicKey: string): void {
    this.remotePublicKey = publicKey;
    this.encryptionContext = undefined;
    const previousReady = this.readyState;
    const nextReady = createReadyDeferred();
    this.readyState = nextReady;
    try {
      this.encryptionContext = new EncryptionContext({
        identityKeyPair: this.identityKeyPair,
        remotePublicKey: publicKey,
        preSharedKey: this.preSharedKey,
      });
      this.logger('collab.encryptionReady');
      nextReady.resolve();
      previousReady.resolve();
    } catch (error) {
      this.logger('collab.encryptionError', { error: String(error) });
      nextReady.reject(error);
      previousReady.reject(error);
      throw error;
    }
  }

  async waitUntilReady(): Promise<void> {
    await this.readyState.promise;
  }

  requireContext(): EncryptionContext {
    if (this.encryptionContext) {
      return this.encryptionContext;
    }
    if (!this.remotePublicKey) {
      throw new Error('Remote key not available');
    }
    this.encryptionContext = new EncryptionContext({
      identityKeyPair: this.identityKeyPair,
      remotePublicKey: this.remotePublicKey,
      preSharedKey: this.preSharedKey,
    });
    return this.encryptionContext;
  }

  reset(): void {
    this.encryptionContext = undefined;
    this.remotePublicKey = undefined;
    this.readyState = createReadyDeferred();
  }
}
