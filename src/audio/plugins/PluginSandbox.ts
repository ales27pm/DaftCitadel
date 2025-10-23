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
  private readonly sandboxes = new Map<
    PluginDescriptor['format'],
    Map<string, SandboxRecord>
  >();

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
      await this.persist().catch((error) => {
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
    await this.persist().catch((error) => {
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
    this.persist().catch((error) => {
      console.warn('Failed to persist sandbox metadata', error);
    });
  }

  private lookup(
    format: PluginDescriptor['format'],
    identifier: string,
  ): SandboxRecord | undefined {
    const byFormat = this.sandboxes.get(format);
    return byFormat?.get(identifier);
  }

  private insert(record: SandboxRecord): void {
    const byFormat =
      this.sandboxes.get(record.format) ?? new Map<string, SandboxRecord>();
    byFormat.set(record.identifier, record);
    this.sandboxes.set(record.format, byFormat);
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

  private async persist(): Promise<void> {
    const serialized: SandboxRecord[] = [];
    this.sandboxes.forEach((records) => {
      records.forEach((record) => {
        serialized.push({ ...record });
      });
    });
    await this.storage.setItem(STORAGE_KEY, JSON.stringify(serialized));
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
