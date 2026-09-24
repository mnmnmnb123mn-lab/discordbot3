"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { applyPragmas } = require("./pragmas");
const {
    acquireProcessLock,
    releaseProcessLock,
    isRestoreLockActive
} = require("./maintenance/processLock");

let activeDb = null;
let currentDbPath = null;

function resolveDbPath(customPath = null) {
    if (customPath) {
        return path.resolve(customPath);
    }
    if (process.env.SQLITE_DB_PATH && process.env.SQLITE_DB_PATH.trim()) {
        return path.resolve(process.env.SQLITE_DB_PATH.trim());
    }
    // Fallback: dedicated data directory in workspace root (avoiding source code collisions)
    return path.resolve(process.cwd(), "data", "discordbot.sqlite");
}

function openDatabase(options = {}) {
    if (activeDb) {
        return activeDb;
    }

    const dbPath = resolveDbPath(options.path);
    const restoreLock = isRestoreLockActive(dbPath);
    if (restoreLock.active && restoreLock.pid !== process.pid) {
        throw new Error(`[SQLITE] ❌ Database is currently locked for maintenance/restore by PID ${restoreLock.pid}`);
    }

    const parentDir = path.dirname(dbPath);

    // Ensure parent directory exists and is writable
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    try {
        fs.accessSync(parentDir, fs.constants.R_OK | fs.constants.W_OK);
        if (fs.existsSync(dbPath)) {
            fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
        }
    } catch (err) {
        throw new Error(`[SQLITE] ❌ Database target or parent directory is not readable/writable: ${parentDir} (${err.message})`);
    }

    const isNew = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;

    const db = new Database(dbPath, {
        fileMustExist: options.fileMustExist || false,
        timeout: options.timeout || 5000,
        verbose: options.verbose || null
    });

    applyPragmas(db, { isNew });

    activeDb = db;
    currentDbPath = dbPath;
    acquireProcessLock(dbPath);

    return activeDb;
}

function getDatabase() {
    if (!activeDb) {
        return openDatabase();
    }
    return activeDb;
}

function closeDatabase() {
    if (activeDb) {
        try {
            // WAL checkpoint truncate on clean shutdown
            try {
                activeDb.pragma("wal_checkpoint(TRUNCATE)");
            } catch (_) {}
            try {
                activeDb.close();
            } catch (err) {
                console.warn(`[SQLITE] ⚠️ Error closing active database: ${err.message}`);
            }
        } finally {
            if (currentDbPath) {
                releaseProcessLock(currentDbPath);
            }
            activeDb = null;
            currentDbPath = null;
        }
    }
}

function isDatabaseOpen() {
    return Boolean(activeDb && activeDb.open);
}

function getCurrentDbPath() {
    return currentDbPath;
}

module.exports = {
    openDatabase,
    getDatabase,
    closeDatabase,
    isDatabaseOpen,
    getCurrentDbPath,
    resolveDbPath
};
