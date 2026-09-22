'use strict';

const crypto = require('node:crypto');

/**
 * TokenCoordinator
 *
 * Central coordinator managing token lifecycle, cross-subsystem activity,
 * rate limit safety, and conflict prevention between:
 * 1. 24/7 Voice Channel Sessions (voiceWorker)
 * 2. Scheduled & Automated Discord Quests (questRunner)
 * 3. Token checking and validation workflows
 */
class TokenCoordinator {
    constructor(options = {}) {
        this.tokenStates = new Map(); // tokenHash -> { voice: null, quest: null, quarantine: null, rateLimiter: { tokens, lastRefill }, lastActivity: number }
        this.tokenLocks = new Map();  // tokenHash -> Promise (FIFO mutex queue)
        this.subsystems = new Map();  // name -> { onTokenQuarantined, onTokenActive }
        this.profileCache = new Map(); // tokenHash -> { profile, cachedAt, expiresAt }
        this.rateLimitConfig = {
            capacity: Number.isFinite(options.capacity) ? options.capacity : 4,
            refillRatePerSec: Number.isFinite(options.refillRatePerSec) ? options.refillRatePerSec : 2
        };
        this.startTime = Date.now();
    }

    /**
     * Compute SHA-256 hash of a token
     * @param {string} token
     * @returns {string}
     */
    hashToken(token) {
        if (!token) return '';
        if (typeof token === 'string' && token.length === 64 && /^[0-9a-f]{64}$/i.test(token)) {
            return token.toLowerCase(); // Already a hash
        }
        return crypto.createHash('sha256').update(String(token)).digest('hex');
    }

    _getOrCreateState(tokenHash) {
        let state = this.tokenStates.get(tokenHash);
        if (!state) {
            state = {
                voice: null,
                quest: null,
                quarantine: null,
                rateLimiter: {
                    tokens: this.rateLimitConfig.capacity,
                    lastRefill: Date.now()
                },
                lastActivity: Date.now()
            };
            this.tokenStates.set(tokenHash, state);
        }
        return state;
    }

    /**
     * Register that a token is actively connected to a Discord voice channel
     * @param {string} token
     * @param {{ guildId: string, channelId: string, sessionId?: string, client?: any }} details
     */
    registerVoiceActivity(token, details) {
        const hash = this.hashToken(token);
        if (!hash) return;

        const state = this._getOrCreateState(hash);
        state.voice = {
            guildId: String(details?.guildId || ''),
            channelId: String(details?.channelId || ''),
            sessionId: String(details?.sessionId || ''),
            activeAt: Date.now()
        };
        state.lastActivity = Date.now();
    }

    /**
     * Unregister voice activity for a token (e.g. when session stops)
     * @param {string} token
     */
    unregisterVoiceActivity(token) {
        const hash = this.hashToken(token);
        if (!hash) return;

        const state = this.tokenStates.get(hash);
        if (state) {
            state.voice = null;
            state.lastActivity = Date.now();
            if (!state.quest && !state.quarantine) {
                this.tokenStates.delete(hash);
            }
        }
    }

    /**
     * Check if a token currently has an active voice connection
     * @param {string} token
     * @returns {boolean}
     */
    isVoiceActive(token) {
        const hash = this.hashToken(token);
        const state = this.tokenStates.get(hash);
        return Boolean(state?.voice?.guildId && state?.voice?.channelId);
    }

    /**
     * Get active voice details for a token
     * @param {string} token
     * @returns {{ guildId: string, channelId: string, sessionId: string, activeAt: number } | null}
     */
    getVoiceActivity(token) {
        const hash = this.hashToken(token);
        return this.tokenStates.get(hash)?.voice || null;
    }

    /**
     * Notify that quest execution has started on a token
     * @param {string} token
     * @param {object} [metadata]
     */
    notifyQuestStart(token, metadata = {}) {
        const hash = this.hashToken(token);
        if (!hash) return;

        const state = this._getOrCreateState(hash);
        state.quest = {
            startedAt: Date.now(),
            questId: metadata?.questId || null,
            mode: metadata?.mode || 'scheduled'
        };
        state.lastActivity = Date.now();
    }

