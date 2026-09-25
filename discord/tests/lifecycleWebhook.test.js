"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const webhooks = require("../core/webhooks");
const sessionManager = require("../sessionManager");

test("sessionManager dispatches alerts on MongoDB connection loss and recovery", async () => {
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
    const dispatched = [];

    webhooks.sendWebhookEvent = async event => {
        dispatched.push(event);
        return true;
    };

    try {
        // 1. Simulate disconnected
        mongoose.connection.emit("disconnected");
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].target, "ALERT");
        assert.equal(dispatched[0].severity, "CRITICAL");
        assert.equal(dispatched[0].category, "DATABASE");
        assert.equal(dispatched[0].code, "database.connection_lost");
        assert.equal(dispatched[0].state, "OPEN");

        // 2. Simulate error
        mongoose.connection.emit("error", new Error("Simulated connection timeout"));
        assert.equal(dispatched.length, 2);
        assert.equal(dispatched[1].target, "ALERT");
        assert.equal(dispatched[1].severity, "ERROR");
        assert.equal(dispatched[1].category, "DATABASE");
        assert.equal(dispatched[1].code, "database.error");
        assert.equal(dispatched[1].state, "OPEN");

        // 3. Simulate connected after loss -> should emit RESOLVED alert
        mongoose.connection.emit("connected");
        assert.equal(dispatched.length, 3);
        assert.equal(dispatched[2].target, "ALERT");
        assert.equal(dispatched[2].severity, "SUCCESS");
        assert.equal(dispatched[2].category, "DATABASE");
        assert.equal(dispatched[2].code, "database.connection_restored");
        assert.equal(dispatched[2].state, "RESOLVED");

        // 4. Simulate connected again without loss -> should NOT emit resolved again
        mongoose.connection.emit("connected");
        assert.equal(dispatched.length, 3);
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
    }
});

test("sessionManager saveDatabase alerts on MongoDB persistence failure", async () => {
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
    const dispatched = [];

    webhooks.sendWebhookEvent = async event => {
        dispatched.push(event);
        return true;
    };

    try {
        const mockStore = new Map([
            ["sess-1", {
                guildId: "g1",
                channelId: "c1",
                token: "tok",
                lifecycleGeneration: 1,
                status: "ACTIVE",
                reconnectAttempts: 0,
                lastActive: Date.now()
            }]
        ]);
        const mockModel = {
            bulkWrite() {
                throw new Error("Disk full or connection closed");
            }
        };

        await sessionManager.saveDatabase({
            dbConnected: true,
            sessions: mockStore,
            sessionModel: mockModel
        });

        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].target, "ALERT");
        assert.equal(dispatched[0].severity, "ERROR");
        assert.equal(dispatched[0].category, "DATABASE");
        assert.equal(dispatched[0].code, "session.persistence_failed");
        assert.equal(dispatched[0].state, "OPEN");
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
    }
});

test("tokenCoordinator dispatches alerts on quarantine, release, and heavy backoff", async () => {
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
    const dispatched = [];

    webhooks.sendWebhookEvent = async event => {
        dispatched.push(event);
        return true;
    };

    try {
        const { TokenCoordinator } = require("../core/tokenCoordinator");
        const coordinator = new TokenCoordinator({ alertCooldownMs: 0 });
        const testToken = "test_token_1234567890abcdef1234567890abcdef";

        // 1. Quarantine -> should dispatch ALERT
        coordinator.quarantineToken(testToken, "Invalid Token (401 Unauthorized)");
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].target, "ALERT");
        assert.equal(dispatched[0].severity, "ERROR");
        assert.equal(dispatched[0].category, "TOKEN");
        assert.equal(dispatched[0].code, "token.quarantined");
        assert.equal(dispatched[0].title, "TOKEN QUARANTINED");

        // 2. Release quarantine -> should dispatch LOG
        coordinator.releaseQuarantine(testToken);
        assert.equal(dispatched.length, 2);
        assert.equal(dispatched[1].target, "LOG");
        assert.equal(dispatched[1].severity, "SUCCESS");
        assert.equal(dispatched[1].category, "TOKEN");
        assert.equal(dispatched[1].code, "token.quarantine_released");
        assert.equal(dispatched[1].title, "TOKEN QUARANTINE RELEASED");

        // 3. Heavy backoff (>= 15s) -> should dispatch ALERT (warning)
        coordinator.applyTokenBackoff(testToken, 20000, { subsystem: "voiceWorker", reason: "429_burst" });
        assert.equal(dispatched.length, 3);
        assert.equal(dispatched[2].target, "ALERT");
        assert.equal(dispatched[2].severity, "WARNING");
        assert.equal(dispatched[2].category, "TOKEN");
        assert.equal(dispatched[2].code, "token.rate_limit_backoff");
        assert.equal(dispatched[2].title, "TOKEN RATE LIMITED (429)");
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
    }
});
