"use strict";

const { executeSqliteAction } = require("../../services/databaseService");
const { getAssetCacheManager } = require("../cache/assetCacheManager");
const { getCurrentDbPath, resolveDbPath } = require("../connection");
const { evaluateEmergencyThresholds, canSendAlert, recordAlertSent } = require("./quota");
const { sendWebhookEvent } = require("../../../discord/core/webhooks");

let walIntervalId = null;
let cleanupIntervalId = null;
let vacuumIntervalId = null;
let backupIntervalId = null;
let emergencyIntervalId = null;

let isWalRunning = false;
let isCleanupRunning = false;
let isVacuumRunning = false;
let isBackupRunning = false;
let isEmergencyRunning = false;

const diagnostics = {
    wal: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", runCount: 0 },
    cleanup: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", runCount: 0 },
    vacuum: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", runCount: 0 },
    backup: { lastRunAt: null, lastDurationMs: 0, lastStatus: "idle", runCount: 0 },
    emergency: { lastRunAt: null, lastStatus: "idle", incidentCount: 0 }
};

function parseMinutes(envVar, defaultMinutes) {
    const val = parseInt(process.env[envVar], 10);
    return !isNaN(val) && val > 0 ? val : defaultMinutes;
}

function parseHours(envVar, defaultHours) {
    const val = parseInt(process.env[envVar], 10);
    return !isNaN(val) && val > 0 ? val : defaultHours;
}

async function runWalCheckpoint() {
    if (isWalRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ WAL Checkpoint skipped: previous checkpoint still running.");
        return;
    }
    isWalRunning = true;
    const start = Date.now();
    diagnostics.wal.lastRunAt = start;
    diagnostics.wal.lastStatus = "running";

    try {
        await executeSqliteAction("checkpoint", {}, "system_scheduler");
        diagnostics.wal.lastStatus = "success";
        diagnostics.wal.runCount++;
    } catch (err) {
        diagnostics.wal.lastStatus = "error";
        console.error(`[DB_SCHEDULER] ❌ WAL Checkpoint failed: ${err.message}`);
    } finally {
        diagnostics.wal.lastDurationMs = Date.now() - start;
        isWalRunning = false;
    }
}

async function runCleanup() {
    if (isCleanupRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ Cleanup skipped: previous cleanup still running.");
        return;
    }
    isCleanupRunning = true;
    const start = Date.now();
    diagnostics.cleanup.lastRunAt = start;
    diagnostics.cleanup.lastStatus = "running";

    try {
        // 1. Cleanup database expired records (nonces, history)
        await executeSqliteAction("cleanup_all", {}, "system_scheduler");

        // 2. Reconcile asset cache & enforce 500MB quota
        try {
            const assetMgr = getAssetCacheManager();
            assetMgr.evictIfOverQuota();
            assetMgr.reconcileOrphans();
        } catch (_) {}

        diagnostics.cleanup.lastStatus = "success";
        diagnostics.cleanup.runCount++;
    } catch (err) {
        diagnostics.cleanup.lastStatus = "error";
        console.error(`[DB_SCHEDULER] ❌ Maintenance cleanup failed: ${err.message}`);
    } finally {
        diagnostics.cleanup.lastDurationMs = Date.now() - start;
        isCleanupRunning = false;
    }
}

async function runVacuum() {
    if (isVacuumRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ Incremental Vacuum skipped: previous vacuum still running.");
        return;
    }
    isVacuumRunning = true;
    const start = Date.now();
    diagnostics.vacuum.lastRunAt = start;
    diagnostics.vacuum.lastStatus = "running";

    try {
        await executeSqliteAction("vacuum", {}, "system_scheduler");
        diagnostics.vacuum.lastStatus = "success";
        diagnostics.vacuum.runCount++;
    } catch (err) {
        diagnostics.vacuum.lastStatus = "error";
        console.error(`[DB_SCHEDULER] ❌ Incremental Vacuum failed: ${err.message}`);
    } finally {
        diagnostics.vacuum.lastDurationMs = Date.now() - start;
        isVacuumRunning = false;
    }
}

