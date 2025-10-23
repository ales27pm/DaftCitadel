import AsyncStorage from '@react-native-async-storage/async-storage';
import { PermissionsAndroid, Platform } from 'react-native';
import { NativePluginHost } from './NativePluginHost';
import type { PluginDescriptor } from './types';

export interface SandboxContext {
  identifier: string;
  path: string;
  descriptor: PluginDescriptor;
}

export interface SandboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface SandboxRecord extends SandboxContext {
  format: PluginDescriptor['format'];
  lastAccessedAt: number;
}

const STORAGE_KEY = 'daftcitadel.pluginSandboxes.v1';

export class PluginSandboxManager {
  private readonly sandboxes = new Map<string, SandboxRecord>();

  private persistTimer?: ReturnType<typeof setTimeout>;

  private pendingPersist?: Promise<void>;

  private pendingResolve?: () => void;

  private pendingReject?: (error: unknown) => void;

  private readonly persistDebounceMs = 150;

  private readonly ready: Promise<void>;

  constructor(
    private readonly requestExternalStorage?: () => Promise<boolean>,
    private readonly storage: SandboxStorage = AsyncStorage,
  ) {
    this.ready = this.hydrateFromStorage().catch((error) => {
      console.warn('Failed to hydrate sandbox metadata', error);
    });
  }

  async ensureSandbox(
    descriptor: PluginDescriptor,
    preferredId?: string,
  ): Promise<SandboxContext> {
    await this.ready;
    const identifier = preferredId ?? descriptor.identifier;
    const existing = this.lookup(descriptor.format, identifier);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      await this.schedulePersist().catch((error) => {
        console.warn('Failed to persist sandbox metadata', error);
      });
      return existing;
    }

    if (Platform.OS === 'android') {
      await this.ensureAndroidPermissions();
    }

    const { sandboxPath } = await NativePluginHost.ensureSandbox(identifier);
    const context: SandboxRecord = {
      identifier,
      path: sandboxPath,
      descriptor,
      format: descriptor.format,
      lastAccessedAt: Date.now(),
    };
    this.insert(context);
    await this.schedulePersist().catch((error) => {
      console.warn('Failed to persist sandbox metadata', error);
    });
    return context;
  }

  recordSandbox(context: SandboxContext): void {
    const record: SandboxRecord = {
      ...context,
      format: context.descriptor.format,
      lastAccessedAt: Date.now(),
    };
    this.insert(record);
    this.schedulePersist().catch((error) => {
      console.warn('Failed to persist sandbox metadata', error);
    });
  }

  private lookup(
    format: PluginDescriptor['format'],
    identifier: string,
  ): SandboxRecord | undefined {
    return this.sandboxes.get(this.makeKey(format, identifier));
  }

  private insert(record: SandboxRecord): void {
    this.sandboxes.set(this.makeKey(record.format, record.identifier), record);
  }

  private async hydrateFromStorage(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed: SandboxRecord[] = JSON.parse(raw);
      parsed.forEach((record) => {
        if (!record || !record.identifier || !record.path || !record.format) {
          return;
        }
        this.insert({
          ...record,
          lastAccessedAt: record.lastAccessedAt ?? Date.now(),
        });
      });
    } catch (error) {
      console.warn('Failed to parse sandbox metadata', error);
    }
  }

  private schedulePersist(): Promise<void> {
    if (!this.pendingPersist) {
      this.pendingPersist = new Promise<void>((resolve, reject) => {
        this.pendingResolve = resolve;
        this.pendingReject = reject;
      }).finally(() => {
        this.pendingPersist = undefined;
        this.pendingResolve = undefined;
        this.pendingReject = undefined;
      });
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow()
        .then(() => this.pendingResolve?.())
        .catch((error) => this.pendingReject?.(error));
    }, this.persistDebounceMs);
    return this.pendingPersist;
  }

  private async persistNow(): Promise<void> {
    const serialized = Array.from(this.sandboxes.values()).map((record) => ({
      ...record,
    }));
    await this.storage.setItem(STORAGE_KEY, JSON.stringify(serialized));
  }

  private makeKey(format: PluginDescriptor['format'], identifier: string): string {
    return `${format}:${identifier}`;
  }

  private async ensureAndroidPermissions(): Promise<void> {
    if (Platform.OS !== 'android') {
      return;
    }
    const customHandlerGranted = this.requestExternalStorage
      ? await this.requestExternalStorage()
      : true;
    if (!customHandlerGranted) {
      throw new Error('Storage permission denied by custom handler');
    }

    if (Platform.Version >= 33) {
      return;
    }

    const writePermission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    const hasPermission = await PermissionsAndroid.check(writePermission);
    if (!hasPermission) {
      const result = await PermissionsAndroid.request(writePermission);
      if (result !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('WRITE_EXTERNAL_STORAGE permission denied');
      }
    }
  }
}