    /**
     * Notify that quest execution has completed on a token
     * @param {string} token
     */
    notifyQuestEnd(token) {
        const hash = this.hashToken(token);
        if (!hash) return;

        const state = this.tokenStates.get(hash);
        if (state) {
            state.quest = null;
            state.lastActivity = Date.now();
            if (!state.voice && !state.quarantine) {
                this.tokenStates.delete(hash);
            }
        }
    }

    /**
     * Check if a quest is currently running for a token
     * @param {string} token
     * @returns {boolean}
     */
    isQuestActive(token) {
        const hash = this.hashToken(token);
        return Boolean(this.tokenStates.get(hash)?.quest);
    }

    /**
     * Check if voice health check should apply grace debounce
     * (e.g. while quest is actively dispatching heartbeats)
     * @param {string} token
     * @returns {boolean}
     */
    shouldDebounceVoiceHealthCheck(token) {
        return this.isQuestActive(token);
    }

    /**
     * Generate safe Heartbeat body for Quest execution.
     * Prevents Discord from interpreting heartbeat as a 1-to-1 Call Stream,
     * which causes Discord to disconnect the account from Guild Voice!
     *
     * @param {string} token
     * @param {object} quest
     * @param {boolean} terminal
     * @returns {object} Payload to send to POST /quests/{id}/heartbeat
     */
    getSafeQuestHeartbeatPayload(token, quest, terminal = false) {
        // Priority 1: Application ID heartbeat (safest, never touches voice state)
        if (quest?.applicationId) {
            return { application_id: quest.applicationId, terminal };
        }

        // Priority 2: Check if account is in guild voice
        const voice = this.getVoiceActivity(token);
        if (voice?.guildId && voice?.channelId) {
            // Send stream_key anchored to the current guild voice channel instead of private call:
            // Discord accepts guild stream keys without ejecting the user from voice!
            return {
                stream_key: `guild:${voice.guildId}:${voice.channelId}`,
                terminal
            };
        }

        // Priority 3: Fallback for accounts not in guild voice
        return {
            stream_key: `call:${quest?.id || 'default'}:1`,
            terminal
        };
    }

