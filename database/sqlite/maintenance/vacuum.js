"use strict";

function runIncrementalVacuum(db, pages = 100) {
    if (!db) throw new TypeError("runIncrementalVacuum requires an active database");
    const autoVacuum = db.pragma("auto_vacuum", { simple: true });
    // auto_vacuum = 2 corresponds to INCREMENTAL
    if (autoVacuum === 2 || autoVacuum === "INCREMENTAL") {
        db.pragma(`incremental_vacuum(${parseInt(pages, 10) || 100})`);
        return { ok: true, pagesVacuumed: pages };
    }
    return { ok: false, reason: "auto_vacuum_not_incremental", autoVacuum };
}

function checkpointWal(db, mode = "PASSIVE") {
    if (!db) throw new TypeError("checkpointWal requires an active database");
    // Mode can be PASSIVE, FULL, RESTART, or TRUNCATE
    try {
        const result = db.pragma(`wal_checkpoint(${mode})`);
        return { ok: true, result };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    runIncrementalVacuum,
    checkpointWal
};
