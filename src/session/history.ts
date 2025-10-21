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

  undo(currentSession: Session): Session | null {
    if (!this.canUndo()) {
      return null;
    }
    const snapshot = this.undoStack.pop();
    if (!snapshot) {
      return null;
    }
    this.redoStack.push({ session: cloneSession(currentSession) });
    return cloneSession(snapshot.session);
  }

  redo(currentSession: Session): Session | null {
    if (!this.canRedo()) {
      return null;
    }
    const snapshot = this.redoStack.pop();
    if (!snapshot) {
      return null;
    }
    this.undoStack.push({ session: cloneSession(currentSession) });
    return cloneSession(snapshot.session);
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
