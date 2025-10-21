import { PermissionsAndroid, Platform } from 'react-native';
import { NativePluginHost } from './NativePluginHost';
import type { PluginDescriptor } from './types';

export interface SandboxContext {
  identifier: string;
  path: string;
  descriptor: PluginDescriptor;
}

export class PluginSandboxManager {
  private readonly sandboxes = new Map<string, SandboxContext>();

  constructor(private readonly requestExternalStorage?: () => Promise<boolean>) {}

  async ensureSandbox(
    descriptor: PluginDescriptor,
    preferredId?: string,
  ): Promise<SandboxContext> {
    const identifier = preferredId ?? descriptor.identifier;
    const existing = this.sandboxes.get(identifier);
    if (existing) {
      return existing;
    }

    if (Platform.OS === 'android') {
      await this.ensureAndroidPermissions();
    }

    const { sandboxPath } = await NativePluginHost.ensureSandbox(identifier);
    const context: SandboxContext = {
      identifier,
      path: sandboxPath,
      descriptor,
    };
    this.sandboxes.set(identifier, context);
    return context;
  }

  recordSandbox(context: SandboxContext): void {
    this.sandboxes.set(context.identifier, context);
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
