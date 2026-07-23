import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { NativeModules } from 'react-native';

import type { SessionStorageAdapter } from '../../../session';
import { JsonSessionStorageAdapter } from '../../../session/storage/jsonAdapter';
import {
  PluginHost,
  SessionAudioBridge,
  type AudioFileLoader,
  type AudioFileData,
} from '../../../audio';
import { demoSession } from '../../../session/fixtures/demoSession';
import {
  NativeAudioUnavailableError,
  createPassiveSessionEnvironment,
  createProductionSessionEnvironment,
} from '../environment';

describe('Session environments', () => {
  let tempDir: string;

  const createTestAudioFileLoader = (): AudioFileLoader => ({
    load: async (_filePath: string): Promise<AudioFileData> => {
      const frames = 2048;
      const left = Float32Array.from({ length: frames }, (_, index) =>
        Math.sin(index / 32),
      );
      const right = Float32Array.from({ length: frames }, (_, index) =>
        Math.cos(index / 32),
      );
      return {
        sampleRate: demoSession.metadata.sampleRate,
        channels: 2,
        frames,
        data: [left, right],
      };
    },
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-env-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initializes the production environment with audio bridge and persists sessions', async () => {
    const sessionId = 'integration-session';
    const storage = new JsonSessionStorageAdapter(tempDir);
    await storage.initialize();
    await storage.write({ ...demoSession, id: sessionId }, { expectedRevision: 0 });

    const environment = await createProductionSessionEnvironment({
      sessionId,
      storageDirectory: tempDir,
      sampleRate: demoSession.metadata.sampleRate,
      framesPerBuffer: 256,
      bpm: demoSession.metadata.bpm,
      fileLoader: createTestAudioFileLoader(),
    });

    const session = environment.manager.getSession();
    expect(session?.id).toBe(sessionId);
    expect(session?.tracks.length).toBeGreaterThan(0);

    const persisted = await storage.read(sessionId);
    expect(persisted?.name).toBe(session?.name);

    await environment.manager.updateSession((current) => ({
      ...current,
      name: 'Updated Session',
    }));

    const updated = await storage.read(sessionId);
    expect(updated?.name).toBe('Updated Session');
    expect(updated?.revision).toBeGreaterThan(persisted?.revision ?? 0);

    const engineState = (
      NativeModules.AudioEngineModule as {
        __state: { clipBuffers: Map<unknown, unknown> };
      }
    ).__state;
    expect(engineState.clipBuffers.size).toBeGreaterThan(0);

    await environment.dispose?.();
  });

  it('seeds a clean starter session without fixture-only audio paths', async () => {
    const load = jest.fn(async () => {
      throw new Error('The starter session must not request an audio file');
    });
    const sessionId = 'clean-install-session';
    const environment = await createProductionSessionEnvironment({
      sessionId,
      storageDirectory: tempDir,
      fileLoader: { load },
    });

    const session = environment.manager.getSession();
    expect(session).toMatchObject({
      id: sessionId,
      name: 'Untitled Session',
      tracks: [],
    });
    expect(load).not.toHaveBeenCalled();

    const storage = new JsonSessionStorageAdapter(tempDir);
    await storage.initialize();
    await expect(storage.read(sessionId)).resolves.toMatchObject({
      id: sessionId,
      tracks: [],
    });

    const engineState = (
      NativeModules.AudioEngineModule as {
        __state: { clipBuffers: Map<unknown, unknown> };
      }
    ).__state;
    expect(engineState.clipBuffers.size).toBe(0);

    await environment.dispose?.();
  });

  it('classifies device initialization failures as native audio unavailability', async () => {
    const engineModule = NativeModules.AudioEngineModule as {
      initialize(sampleRate: number, framesPerBuffer: number): Promise<void>;
      shutdown(): Promise<void>;
    };
    const initializationError = new Error('Unsupported device configuration');
    jest.spyOn(engineModule, 'initialize').mockRejectedValueOnce(initializationError);
    const shutdownSpy = jest.spyOn(engineModule, 'shutdown');

    await expect(
      createProductionSessionEnvironment({
        storageDirectory: tempDir,
        fileLoader: createTestAudioFileLoader(),
      }),
    ).rejects.toMatchObject({
      name: 'NativeAudioUnavailableError',
      cause: initializationError,
    });
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes every acquired native resource once when late bootstrap fails', async () => {
    const bootstrapError = new Error('Storage initialization failed');
    const storage = new JsonSessionStorageAdapter(tempDir);
    jest.spyOn(storage, 'initialize').mockRejectedValueOnce(bootstrapError);
    const bridgeDisposeSpy = jest
      .spyOn(SessionAudioBridge.prototype, 'dispose')
      .mockResolvedValue(undefined);
    const pluginDisposeSpy = jest
      .spyOn(PluginHost.prototype, 'dispose')
      .mockImplementation(() => undefined);
    const engineModule = NativeModules.AudioEngineModule as {
      shutdown(): Promise<void>;
    };
    const shutdownSpy = jest.spyOn(engineModule, 'shutdown');

    await expect(
      createProductionSessionEnvironment({
        storageAdapter: storage as SessionStorageAdapter,
        fileLoader: createTestAudioFileLoader(),
      }),
    ).rejects.toBe(bootstrapError);

    expect(bridgeDisposeSpy).toHaveBeenCalledTimes(1);
    expect(pluginDisposeSpy).toHaveBeenCalledTimes(1);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies a missing native sample loader as native audio unavailability', async () => {
    const modules = NativeModules as Record<string, unknown>;
    const originalLoaderModule = modules.AudioSampleLoaderModule;
    delete modules.AudioSampleLoaderModule;

    try {
      await expect(
        createProductionSessionEnvironment({ storageDirectory: tempDir }),
      ).rejects.toBeInstanceOf(NativeAudioUnavailableError);
    } finally {
      modules.AudioSampleLoaderModule = originalLoaderModule;
    }
  });

  it('falls back to passive environment when native audio is unavailable', async () => {
    const modules = NativeModules as Record<string, unknown>;
    const originalEngineModule = modules.AudioEngineModule;
    delete modules.AudioEngineModule;

    await expect(
      createProductionSessionEnvironment({
        storageDirectory: tempDir,
        fileLoader: createTestAudioFileLoader(),
      }),
    ).rejects.toBeInstanceOf(NativeAudioUnavailableError);

    const passive = await createPassiveSessionEnvironment({
      storageDirectory: tempDir,
      sessionId: 'passive-session',
    });

    await passive.manager.updateSession((current) => ({
      ...current,
      name: 'Passive Updated',
    }));

    const storage = new JsonSessionStorageAdapter(tempDir);
    await storage.initialize();
    const persisted = await storage.read('passive-session');
    expect(persisted?.name).toBe('Passive Updated');

    if (passive.dispose) {
      await passive.dispose();
    }

    modules.AudioEngineModule = originalEngineModule;
  });
});
