import {
  AudioEngineBridge,
  InMemorySessionStorageAdapter,
  Session,
  SessionManager,
} from '../../session';
import { demoSession, DEMO_SESSION_ID } from '../../session/fixtures/demoSession';

class PassiveAudioEngineBridge implements AudioEngineBridge {
  private lastSession: Session | null = null;

  async applySessionUpdate(session: Session): Promise<void> {
    this.lastSession = session;
  }

  getSnapshot(): Session | null {
    return this.lastSession;
  }
}

export interface SessionEnvironment {
  manager: SessionManager;
  audioBridge: PassiveAudioEngineBridge;
  sessionId: string;
}

export const createDemoSessionEnvironment = async (): Promise<SessionEnvironment> => {
  const storage = new InMemorySessionStorageAdapter();
  await storage.initialize();
  const audioBridge = new PassiveAudioEngineBridge();
  const manager = new SessionManager(storage, audioBridge);
  await manager.createSession(demoSession);
  return { manager, audioBridge, sessionId: DEMO_SESSION_ID };
};

export { PassiveAudioEngineBridge };
