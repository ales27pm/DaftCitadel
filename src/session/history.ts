import { Session } from './models';
import { cloneSession } from './serialization';

interface HistorySnapshot {
  session: Session;
}

export class SessionHistory {
  private readonly undoStack: HistorySnapshot[] = [];
  private readonly redoStack: HistorySnapshot[] = [];

  constructor(private readonly capacity = 50) {}

  record(session: Session): void {
    const snapshot: HistorySnapshot = { session: cloneSession(session) };
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.capacity) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peekUndo(): Session | null {
    const snapshot = this.undoStack.at(-1);
    return snapshot ? cloneSession(snapshot.session) : null;
  }

  peekRedo(): Session | null {
    const snapshot = this.redoStack.at(-1);
    return snapshot ? cloneSession(snapshot.session) : null;
  }

  commitUndo(currentSession: Session): void {
    if (!this.canUndo()) {
      throw new Error('Cannot commit undo without an undo snapshot');
    }
    const currentSnapshot = cloneSession(currentSession);
    this.undoStack.pop();
    this.redoStack.push({ session: currentSnapshot });
  }

  commitRedo(currentSession: Session): void {
    if (!this.canRedo()) {
      throw new Error('Cannot commit redo without a redo snapshot');
    }
    const currentSnapshot = cloneSession(currentSession);
    this.redoStack.pop();
    this.undoStack.push({ session: currentSnapshot });
    if (this.undoStack.length > this.capacity) {
      this.undoStack.shift();
    }
  }

  undo(currentSession: Session): Session | null {
    const session = this.peekUndo();
    if (!session) {
      return null;
    }
    this.commitUndo(currentSession);
    return session;
  }

  redo(currentSession: Session): Session | null {
    const session = this.peekRedo();
    if (!session) {
      return null;
    }
    this.commitRedo(currentSession);
    return session;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
