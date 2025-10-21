import { normalizeSession, Session, validateSession } from './models';
import { deepClone } from './util';

export interface SerializedSessionEnvelope {
  schemaVersion: number;
  session: Session;
}

const CURRENT_SCHEMA_VERSION = 1;

export const serializeSession = (session: Session): string => {
  const normalized = normalizeSession(deepClone(session));
  validateSession(normalized);
  const payload: SerializedSessionEnvelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    session: normalized,
  };
  return JSON.stringify(payload);
};

export const deserializeSession = (payload: string): Session => {
  const parsed = JSON.parse(payload) as SerializedSessionEnvelope;
  if (!parsed.schemaVersion) {
    throw new Error('Missing schema version in session payload');
  }
  if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version ${parsed.schemaVersion}. Expected ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const session = normalizeSession(parsed.session);
  validateSession(session);
  return session;
};

export const cloneSession = (session: Session): Session => deepClone(session);

export const mergeSessions = (
  base: Session,
  local: Session,
  remote: Session,
): Session => {
  const winner = local.revision >= remote.revision ? local : remote;
  const merged = {
    ...winner,
    metadata: {
      ...winner.metadata,
      createdAt: base.metadata.createdAt,
      updatedAt: new Date(
        Math.max(
          new Date(winner.metadata.updatedAt).getTime(),
          new Date(base.metadata.updatedAt).getTime(),
        ),
      ).toISOString(),
    },
    revision: Math.max(local.revision, remote.revision) + 1,
  };
  validateSession(merged);
  return merged;
};
