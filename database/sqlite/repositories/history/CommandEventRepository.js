"use strict";

const { getDatabase } = require("../../connection");
const { resolvePriority, evictWithPriority, notifyBufferDropped } = require("./bufferPolicy");

const SENSITIVE_KEY_REGEX = /(token|password|pin|secret|credential|auth|bearer|cookie|salt|private|api_?key|access_?key|secret_?key|^key$)/i;

function sanitizeDetails(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 5) return obj;
    if (Array.isArray(obj)) {
        return obj.slice(0, 50).map(item => sanitizeDetails(item, depth + 1));
    }
    const clean = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_KEY_REGEX.test(key)) {
            clean[key] = "[REDACTED]";
        } else if (value && typeof value === "object") {
            clean[key] = sanitizeDetails(value, depth + 1);
        } else if (typeof value === "string" && value.length > 500) {
            clean[key] = value.slice(0, 500) + "...";
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

class CommandEventRepository {
    constructor(db = null) {
        this._db = db;
        this.buffer = [];
        this.flushInterval = null;
        this.maxQueueCap = 2000;
        this.flushSizeThreshold = 100;
        this.isDegraded = false;
        this.droppedEventsCount = 0;
        this.startFlusher();
    }

    get db() {
        return this._db || getDatabase();
    }

    startFlusher(intervalMs = 10000) {
        if (this.flushInterval) return;
        this.flushInterval = setInterval(() => {
            this.flush();
        }, intervalMs);
        if (this.flushInterval.unref) {
            this.flushInterval.unref();
        }
    }

    stopFlusher() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }
        this.flush();
    }

    getBufferStats() {
        return {
            bufferedCount: this.buffer.length,
            maxQueueCap: this.maxQueueCap,
            flushSizeThreshold: this.flushSizeThreshold,
            isDegraded: this.isDegraded,
            droppedEventsCount: this.droppedEventsCount
        };
    }

    record(event, critical = false) {
        let detailJson = null;
        if (event.details !== undefined && event.details !== null) {
            try {
                const cleaned = sanitizeDetails(event.details);
                detailJson = JSON.stringify(cleaned).slice(0, 4096);
            } catch (_) {
                detailJson = null;
            }
        }

        const priority = resolvePriority(event, critical);
        const item = {
            priority,
            occurredAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
            commandName: String(event.commandName || "unknown").slice(0, 64),
            actorId: String(event.actorId || "unknown"),
            guildId: event.guildId ? String(event.guildId) : null,
            channelId: event.channelId ? String(event.channelId) : null,
            status: String(event.status || "success"),
            durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
            detailJson
        };

        // P0: Critical Security / Corruption / Backup Failure - NEVER drop, insert immediately
        if (priority === "P0") {
            this._insertSingle(item);
            return;
        }

        // Bounded queue overflow guard with priority eviction
        if (this.buffer.length >= this.maxQueueCap) {
            const dropTarget = Math.min(500, Math.max(1, Math.floor(this.maxQueueCap / 4)));
            const dropCount = evictWithPriority(this.buffer, dropTarget);
            if (dropCount > 0) {
                this.droppedEventsCount += dropCount;
                this.isDegraded = true;
                console.warn(`[COMMAND_EVENT_BUFFER] ⚠️ Queue reached capacity (${this.maxQueueCap}). Dropped ${dropCount} low-priority events.`);
                notifyBufferDropped("CommandEventRepository", dropCount, this.maxQueueCap, this.droppedEventsCount);
            }
        }

        this.buffer.push(item);
        if (this.buffer.length >= this.flushSizeThreshold) {
            this.flush();
        }
    }

    _insertSingle(item) {
        const stmt = this.db.prepare(`
            INSERT INTO command_events (
                occurred_at, command_name, actor_id, guild_id,
                channel_id, status, duration_ms, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            item.occurredAt,
            item.commandName,
            item.actorId,
            item.guildId,
            item.channelId,
            item.status,
            item.durationMs,
            item.detailJson
        );
    }

    flush() {
        if (this.buffer.length === 0) return 0;
        const batchSize = Math.min(this.buffer.length, 500);
        const items = this.buffer.slice(0, batchSize);

        const stmt = this.db.prepare(`
            INSERT INTO command_events (
                occurred_at, command_name, actor_id, guild_id,
                channel_id, status, duration_ms, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertTx = this.db.transaction(() => {
            for (const item of items) {
                stmt.run(
                    item.occurredAt,
                    item.commandName,
                    item.actorId,
                    item.guildId,
                    item.channelId,
                    item.status,
                    item.durationMs,
                    item.detailJson
                );
            }
        });

        try {
            insertTx();
            this.buffer.splice(0, batchSize);
            return items.length;
        } catch (err) {
            this.isDegraded = true;
            console.error(`[COMMAND_EVENT_BUFFER] ❌ Batch flush failed: ${err.message}`);
            return 0;
        }
    }

    findRecent(limit = 100) {
        this.flush();
        const bounded = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
        const rows = this.db.prepare(`
            SELECT * FROM command_events
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(bounded);

        return rows.map(r => this._hydrate(r));
    }

    _hydrate(row) {
        let details = null;
        try {
            if (row.detail_json) details = JSON.parse(row.detail_json);
        } catch (_) {}

        return {
            id: row.id,
            occurredAt: new Date(row.occurred_at),
            commandName: row.command_name,
            actorId: row.actor_id,
            guildId: row.guild_id,
            channelId: row.channel_id,
            status: row.status,
            durationMs: row.duration_ms,
            details
        };
    }
}

let defaultCommandEventRepo = null;
function getCommandEventRepository() {
    if (!defaultCommandEventRepo) {
        defaultCommandEventRepo = new CommandEventRepository();
    }
    return defaultCommandEventRepo;
}

module.exports = {
    CommandEventRepository,
    getCommandEventRepository,
    sanitizeDetails
};
