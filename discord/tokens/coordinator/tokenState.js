'use strict';

const crypto = require('node:crypto');

/**
 * Compute SHA-256 hash of a token
 * @param {string} token
 * @returns {string}
 */
function hashToken(token) {
    if (!token) return '';
    if (typeof token === 'string' && token.length === 64 && /^[0-9a-f]{64}$/i.test(token)) {
        return token.toLowerCase(); // Already a hash
    }
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Create a new token state record
 * @param {number} capacity
 * @returns {object}
 */
function createTokenState(capacity = 4) {
    return {
        tokenType: 'unknown',
        voice: null,
        voiceSessions: new Map(),
        quest: null,
        activities: new Map(),
        quarantine: null,
        backoffUntil: 0,
        rateLimiter: {
            tokens: capacity,
            lastRefill: Date.now(),
            queue: [],
            pumpTimer: null
        },
        lastActivity: Date.now()
    };
}

/**
 * Get or create state for a tokenHash in the states map
 * @param {Map} tokenStates
 * @param {string} tokenHash
 * @param {number} capacity
 * @returns {object}
 */
function getOrCreateTokenState(tokenStates, tokenHash, capacity = 4) {
    let state = tokenStates.get(tokenHash);
    if (!state) {
        state = createTokenState(capacity);
        tokenStates.set(tokenHash, state);
    } else {
        if (!state.activities) state.activities = new Map();
        if (!state.voiceSessions) state.voiceSessions = new Map();
        if (state.rateLimiter && !state.rateLimiter.queue) state.rateLimiter.queue = [];
    }
    return state;
}

/**
 * Set token type ('user' | 'bot' | 'unknown')
 * @param {Map} tokenStates
 * @param {string} tokenHash
 * @param {'user'|'bot'|'unknown'} type
 * @param {number} capacity
 */
function setTokenType(tokenStates, tokenHash, type, capacity = 4) {
    if (!tokenHash) return;
    const state = getOrCreateTokenState(tokenStates, tokenHash, capacity);
    let normalizedType = 'unknown';
    if (type === 'bot') {
        normalizedType = 'bot';
    } else if (type === 'user') {
        normalizedType = 'user';
    }
    state.tokenType = normalizedType;
}

/**
 * Get token type from profile cache or state
 * @param {Map} tokenStates
 * @param {string} tokenHash
 * @param {object|null} cached
 * @returns {'user'|'bot'|'unknown'}
 */
function getTokenType(tokenStates, tokenHash, cached = null) {
    if (!tokenHash) return 'unknown';
    if (cached?.isBot || cached?.tokenType === 'bot' || cached?.category === 'bot') return 'bot';
    if (cached?.tokenType === 'user' || (cached && !cached.isBot)) return 'user';
    return tokenStates.get(tokenHash)?.tokenType || 'unknown';
}

/**
 * Format authorization header based on token type
 * @param {string} token
 * @param {'user'|'bot'} [explicitType]
 * @param {'user'|'bot'|'unknown'} [inferredType]
 * @returns {string}
 */
function formatAuthHeader(token, explicitType = null, inferredType = 'unknown') {
    if (!token) return '';
    const trimmed = String(token).trim();
    if (trimmed.startsWith('Bot ')) return trimmed;
    const type = explicitType || inferredType;
    return type === 'bot' ? `Bot ${trimmed}` : trimmed;
}

module.exports = {
    hashToken,
    createTokenState,
    getOrCreateTokenState,
    setTokenType,
    getTokenType,
    formatAuthHeader
};
