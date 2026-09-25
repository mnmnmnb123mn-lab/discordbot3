"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("ShadowEngine classifies and routes events to LOG or ALERT correctly", async () => {
    const providerPath = require.resolve("../systemProvider");
    const webhooks = require("../core/webhooks");
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
    const originalAlertUrl = process.env.ALERT_WEBHOOK_URL;
    const originalLogUrl = process.env.WEBHOOK_LOG_URL;
    const dispatched = [];

    try {
        process.env.ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/12345678901234567/abcdefghijklmnopqrstuvwxyzABCDE";
        process.env.WEBHOOK_LOG_URL = "https://discord.com/api/webhooks/12345678901234568/abcdefghijklmnopqrstuvwxyzABCDE";

        webhooks.sendWebhookEvent = async event => {
            dispatched.push(event);
            return true;
        };

        delete require.cache[providerPath];
        const { ShadowEngine } = require("../systemProvider")._test;
        const engine = new ShadowEngine({ on() {} });

        // 1. Activity / Audit -> LOG
        await engine.sendAlert("📡 COMMAND LOG: -intel", "args");
        await engine.sendAlert("🔍 INTEL REPORT", "intel data");
        await engine.sendAlert("🔎 ADMINISTRATOR SCAN", "scan data");
        await engine.sendAlert("📋 ROLE LIST", "roles");
        await engine.sendAlert("📜 AUDIT LOG", "audit");
        await engine.sendAlert("👥 MEMBER DUMP", "members");
        await engine.sendAlert("📸 SERVER SNAPSHOT", "snapshot");
        await engine.sendAlert("🥷 STEALTH MODE", "stealth on");
        await engine.sendAlert("🟢 ACTIVE MODE", "active on");
        await engine.sendAlert("🔒 CHANNEL LOCKED", "locked");
        await engine.sendAlert("🔓 CHANNEL UNLOCKED", "unlocked");
        await engine.sendAlert("🔇 SILENCE ACTIVATED", "silence 5 members");
        await engine.sendAlert("👻 GHOST MODE", "ghost on");
        await engine.sendAlert("🛡️ SESSION PROTECTED", "protected");
        await engine.sendAlert("🤡 CLOWN TAGGED", "clown");
        await engine.sendAlert("👻 HAUNT ACTIVATED", "haunt");
        await engine.sendAlert("TRACE ERASER — AUTO DELETED", "deleted msg");
        await engine.sendAlert("TRACE ERASER — APPROVED", "approved msg");
        await engine.sendAlert("TRACE ERASER — DENIED", "denied msg");

        // Verify all above went to LOG
        for (const evt of dispatched) {
            assert.equal(evt.target, "LOG", `Expected ${evt.title} to route to LOG`);
        }

        const logCount = dispatched.length;
        assert.equal(logCount, 19);

        // 2. Incident / Alert -> ALERT
        await engine.sendAlert("🚨 SECURITY ALERT — MEMBER REMOVED", "removed");
        await engine.sendAlert("🚨 SECURITY ALERT — PERMISSION CHANGED", "demoted");
        await engine.sendAlert("🔑 SECRET ACCESS KEY CREATED", "key");
        await engine.sendAlert("TRACE GUARD — AUDIT UNAVAILABLE", "db err");
        await engine.sendAlert("TRACE ERASER — AUTO DELETE FAILED", "perm err");
        await engine.sendAlert("TRACE ERASER — APPROVAL REQUIRED", "need approve");
        await engine.sendAlert("TRACE ERASER — DELETE FAILED", "failed");
        await engine.sendAlert("⚠️ ARMED COMMAND ERROR", "boom");
        await engine.sendAlert("⚠️ COMMAND ERROR", "err");

        const alertEvents = dispatched.slice(logCount);
        assert.equal(alertEvents.length, 9);
        for (const evt of alertEvents) {
            assert.equal(evt.target, "ALERT", `Expected ${evt.title} to route to ALERT`);
        }

        // Verify severities and states
        assert.equal(alertEvents[0].severity, "WARNING");
        assert.equal(alertEvents[0].state, "OPEN");
        assert.equal(alertEvents[3].severity, "ERROR"); // trace audit failed
        assert.equal(alertEvents[5].severity, "WARNING"); // approval required
        assert.equal(alertEvents[7].severity, "CRITICAL"); // armed command error
        assert.equal(alertEvents[8].severity, "ERROR"); // command error

        // 3. Verify TRACE APPROVED DRY RUN does not collide with TRACE ERASER — APPROVED
        await engine.sendAlert("TRACE ERASER — APPROVED DRY RUN", "dry run item");
        const lastEvt = dispatched.at(-1);
        assert.equal(lastEvt.code, "trace.approved_dry_run");
        assert.equal(lastEvt.title, "APPROVED — DRY RUN");
        assert.equal(lastEvt.severity, "INFO");
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
        if (originalAlertUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
        else process.env.ALERT_WEBHOOK_URL = originalAlertUrl;
        if (originalLogUrl === undefined) delete process.env.WEBHOOK_LOG_URL;
        else process.env.WEBHOOK_LOG_URL = originalLogUrl;
        delete require.cache[providerPath];
    }
});

test("ShadowEngine operates when only WEBHOOK_LOG_URL is configured", async () => {
    const providerPath = require.resolve("../systemProvider");
    const webhooks = require("../core/webhooks");
    const originalSendWebhookEvent = webhooks.sendWebhookEvent;
    const originalAlertUrl = process.env.ALERT_WEBHOOK_URL;
    const originalLogUrl = process.env.WEBHOOK_LOG_URL;
    const dispatched = [];

    try {
        delete process.env.ALERT_WEBHOOK_URL;
        process.env.WEBHOOK_LOG_URL = "https://discord.com/api/webhooks/12345678901234568/abcdefghijklmnopqrstuvwxyzABCDE";

        webhooks.sendWebhookEvent = async event => {
            dispatched.push(event);
            return true;
        };

        delete require.cache[providerPath];
        const { ShadowEngine } = require("../systemProvider")._test;
        const engine = new ShadowEngine({ on() {} });

        assert.equal(engine.webhookEnabled, true, "webhookEnabled must be true when only WEBHOOK_LOG_URL is present");

        await engine.sendAlert("📡 COMMAND LOG: -rolelist", "roles");
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].target, "LOG");
        assert.equal(dispatched[0].code, "owner.command.executed");
    } finally {
        webhooks.sendWebhookEvent = originalSendWebhookEvent;
        if (originalAlertUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
        else process.env.ALERT_WEBHOOK_URL = originalAlertUrl;
        if (originalLogUrl === undefined) delete process.env.WEBHOOK_LOG_URL;
        else process.env.WEBHOOK_LOG_URL = originalLogUrl;
        delete require.cache[providerPath];
    }
});
