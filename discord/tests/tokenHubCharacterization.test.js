'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tokenCoordinator = require('../tokens/tokenCoordinator');
const oauthTokenManager = require('../tokens/oauthTokenManager');
const tokensIndex = require('../tokens');

test('Token Hub Entrypoint Contract: index.js exports match legacy references', () => {
    assert.equal(tokensIndex.tokenCoordinator, tokenCoordinator, 'tokens.tokenCoordinator must strictly equal tokenCoordinator singleton');
    assert.equal(tokensIndex.oauthTokenManager, oauthTokenManager, 'tokens.oauthTokenManager must strictly equal oauthTokenManager');
    assert.equal(tokensIndex.TokenCoordinator, tokenCoordinator.TokenCoordinator, 'TokenCoordinator class matches');
    assert.equal(typeof tokensIndex.TokenCoordinator, 'function');
    assert.equal(typeof tokenCoordinator.attachTelemetryListeners, 'function');
});

test('TokenCoordinator: Hashing and precomputed hash detection', () => {
    const raw = 'my-secret-token-value-999';
    const hash = tokenCoordinator.hashToken(raw);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(tokenCoordinator.hashToken(hash), hash, 'Precomputed 64-char hex hash is preserved');
    assert.equal(tokenCoordinator.hashToken(''), '');
    assert.equal(tokenCoordinator.hashToken(null), '');
});

test('TokenCoordinator: Same-token lock FIFO and parallel isolation', async () => {
    tokenCoordinator.reset();
    const tokenA = 'token-lock-a';
    const tokenB = 'token-lock-b';

    const order = [];
    const p1 = tokenCoordinator.withTokenLock(tokenA, async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push('a1');
    });
    const p2 = tokenCoordinator.withTokenLock(tokenA, async () => {
        order.push('a2');
    });
    const p3 = tokenCoordinator.withTokenLock(tokenB, async () => {
        order.push('b1');
    });

    await Promise.all([p1, p2, p3]);
    assert.equal(order.indexOf('a1') < order.indexOf('a2'), true, 'Token A operations run in FIFO order');
    assert.equal(order.includes('b1'), true, 'Token B operation runs in parallel');

    // Release after operation throws
    await assert.rejects(
        tokenCoordinator.withTokenLock(tokenA, async () => {
            throw new Error('Lock operation failed');
        }),
        /Lock operation failed/
    );

    // Subsequent operation on tokenA succeeds without deadlock
    let unlocked = false;
    await tokenCoordinator.withTokenLock(tokenA, async () => {
        unlocked = true;
    });
    assert.equal(unlocked, true, 'Subsequent lock succeeds after previous rejection');
});

test('TokenCoordinator: Activity lifecycle and event emission contracts', () => {
    tokenCoordinator.reset();
    const token = 'token-activity-test';
    const events = [];

    const onStart = (e) => events.push({ event: 'start', ...e });
    const onEnd = (e) => events.push({ event: 'end', ...e });
    tokenCoordinator.on('token:activity_start', onStart);
    tokenCoordinator.on('token:activity_end', onEnd);

    const acquired = tokenCoordinator.acquireActivity(token, 'customWorker', { jobId: 'job-1' });
    assert.equal(acquired, true);
    assert.equal(tokenCoordinator.hasActivity(token, 'customWorker'), true);

    const activities = tokenCoordinator.getActivities(token);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].subsystem, 'customWorker');
    assert.equal(activities[0].metadata.jobId, 'job-1');

    const released = tokenCoordinator.releaseActivity(token, 'customWorker');
    assert.equal(released, true);
    assert.equal(tokenCoordinator.hasActivity(token, 'customWorker'), false);

    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'start');
    assert.equal(events[0].subsystem, 'customWorker');
    assert.equal(events[1].event, 'end');
    assert.equal(events[1].subsystem, 'customWorker');

    tokenCoordinator.off('token:activity_start', onStart);
    tokenCoordinator.off('token:activity_end', onEnd);
});

