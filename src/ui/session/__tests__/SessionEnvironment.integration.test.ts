import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { NativeModules } from 'react-native';

import { JsonSessionStorageAdapter } from '../../../session';
import type { AudioFileLoader, AudioFileData } from '../../../audio';
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
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initializes the production environment with audio bridge and persists sessions', async () => {
    const sessionId = 'integration-session';
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

    const storage = new JsonSessionStorageAdapter(tempDir);
    await storage.initialize();
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
