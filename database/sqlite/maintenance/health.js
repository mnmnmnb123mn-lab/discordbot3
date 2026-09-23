"use strict";

const { evaluateQuota } = require("./quota");

let lastHealthCheck = null;
let errorCounter = 0;

function incrementErrorCounter() {
    errorCounter++;
}

function getHealthStatus(db, dbPath) {
    if (!db || !db.open) {
        return {
            status: "failed",
            isReady: false,
            reason: "connection_closed",
            errorCount: errorCounter,
            timestamp: Date.now()
        };
    }

    try {
        const userVersion = db.pragma("user_version", { simple: true });
        const quotaInfo = dbPath ? evaluateQuota(dbPath) : null;
        const tables = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();

        const isDegraded = quotaInfo && (quotaInfo.status === "critical" || quotaInfo.status === "hard");

        const health = {
            status: isDegraded ? "degraded" : "ready",
            isReady: true,
            schemaVersion: userVersion,
            tablesCount: tables ? tables.count : 0,
            quota: quotaInfo,
            errorCount: errorCounter,
            timestamp: Date.now()
        };

        lastHealthCheck = health;
        return health;
    } catch (err) {
        incrementErrorCounter();
        return {
            status: "failed",
            isReady: false,
            error: err.message,
            errorCount: errorCounter,
            timestamp: Date.now()
        };
    }
}

module.exports = {
    getHealthStatus,
    incrementErrorCounter
};