    /**
     * Run an operation with token-level serialized mutual exclusion
     * to prevent rate limits and conflicting concurrent requests.
     * @param {string} token
     * @param {() => Promise<any>} operation
     * @returns {Promise<any>}
     */
    async withTokenLock(token, operation) {
        const hash = this.hashToken(token);
        if (!hash) return operation();

        const previous = this.tokenLocks.get(hash) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const queued = previous.then(() => gate);
        this.tokenLocks.set(hash, queued);

        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.tokenLocks.get(hash) === queued) {
                this.tokenLocks.delete(hash);
            }
        }
    }

    /**
     * Register a subsystem with the coordinator to receive lifecycle events
     * @param {{ name: string, onTokenQuarantined?: (tokenHash: string, reason: string, state: object) => void, onTokenActive?: (tokenHash: string, state: object) => void }} config
     */
    registerSubsystem(config) {
        if (!config?.name || typeof config.name !== 'string') {
            throw new TypeError('registerSubsystem requires a valid string name');
        }
        this.subsystems.set(config.name, {
            onTokenQuarantined: typeof config.onTokenQuarantined === 'function' ? config.onTokenQuarantined : null,
            onTokenActive: typeof config.onTokenActive === 'function' ? config.onTokenActive : null
        });
    }

    /**
     * Unregister a subsystem
     * @param {string} name
     * @returns {boolean}
     */
    unregisterSubsystem(name) {
        if (!name) return false;
        return this.subsystems.delete(String(name));
    }

    /**
     * Acquire a rate limit slot for a token using adaptive leaky bucket
     * @param {string} tokenHash
     * @param {{ maxWaitMs?: number }} [options]
     */
    async _acquireRateLimitSlot(tokenHash, options = {}) {
        if (!tokenHash) return;
        const maxWaitMs = options.maxWaitMs ?? 15000;
        const state = this._getOrCreateState(tokenHash);
        const limiter = state.rateLimiter;
        const now = Date.now();

        // Refill tokens
        const elapsedSec = (now - limiter.lastRefill) / 1000;
        limiter.tokens = Math.min(
            this.rateLimitConfig.capacity,
            limiter.tokens + (elapsedSec * this.rateLimitConfig.refillRatePerSec)
        );
        limiter.lastRefill = now;

        if (limiter.tokens >= 1) {
            limiter.tokens -= 1;
            return;
        }

        // Calculate needed wait time to refill 1 token
        const needed = 1 - limiter.tokens;
        const waitMs = Math.ceil((needed / this.rateLimitConfig.refillRatePerSec) * 1000);
        if (waitMs > maxWaitMs) {
            const err = new Error(`RATE_LIMIT_TIMEOUT: Token rate limit capacity exhausted (wait ${waitMs}ms > max ${maxWaitMs}ms)`);
            err.code = 'RATE_LIMIT_TIMEOUT';
            throw err;
        }

        // Micro-jitter to prevent thundering herd
        const jitter = Math.floor(Math.random() * 8) + 2;
        await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));

        limiter.tokens = Math.max(0, limiter.tokens - 1);
        limiter.lastRefill = Date.now();
    }

    /**
     * Execute an operation safely with token rate limiting, quarantine guard,
     * and automatic 401 detection.
     *
     * @param {string} token
     * @param {string} subsystem
     * @param {() => Promise<any>} operation
     * @param {{ maxWaitMs?: number }} [options]
     * @returns {Promise<any>}
     */
    async executeWithToken(token, subsystem, operation, options = {}) {
        if (typeof operation !== 'function') {
            throw new TypeError('executeWithToken requires operation to be a function');
        }
        const hash = this.hashToken(token);
        if (!hash) {
            return operation();
        }

        if (this.isQuarantined(hash)) {
            const details = this.getQuarantineDetails(hash);
            const err = new Error(`TOKEN_QUARANTINED: Token is quarantined (${details?.reason || 'Invalid/Revoked'})`);
            err.code = 'TOKEN_QUARANTINED';
            err.quarantine = details;
            throw err;
        }

        await this._acquireRateLimitSlot(hash, options);

        try {
            const result = await operation();
            const state = this._getOrCreateState(hash);
            state.lastActivity = Date.now();
            return result;
        } catch (err) {
            const status = err?.status || err?.statusCode || err?.response?.status;
            const msg = String(err?.message || '');
            const is401 = status === 401 ||
                msg.includes('401') ||
                msg.toLowerCase().includes('unauthorized') ||
                msg.toLowerCase().includes('invalid token') ||
                err?.code === 'TOKEN_INVALID';

            if (is401) {
                this.quarantineToken(hash, `Detected by ${subsystem || 'unknown'}: ${msg || '401 Unauthorized'}`);
            }
            throw err;
        }
    }

    /**
     * Quarantine a token across the entire system
     * @param {string} token
     * @param {string} [reason]
     * @returns {boolean}
     */
    quarantineToken(token, reason = 'Token Invalid or Revoked') {
        const hash = this.hashToken(token);
        if (!hash) return false;

        const state = this._getOrCreateState(hash);
        const now = Date.now();
        state.quarantine = {
            quarantinedAt: now,
            reason: String(reason)
        };
        state.lastActivity = now;

        // Invalidate cached profile
        this.profileCache.delete(hash);

        // Notify registered subsystems to gracefully clean up
        for (const [subName, sub] of this.subsystems.entries()) {
            if (typeof sub?.onTokenQuarantined === 'function') {
                try {
                    sub.onTokenQuarantined(hash, reason, state);
                } catch {
                    // Safe swallow to avoid cascade
                }
            }
        }

        // Send unified webhook notification if webhooks module is accessible
        try {
            const { sendAlertWebhook, WEBHOOK_SEVERITIES } = require('./webhooks');
            if (typeof sendAlertWebhook === 'function') {
                sendAlertWebhook({
                    title: '🚨 Token Quarantined (โทเคนถูกกักกัน)',
                    description: `ตรวจพบโทเคนหมดอายุหรือไม่ถูกต้อง ระบบได้ทำการกักกัน (Quarantine) และหยุดการทำงานของเซสชันที่เกี่ยวข้องอย่างปลอดภัย\n\n**Token Hash:** \`${hash.slice(0, 16)}...\`\n**เหตุผล:** ${reason}`,
                    severity: WEBHOOK_SEVERITIES?.ERROR || 'ERROR',
                    category: 'SECURITY'
                }).catch(() => {});
            }
        } catch {
            // Webhooks module not available in isolated unit tests
        }

        return true;
    }

    /**
     * Release a token from quarantine
     * @param {string} token
     * @returns {boolean}
     */
    releaseQuarantine(token) {
        const hash = this.hashToken(token);
        if (!hash) return false;

        const state = this.tokenStates.get(hash);
        if (state) {
            state.quarantine = null;
            state.lastActivity = Date.now();
            if (!state.voice && !state.quest) {
                this.tokenStates.delete(hash);
            }
            return true;
        }
        return false;
    }

    /**
     * Check if a token is currently quarantined
     * @param {string} token
     * @returns {boolean}
     */
    isQuarantined(token) {
        const hash = this.hashToken(token);
        return Boolean(this.tokenStates.get(hash)?.quarantine);
    }

    /**
     * Get details of quarantine for a token
     * @param {string} token
     * @returns {{ quarantinedAt: number, reason: string } | null}
     */
    getQuarantineDetails(token) {
        const hash = this.hashToken(token);
        return this.tokenStates.get(hash)?.quarantine || null;
    }

    /**
     * Cache a token profile in memory with a TTL
     * @param {string} token
     * @param {object} profile
     * @param {number} [ttlMs] Default: 20 minutes
     */
    cacheTokenProfile(token, profile, ttlMs = 20 * 60 * 1000) {
        const hash = this.hashToken(token);
        if (!hash || !profile) return;

        // Bounded pruning if cache grows over 2000 entries
        if (this.profileCache.size > 2000) {
            const now = Date.now();
            for (const [k, v] of this.profileCache.entries()) {
                if (v.expiresAt <= now) {
                    this.profileCache.delete(k);
                }
            }
        }

        this.profileCache.set(hash, {
            profile,
            cachedAt: Date.now(),
            expiresAt: Date.now() + ttlMs
        });
    }

    /**
     * Get cached token profile if present and not expired
     * @param {string} token
     * @returns {object | null}
     */
    getCachedTokenProfile(token) {
        const hash = this.hashToken(token);
        if (!hash) return null;

        const entry = this.profileCache.get(hash);
        if (!entry) return null;

        if (entry.expiresAt <= Date.now()) {
            this.profileCache.delete(hash);
            return null;
        }

        return entry.profile;
    }

    /**
     * Clear token profile cache (single token or all)
     * @param {string} [token]
     */
    clearTokenProfileCache(token = null) {
        if (token) {
            this.profileCache.delete(this.hashToken(token));
        } else {
            this.profileCache.clear();
        }
    }

    /**
     * Get status summary for monitoring and Owner Dashboard API
     * @returns {object}
     */
    getStatusSummary() {
        const states = Array.from(this.tokenStates.entries());
        const voiceSessions = states.filter(([_, s]) => Boolean(s.voice)).map(([hash, s]) => ({
            tokenHash: hash,
            guildId: s.voice.guildId,
            channelId: s.voice.channelId,
            sessionId: s.voice.sessionId,
            activeAt: s.voice.activeAt
        }));

        const questSessions = states.filter(([_, s]) => Boolean(s.quest)).map(([hash, s]) => ({
            tokenHash: hash,
            questId: s.quest.questId,
            mode: s.quest.mode,
            startedAt: s.quest.startedAt
        }));

        const quarantinedTokens = states.filter(([_, s]) => Boolean(s.quarantine)).map(([hash, s]) => ({
            tokenHash: hash,
            reason: s.quarantine.reason,
            quarantinedAt: s.quarantine.quarantinedAt
        }));

        return {
            activeTokens: this.tokenStates.size,
            voiceSessionsCount: voiceSessions.length,
            voiceSessions,
            questSessionsCount: questSessions.length,
            questSessions,
            quarantinedCount: quarantinedTokens.length,
            quarantinedTokens,
            cachedProfilesCount: this.profileCache.size,
            registeredSubsystems: Array.from(this.subsystems.keys()),
            uptimeMs: Date.now() - this.startTime
        };
    }

    /**
     * Reset all internal states (useful for testing or full cleanup)
     */
    reset() {
        this.tokenStates.clear();
        this.tokenLocks.clear();
        this.subsystems.clear();
        this.profileCache.clear();
    }
}

// Singleton instance across the unified runtime
const tokenCoordinator = new TokenCoordinator();

module.exports = tokenCoordinator;
module.exports.TokenCoordinator = TokenCoordinator;