async function runAutoBackup() {
    if (isBackupRunning) {
        console.warn("[DB_SCHEDULER] ⚠️ Auto-backup skipped: previous backup still running.");
        return;
    }
    isBackupRunning = true;
    const start = Date.now();
    diagnostics.backup.lastRunAt = start;
    diagnostics.backup.lastStatus = "running";

    try {
        const retention = parseInt(process.env.SQLITE_BACKUP_RETENTION, 10) || 2;
        const res = await executeSqliteAction("backup", { retention }, "system_scheduler");
        if (res && res.ok) {
            diagnostics.backup.lastStatus = "success";
            diagnostics.backup.runCount++;
            console.log(`[DB_SCHEDULER] 💾 Automated 24h backup completed successfully: ${res.backup?.filename || "ok"} (retention: ${retention})`);

            try {
                sendWebhookEvent({
                    target: "ALERT",
                    severity: "SUCCESS",
                    category: "DATA",
                    code: "sqlite.backup.success",
                    title: "💾 สำรองข้อมูล SQLite ประจำวันสำเร็จ",
                    description: "การสำรองข้อมูลอัตโนมัติประจำ 24 ชั่วโมงเสร็จสิ้นสมบูรณ์และถูกจัดเก็บไว้บน Local Persistent Storage อย่างปลอดภัย",
                    context: {
                        "ชื่อไฟล์": res.backup?.filename || "unknown",
                        "ขนาดไฟล์": `${res.backup?.sizeMb || 0} MB`,
                        "SHA-256": res.backup?.sha256 || "N/A",
                        "ระยะเวลาสำรอง": `${res.backup?.durationMs || (Date.now() - start)} ms`,
                        "นโยบาย Retention": `เก็บ ${retention} ชุดล่าสุด`,
                        "พื้นที่จัดเก็บ": "Local Persistent Storage (/persistent/backups/)"
                    }
                }).catch(() => {});
            } catch (_) {}
        } else {
            diagnostics.backup.lastStatus = "error";
            const errDetail = res?.message || res?.error || "unknown error";
            console.error(`[DB_SCHEDULER] ⚠️ Automated backup failed: ${errDetail}`);

            try {
                sendWebhookEvent({
                    target: "ALERT",
                    severity: "CRITICAL",
                    category: "DATA",
                    code: "sqlite.backup.failure",
                    title: "🚨 การสำรองข้อมูล SQLite ประจำวันล้มเหลว",
                    description: `ระบบไม่สามารถสร้าง Snapshot สำรองข้อมูล SQLite ประจำวันได้: ${errDetail}`,
                    context: {
                        "สาเหตุ": errDetail,
                        "เวลาที่เกิด": new Date().toISOString()
                    }
                }).catch(() => {});
            } catch (_) {}
        }
    } catch (err) {
        diagnostics.backup.lastStatus = "error";
        console.error(`[DB_SCHEDULER] ❌ Automated backup exception: ${err.message}`);

        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "CRITICAL",
                category: "DATA",
                code: "sqlite.backup.exception",
                title: "🚨 เกิดข้อผิดพลาดร้ายแรงขณะสำรองข้อมูล SQLite",
                description: `เกิด Exception ระหว่างสร้าง Snapshot สำรองข้อมูล: ${err.message}`,
                context: {
                    "ข้อความ Exception": err.message,
                    "เวลาที่เกิด": new Date().toISOString()
                }
            }).catch(() => {});
        } catch (_) {}
    } finally {
        diagnostics.backup.lastDurationMs = Date.now() - start;
        isBackupRunning = false;
    }
}

