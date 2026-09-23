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

async function main() {
    console.log("[RESTORE-SQLITE] 🔄 Starting SQLite restore procedure...");
    const { sourceBackup, targetDb, force } = parseArgs();

    if (!sourceBackup) {
        console.error("❌ Usage: node scripts/db/restoreSqlite.js --source <backup_file.sqlite> [--target <target_db.sqlite>] [--force]");
        process.exit(1);
    }

    const sourcePath = path.resolve(sourceBackup);
    const targetPath = resolveDbPath(targetDb);

    console.log(`[RESTORE-SQLITE] 📦 Source Backup: ${sourcePath}`);
    console.log(`[RESTORE-SQLITE] 🎯 Target Path:   ${targetPath}`);

    if (!fs.existsSync(sourcePath)) {
        console.error(`[RESTORE-SQLITE] ❌ Source backup file does not exist: ${sourcePath}`);
        process.exit(1);
    }

    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.size === 0) {
        console.error(`[RESTORE-SQLITE] ❌ Source backup file is empty (0 bytes): ${sourcePath}`);
        process.exit(1);
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
    } catch (err) {
        console.error(`[RESTORE-SQLITE] ❌ Source backup is corrupted or invalid: ${err.message}`);
        if (sourceDb) sourceDb.close();
        process.exit(1);
    } finally {
        if (sourceDb) sourceDb.close();
    }

    // Step 2: Ensure connection is closed and backup existing target
    console.log("[RESTORE-SQLITE] 2/4 Securing current target database...");
    closeDatabase();

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    if (fs.existsSync(targetPath)) {
        const rollbackBakPath = `${targetPath}.pre-restore-${Date.now()}.bak`;
        fs.copyFileSync(targetPath, rollbackBakPath);
        console.log(`[RESTORE-SQLITE]     Pre-restore safety backup created: ${rollbackBakPath}`);

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
        if (targetCheckDb) targetCheckDb.close();
        process.exit(1);
    } finally {
        if (targetCheckDb) targetCheckDb.close();
    }

    console.log("------------------------------------------------------------");
    console.log("[RESTORE-SQLITE] ✅ Database restored successfully!");
    console.log(`[RESTORE-SQLITE] Target: ${targetPath}`);
    console.log("------------------------------------------------------------");
}

main().catch(err => {
    console.error("[RESTORE-SQLITE] Unhandled rejection:", err);
    process.exit(1);
});
