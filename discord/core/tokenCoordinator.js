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
    constructor() {
        this.tokenStates = new Map(); // tokenHash -> { voice: null, quest: null, lastActivity: number }
        this.tokenLocks = new Map();  // tokenHash -> Promise (FIFO mutex queue)
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
            if (!state.quest) {
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
            if (!state.voice) {
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
     * Reset all internal states (useful for testing or full cleanup)
     */
    reset() {
        this.tokenStates.clear();
        this.tokenLocks.clear();
    }
}

// Singleton instance across the unified runtime
const tokenCoordinator = new TokenCoordinator();

module.exports = tokenCoordinator;
module.exports.TokenCoordinator = TokenCoordinator;
