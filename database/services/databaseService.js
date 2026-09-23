"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getDatabase, getCurrentDbPath, resolveDbPath } = require("../sqlite/connection");
const { evaluateQuota, getDatabaseFootprint, getFilesystemFreeSpace, evaluateEmergencyThresholds, canSendAlert, recordAlertSent } = require("../sqlite/maintenance/quota");
const { runBoundedCleanup } = require("../sqlite/maintenance/cleanup");
const { runIncrementalVacuum, checkpointWal } = require("../sqlite/maintenance/vacuum");
const { createBackup, listBackups } = require("../sqlite/maintenance/backup");
const { runStartupCheck } = require("../sqlite/maintenance/startupCheck");
const { executeEmergencyTrim } = require("../sqlite/maintenance/emergencyTrim");
const { sendWebhookEvent } = require("../../discord/core/webhooks");
const mongo = require("../mongo/index");

// ════════════════════════════════════════════════════════════════════════════
//  🛡️ ALLOWLISTS & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const CONSOLE_COMMANDS = Object.freeze([
    "status",
    "health",
    "stats",
    "tables",
    "migrations",
    "integrity",
    "cleanup",
    "cleanup cache",
    "cleanup history",
    "checkpoint",
    "vacuum",
    "backup",
    "emergency-trim",
    "full-check"
]);

const ALLOWED_MONGO_COLLECTIONS = Object.freeze([
    "GuildConfig",
    "VerifyLog",
    "OAuthUser",
    "OAuthMemberSnapshot",
    "OAuthMemberRoleSnapshot",
    "OAuthUserProfileSnapshot",
    "OAuthUserGuildSnapshot",
    "OAuthUserConnectionSnapshot",
    "OAuthObjectChunkSnapshot",
    "OAuthSnapshotRecovery",
    "IpIdentityLink",
    "IpIdentityUserHistory",
    "IpIdentityDeviceHistory",
    "IpIdentityRoleHistory",
    "PrivacyDeletionJob",
    "VerificationMigrationArchive",
    "VerificationMigrationState"
]);

// ════════════════════════════════════════════════════════════════════════════
//  📊 1. OVERVIEW & HEALTH
// ════════════════════════════════════════════════════════════════════════════