async function runEmergencyEvaluation() {
    if (isEmergencyRunning) return;
    isEmergencyRunning = true;
    const start = Date.now();
    diagnostics.emergency.lastRunAt = start;

    try {
        const dbPath = getCurrentDbPath() || resolveDbPath();

        // Check quick integrity during periodic emergency evaluation
        try {
            const { getDatabase } = require("../connection");
            const db = getDatabase();
            if (db && db.open) {
                const quickRows = db.pragma("quick_check(1)");
                const quickOk = quickRows.length === 1 && (quickRows[0].quick_check === "ok" || quickRows[0] === "ok");
                if (!quickOk && canSendAlert("sqlite_integrity_corrupted")) {
                    recordAlertSent("sqlite_integrity_corrupted");
                    sendWebhookEvent({
                        target: "ALERT",
                        severity: "CRITICAL",
                        category: "DATA",
                        code: "sqlite.integrity.corrupted",
                        title: "🚨 ตรวจพบความเสียหายในไฟล์ฐานข้อมูล SQLite (Integrity Corrupted)",
                        description: "ระบบ Background Scheduler ตรวจพบความผิดปกติของโครงสร้างไฟล์ฐานข้อมูล SQLite ระหว่างการตรวจสอบประจำรอบ",
                        context: {
                            "ผลการตรวจสอบ": JSON.stringify(quickRows),
                            "ไฟล์ฐานข้อมูล": dbPath,
                            "เวลาที่เกิด": new Date().toISOString()
                        }
                    }).catch(() => {});
                }
            }
        } catch (_) {}

        // Aggregate write buffer counts from history repositories
        let totalBufferCount = 0;
        try {
            const { getVoiceEventRepository } = require("../repositories/history/VoiceEventRepository");
            const { getCommandEventRepository } = require("../repositories/history/CommandEventRepository");
            const { getSessionEventRepository } = require("../repositories/history/SessionEventRepository");
            const vBuf = getVoiceEventRepository()?.getBufferStats()?.bufferedCount || 0;
            const cBuf = getCommandEventRepository()?.getBufferStats()?.bufferedCount || 0;
            const sBuf = getSessionEventRepository()?.getBufferStats()?.bufferedCount || 0;
            totalBufferCount = vBuf + cBuf + sBuf;
        } catch (_) {}

        const evalResult = evaluateEmergencyThresholds(dbPath, { writeBufferCount: totalBufferCount });

        if (evalResult.isEmergency) {
            diagnostics.emergency.incidentCount++;
            diagnostics.emergency.lastStatus = "critical";

            const eventKey = "sqlite_emergency_storage";
            const alertAllowed = canSendAlert(eventKey);

            if (alertAllowed) {
                recordAlertSent(eventKey);
                try {
                    sendWebhookEvent({
                        target: "ALERT",
                        severity: "CRITICAL",
                        category: "DATA",
                        code: "sqlite.emergency.critical",
                        title: "🚨 ตรวจพบภาวะวิกฤตระบบฐานข้อมูล SQLite",
                        description: `ระบบตรวจพบเงื่อนไขวิกฤต กำลังเริ่ม Emergency Auto-Trim อัตโนมัติ:\n${evalResult.reasons.map(r => `• ${r}`).join("\n")}`,
                        context: {
                            "ขนาด Footprint": `${evalResult.quota.footprint.totalMb} MB`,
                            "เพดานวิกฤต": `${evalResult.quota.limits.critMb} MB`,
                            "ขนาดไฟล์ WAL": `${evalResult.walMb} MB`,
                            "สถานะระบบ": evalResult.quota.status.toUpperCase()
                        }
                    }).catch(() => {});
                } catch (_) {}
            }

            // Execute Emergency Auto-Trim
            const trimResult = await executeSqliteAction("emergency_trim", {
                reason: evalResult.reasons.join("; ")
            }, "system_auto_emergency");

            if (trimResult && trimResult.ok && trimResult.trimResult?.isResolved) {
                diagnostics.emergency.lastStatus = "resolved";
                // Send RESOLVED Webhook alert
                try {
                    sendWebhookEvent({
                        target: "ALERT",
                        severity: "SUCCESS",
                        category: "DATA",
                        code: "sqlite.emergency.resolved",
                        title: "🟢 ระบบฐานข้อมูล SQLite คืนสู่สภาวะปกติแล้ว",
                        description: "Emergency Auto-Trim ดำเนินการสำเร็จ และระดับพื้นที่จัดเก็บกลับเข้าสู่เกณฑ์ปลอดภัยแล้ว",
                        context: {
                            "สาเหตุที่เกิด": evalResult.reasons[0] || "Storage critical",
                            "พื้นที่ที่คืนได้": `${trimResult.trimResult.freedMb} MB`,
                            "จำนวนรายการที่ลบ": `${trimResult.trimResult.itemsPurged?.totalItems || 0} รายการ`,
                            "ขนาดก่อน ➔ หลัง": `${trimResult.trimResult.preFootprint?.totalMb} MB ➔ ${trimResult.trimResult.postFootprint?.totalMb} MB`,
                            "ระยะเวลาดำเนินการ": `${trimResult.trimResult.durationMs} ms`
                        }
                    }).catch(() => {});
                } catch (_) {}
            }
        } else {
            diagnostics.emergency.lastStatus = "normal";
        }
    } catch (err) {
        console.error(`[DB_SCHEDULER] ⚠️ Emergency evaluation error: ${err.message}`);
    } finally {
        isEmergencyRunning = false;
    }
}

