"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getFilesystemFreeSpace } = require("./quota");

function isPathInside(childPath, parentPath) {
    const relative = path.relative(parentPath, childPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function evaluateStoragePaths(options = {}) {
    const isProduction = (options.env || process.env.NODE_ENV) === "production";
    const repoRoot = path.resolve(process.cwd());

    const rawDbPath = options.dbPath || process.env.SQLITE_DB_PATH || path.join(repoRoot, "data", "discordbot.sqlite");
    const rawBackupDir = options.backupDir || process.env.SQLITE_BACKUP_DIR || path.join(repoRoot, "backups");
    const rawAssetDir = options.assetDir || process.env.SQLITE_ASSET_DIR || path.join(repoRoot, "data", "cache-assets");

    const resolvedDbPath = path.resolve(rawDbPath);
    const resolvedDbDir = path.dirname(resolvedDbPath);
    const resolvedBackupDir = path.resolve(rawBackupDir);
    const resolvedAssetDir = path.resolve(rawAssetDir);

    const dbInSource = isPathInside(resolvedDbPath, repoRoot);
    const backupInSource = isPathInside(resolvedBackupDir, repoRoot);
    const assetInSource = isPathInside(resolvedAssetDir, repoRoot);
    const hasInSource = dbInSource || backupInSource || assetInSource;

    const explicitDbPath = Boolean(options.dbPath || (process.env.SQLITE_DB_PATH && process.env.SQLITE_DB_PATH.trim()));
    const explicitBackupDir = Boolean(options.backupDir || (process.env.SQLITE_BACKUP_DIR && process.env.SQLITE_BACKUP_DIR.trim()));
    const explicitAssetDir = Boolean(options.assetDir || (process.env.SQLITE_ASSET_DIR && process.env.SQLITE_ASSET_DIR.trim()));
    const allowInSource = process.env.ALLOW_IN_SOURCE_STORAGE === "true";

    const missingExplicitEnvs = [];
    if (!explicitDbPath) missingExplicitEnvs.push("SQLITE_DB_PATH");
    if (!explicitBackupDir) missingExplicitEnvs.push("SQLITE_BACKUP_DIR");
    if (!explicitAssetDir) missingExplicitEnvs.push("SQLITE_ASSET_DIR");

    // Persistent storage is verified when no paths reside inside source tree and explicit external paths are configured
    const isPersistent = !hasInSource && (missingExplicitEnvs.length === 0 || !isProduction);

    const results = {
        ok: true,
        isProduction,
        isPersistent,
        allowInSource,
        missingExplicitEnvs,
        hasInSource,
        errors: [],
        warnings: [],
        pathWarning: false,
        filesystemWarning: false,
        filesystemCritical: false,
        persistentRecommended: false,
        readable: true,
        writable: true,
        paths: {
            database: { path: resolvedDbPath, dir: resolvedDbDir, inSource: dbInSource, explicit: explicitDbPath },
            backup: { path: resolvedBackupDir, inSource: backupInSource, explicit: explicitBackupDir },
            assetCache: { path: resolvedAssetDir, inSource: assetInSource, explicit: explicitAssetDir }
        },
        permissions: {},
        freeSpace: {}
    };

    const targetDirs = [
        { name: "Database Directory", dir: resolvedDbDir, key: "database" },
        { name: "Backup Directory", dir: resolvedBackupDir, key: "backup" },
        { name: "Asset Cache Directory", dir: resolvedAssetDir, key: "assetCache" }
    ];

    // 1. Path Placement & Persistence Assessment
    if (!isPersistent) {
        results.persistentRecommended = true;
        results.pathWarning = true;
        const inSourceNames = [];
        if (dbInSource) inSourceNames.push("database");
        if (backupInSource) inSourceNames.push("backup");
        if (assetInSource) inSourceNames.push("asset-cache");

        if (isProduction) {
            const missingDetails = missingExplicitEnvs.length > 0
                ? `Missing explicit external path ENV(s): [${missingExplicitEnvs.join(", ")}]. `
                : "";
            const sourceDetails = inSourceNames.length > 0
                ? `Storage path(s) [${inSourceNames.join(", ")}] reside inside source directory (${repoRoot}). `
                : "";
            const msg = `[PRODUCTION_STORAGE] ⚠️ Production storage is not using verified external persistent mount. ${missingDetails}${sourceDetails}In containerized production (Pterodactyl/Docker/VPS), data may be lost on container rebuild or redeploy unless external persistent mounts (e.g. /persistent/...) are configured or ALLOW_IN_SOURCE_STORAGE=true is explicitly set.`;
            results.warnings.push(msg);
        } else {
            const msg = `[STORAGE] ℹ️ Storage path(s) [${inSourceNames.join(", ") || "default"}] reside in local workspace. Ensure persistent volumes are mounted before deploying to production.`;
            results.warnings.push(msg);
        }
    }

    // 2. Ensure directories exist & verify Read/Write permissions (Actual Filesystem Failure -> CRITICAL)
    for (const target of targetDirs) {
        try {
            if (!fs.existsSync(target.dir)) {
                fs.mkdirSync(target.dir, { recursive: true });
            }
            fs.accessSync(target.dir, fs.constants.R_OK | fs.constants.W_OK);

            // Write probe check: create temporary file and delete
            const probeFile = path.join(target.dir, `.__perm_probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
            fs.writeFileSync(probeFile, "probe");
            fs.unlinkSync(probeFile);

            results.permissions[target.key] = { readable: true, writable: true };
        } catch (err) {
            results.readable = false;
            results.writable = false;
            results.filesystemCritical = true;
            results.permissions[target.key] = { readable: false, writable: false, error: err.message };
            results.errors.push(`[STORAGE] ❌ Filesystem write failure on ${target.name} (${target.dir}): ${err.message}`);
        }
    }

    // 3. Free Space Check (Split into Warning vs Critical)
    try {
        const space = getFilesystemFreeSpace(resolvedDbDir);
        results.freeSpace = space;

        if (space.availableMb !== null) {
            if (space.availableMb < 100) {
                // < 100MB = CRITICAL (Actual disk exhaustion risk)
                results.filesystemCritical = true;
                results.errors.push(`[STORAGE] ❌ Critically low disk space: ${space.availableMb} MB available (< 100 MB required threshold). Risk of SQLite corruption.`);
            } else if (space.availableMb < 1000) {
                // 100MB – 1,000MB = WARNING
                results.filesystemWarning = true;
                results.warnings.push(`[STORAGE] ⚠️ Low free disk space: ${space.availableMb} MB available (< 1,000 MB recommended). Consider expanding volume.`);
            }
        }
    } catch (err) {
        results.warnings.push(`[STORAGE] ⚠️ Could not evaluate free filesystem space: ${err.message}`);
    }

    // ok is true as long as there are no actual filesystem errors
    results.ok = results.errors.length === 0;
    return results;
}

module.exports = {
    evaluateStoragePaths,
    isPathInside
};