test('TokenCoordinator: Multi-voice session registration and ambiguous release safety', () => {
    tokenCoordinator.reset();
    const token = 'token-multi-voice';

    // Register Session 1 and Session 2
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-1',
        channelId: 'chan-1',
        sessionId: 'session-1'
    });
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-2',
        channelId: 'chan-2',
        sessionId: 'session-2'
    });

    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-1'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-2'), true);

    // Release session-1 explicitly
    const rel1 = tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-1' });
    assert.equal(rel1, true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-1'), false);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-2'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token), true);
    assert.equal(tokenCoordinator.getVoiceActivity(token)?.sessionId, 'session-2');

    // Register another session to test ambiguous release
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-3',
        channelId: 'chan-3',
        sessionId: 'session-3'
    });

    // Ambiguous unregister without sessionId when 2 sessions exist returns false without wiping
    const ambiguousRel = tokenCoordinator.unregisterVoiceActivity(token);
    assert.equal(ambiguousRel, false, 'Ambiguous release when multiple sessions exist returns false');
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-2'), true);
    assert.equal(tokenCoordinator.isVoiceActive(token, 'session-3'), true);

    // Explicit unregister of remaining sessions
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-2' });
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'session-3' });
    assert.equal(tokenCoordinator.isVoiceActive(token), false);
});

test('TokenCoordinator: Isolation between tokens during backoff and quarantine', () => {
    tokenCoordinator.reset();
    const tokenA = 'token-isolation-a';
    const tokenB = 'token-isolation-b';

    tokenCoordinator.applyTokenBackoff(tokenA, 5000, { subsystem: 'test' });
    assert.equal(tokenCoordinator.tokenStates.get(tokenCoordinator.hashToken(tokenA))?.backoffUntil > Date.now(), true);
    assert.equal(tokenCoordinator.tokenStates.get(tokenCoordinator.hashToken(tokenB))?.backoffUntil || 0, 0);

    tokenCoordinator.quarantineToken(tokenA, 'Invalid Token');
    assert.equal(tokenCoordinator.isQuarantined(tokenA), true);
    assert.equal(tokenCoordinator.isQuarantined(tokenB), false);

    tokenCoordinator.releaseQuarantine(tokenA);
    assert.equal(tokenCoordinator.isQuarantined(tokenA), false);
});

test('TokenCoordinator: Subsystem registration and callback isolation', () => {
    tokenCoordinator.reset();
    const token = 'token-subsystem-test';
    let subACalled = false;
    let subBCalled = false;

    tokenCoordinator.registerSubsystem({
        name: 'subA',
        onTokenQuarantined: () => {
            subACalled = true;
            throw new Error('Exploding subsystem A');
        }
    });

    tokenCoordinator.registerSubsystem({
        name: 'subB',
        onTokenQuarantined: () => {
            subBCalled = true;
        }
    });

    // Subsystem A throwing must not prevent Subsystem B from being notified
    tokenCoordinator.quarantineToken(token, 'Auth failure');
    assert.equal(subACalled, true);
    assert.equal(subBCalled, true);

    assert.equal(tokenCoordinator.unregisterSubsystem('subA'), true);
    assert.equal(tokenCoordinator.unregisterSubsystem('subB'), true);
    assert.equal(tokenCoordinator.unregisterSubsystem('nonExistent'), false);
});

test('TokenCoordinator: Quest heartbeat resolution across all branches', () => {
    tokenCoordinator.reset();
    const token = 'token-quest-heartbeat';

    // 1. Application ID priority
    const resApp = tokenCoordinator.getSafeQuestHeartbeatPayload(token, { id: 'q1', applicationId: 'app-100' });
    assert.deepEqual(resApp, { application_id: 'app-100', terminal: false });

    // 2. Specific guild match when in voice
    tokenCoordinator.registerVoiceActivity(token, {
        guildId: 'guild-abc',
        channelId: 'chan-abc',
        sessionId: 'sess-abc'
    });
    const resGuild = tokenCoordinator.getSafeQuestHeartbeatPayload(token, { id: 'q2', guildId: 'guild-abc' });
    assert.deepEqual(resGuild, { stream_key: 'guild:guild-abc:chan-abc', terminal: false });

    // 3. Fallback when not matching guild
    tokenCoordinator.unregisterVoiceActivity(token, { sessionId: 'sess-abc' });
    const resFallback = tokenCoordinator.getSafeQuestHeartbeatPayload(token, { id: 'q3' });
    assert.deepEqual(resFallback, { stream_key: 'call:q3:1', terminal: false });
});

