import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { NativeModules } from 'react-native';

import { JsonSessionStorageAdapter } from '../../../session/storage/jsonAdapter';
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

    try {
      const session = environment.manager.getSession();
      expect(session?.id).toBe(sessionId);
      expect(session?.name).toBe('Daft Citadel Session');
      expect(session?.tracks).toEqual([]);

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
          __state: {
            initialized: boolean;
            clipBuffers: Map<unknown, unknown>;
          };
        }
      ).__state;
      expect(engineState.initialized).toBe(true);
      expect(engineState.clipBuffers.size).toBe(0);
    } finally {
      await environment.dispose?.();
    }
  });

  it('rejects production startup and allows an explicit passive environment', async () => {
    const modules = NativeModules as Record<string, unknown>;
    const originalEngineModule = modules.AudioEngineModule;
    delete modules.AudioEngineModule;

    try {
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

      try {
        await passive.manager.updateSession((current) => ({
          ...current,
          name: 'Passive Updated',
        }));

        const storage = new JsonSessionStorageAdapter(tempDir);
        await storage.initialize();
        const persisted = await storage.read('passive-session');
        expect(persisted?.name).toBe('Passive Updated');
      } finally {
        await passive.dispose?.();
      }
    } finally {
      modules.AudioEngineModule = originalEngineModule;
    }
  });
});
