"use strict";

const fs = require("node:fs");
const path = require("node:path");

function isPidAlive(pid) {
    if (!pid || typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function getLockFilePath(dbPath) {
    return `${path.resolve(dbPath)}.lock`;
}

function getRestoreLockFilePath(dbPath) {
    return `${path.resolve(dbPath)}.restore.lock`;
}

function isProcessLockActive(dbPath) {
    const lockPath = getLockFilePath(dbPath);
    if (!fs.existsSync(lockPath)) return { active: false };

    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid && isPidAlive(data.pid)) {
            return {
                active: true,
                pid: data.pid,
                createdAt: data.createdAt || null
            };
        }
        // Stale lock: PID is no longer alive
        try { fs.unlinkSync(lockPath); } catch (_) {}
        return { active: false, stale: true, oldPid: data.pid };
    } catch (_) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        return { active: false };
    }
}

function acquireProcessLock(dbPath) {
    const lockPath = getLockFilePath(dbPath);
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }

    const currentLock = isProcessLockActive(dbPath);
    if (currentLock.active && currentLock.pid !== process.pid) {
        return {
            acquired: false,
            pid: currentLock.pid,
            createdAt: currentLock.createdAt
        };
    }

    try {
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            createdAt: Date.now()
        }), { flag: "w" });
        return { acquired: true, pid: process.pid };
    } catch (err) {
        return { acquired: false, error: err.message };
    }
}

function releaseProcessLock(dbPath) {
    if (!dbPath) return;
    const lockPath = getLockFilePath(dbPath);
    if (!fs.existsSync(lockPath)) return;

    try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === process.pid) {
            fs.unlinkSync(lockPath);
        }
    } catch (_) {}
}

function isRestoreLockActive(dbPath) {
    const restorePath = getRestoreLockFilePath(dbPath);
    if (!fs.existsSync(restorePath)) return { active: false };

    try {
        const raw = fs.readFileSync(restorePath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid && isPidAlive(data.pid)) {
            return {
                active: true,
                pid: data.pid,
                createdAt: data.createdAt || null
            };
        }
        try { fs.unlinkSync(restorePath); } catch (_) {}
        return { active: false, stale: true };
    } catch (_) {
        try { fs.unlinkSync(restorePath); } catch (_) {}
        return { active: false };
    }
}

function acquireRestoreLock(dbPath) {
    const restorePath = getRestoreLockFilePath(dbPath);
    const lockDir = path.dirname(restorePath);
    if (!fs.existsSync(lockDir)) {
        fs.mkdirSync(lockDir, { recursive: true });
    }

    const current = isRestoreLockActive(dbPath);
    if (current.active && current.pid !== process.pid) {
        return { acquired: false, pid: current.pid };
    }

    try {
        fs.writeFileSync(restorePath, JSON.stringify({
            pid: process.pid,
            createdAt: Date.now()
        }), { flag: "w" });
        return { acquired: true, pid: process.pid };
    } catch (err) {
        return { acquired: false, error: err.message };
    }
}

function releaseRestoreLock(dbPath) {
    if (!dbPath) return;
    const restorePath = getRestoreLockFilePath(dbPath);
    if (!fs.existsSync(restorePath)) return;

    try {
        const raw = fs.readFileSync(restorePath, "utf8");
        const data = JSON.parse(raw);
        if (data.pid === process.pid) {
            fs.unlinkSync(restorePath);
        }
    } catch (_) {}
}

module.exports = {
    isPidAlive,
    getLockFilePath,
    getRestoreLockFilePath,
    isProcessLockActive,
    acquireProcessLock,
    releaseProcessLock,
    isRestoreLockActive,
    acquireRestoreLock,
    releaseRestoreLock
};
