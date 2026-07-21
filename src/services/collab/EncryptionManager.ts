import { EncryptionContext, generateIdentityKeyPair, type KeyPair } from './encryption';
import type { Logger } from './types';

function createReadyDeferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => {
      if (!settled) {
        settled = true;
        res();
      }
    };
    reject = (error: unknown) => {
      if (!settled) {
        settled = true;
        rej(error);
      }
    };
  });
  // Prevent unhandled rejection warnings when errors are intentionally swallowed
  // by higher-level handlers.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function equalBytes(left?: Uint8Array, right?: Uint8Array): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export interface EncryptionManagerOptions {
  logger: Logger;
  preSharedKey?: Uint8Array;
  contextBinding?: Uint8Array;
}

export class EncryptionResetError extends Error {
  constructor(message = 'Collaboration encryption was reset') {
    super(message);
    this.name = 'EncryptionResetError';
  }
}

export class EncryptionManager {
  private readonly logger: Logger;
  private readonly preSharedKey?: Uint8Array;
  private contextBinding?: Uint8Array;
  private readonly identityKeyPair: KeyPair;
  private encryptionContext?: EncryptionContext;
  private remotePublicKey?: string;
  private readyState = createReadyDeferred();

  constructor(options: EncryptionManagerOptions) {
    this.logger = options.logger;
    this.preSharedKey = options.preSharedKey;
    this.contextBinding = options.contextBinding
      ? new Uint8Array(options.contextBinding)
      : undefined;
    this.identityKeyPair = generateIdentityKeyPair();
  }

  getLocalPublicKey(): string {
    return this.identityKeyPair.publicKey;
  }

  setRemotePublicKey(publicKey: string, contextBinding?: Uint8Array): void {
    const nextBinding = contextBinding
      ? new Uint8Array(contextBinding)
      : this.contextBinding;
    if (
      this.remotePublicKey === publicKey &&
      this.encryptionContext &&
      equalBytes(this.contextBinding, nextBinding)
    ) {
      return;
    }
    this.contextBinding = nextBinding;
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
        contextBinding: this.contextBinding,
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
      contextBinding: this.contextBinding,
    });
    return this.encryptionContext;
  }

  reset(reason?: Error): void {
    this.readyState.reject(reason ?? new EncryptionResetError());
    this.encryptionContext = undefined;
    this.remotePublicKey = undefined;
    this.readyState = createReadyDeferred();
  }
}
