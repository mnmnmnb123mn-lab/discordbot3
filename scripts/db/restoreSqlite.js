#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { resolveDbPath, closeDatabase } = require("../../database/sqlite/connection");

function parseArgs() {
    const args = process.argv.slice(2);
    let sourceBackup = null;
    let targetDb = null;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--source" || args[i] === "-s") && args[i + 1]) {
            sourceBackup = args[i + 1];
            i++;
        } else if ((args[i] === "--target" || args[i] === "-t") && args[i + 1]) {
            targetDb = args[i + 1];
            i++;
        } else if (args[i] === "--force" || args[i] === "-f") {
            force = true;
        } else if (!sourceBackup && !args[i].startsWith("-")) {
            sourceBackup = args[i];
        }
    }
    return { sourceBackup, targetDb, force };
}

function prunePreRestoreBackups(targetPath, maxKeep = 2) {
    try {
        const targetDir = path.dirname(targetPath);
        const baseName = path.basename(targetPath);
        if (!fs.existsSync(targetDir)) return;
        const prefix = `${baseName}.pre-restore-`;
        const files = fs.readdirSync(targetDir)
            .filter(f => f.startsWith(prefix) && f.endsWith(".bak"))
            .map(f => {
                const fullPath = path.join(targetDir, f);
                const stat = fs.statSync(fullPath);
                return { fullPath, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (files.length > maxKeep) {
            for (const item of files.slice(maxKeep)) {
                try {
                    fs.unlinkSync(item.fullPath);
                    console.log(`[RESTORE-SQLITE]     Pruned old pre-restore safety backup: ${path.basename(item.fullPath)}`);
                } catch (_) {}
            }
        }
    } catch (err) {
        console.warn(`[RESTORE-SQLITE] ⚠️ Failed to prune old pre-restore backups: ${err.message}`);
    }
}

async function restoreDatabase({ sourceBackup, targetDb, force = false }) {
    console.log("[RESTORE-SQLITE] 🔄 Starting SQLite restore procedure...");

    if (!sourceBackup) {
        throw new Error("Missing required source backup path");
    }

    const sourcePath = path.resolve(sourceBackup);
    const targetPath = resolveDbPath(targetDb);

    console.log(`[RESTORE-SQLITE] 📦 Source Backup: ${sourcePath}`);
    console.log(`[RESTORE-SQLITE] 🎯 Target Path:   ${targetPath}`);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source backup file does not exist: ${sourcePath}`);
    }

    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.size === 0) {
        throw new Error(`Source backup file is empty (0 bytes): ${sourcePath}`);
    }

    // Step 1: Pre-flight integrity verification on source backup
    console.log("[RESTORE-SQLITE] 1/4 Verifying source backup integrity...");
    let sourceDb;
    try {
        sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
        const integrity = sourceDb.pragma("integrity_check");
        const ok = integrity.length === 1 && (integrity[0].integrity_check === "ok" || integrity[0] === "ok");
        if (!ok) {
            throw new Error(`Integrity check failed: ${JSON.stringify(integrity)}`);
        }
        const userVersion = sourceDb.pragma("user_version", { simple: true });
        console.log(`[RESTORE-SQLITE]     Source verified intact (PRAGMA user_version = ${userVersion}).`);
    } finally {
        if (sourceDb) {
            try { sourceDb.close(); } catch (_) {}
        }
    }

    // Step 2: Ensure connection is closed and backup existing target
    console.log("[RESTORE-SQLITE] 2/4 Securing current target database...");
    closeDatabase();

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    let rollbackBakPath = null;
    if (fs.existsSync(targetPath)) {
        rollbackBakPath = `${targetPath}.pre-restore-${Date.now()}.bak`;
        fs.copyFileSync(targetPath, rollbackBakPath);
        console.log(`[RESTORE-SQLITE]     Pre-restore safety backup created: ${rollbackBakPath}`);
        prunePreRestoreBackups(targetPath, 2);

        // Clean stale WAL and SHM files to prevent WAL corruption
        const walPath = `${targetPath}-wal`;
        const shmPath = `${targetPath}-shm`;
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    }

    // Step 3: Copy source backup to target
    console.log("[RESTORE-SQLITE] 3/4 Copying backup to target location...");
    fs.copyFileSync(sourcePath, targetPath);

    // Step 4: Post-flight integrity verification on restored target
    console.log("[RESTORE-SQLITE] 4/4 Verifying restored database integrity...");
    let targetCheckDb;
    try {
        targetCheckDb = new Database(targetPath, { readonly: true, fileMustExist: true });
        const integrity = targetCheckDb.pragma("integrity_check");
        const ok = integrity.length === 1 && (integrity[0].integrity_check === "ok" || integrity[0] === "ok");
        if (!ok) {
            throw new Error(`Target integrity check failed: ${JSON.stringify(integrity)}`);
        }
        console.log("[RESTORE-SQLITE]     Target verified intact.");
    } catch (err) {
        console.error(`[RESTORE-SQLITE] ❌ Restored target verification failed: ${err.message}`);
        if (targetCheckDb) {
            try { targetCheckDb.close(); } catch (_) {}
            targetCheckDb = null;
        }

        if (rollbackBakPath && fs.existsSync(rollbackBakPath)) {
            console.warn(`[RESTORE-SQLITE] ⚠️ Auto-rollback initiated: restoring from safety backup ${rollbackBakPath}...`);
            try {
                fs.copyFileSync(rollbackBakPath, targetPath);
                const walPath = `${targetPath}-wal`;
                const shmPath = `${targetPath}-shm`;
                if (fs.existsSync(walPath)) try { fs.unlinkSync(walPath); } catch (_) {}
                if (fs.existsSync(shmPath)) try { fs.unlinkSync(shmPath); } catch (_) {}
                console.log("[RESTORE-SQLITE] 🔄 Auto-rollback completed successfully. Original database state restored.");
            } catch (rbErr) {
                console.error(`[RESTORE-SQLITE] 🚨 Auto-rollback failed: ${rbErr.message}`);
            }
        }
        throw err;
    } finally {
        if (targetCheckDb) {
            try { targetCheckDb.close(); } catch (_) {}
        }
    }

    console.log("------------------------------------------------------------");
    console.log("[RESTORE-SQLITE] ✅ Database restored successfully!");
    console.log(`[RESTORE-SQLITE] Target: ${targetPath}`);
    console.log("------------------------------------------------------------");

    return {
        ok: true,
        sourcePath,
        targetPath,
        rollbackBakPath
    };
}

async function main() {
    const { sourceBackup, targetDb, force } = parseArgs();
    if (!sourceBackup) {
        console.error("❌ Usage: node scripts/db/restoreSqlite.js --source <backup_file.sqlite> [--target <target_db.sqlite>] [--force]");
        process.exit(1);
    }

    try {
        await restoreDatabase({ sourceBackup, targetDb, force });
    } catch (err) {
        console.error(`[RESTORE-SQLITE] ❌ Restore failed: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error("[RESTORE-SQLITE] Unhandled rejection:", err);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    prunePreRestoreBackups,
    restoreDatabase
};

