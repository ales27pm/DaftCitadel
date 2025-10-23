import type { CollabPayload } from './encryption';
import type { Session, SessionID } from '../../session/models';
import { normalizeSession, validateSession } from '../../session/models';
import { mergeSessions } from '../../session/serialization';
import { deepClone } from '../../session/util';
import type { SessionManager } from '../../session/sessionManager';

export type Logger = (message: string, context?: Record<string, unknown>) => void;

export const COLLAB_SESSION_PATCH_VERSION = 1 as const;

export interface CollabSessionPatchInput {
  readonly sessionId: SessionID;
  readonly base: Session;
  readonly update: Session;
  readonly actorId: string;
}

export interface CollabSessionPatchMessage extends CollabSessionPatchInput {
  readonly version: typeof COLLAB_SESSION_PATCH_VERSION;
}

const sanitizeSession = (session: Session): Session => {
  const normalized = normalizeSession(deepClone(session));
  validateSession(normalized);
  return normalized;
};

const assertSessionAlignment = (
  session: Session,
  sessionId: SessionID,
  role: 'base' | 'update',
): void => {
  if (session.id !== sessionId) {
    throw new Error(
      `Collaboration ${role} session id mismatch. Expected ${sessionId} but received ${session.id}.`,
    );
  }
};

const sanitizePatchSessions = (
  sessionId: SessionID,
  base: Session,
  update: Session,
): { base: Session; update: Session } => {
  const sanitizedBase = sanitizeSession(base);
  const sanitizedUpdate = sanitizeSession(update);

  assertSessionAlignment(sanitizedBase, sessionId, 'base');
  assertSessionAlignment(sanitizedUpdate, sessionId, 'update');

  return { base: sanitizedBase, update: sanitizedUpdate };
};

const requireActorId = (actorId: unknown): string => {
  if (typeof actorId !== 'string' || actorId.trim().length === 0) {
    throw new Error('Collaborative patch requires a non-empty actor id');
  }

  return actorId.trim();
};

export const serializeCollabSessionPatch = (
  patch: CollabSessionPatchInput,
): CollabSessionPatchMessage => {
  const { sessionId, base, update } = patch;
  const actorId = requireActorId(patch.actorId);

  const sanitized = sanitizePatchSessions(sessionId, base, update);

  return {
    version: COLLAB_SESSION_PATCH_VERSION,
    sessionId,
    actorId,
    base: sanitized.base,
    update: sanitized.update,
  };
};

export const deserializeCollabSessionPatch = (
  payload: unknown,
): CollabSessionPatchMessage => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid collaborative session payload: expected an object');
  }

  const record = payload as Partial<CollabSessionPatchMessage> & { version?: number };

  if (record.version !== COLLAB_SESSION_PATCH_VERSION) {
    throw new Error(
      `Unsupported collaborative session patch version ${record.version}. Expected ${COLLAB_SESSION_PATCH_VERSION}.`,
    );
  }

  if (!record.sessionId || typeof record.sessionId !== 'string') {
    throw new Error('Collaborative session patch missing session id');
  }

  if (!record.base || !record.update) {
    throw new Error('Collaborative session patch missing base or update payload');
  }

  const actorId = requireActorId(record.actorId);
  const { base, update } = sanitizePatchSessions(
    record.sessionId,
    record.base,
    record.update,
  );

  return {
    version: COLLAB_SESSION_PATCH_VERSION,
    sessionId: record.sessionId,
    actorId,
    base,
    update,
  };
};

export type RemoteSessionPatchApplier = (
  payload: CollabPayload<CollabSessionPatchMessage>,
) => Promise<void>;

export const createRemoteSessionPatchApplier = (
  sessionManager: Pick<SessionManager, 'updateSession'>,
): RemoteSessionPatchApplier => {
  return async (payload) => {
    const patch = deserializeCollabSessionPatch(payload.body);

    await sessionManager.updateSession((localSession) => {
      if (localSession.id !== patch.sessionId) {
        throw new Error(
          `Remote patch targeted session ${patch.sessionId} but local session is ${localSession.id}`,
        );
      }

      const merged = mergeSessions(patch.base, localSession, patch.update);

      localSession.name = merged.name;
      localSession.metadata = merged.metadata;
      localSession.tracks = merged.tracks;

      return localSession;
    });
  };
};
