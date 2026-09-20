'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tokenCoordinator = require('../core/tokenCoordinator');

test.beforeEach(() => {
    tokenCoordinator.reset();
});

test('tokenCoordinator correctly hashes tokens', () => {
    const raw = 'test-token-12345';
    const hash1 = tokenCoordinator.hashToken(raw);
    const hash2 = tokenCoordinator.hashToken(raw);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^[0-9a-f]{64}$/);

    // Recognizes precomputed hash
    assert.equal(tokenCoordinator.hashToken(hash1), hash1);
});

test('voice activity registration, querying, and unregistration lifecycle', () => {
    const token = 'token-voice-test';
    assert.equal(tokenCoordinator.isVoiceActive(token), false);
    assert.equal(tokenCoordinator.getVoiceActivity(token), null);

    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-100',
        channelId: 'channel-200',
        sessionId: 'sess-300'
    });

    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    const act = tokenCoordinator.getVoiceActivity(token);
    assert.equal(act.guildId, 'guild-100');
    assert.equal(act.channelId, 'channel-200');
    assert.equal(act.sessionId, 'sess-300');

    tokenCoordinator.unregisterVoiceActivity(token);
    assert.equal(tokenCoordinator.isVoiceActive(token), false);
    assert.equal(tokenCoordinator.getVoiceActivity(token), null);
});

test('quest start, end, and active status tracking', () => {
    const token = 'token-quest-test';
    assert.equal(tokenCoordinator.isQuestActive(token), false);
    assert.equal(tokenCoordinator.shouldDebounceVoiceHealthCheck(token), false);

    tokenCoordinator.notifyQuestStart(token, { questId: 'q-456', mode: 'oneshot' });
    assert.equal(tokenCoordinator.isQuestActive(token), true);
    assert.equal(tokenCoordinator.shouldDebounceVoiceHealthCheck(token), true);

    tokenCoordinator.notifyQuestEnd(token);
    assert.equal(tokenCoordinator.isQuestActive(token), false);
    assert.equal(tokenCoordinator.shouldDebounceVoiceHealthCheck(token), false);
});

test('getSafeQuestHeartbeatPayload prioritizes applicationId when present', () => {
    const token = 'token-heartbeat-app';
    const quest = {
        id: 'q-app-1',
        applicationId: 'app-999'
    };
    const payload = tokenCoordinator.getSafeQuestHeartbeatPayload(token, quest, false);
    assert.deepEqual(payload, { application_id: 'app-999', terminal: false });
});

test('getSafeQuestHeartbeatPayload uses guild voice stream key when account is in voice', () => {
    const token = 'token-voice-concurrent';
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: '1530554002708631572',
        channelId: '1530554002708631575',
        sessionId: 'sess-active'
    });

    const questWithoutAppId = {
        id: 'q-game-fallback',
        applicationId: null
    };

    const payload = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questWithoutAppId, false);
    // MUST NOT use call: stream key because that drops the user from guild voice!
    assert.equal(payload.stream_key.startsWith('call:'), false);
    assert.equal(payload.stream_key, 'guild:1530554002708631572:1530554002708631575');
    assert.equal(payload.terminal, false);
});

test('getSafeQuestHeartbeatPayload falls back to call stream only when not in voice', () => {
    const token = 'token-no-voice';
    const questWithoutAppId = {
        id: 'q-game-standalone',
        applicationId: null
    };

    const payload = tokenCoordinator.getSafeQuestHeartbeatPayload(token, questWithoutAppId, true);
    assert.equal(payload.stream_key, 'call:q-game-standalone:1');
    assert.equal(payload.terminal, true);
});

test('withTokenLock serializes operations on the same token in FIFO order', async () => {
    const token = 'token-lock-test';
    const executionOrder = [];

    const p1 = tokenCoordinator.withTokenLock(token, async () => {
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(1);
    });

    const p2 = tokenCoordinator.withTokenLock(token, async () => {
        executionOrder.push(2);
    });

    const p3 = tokenCoordinator.withTokenLock(token, async () => {
        executionOrder.push(3);
    });

    await Promise.all([p1, p2, p3]);
    assert.deepEqual(executionOrder, [1, 2, 3]);
});
