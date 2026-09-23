# 3-Tier Hybrid Database Architecture

Updated: 2026-09-23

## Overview

The Phomueangtai Personal Multi-Tool Discord Bot employs a **3-Tier Hybrid Database Architecture** designed to balance durability, ultra-low latency, and MongoDB Atlas resource limits:

```text
                         DISCORD BOT RUNTIME
                                  │
                           DATABASE LAYER
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
       RAM                     SQLite                    MongoDB
   (Hot State)         (Local Operational DB)      (Authoritative Source)
        │                         │                         │
 - Active Voice Sessions   - DM Notification Queue   - GuildConfig & Rules
 - In-Flight Deduplication - Quest Execution Logs    - VerifyLog & Audit Proof
 - Rate Limit Windows      - Ephemeral Nonces        - OAuth Identity & Tokens
 - Hot Cache Buffers       - Recovery Checkpoints    - Snapshots & Roles
                           - History Events          - IP & Device History
                           - Local Asset Cache       - Privacy Deletion Jobs
```

---

## 1. Division of Responsibilities

### Tier 1: RAM (In-Memory Hot State)
- **Purpose**: Ultra-fast access for volatile, sub-second operations.
- **Data Held**:
  - Active Voice connections and ephemeral WebSocket state (`discord/sessionManager.js`).
  - Cache stampede mutexes and in-flight promises.
  - Rate limit counters and recent access debounce buffers (e.g. 30s touch buffer for cache entries).
- **Durability**: Ephemeral; rebuilt on process restart.

### Tier 2: SQLite (`better-sqlite3@13.0.3`) (Local Operational DB)
- **Purpose**: High-frequency writes, durable queues, execution logs, ephemeral security nonces, and structured operational cache. Offloads write pressure from MongoDB Atlas.
- **Data Held**:
  - **Queues**: `dm_notifications` (worker queue with atomic claiming and retry lifecycle).
  - **Quest Subsystem**: `quest_logs`, `quest_accounts`, `quest_details`, `scheduled_runners`.
  - **Ephemeral Tokens**: `verification_state_nonce` (OAuth state validation with TTL), `verification_recovery` (durable state machine recovery).
  - **Telemetry & History**: `voice_events`, `command_events`, `session_events`, `runtime_events`.
  - **Local Cache**: `cache_entries`, `asset_cache`.
- **Durability**: Full ACID durability on local disk using Write-Ahead Logging (`WAL`).

### Tier 3: MongoDB (`mongoose@^9.8.0`) (Authoritative Cloud Database)
- **Purpose**: Critical identity, verification authority, security intelligence, and long-term audits.
- **Data Held**:
  - Verification configurations (`GuildConfig`).
  - Formal audit trails (`VerifyLog`).
  - Discord OAuth credentials (`OAuthUser`) and full-state snapshots (`OAuthMemberSnapshot`, etc.).
  - Security intelligence: IP & Device tracking (`IpIdentityLink`, `IpIdentityUserHistory`, `IpIdentityDeviceHistory`, `IpIdentityRoleHistory`).
  - Compliance workflows: `PrivacyDeletionJob`, migration archives.
- **Durability**: Multi-replica cloud durability on MongoDB Atlas.

---

## 2. Invariants & Storage Boundaries

1. **Storage Isolation**:
   - SQLite database files **MUST NOT** reside in source code directories.
   - Default path: `./data/discordbot.sqlite` (configurable via `SQLITE_DB_PATH`).
   - Backup directory: `./backups` (configurable via `SQLITE_BACKUP_DIR`).
   - Both `./data/` and `./backups/` are strictly ignored by version control (`.gitignore`).

2. **PRAGMA Order Dependency**:
   - `PRAGMA auto_vacuum = INCREMENTAL` **MUST** be applied before `PRAGMA journal_mode = WAL` on database creation. SQLite writes `auto_vacuum` configuration into the root page header upon initial page allocation.
   - Runtime configuration:
     - `journal_mode = WAL`
     - `synchronous = NORMAL`
     - `foreign_keys = ON`
     - `busy_timeout = 5000`

3. **Concurrency Model**:
   - Exactly **ONE** open connection to SQLite per Node process (`database/sqlite/connection.js`).
   - SQLite WAL enables concurrent readers alongside one active writer without locking bottlenecks.

4. **No Backward Data Migration**:
   - Pre-existing operational records remain in MongoDB as historical data.
   - SQLite boots at schema version 1, starting clean without destructive collection drops.

5. **Clean Architecture & Repository Abstraction**:
   - Feature code interacts with SQLite solely through Repositories located in `database/repositories/`.
   - Direct SQL statements are strictly forbidden in bot feature code and command handlers.
   - **Administrative Exemption**: Direct SQL is explicitly permitted within administrative infrastructure files (`database/services/databaseService.js`, `database/sqlite/maintenance/*`, and `database/sqlite/migrations/*`) for maintenance, integrity checks, table inspection, schema migrations, and emergency trim actions.

6. **Technical Debt & Migration Lifecycle**:
   - **Migration 004 Note (`DROP TABLE IF EXISTS asset_cache`)**: Migration 004 dropped and recreated `asset_cache` to transition from embedded binary BLOB storage to lean disk-backed filesystem metadata. In dev/test environments, this purged stale binary entries cleanly. In future production schema migrations, all table alterations **MUST** use additive `ALTER TABLE` or multi-step migration procedures without `DROP TABLE` to prevent data loss.

---

## 3. Compliance with Binding Owner Intent

All database operations strictly adhere to [`docs/OWNER_INTENT_POLICY.md`](docs/OWNER_INTENT_POLICY.md):
- **OI-01**: Alternate account voice tokens are fully supported without owner matching checks.
- **OI-02**: Token isolation remains absolute.
- **OI-03**: Forced full-data collection policy is preserved across all verification pipelines.
- **OI-04**: Direct owner dashboard access to tokens and raw data without additional PIN or reason prompts.
- **OI-05**: Full-fidelity logging for owner-selected fields.
