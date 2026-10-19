"use strict";

const { DefaultWebSocketManagerOptions } = require("@discordjs/ws");
const { PLATFORM_CONFIGS } = require("./constants");

let currentPlatform = "desktop";
let lastReconnectTime = 0;
const RECONNECT_COOLDOWN_MS = 15_000;

function resolvePlatformKey(key, fallback = "desktop") {
    if (typeof key === "string" && PLATFORM_CONFIGS[key]) {
        return key;
    }
    return fallback;
}

function getPlatformProperties(platformKey) {
    const key = resolvePlatformKey(platformKey);
    return { ...PLATFORM_CONFIGS[key].properties };
}

function applyDefaultPlatform(platformKey) {
    const key = resolvePlatformKey(platformKey);
    const props = getPlatformProperties(key);
    DefaultWebSocketManagerOptions.identifyProperties = {
        browser: props.browser,
        device: props.device,
        os: props.os
    };
    currentPlatform = key;
    return { success: true, platform: key, properties: props };
}

async function applyRuntimePlatform(client, platformKey, options = {}) {
    const key = resolvePlatformKey(platformKey);
    const force = options.force === true;
    const now = Date.now();

    if (!force && key === currentPlatform) {
        return {
            success: true,
            changed: false,
            platform: key,
            reason: "already_active"
        };
    }

    const elapsed = now - lastReconnectTime;
    if (elapsed < RECONNECT_COOLDOWN_MS && !options.skipCooldown && !force) {
        const waitSec = Math.ceil((RECONNECT_COOLDOWN_MS - elapsed) / 1000);
        return {
            success: false,
            changed: false,
            platform: currentPlatform,
            error: `กรุณารออีก ${waitSec} วินาที ก่อนเปลี่ยนแพลตฟอร์มเพื่อความปลอดภัยต่อระบบเชื่อมต่อ Discord Gateway`
        };
    }

    const props = getPlatformProperties(key);

    // 1. Update default template for any future shard creation
    DefaultWebSocketManagerOptions.identifyProperties = {
        browser: props.browser,
        device: props.device,
        os: props.os
    };

    // 2. Update active WebSocketManager options if instantiated
    const ws = client?.ws?._ws;
    if (ws?.options) {
        ws.options.identifyProperties = {
            browser: props.browser,
            device: props.device,
            os: props.os
        };
    }

    currentPlatform = key;
    lastReconnectTime = now;

    // 3. If client is online and active, trigger shard re-identification with recovery=0 (fresh IDENTIFY)
    let reconnected = false;
    const shardCollection = ws?.strategy?.shards || ws?.shards || client?.ws?.shards;
    const isClientReady = typeof client?.isReady === "function" ? client.isReady() : (client?.isReady !== false);
    if (isClientReady && shardCollection && (shardCollection.size > 0 || shardCollection.length > 0)) {
        try {
            const shardPromises = [];
            const shardsList = typeof shardCollection.values === "function" ? shardCollection.values() : shardCollection;
            for (const shard of shardsList) {
                // recover: 0 (Reconnect) clears session cache and triggers fresh IDENTIFY
                shardPromises.push(
                    shard.destroy({
                        recover: 0,
                        reason: `Gateway Platform changed to ${key}`
                    })
                );
            }
            await Promise.all(shardPromises);
            reconnected = true;
        } catch (err) {
            return {
                success: true,
                changed: true,
                reconnected: false,
                platform: key,
                warning: `บันทึกการตั้งค่าแล้ว แต่ไม่สามารถ reconnect ได้ทันที: ${err.message}`
            };
        }
    }

    return {
        success: true,
        changed: true,
        reconnected,
        platform: key,
        properties: props
    };
}

function getCurrentPlatform() {
    return currentPlatform;
}

function resetCooldownForTest() {
    lastReconnectTime = 0;
}

module.exports = {
    resolvePlatformKey,
    getPlatformProperties,
    applyDefaultPlatform,
    applyRuntimePlatform,
    getCurrentPlatform,
    resetCooldownForTest,
    RECONNECT_COOLDOWN_MS
};
