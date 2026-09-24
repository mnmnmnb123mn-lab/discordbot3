"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const APP_VERSION = (() => {
    try {
        const pkg = require("../../package.json");
        return pkg.version || "5.0.0";
    } catch (_) {
        return "5.0.0";
    }
})();

function calculateChecksum(content) {
    return crypto.createHash("sha256").update(content.trim()).digest("hex");
}

function ensureMigrationTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            app_version TEXT NOT NULL
        );
    `);
}

function getAppliedMigrations(db) {
    ensureMigrationTable(db);
    const rows = db.prepare("SELECT migration_id, version, checksum, applied_at FROM schema_migrations ORDER BY version ASC").all();
    const map = new Map();
    for (const row of rows) {
        map.set(row.migration_id, row);
    }
    return map;
}

function loadMigrationFiles(migrationsDir) {
    if (!fs.existsSync(migrationsDir)) {
        return [];
    }
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith(".sql"))
        .sort();

    return files.map(file => {
        const filePath = path.join(migrationsDir, file);
        const content = fs.readFileSync(filePath, "utf8");
        const match = file.match(/^(\d+)_(.+)\.sql$/);
        const version = match ? parseInt(match[1], 10) : 0;
        return {
            migrationId: file,
            version,
            filePath,
            content,
            checksum: calculateChecksum(content)
        };
    });
}

function isDestructiveMigration(content) {
    if (!content || typeof content !== "string") return false;
    const stripped = content.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i.test(stripped);
}

function resolveBackupDir(customDir = null) {
    if (customDir) return path.resolve(customDir);
    if (process.env.SQLITE_BACKUP_DIR && process.env.SQLITE_BACKUP_DIR.trim()) {
        return path.resolve(process.env.SQLITE_BACKUP_DIR.trim());
    }
    return path.resolve(process.cwd(), "backups");
}

function createPreMigrationBackup(db, migrationItem, options = {}) {
    const isMemory = !db.name || db.name === ":memory:";
    if (isMemory && !options.backupDir) {
        return null;
    }

    const backupDir = resolveBackupDir(options.backupDir);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const cleanId = String(migrationItem.migrationId || "migration").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `sqlite_backup_pre_migration_${cleanId}_${timestamp}.sqlite`;
    const targetPath = path.join(backupDir, filename);

    // Escape single quotes for SQL string literal
    const escaped = targetPath.replace(/'/g, "''");
    try {
        db.exec(`VACUUM INTO '${escaped}'`);
    } catch (err) {
        throw new Error(`[MIGRATION] Pre-migration safety backup failed before applying destructive migration ${migrationItem.migrationId}: ${err.message}`);
    }

    return {
        migrationId: migrationItem.migrationId,
        backupPath: targetPath,
        filename,
        createdAt: timestamp
    };
}

function runMigrations(db, options = {}) {
    if (!db) {
        throw new TypeError("runMigrations requires an active database connection");
    }

    const migrationsDir = options.migrationsDir || __dirname;
    ensureMigrationTable(db);

    const appliedMap = getAppliedMigrations(db);
    const migrationFiles = loadMigrationFiles(migrationsDir);
    const results = {
        applied: [],
        verified: [],
        preMigrationBackups: [],
        currentVersion: db.pragma("user_version", { simple: true })
    };

    for (const item of migrationFiles) {
        const existing = appliedMap.get(item.migrationId);

        if (existing) {
            // Integrity validation: ensure already applied migration SQL hasn't been modified
            if (existing.checksum !== item.checksum) {
                throw new Error(
                    `[MIGRATION] ❌ Checksum mismatch in already applied migration ${item.migrationId}! ` +
                    `Recorded: ${existing.checksum}, Current: ${item.checksum}. ` +
                    `Migrations are immutable forward-only. Do not edit past migration files.`
                );
            }
            results.verified.push(item.migrationId);
            continue;
        }

        // Pre-migration safety backup guard: if migration contains destructive statements, backup first
        if (isDestructiveMigration(item.content) && !options.skipPreMigrationBackup) {
            const backupInfo = createPreMigrationBackup(db, item, options);
            if (backupInfo) {
                results.preMigrationBackups.push(backupInfo);
            }
        }

        // Apply new migration inside a strict transaction
        const applyTx = db.transaction(() => {
            db.exec(item.content);

            db.prepare(`
                INSERT INTO schema_migrations (migration_id, version, checksum, applied_at, app_version)
                VALUES (?, ?, ?, ?, ?)
            `).run(item.migrationId, item.version, item.checksum, Date.now(), APP_VERSION);
        });

        applyTx();

        // PRAGMA user_version is non-transactional in SQLite; execute only after transaction commits
        db.pragma(`user_version = ${item.version}`);

        results.applied.push(item.migrationId);
        results.currentVersion = item.version;
    }

    return results;
}

function getPendingMigrations(db, options = {}) {
    const migrationsDir = options.migrationsDir || __dirname;
    ensureMigrationTable(db);
    const appliedMap = getAppliedMigrations(db);
    const migrationFiles = loadMigrationFiles(migrationsDir);
    return migrationFiles.filter(item => !appliedMap.has(item.migrationId));
}

module.exports = {
    runMigrations,
    getAppliedMigrations,
    getPendingMigrations,
    loadMigrationFiles,
    calculateChecksum,
    isDestructiveMigration,
    createPreMigrationBackup
};