function startScheduler() {
    if (walIntervalId || cleanupIntervalId || vacuumIntervalId || backupIntervalId || emergencyIntervalId) {
        return; // Already running
    }

    const walMinutes = parseMinutes("SQLITE_WAL_CHECKPOINT_INTERVAL_MINUTES", 60);
    const cleanupMinutes = parseMinutes("SQLITE_CLEANUP_INTERVAL_MINUTES", 360);
    const vacuumMinutes = parseMinutes("SQLITE_VACUUM_INTERVAL_MINUTES", 1440);
    const autoBackupEnabled = process.env.SQLITE_AUTO_BACKUP_ENABLED !== "false";
    const backupHours = parseHours("SQLITE_AUTO_BACKUP_INTERVAL_HOURS", 24);

    walIntervalId = setInterval(runWalCheckpoint, walMinutes * 60 * 1000);
    if (walIntervalId.unref) walIntervalId.unref();

    cleanupIntervalId = setInterval(runCleanup, cleanupMinutes * 60 * 1000);
    if (cleanupIntervalId.unref) cleanupIntervalId.unref();

    vacuumIntervalId = setInterval(runVacuum, vacuumMinutes * 60 * 1000);
    if (vacuumIntervalId.unref) vacuumIntervalId.unref();

    if (autoBackupEnabled) {
        backupIntervalId = setInterval(runAutoBackup, backupHours * 60 * 60 * 1000);
        if (backupIntervalId.unref) backupIntervalId.unref();
    }

    emergencyIntervalId = setInterval(runEmergencyEvaluation, 2 * 60 * 1000);
    if (emergencyIntervalId.unref) emergencyIntervalId.unref();

    console.log(`[DB_SCHEDULER] 🕒 Background Maintenance Scheduler started (WAL=${walMinutes}m, Cleanup=${cleanupMinutes}m, Vacuum=${vacuumMinutes}m, EmergencyCheck=2m, AutoBackup=${autoBackupEnabled ? `${backupHours}h` : "disabled"})`);
}

function stopScheduler() {
    if (walIntervalId) {
        clearInterval(walIntervalId);
        walIntervalId = null;
    }
    if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId);
        cleanupIntervalId = null;
    }
    if (vacuumIntervalId) {
        clearInterval(vacuumIntervalId);
        vacuumIntervalId = null;
    }
    if (backupIntervalId) {
        clearInterval(backupIntervalId);
        backupIntervalId = null;
    }
    if (emergencyIntervalId) {
        clearInterval(emergencyIntervalId);
        emergencyIntervalId = null;
    }
    console.log("[DB_SCHEDULER] 🛑 Background Maintenance Scheduler stopped.");
}

function getSchedulerDiagnostics() {
    return {
        active: Boolean(walIntervalId || cleanupIntervalId || vacuumIntervalId || backupIntervalId || emergencyIntervalId),
        timers: {
            wal: Boolean(walIntervalId),
            cleanup: Boolean(cleanupIntervalId),
            vacuum: Boolean(vacuumIntervalId),
            backup: Boolean(backupIntervalId),
            emergency: Boolean(emergencyIntervalId)
        },
        diagnostics
    };
}

module.exports = {
    startScheduler,
    stopScheduler,
    runWalCheckpoint,
    runCleanup,
    runVacuum,
    runAutoBackup,
    runEmergencyEvaluation,
    getSchedulerDiagnostics
};