test('TokenCoordinator: Reset clears state, maps, timers, and reattaches telemetry once', () => {
    tokenCoordinator.reset();
    const token = 'token-reset-test';

    tokenCoordinator.acquireActivity(token, 'someTask');
    tokenCoordinator.quarantineToken(token, 'Test');
    tokenCoordinator.cacheTokenProfile('other-token', { username: 'testuser' });

    assert.equal(tokenCoordinator.tokenStates.size > 0, true);
    assert.equal(tokenCoordinator.profileCache.size > 0, true);

    tokenCoordinator.reset();

    assert.equal(tokenCoordinator.tokenStates.size, 0);
    assert.equal(tokenCoordinator.tokenLocks.size, 0);
    assert.equal(tokenCoordinator.subsystems.size, 0);
    assert.equal(tokenCoordinator.profileCache.size, 0);
    assert.equal(tokenCoordinator.alertHistory.size, 0);
    assert.equal(tokenCoordinator.listenerCount('token:rate_limited'), 1, 'Telemetry listener attached exactly once');
    assert.equal(tokenCoordinator.listenerCount('token:quarantined'), 1, 'Telemetry listener attached exactly once');
    assert.equal(tokenCoordinator.listenerCount('token:released'), 1, 'Telemetry listener attached exactly once');
    assert.equal(tokenCoordinator.listenerCount('token:error'), 1, 'Telemetry listener attached exactly once');
});

test('OAuthTokenManager Contract: Public exports, aliases, and _test integrity', () => {
    assert.equal(typeof oauthTokenManager.getAccessToken, 'function');
    assert.equal(typeof oauthTokenManager.refreshDueTokens, 'function');
    assert.equal(typeof oauthTokenManager.listAccessTokenCandidates, 'function');
    assert.equal(typeof oauthTokenManager.getOwnerTokenState, 'function');
    assert.equal(typeof oauthTokenManager.getOwnerTokenMetadata, 'function');
    assert.equal(typeof oauthTokenManager.getRecoveryStatuses, 'function');
    assert.equal(typeof oauthTokenManager.recoveryReasonLabel, 'function');
    assert.equal(typeof oauthTokenManager.migrateStoredTokenEncryption, 'function');
    assert.equal(typeof oauthTokenManager.revokeToken, 'function');
    assert.equal(typeof oauthTokenManager.start, 'function');
    assert.equal(typeof oauthTokenManager.stop, 'function');
    assert.equal(typeof oauthTokenManager.getDiagnostics, 'function');
    assert.equal(typeof oauthTokenManager.withTokenRefreshLock, 'function');
    assert.equal(oauthTokenManager.withOAuthTokenStateLock, oauthTokenManager.withTokenRefreshLock, 'Alias must match exactly');

    // Constants
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_MARGIN_MS, 24 * 60 * 60 * 1000);
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_SCAN_LIMIT, 100);
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_FAIL_MAX, 5);
    assert.equal(oauthTokenManager.DEFAULT_REFRESH_INTERVAL_MS, 10 * 60 * 1000);
    assert.equal(oauthTokenManager.DEFAULT_ON_DEMAND_MARGIN_MS, 5 * 60 * 1000);
    assert.deepEqual(oauthTokenManager.TOKEN_FIELDS, ['oauth']);

    // _test API integrity
    const expectedTestFunctions = [
        'dispatchOAuthAlert', 'resolveFailMax', 'isInvalidGrantError', 'assertValidTokenField',
        'validateTokenData', 'tokenPath', 'versionCondition', 'conflictOutcome',
        'readFreshOAuthDocument', 'markRefreshFailure', 'performTokenRefreshUnderLock',
        'buildRefreshQuery', 'refreshStateIsDue', 'applyRefreshOutcome', 'refreshTokenField',
        'revealTokenStateForOwner', 'tokenMetadataState', 'checkTokenCryptoReasons',
        'collectMissingScopeReasons', 'resetInternalStateForTesting', 'encryptToken',
        'decryptToken', 'decryptTokenForMigration'
    ];
    for (const fn of expectedTestFunctions) {
        assert.equal(typeof oauthTokenManager._test[fn], 'function', `_test.${fn} must be a function`);
    }
    assert.equal(oauthTokenManager._test.refreshLocks instanceof Map, true);
});
