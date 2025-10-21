import { Session } from './models';

export interface CloudSyncResult {
  session: Session | null;
}

export interface CloudSyncProvider {
  pull(sessionId: string): Promise<CloudSyncResult>;
  push(session: Session): Promise<void>;
  resolveConflict?(params: {
    local: Session;
    remote: Session;
    base: Session;
  }): Promise<Session>;
}

export class NoopCloudSyncProvider implements CloudSyncProvider {
  async pull(_sessionId: string): Promise<CloudSyncResult> {
    return { session: null };
  }

  async push(_session: Session): Promise<void> {
    // no-op
  }

  async resolveConflict(params: {
    local: Session;
    remote: Session;
    base: Session;
  }): Promise<Session> {
    return params.local.revision >= params.remote.revision ? params.local : params.remote;
  }
}