async function getDatabaseOverview() {
    const startTime = Date.now();
    const dbPath = getCurrentDbPath() || resolveDbPath();
    const db = getDatabase();

    // 1. SQLite Status & Quota
    const quota = evaluateQuota(dbPath);
    let sqliteHealth = "ok"; // 'ok' | 'check' | 'warning' | 'error'
    let sqliteStatusLabel = "🟢 ปกติ";

    if (quota.status === "hard") {
        sqliteHealth = "error";
        sqliteStatusLabel = "🔴 มีปัญหา (Hard Limit)";
    } else if (quota.status === "critical") {
        sqliteHealth = "warning";
        sqliteStatusLabel = "🟠 ใกล้ถึงขีดจำกัด";
    } else if (quota.status === "soft") {
        sqliteHealth = "check";
        sqliteStatusLabel = "🟡 ควรตรวจสอบ";
    }

    // 2. Table counts & record totals
    let totalRecords = 0;
    let coreCount = 0;
    let cacheCount = 0;
    let historyCount = 0;
    let tempCount = 0;

    try {
        const tableStats = db.prepare(`
            SELECT 'quest_logs' AS tbl, COUNT(*) AS cnt FROM quest_logs
            UNION ALL SELECT 'scheduled_runners', COUNT(*) FROM scheduled_runners
            UNION ALL SELECT 'dm_notifications', COUNT(*) FROM dm_notifications
            UNION ALL SELECT 'verification_recovery', COUNT(*) FROM verification_recovery
            UNION ALL SELECT 'cache_entries', COUNT(*) FROM cache_entries
            UNION ALL SELECT 'asset_cache', COUNT(*) FROM asset_cache
            UNION ALL SELECT 'voice_events', COUNT(*) FROM voice_events
            UNION ALL SELECT 'command_events', COUNT(*) FROM command_events
            UNION ALL SELECT 'session_events', COUNT(*) FROM session_events
            UNION ALL SELECT 'runtime_events', COUNT(*) FROM runtime_events
            UNION ALL SELECT 'verification_state_nonce', COUNT(*) FROM verification_state_nonce
            UNION ALL SELECT 'database_meta', COUNT(*) FROM database_meta
        `).all();

        for (const row of tableStats) {
            totalRecords += row.cnt;
            if (["quest_logs", "scheduled_runners", "dm_notifications", "verification_recovery"].includes(row.tbl)) {
                coreCount += row.cnt;
            } else if (["cache_entries", "asset_cache"].includes(row.tbl)) {
                cacheCount += row.cnt;
            } else if (["voice_events", "command_events", "session_events", "runtime_events"].includes(row.tbl)) {
                historyCount += row.cnt;
            } else {
                tempCount += row.cnt;
            }
        }
    } catch (_) {}

    // 3. Maintenance metadata
    const metaMap = {};
    try {
        const metaRows = db.prepare("SELECT key, value FROM database_meta").all();
        for (const r of metaRows) metaMap[r.key] = r.value;
    } catch (_) {}

    // 4. Backups list
    const backups = listBackups();
    const lastBackupInfo = backups.length > 0 ? backups[0] : null;

    // 5. MongoDB Overview
    const mongoStatus = mongo.getMongoStatus();
    let mongoPingMs = null;
    let mongoHealthLabel = mongoStatus.connected ? "🟢 ปกติ" : "🔴 ขาดการเชื่อมต่อ";

    if (mongoStatus.connected && mongo.mongoose.connection.db) {
        try {
            const pStart = Date.now();
            await mongo.mongoose.connection.db.command({ ping: 1 });
            mongoPingMs = Date.now() - pStart;
        } catch (_) {
            mongoHealthLabel = "🟡 ช้า/มีปัญหา";
        }
    }

    return {
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        databases: {
            sqlite: {
                status: sqliteHealth,
                statusLabel: sqliteStatusLabel,
                path: dbPath,
                footprintMb: quota.footprint.totalMb,
                hardLimitMb: quota.limits.hardMb,
                usedPercent: parseFloat(((quota.footprint.totalMb / quota.limits.hardMb) * 100).toFixed(1)),
                degradedReason: quota.degradedReason,
                records: {
                    total: totalRecords,
                    core: coreCount,
                    cache: cacheCount,
                    history: historyCount,
                    temp: tempCount
                },
                lastMaintenance: {
                    lastCleanup: metaMap.last_cleanup || null,
                    lastBackup: lastBackupInfo?.createdAt || metaMap.last_backup || null,
                    lastIntegrityCheck: metaMap.last_integrity_check || null,
                    lastCheckpoint: metaMap.last_checkpoint || null
                }
            },
            mongodb: {
                status: mongoStatus.connected ? "ok" : "error",
                statusLabel: mongoHealthLabel,
                connected: mongoStatus.connected,
                pingMs: mongoPingMs,
                name: mongoStatus.name,
                modelsCount: mongoStatus.models,
                pool: mongoStatus.pool
            }
        }
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🗄️ 2. SQLITE DETAILED STATUS & CATEGORIES
// ════════════════════════════════════════════════════════════════════════════

async function getSqliteDetailedStatus() {
    const dbPath = getCurrentDbPath() || resolveDbPath();
    const db = getDatabase();
    const quota = evaluateQuota(dbPath);

    // Pragmas
    const journalMode = db.pragma("journal_mode", { simple: true });
    const userVersion = db.pragma("user_version", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    const synchronous = db.pragma("synchronous", { simple: true });

    // Table Detailed Row Counts
    const tableCounts = {};
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);

    for (const tbl of tables) {
        try {
            const r = db.prepare(`SELECT COUNT(*) AS c FROM "${tbl}"`).get();
            tableCounts[tbl] = r ? r.c : 0;
        } catch (_) {
            tableCounts[tbl] = 0;
        }
    }

    // Category Aggregates
    const categories = {
        core: {
            label: "ข้อมูลหลัก (Core Operational)",
            count: (tableCounts.quest_logs || 0) + (tableCounts.quest_accounts || 0) + (tableCounts.quest_details || 0) + (tableCounts.scheduled_runners || 0) + (tableCounts.dm_notifications || 0) + (tableCounts.verification_recovery || 0),
            tables: {
                quest_logs: { count: tableCounts.quest_logs || 0, label: "ประวัติการรัน Quest" },
                quest_accounts: { count: tableCounts.quest_accounts || 0, label: "บัญชี Quest" },
                quest_details: { count: tableCounts.quest_details || 0, label: "รายละเอียด Quest Step" },
                scheduled_runners: { count: tableCounts.scheduled_runners || 0, label: "ตัวตั้งเวลา Auto Daily" },
                dm_notifications: { count: tableCounts.dm_notifications || 0, label: "คิวแจ้งเตือน DM" },
                verification_recovery: { count: tableCounts.verification_recovery || 0, label: "จุดกู้คืนสถานะยืนยันตัวตน" }
            }
        },
        temporary: {
            label: "ข้อมูลชั่วคราว (Temporary / Nonces)",
            count: (tableCounts.verification_state_nonce || 0) + (tableCounts.database_meta || 0),
            tables: {
                verification_state_nonce: { count: tableCounts.verification_state_nonce || 0, label: "OAuth State Nonces (มีอายุ)" },
                database_meta: { count: tableCounts.database_meta || 0, label: "ค่าสถานะระบบภายใน" }
            }
        },
        history: {
            label: "บันทึกประวัติ (History & Telemetry - 30 วัน)",
            count: (tableCounts.voice_events || 0) + (tableCounts.command_events || 0) + (tableCounts.session_events || 0) + (tableCounts.runtime_events || 0),
            tables: {
                voice_events: { count: tableCounts.voice_events || 0, label: "ประวัติเหตุการณ์ห้องเสียง" },
                command_events: { count: tableCounts.command_events || 0, label: "ประวัติการใช้คำสั่ง Slash" },
                session_events: { count: tableCounts.session_events || 0, label: "ประวัติ Token Coordinator" },
                runtime_events: { count: tableCounts.runtime_events || 0, label: "ประวัติการทำงานของระบบ" }
            }
        },
        cache: {
            label: "ข้อมูลแคช (Cache Subsystem)",
            count: (tableCounts.cache_entries || 0) + (tableCounts.asset_cache || 0),
            tables: {
                cache_entries: { count: tableCounts.cache_entries || 0, label: "แคชทั่วไป (KV Store)" },
                asset_cache: { count: tableCounts.asset_cache || 0, label: "แคชรูปภาพ/ไอคอน" }
            }
        }
    };

    // Maintenance runs log (last 5)
    let maintenanceHistory = [];
    try {
        maintenanceHistory = db.prepare(`
            SELECT id, type, status, details, duration_ms, started_at, completed_at
            FROM maintenance_runs
            ORDER BY id DESC LIMIT 5
        `).all();
    } catch (_) {}

    // Backups
    const backups = listBackups();

    return {
        path: dbPath,
        open: db.open,
        pragmas: {
            journalMode,
            userVersion,
            foreignKeys: foreignKeys === 1,
            synchronous
        },
        quota,
        storage: {
            mainBytes: quota.footprint.mainBytes,
            walBytes: quota.footprint.walBytes,
            shmBytes: quota.footprint.shmBytes,
            totalMb: quota.footprint.totalMb,
            limits: quota.limits,
            filesystem: quota.filesystem
        },
        categories,
        maintenanceHistory,
        backups
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  ⚡ 3. SQLITE MAINTENANCE ACTIONS & AUDIT
// ════════════════════════════════════════════════════════════════════════════

function notifyIntegrityCorrupted(intRows, fkRows, dbPath = null) {
    if (!canSendAlert("sqlite_integrity_corrupted")) return;
    recordAlertSent("sqlite_integrity_corrupted");
    try {
        sendWebhookEvent({
            target: "ALERT",
            severity: "CRITICAL",
            category: "DATA",
            code: "sqlite.integrity.corrupted",
            title: "🚨 ตรวจพบความเสียหายในไฟล์ฐานข้อมูล SQLite (Integrity Corrupted)",
            description: "ระบบตรวจพบความเสียหายของโครงสร้าง B-Tree หรือ Foreign Key ในไฟล์ SQLite Database ระหว่างการตรวจสอบ Integrity Check",
            context: {
                "Integrity Status": Array.isArray(intRows) ? JSON.stringify(intRows).slice(0, 500) : String(intRows),
                "Foreign Key Errors": fkRows && fkRows.length > 0 ? JSON.stringify(fkRows).slice(0, 500) : "None",
                "ไฟล์ฐานข้อมูล": dbPath || getCurrentDbPath() || resolveDbPath(),
                "เวลาที่เกิด": new Date().toISOString()
            }
        }).catch(() => {});
    } catch (_) {}
}

async function executeSqliteAction(action, options = {}, invoker = "owner") {
    const db = getDatabase();
    const startTime = Date.now();
    let result = { ok: false, action, message: "" };

    const recordAudit = (status, details) => {
        try {
            db.prepare(`
                INSERT INTO maintenance_runs (type, status, details, duration_ms, started_at, completed_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(action, status, JSON.stringify(details), Date.now() - startTime, startTime, Date.now());
        } catch (_) {}
    };

    try {
        switch (action) {
            case "check": {
                const probe = runStartupCheck(db, { dbPath: getCurrentDbPath() });
                result = { ok: probe.ok, action, probe, message: "ตรวจสอบความสมบูรณ์สำเร็จ" };
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_health_check', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit("success", result);
                break;
            }

            case "integrity": {
                const intRows = db.pragma("integrity_check");
                const fkRows = db.pragma("foreign_key_check");
                const passed = intRows.length === 1 && (intRows[0].integrity_check === "ok" || intRows[0] === "ok") && fkRows.length === 0;
                result = {
                    ok: passed,
                    action,
                    integrity: intRows,
                    foreignKeyErrors: fkRows,
                    message: passed ? "ตรวจสอบ Integrity ผ่าน 100%" : "พบข้อผิดพลาดใน Integrity"
                };
                if (!passed) {
                    notifyIntegrityCorrupted(intRows, fkRows);
                }
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_integrity_check', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit(passed ? "success" : "failure", result);
                break;
            }

            case "cleanup_expired":
            case "cleanup_all": {
                const stats = runBoundedCleanup(db, { maxBatches: options.maxBatches || 5 });
                result = { ok: true, action, stats, message: `ทำความสะอาดข้อมูลสำเร็จ ลบ ${stats.deletedRows} รายการ` };
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_cleanup', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit("success", result);
                break;
            }

            case "cleanup_cache": {
                const del = db.prepare("DELETE FROM cache_entries").run();
                const delAssets = db.prepare("DELETE FROM asset_cache").run();
                const total = (del.changes || 0) + (delAssets.changes || 0);
                result = { ok: true, action, deletedRows: total, message: `ล้างแคชสำเร็จ ลบทั้งหมด ${total} รายการ` };
                recordAudit("success", result);
                break;
            }

            case "cleanup_history": {
                const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
                const vDel = db.prepare("DELETE FROM voice_events WHERE created_at < ?").run(cutoff);
                const cDel = db.prepare("DELETE FROM command_events WHERE created_at < ?").run(cutoff);
                const sDel = db.prepare("DELETE FROM session_events WHERE created_at < ?").run(cutoff);
                const rDel = db.prepare("DELETE FROM runtime_events WHERE created_at < ?").run(cutoff);
                const total = (vDel.changes || 0) + (cDel.changes || 0) + (sDel.changes || 0) + (rDel.changes || 0);
                result = { ok: true, action, deletedRows: total, message: `ล้างประวัติเก่าเกิน 30 วันสำเร็จ ลบ ${total} รายการ` };
                recordAudit("success", result);
                break;
            }

            case "checkpoint": {
                const chk = checkpointWal(db, options.mode || "PASSIVE");
                result = { ok: chk.ok, action, checkpoint: chk, message: "ดำเนินการ Checkpoint WAL สำเร็จ" };
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_checkpoint', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit("success", result);
                break;
            }

            case "vacuum": {
                const vac = runIncrementalVacuum(db, options.pages || 500);
                result = { ok: vac.ok, action, vacuum: vac, message: "ดำเนินการ Incremental Vacuum สำเร็จ" };
                recordAudit("success", result);
                break;
            }

            case "backup": {
                const maxBackups = options.retention || parseInt(process.env.SQLITE_BACKUP_RETENTION, 10) || 2;
                const bkp = await createBackup(db, { maxBackups });
                result = { ok: bkp.ok, action, backup: bkp, message: `สำรองข้อมูลสำเร็จ (${bkp.filename}) ขนาด ${bkp.sizeMb} MB` };
                db.prepare("INSERT OR REPLACE INTO database_meta (key, value, updated_at) VALUES ('last_backup', ?, ?)")
                    .run(new Date().toISOString(), Date.now());
                recordAudit("success", result);
                break;
            }

            case "emergency_trim": {
                const trim = await executeEmergencyTrim(db, {
                    actor: invoker,
                    reason: options.reason || "Manual Owner Emergency Trim"
                });
                result = {
                    ok: trim.ok,
                    action,
                    trimResult: trim,
                    message: trim.isResolved
                        ? `Emergency Trim สำเร็จ: คืนพื้นที่ได้ ${trim.freedMb} MB (ลบทั้งหมด ${trim.itemsPurged.totalItems} รายการ) สภาวะกลับสู่ปกติ`
                        : `Emergency Trim เสร็จสิ้น: คืนพื้นที่ได้ ${trim.freedMb} MB แต่ระบบยังอยู่ในเกณฑ์เฝ้าระวัง (${trim.postStatus})`
                };
                recordAudit(trim.ok ? "success" : "failure", result);
                break;
            }

            case "full_check": {
                const probe = runStartupCheck(db, { dbPath: getCurrentDbPath() });
                const intRows = db.pragma("integrity_check");
                const fkRows = db.pragma("foreign_key_check");
                const quota = evaluateQuota(getCurrentDbPath() || resolveDbPath());
                const emergency = evaluateEmergencyThresholds(getCurrentDbPath() || resolveDbPath());
                const passed = probe.ok && intRows.length === 1 && (intRows[0].integrity_check === "ok" || intRows[0] === "ok") && fkRows.length === 0;

                if (!passed) {
                    notifyIntegrityCorrupted(intRows, fkRows);
                }

                const schemaVer = probe?.stats?.migration?.currentVersion || db.pragma("user_version", { simple: true });
                result = {
                    ok: passed,
                    action,
                    probe,
                    schemaVersion: schemaVer,
                    integrityOk: passed,
                    foreignKeyErrors: fkRows,
                    quota,
                    emergency,
                    message: passed
                        ? `Full Health Check ผ่าน 100%: SQLite ทำงานปกติ, Schema Version ${schemaVer}, พื้นที่ ${quota.footprint.totalMb} MB (${quota.status})`
                        : "ตรวจพบข้อผิดพลาดหรือคำเตือนในการตรวจสอบความสมบูรณ์แบบละเอียด"
                };
                recordAudit(passed ? "success" : "warning", result);
                break;
            }

            default:
                throw new Error(`ไม่รองรับคำสั่งการทำงาน: ${action}`);
        }
    } catch (err) {
        result = { ok: false, action, error: err.message, message: `เกิดข้อผิดพลาด: ${err.message}` };
        recordAudit("error", result);
    }

    result.durationMs = Date.now() - startTime;
    return result;
}

// ════════════════════════════════════════════════════════════════════════════
//  💻 4. DATABASE CONSOLE (STRICT ALLOWLIST - NO SHELL)
// ════════════════════════════════════════════════════════════════════════════

async function executeDatabaseConsole(commandString, invoker = "owner") {
    const raw = String(commandString || "").trim();
    const startTime = Date.now();

    if (!raw) {
        return {
            ok: false,
            command: "",
            output: "กรุณาระบุคำสั่ง เช่น status, health, stats, tables, integrity, cleanup, checkpoint, vacuum, backup",
            durationMs: 0
        };
    }

    // Shell injection guard: block common shell binaries and symbols
    const lower = raw.toLowerCase();
    const blockedKeywords = ["rm ", "rmdir", "curl", "wget", "bash", "sh", "npm", "node", "cat ", "ls ", "eval", ";", "|", "&", "`", "$"];
    if (blockedKeywords.some(kw => lower.includes(kw))) {
        return {
            ok: false,
            command: raw,
            output: "❌ ไม่อนุญาตให้รันคำสั่ง OS Shell หรืออักขระพิเศษบน Database Console เพื่อความปลอดภัยสูงสุด กรุณาใช้คำสั่งเฉพาะสำหรับฐานข้อมูลที่กำหนดไว้เท่านั้น",
            durationMs: Date.now() - startTime
        };
    }

    // Normalize command
    const cmd = lower;

    if (!CONSOLE_COMMANDS.includes(cmd)) {
        return {
            ok: false,
            command: raw,
            output: `❌ ไม่รู้จักคำสั่ง '${raw}'\nคำสั่งที่อนุญาตให้ใช้งานได้:\n${CONSOLE_COMMANDS.map(c => `  - ${c}`).join("\n")}`,
            durationMs: Date.now() - startTime
        };
    }

    let output = "";
    let ok = true;

    try {
        const db = getDatabase();
        switch (cmd) {
            case "status":
            case "health": {
                const overview = await getDatabaseOverview();
                const sq = overview.databases.sqlite;
                const mg = overview.databases.mongodb;
                output = [
                    "════════════════════════════════════════════════════════════",
                    "                สถานะระบบฐานข้อมูล (Database Status)          ",
                    "════════════════════════════════════════════════════════════",
                    `[SQLite]  สถานะ: ${sq.statusLabel} | พื้นที่: ${sq.footprintMb} MB / ${sq.hardLimitMb} MB (${sq.usedPercent}%)`,
                    `          จำนวน Records รวม: ${sq.records.total.toLocaleString()} รายการ (Core: ${sq.records.core}, Cache: ${sq.records.cache}, History: ${sq.records.history}, Temp: ${sq.records.temp})`,
                    `          รายละเอียดสถานะ: ${sq.degradedReason}`,
                    "------------------------------------------------------------",
                    `[MongoDB] สถานะ: ${mg.statusLabel} | ฐานข้อมูล: ${mg.name || "-"} | Ping: ${mg.pingMs !== null ? `${mg.pingMs}ms` : "-"}`,
                    `          โมเดลทั้งหมด: ${mg.modelsCount} โมเดล | Connection Pool: max ${mg.pool.maxPoolSize}, min ${mg.pool.minPoolSize}`,
                    "════════════════════════════════════════════════════════════"
                ].join("\n");
                break;
            }

            case "stats": {
                const details = await getSqliteDetailedStatus();
                output = [
                    "════════════════════════════════════════════════════════════",
                    "                สถิติแยกหมวดหมู่ (SQLite Stats)             ",
                    "════════════════════════════════════════════════════════════",
                    `1. ข้อมูลหลัก (Core):      ${details.categories.core.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.core.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    `2. ข้อมูลชั่วคราว (Temp):    ${details.categories.temporary.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.temporary.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    `3. ข้อมูลประวัติ (History): ${details.categories.history.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.history.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    `4. แคชระบบ (Cache):        ${details.categories.cache.count.toLocaleString()} รายการ`,
                    ...Object.entries(details.categories.cache.tables).map(([k, v]) => `   - ${k} (${v.label}): ${v.count.toLocaleString()}`),
                    "════════════════════════════════════════════════════════════"
                ].join("\n");
                break;
            }

            case "tables": {
                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
                output = `ตารางทั้งหมดใน SQLite (${tables.length} ตาราง):\n` + tables.map(t => {
                    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get()?.c || 0;
                    return `  - ${t.padEnd(28)} : ${cnt.toLocaleString()} แถว`;
                }).join("\n");
                break;
            }

            case "migrations": {
                const userVersion = db.pragma("user_version", { simple: true });
                const rows = db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
                output = [
                    `PRAGMA user_version: ${userVersion}`,
                    "ประวัติ Schema Migrations:",
                    ...rows.map(r => `  [v${r.version}] ${r.name.padEnd(25)} (เมื่อ: ${r.applied_at})`)
                ].join("\n");
                break;
            }

            case "integrity": {
                const act = await executeSqliteAction("integrity", {}, invoker);
                output = act.ok ? "✅ ผ่านการตรวจสอบ Integrity และ Foreign Keys 100% ฐานข้อมูลสมบูรณ์ปกติ" : `❌ พบข้อผิดพลาด: ${JSON.stringify(act)}`;
                ok = act.ok;
                break;
            }

            case "cleanup": {
                const act = await executeSqliteAction("cleanup_all", {}, invoker);
                output = `✅ ทำความสะอาดข้อมูลสำเร็จ: ลบข้อมูลชั่วคราวและประวัติเก่า ${act.stats?.deletedRows || 0} รายการ`;
                break;
            }

            case "cleanup cache": {
                const act = await executeSqliteAction("cleanup_cache", {}, invoker);
                output = `✅ ล้างแคชทั้งหมดสำเร็จ: ลบ ${act.deletedRows || 0} รายการ`;
                break;
            }

            case "cleanup history": {
                const act = await executeSqliteAction("cleanup_history", {}, invoker);
                output = `✅ ล้างประวัติย้อนหลังเกิน 30 วันสำเร็จ: ลบ ${act.deletedRows || 0} รายการ`;
                break;
            }

            case "checkpoint": {
                const act = await executeSqliteAction("checkpoint", {}, invoker);
                output = `✅ ดำเนินการ Checkpoint WAL สำเร็จ`;
                break;
            }

            case "vacuum": {
                const act = await executeSqliteAction("vacuum", {}, invoker);
                output = `✅ ดำเนินการ Incremental Vacuum สำเร็จ`;
                break;
            }

            case "backup": {
                const act = await executeSqliteAction("backup", {}, invoker);
                output = act.ok ? `✅ สร้างไฟล์สำรองข้อมูลสำเร็จ:\n   ไฟล์: ${act.backup?.filename}\n   ขนาด: ${act.backup?.sizeMb} MB\n   SHA-256: ${act.backup?.sha256 || 'N/A'}` : `❌ ล้มเหลว: ${act.error}`;
                ok = act.ok;
                break;
            }

            case "emergency-trim": {
                const act = await executeSqliteAction("emergency_trim", {}, invoker);
                if (act.ok) {
                    const t = act.trimResult;
                    output = [
                        `🚨 ผลการดำเนินการ Emergency Auto-Trim:`,
                        `  สถานะผลลัพธ์:         ${t.isResolved ? '✅ RESOLVED (ปกติ)' : '⚠️ DEGRADED (เฝ้าระวัง)'}`,
                        `  พื้นที่ที่คืนได้:        ${t.freedMb} MB`,
                        `  รายการที่ถูกลบ:       ${t.itemsPurged?.totalItems || 0} รายการ`,
                        `    - Asset หมดอายุ:    ${t.itemsPurged?.assetExpired || 0}`,
                        `    - Cache ชั่วคราว:    ${(t.itemsPurged?.nonces || 0) + (t.itemsPurged?.cacheEntries || 0)}`,
                        `    - ประวัติพ้น Retention: ${t.itemsPurged?.expiredHistory || 0}`,
                        `  ขนาดก่อน/หลัง:        ${t.preFootprint?.totalMb} MB ➔ ${t.postFootprint?.totalMb} MB`,
                        `  ระยะเวลา:             ${t.durationMs} ms`
                    ].join("\n");
                } else {
                    output = `❌ ล้มเหลว: ${act.message || act.error}`;
                }
                ok = act.ok;
                break;
            }

            case "full-check": {
                const act = await executeSqliteAction("full_check", {}, invoker);
                if (act.ok) {
                    output = [
                        `🔍 ผลการตรวจสอบความสมบูรณ์แบบละเอียด (Full Health Check):`,
                        `  สถานะ Integrity Check:    ${act.integrityOk ? '✅ PASS (สมบูรณ์ 100%)' : '❌ FAIL'}`,
                        `  Schema Migrations:        ✅ Version ${act.schemaVersion || 4}`,
                        `  Foreign Keys Check:       ✅ PASS (0 errors)`,
                        `  Storage Footprint:        ${act.quota?.footprint?.totalMb} MB / ${act.quota?.limits?.hardMb} MB (${act.quota?.status})`,
                        `  Emergency Alert Status:   ${act.emergency?.isEmergency ? '🚨 CRITICAL' : '🟢 NORMAL'}`
                    ].join("\n");
                } else {
                    output = `❌ ตรวจพบปัญหา: ${act.message || act.error}`;
                }
                ok = act.ok;
                break;
            }
        }
    } catch (err) {
        ok = false;
        output = `❌ เกิดข้อผิดพลาดในการประมวลผลคำสั่ง: ${err.message}`;
    }

    return {
        ok,
        command: raw,
        output,
        durationMs: Date.now() - startTime
    };
}

// ════════════════════════════════════════════════════════════════════════════
//  🍃 5. MONGODB MONITORING & SAFE DATA EXPLORER
// ════════════════════════════════════════════════════════════════════════════

async function getMongoDetailedStatus() {
    const mongoStatus = mongo.getMongoStatus();
    if (!mongoStatus.connected || !mongo.mongoose.connection.db) {
        return {
            connected: false,
            statusLabel: "🔴 ขาดการเชื่อมต่อ",
            collections: []
        };
    }

    // Ping
    let pingMs = 0;
    try {
        const pStart = Date.now();
        await mongo.mongoose.connection.db.command({ ping: 1 });
        pingMs = Date.now() - pStart;
    } catch (_) {}

    // Host & Connection safe info
    const safeHost = mongo.mongoose.connection.host || "cluster.mongodb.net";
    const maskedHost = safeHost.replace(/(:\/\/)([^@]+)@/, "$1***:***@");

    // Collections stats
    const collections = [];
    for (const modelName of ALLOWED_MONGO_COLLECTIONS) {
        const Model = mongo.models[modelName];
        if (!Model) continue;

        let docCount = 0;
        try {
            docCount = await Model.estimatedDocumentCount();
        } catch (_) {
            try {
                docCount = await Model.countDocuments();
            } catch (_) {}
        }

        collections.push({
            name: modelName,
            collectionName: Model.collection?.collectionName || modelName.toLowerCase(),
            count: docCount,
            indexesCount: Model.schema?.indexes()?.length || 0
        });
    }

    return {
        connected: true,
        statusLabel: "🟢 ปกติ",
        databaseName: mongoStatus.name,
        host: maskedHost,
        pingMs,
        pool: mongoStatus.pool,
        collectionsCount: collections.length,
        collections
    };
}

function maskSensitiveValue(key, value) {
    if (value === null || value === undefined) return value;

    const lowerKey = String(key).toLowerCase();

    // 1. Tokens, Secrets, Passwords, Cryptographic blobs
    if (/token|secret|password|key|hash|salt|iv|cipher|auth/i.test(lowerKey)) {
        if (typeof value === "string" && value.length > 8) {
            return `${value.slice(0, 4)}...${value.slice(-3)} [PROTECTED]`;
        }
        return "[PROTECTED_SECRET]";
    }

    // 2. IP Addresses (IPv4 & IPv6)
    if (typeof value === "string") {
        // IPv4 regex
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) {
            return value.replace(/\.\d{1,3}\.\d{1,3}$/, ".***.***");
        }
        // Email
        if (value.includes("@") && value.includes(".")) {
            const [local, dom] = value.split("@");
            return `${local.slice(0, 1)}***@${dom}`;
        }
    }

    // Recursive object masking
    if (typeof value === "object") {
        if (Array.isArray(value)) {
            return value.map((item, idx) => maskSensitiveValue(idx, item));
        }
        const maskedObj = {};
        for (const [k, v] of Object.entries(value)) {
            maskedObj[k] = maskSensitiveValue(k, v);
        }
        return maskedObj;
    }

    return value;
}

async function getMongoCollectionSample(collectionName, limit = 5) {
    if (!ALLOWED_MONGO_COLLECTIONS.includes(collectionName)) {
        throw new Error(`ไม่อนุญาตให้เปิดดู Collection '${collectionName}'`);
    }

    const Model = mongo.models[collectionName];
    if (!Model) {
        throw new Error(`ไม่พบโมเดล '${collectionName}' ในระบบ`);
    }

    const boundedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10);
    const docs = await Model.find({}).sort({ _id: -1 }).limit(boundedLimit).lean().exec();

    const maskedDocs = docs.map(doc => {
        const masked = {};
        for (const [k, v] of Object.entries(doc)) {
            masked[k] = maskSensitiveValue(k, v);
        }
        return masked;
    });

    const totalCount = await Model.estimatedDocumentCount().catch(() => 0);

    return {
        collectionName,
        totalCount,
        sampleCount: maskedDocs.length,
        documents: maskedDocs
    };
}

module.exports = {
    getDatabaseOverview,
    getSqliteDetailedStatus,
    executeSqliteAction,
    executeDatabaseConsole,
    getMongoDetailedStatus,
    getMongoCollectionSample,
    maskSensitiveValue,
    notifyIntegrityCorrupted,
    CONSOLE_COMMANDS,
    ALLOWED_MONGO_COLLECTIONS
};
