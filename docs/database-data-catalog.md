# Database Data Catalog

Updated: 2026-09-23

This document lists the schema catalog across both MongoDB Atlas and local SQLite stores.

---

## 1. MongoDB Models (Authoritative & Security Core)

All 17 models are centralized in `database/mongo/models/`.

| Model Name | Category | Primary Function | Retention Policy |
| :--- | :--- | :--- | :--- |
| `GuildConfig` | Verification | Per-guild verification settings, role bindings, and policies. | Permanent |
| `VerifyLog` | Verification | Audit trail of member verification attempts, decisions, and evidence. | 90 days / Permanent |
| `OAuthUser` | Identity | OAuth access/refresh tokens and primary Discord user identity. | Permanent / Revocation |
| `OAuthMemberSnapshot` | Snapshots | Complete guild member state capture at verification time. | Configurable snapshot retention |
| `OAuthMemberRoleSnapshot` | Snapshots | Role assignments recorded during verification. | Configurable snapshot retention |
| `OAuthUserProfileSnapshot` | Snapshots | Detailed profile data (avatar, banner, bio, nitro) snapshot. | Configurable snapshot retention |
| `OAuthUserGuildSnapshot` | Snapshots | Mutual guilds and membership state snapshot. | Configurable snapshot retention |
| `OAuthUserConnectionSnapshot`| Snapshots | Connected third-party accounts (Steam, GitHub, etc.). | Configurable snapshot retention |
| `OAuthObjectChunkSnapshot` | Snapshots | Chunked payload storage for large snapshot payloads. | Matched to parent snapshot |
| `OAuthSnapshotRecovery` | Snapshots | Recovery checkpoints for multipart snapshot processing. | Transient / 7 days |
| `IpIdentityLink` | Security | Association mapping between IP address and Discord accounts. | Permanent security audit |
| `IpIdentityUserHistory` | Security | Historical timeline of IP addresses used per user. | Permanent security audit |
| `IpIdentityDeviceHistory` | Security | Device fingerprints and user agents seen per IP. | Permanent security audit |
| `IpIdentityRoleHistory` | Security | Role escalations and changes correlated with IP. | Permanent security audit |
| `PrivacyDeletionJob` | Compliance | GDPR / owner data deletion jobs with execution proof. | Permanent audit log |
| `VerificationMigrationArchive`| Migration | Archive storage for pre-migration verification snapshots. | 180 days |
| `VerificationMigrationState` | Migration | Tracking state for active/completed verification migrations. | Permanent |

---

## 2. SQLite Tables (Local Operational & High-Frequency Store)

All tables are defined in `database/sqlite/migrations/` and accessed via `database/repositories/`.

### Core Operational Tables (`001_initial_core.sql`)
| Table Name | Entity / Subsystem | Description | Indexes / Constraints |
| :--- | :--- | :--- | :--- |
| `schema_migrations` | System | Tracks executed migration versions and checksums. | `PRIMARY KEY (version)` |
| `database_meta` | System | Key-value store for internal database engine state. | `PRIMARY KEY (key)` |
| `maintenance_runs` | Maintenance | History of vacuum, cleanup, and quota evaluation runs. | `idx_maintenance_runs_type_started` |
| `quest_logs` | Quests | Quest execution records, run state, and metadata. | `idx_quest_logs_created_at`, `idx_quest_logs_status` |
| `quest_accounts` | Quests | Per-account run details within a quest execution. | Foreign key to `quest_logs(id)` ON DELETE CASCADE |
| `quest_details` | Quests | Step-by-step progress tracking for quest accounts. | Foreign key to `quest_accounts(id)` ON DELETE CASCADE |
| `scheduled_runners` | Quests | Cron/interval schedules for automated quest execution. | `UNIQUE (name)`, `idx_scheduled_runners_status` |
| `dm_notifications` | Notification Queue | Queue worker for DM dispatch with atomic leasing. | `idx_dm_notifications_queue`, `UNIQUE (notification_key)` |
| `verification_recovery`| Verification Temp | Multi-stage verification session recovery state. | `idx_verif_recovery_guild_user`, `UNIQUE (session_id)` |
| `verification_state_nonce`| Ephemeral Auth | Short-lived nonces validating OAuth callback authenticity. | `idx_verif_state_nonce_expires`, `UNIQUE (hash)` |

### History & Telemetry Tables (`002_history_events.sql`)
| Table Name | Entity / Subsystem | Description | Retention |
| :--- | :--- | :--- | :--- |
| `voice_events` | Voice Subsystem | Voice worker transitions, join/leave, AutoDeaf events. | 30 days (auto-cleaned) |
| `command_events` | Slash Commands | Execution metrics and timing of slash interactions. | 30 days (auto-cleaned) |
| `session_events` | Token Coordinator | Concurrency, backoff, and quarantine lifecycle events. | 30 days (auto-cleaned) |
| `runtime_events` | System Lifecycle | Startup, shutdown, shard resumes, and health alerts. | 30 days (auto-cleaned) |

### Cache Subsystem Tables (`003_cache_subsystem.sql`)
| Table Name | Namespace | Description | TTL / Max Rows |
| :--- | :--- | :--- | :--- |
| `cache_entries` | Generic Cache | Fast key-value store with namespace isolation & priority. | Policy-based (1h - 24h) |
| `asset_cache` | Assets & Files | Binary blobs and metadata for avatars and panel icons. | 7 days / Quota-bounded |

---

## 3. Data Integrity & Migration Principles

1. **Schema Migrations**:
   - Sequential, idempotent SQL files evaluated inside a single transaction per migration.
   - Guarded by `PRAGMA user_version`.
2. **Error Code Emulation**:
   - `DmNotificationRepository` and `VerificationStateNonceRepository` translate SQLite unique constraint violations (`SQLITE_CONSTRAINT_UNIQUE`) into Mongoose-compatible error objects (`code: 11000`) to guarantee drop-in compatibility.
3. **Write-Behind History Buffer**:
   - High-throughput history events (`voice_events`, etc.) are held in RAM and flushed in transactions every 10 seconds or on process shutdown.
