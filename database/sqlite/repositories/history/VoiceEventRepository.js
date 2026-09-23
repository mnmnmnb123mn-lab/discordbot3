"use strict";

const { getDatabase } = require("../../connection");
const { resolvePriority, evictWithPriority, notifyBufferDropped } = require("./bufferPolicy");

class VoiceEventRepository {
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
        const priority = resolvePriority(event, critical);
        const item = {
            priority,
            occurredAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
            eventType: String(event.eventType || "voice_event"),
            sessionId: event.sessionId ? String(event.sessionId) : null,
            accountId: event.accountId ? String(event.accountId) : null,
            guildId: event.guildId ? String(event.guildId) : null,
            voiceId: event.voiceId ? String(event.voiceId) : null,
            detail: event.detail ? String(event.detail) : null,
            metadataJson: event.metadata ? JSON.stringify(event.metadata) : null
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
                console.warn(`[VOICE_EVENT_BUFFER] ⚠️ Queue reached capacity (${this.maxQueueCap}). Dropped ${dropCount} low-priority events.`);
                notifyBufferDropped("VoiceEventRepository", dropCount, this.maxQueueCap, this.droppedEventsCount);
            }
        }

        this.buffer.push(item);
        if (this.buffer.length >= this.flushSizeThreshold) {
            this.flush();
        }
    }

    _insertSingle(item) {
        const stmt = this.db.prepare(`
            INSERT INTO voice_events (
                occurred_at, event_type, session_id, account_id,
                guild_id, voice_id, detail, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            item.occurredAt,
            item.eventType,
            item.sessionId,
            item.accountId,
            item.guildId,
            item.voiceId,
            item.detail,
            item.metadataJson
        );
    }

    flush() {
        if (this.buffer.length === 0) return 0;
        const batchSize = Math.min(this.buffer.length, 500);
        const items = this.buffer.slice(0, batchSize);

        const stmt = this.db.prepare(`
            INSERT INTO voice_events (
                occurred_at, event_type, session_id, account_id,
                guild_id, voice_id, detail, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertTx = this.db.transaction(() => {
            for (const item of items) {
                stmt.run(
                    item.occurredAt,
                    item.eventType,
                    item.sessionId,
                    item.accountId,
                    item.guildId,
                    item.voiceId,
                    item.detail,
                    item.metadataJson
                );
            }
        });

        try {
            insertTx();
            this.buffer.splice(0, batchSize);
            return items.length;
        } catch (err) {
            this.isDegraded = true;
            console.error(`[VOICE_EVENT_BUFFER] ❌ Batch flush failed: ${err.message}`);
            return 0;
        }
    }

    findRecent(limit = 100) {
        this.flush();
        const bounded = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
        const rows = this.db.prepare(`
            SELECT * FROM voice_events
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(bounded);

        return rows.map(r => this._hydrate(r));
    }

    findBySession(sessionId, limit = 50) {
        this.flush();
        const rows = this.db.prepare(`
            SELECT * FROM voice_events
            WHERE session_id = ?
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(String(sessionId), limit);

        return rows.map(r => this._hydrate(r));
    }

    _hydrate(row) {
        let metadata = null;
        try {
            if (row.metadata_json) metadata = JSON.parse(row.metadata_json);
        } catch (_) {}

        return {
            id: row.id,
            occurredAt: new Date(row.occurred_at),
            eventType: row.event_type,
            sessionId: row.session_id,
            accountId: row.account_id,
            guildId: row.guild_id,
            voiceId: row.voice_id,
            detail: row.detail,
            metadata
        };
    }
}

let defaultVoiceEventRepo = null;
function getVoiceEventRepository() {
    if (!defaultVoiceEventRepo) {
        defaultVoiceEventRepo = new VoiceEventRepository();
    }
    return defaultVoiceEventRepo;
}

module.exports = {
    VoiceEventRepository,
    getVoiceEventRepository
};
