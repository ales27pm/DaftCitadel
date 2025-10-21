# Session Management

The session management subsystem consolidates transport, routing, and automation
state for the Daft Citadel audio engine. It is written entirely in TypeScript to
keep the React Native and desktop runtimes type-safe while remaining portable to
both mobile (SQLite-backed) and desktop (JSON file-backed) environments.

## Module Overview

The `src/session/` directory provides the following building blocks:

- **Models (`models.ts`)** — Typed data structures for tracks, clips, automation
  curves, and routing metadata. Helper utilities such as
  `normalizeSession` and `validateSession` ensure that data remains well ordered
  before it is persisted or sent to the audio engine.
- **Serialization (`serialization.ts`)** — Canonical JSON encoding/decoding with
  schema versioning. `mergeSessions` performs revision-winner reconciliation that
  keeps metadata consistent while preventing stale revisions from overwriting
  newer work.
- **Storage adapters (`storage/`)** —
  - `SQLiteSessionStorageAdapter` targets mobile platforms and accepts any
    SQLite bridge that implements the lightweight `SQLiteConnection` interface.
  - `JsonSessionStorageAdapter` persists sessions as atomic JSON documents on
    desktop systems.
- **Cloud sync (`cloud.ts`)** — A pluggable `CloudSyncProvider` abstraction that
  supports no-op local development, device-to-device sync, or hosted
  collaboration back ends.
- **Undo/redo (`history.ts`)** — An in-memory history stack with configurable
  capacity that powers editor undo/redo without sacrificing determinism.
- **Session manager (`sessionManager.ts`)** — Coordinates transactional storage
  writes, undo/redo, cloud merge, and audio-engine notifications behind a
  single, mutex-guarded façade.

## Storage Migration Guidelines

When evolving the session schema you should apply the following process:

1. **Introduce new schema version** — Increment the `CURRENT_SCHEMA_VERSION` in
   `serialization.ts` and expand the `SerializedSessionEnvelope` interface with
   any new fields required for your migration.
2. **Write forward-compatible serializers** — Update `serializeSession` to emit
   default values for new properties. Prefer explicit defaults instead of
   relying on optional chaining so that older clients can ignore unknown keys.
3. **Implement deserialization shims** — Extend `deserializeSession` with a
   switch statement for legacy schema versions. Migrations should be pure
   functions that transform the parsed payload into the latest `Session`
   structure before validation.
4. **Backfill storage adapters** — For SQLite, add ALTER TABLE statements to the
   `ensureInitialized` helper in `sqliteAdapter.ts`. For JSON, update the
   `JsonSessionFile` structure and handle missing fields gracefully while
   reading legacy files.
5. **Coordinate cloud sync** — When bumping the schema, deploy server-side
   migrations before pushing client updates. The optional
   `CloudSyncProvider.resolveConflict` hook can upgrade remote documents during
   merge operations.
6. **Document breaking changes** — Record any manual steps (e.g., re-exporting
   stems, clearing cache directories) required for users in release notes.

## Testing

All storage layers and conflict-resolution flows are covered by Jest tests in
`src/session/__tests__/sessionStorage.test.ts`. Run the full suite before
shipping changes:

```bash
npm test
```

Follow up with linting and formatting to match repository standards:

```bash
npm run lint
npm run prettier
```
