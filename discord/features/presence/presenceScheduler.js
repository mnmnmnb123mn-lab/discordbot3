"use strict";

const { STATUS_OPTIONS, PLATFORM_CONFIGS, DEFAULT_ROTATION_ITEMS } = require("./constants");

function sanitizeItem(rawItem, index = 0) {
    if (!rawItem || typeof rawItem !== "object") return null;

    const id = typeof rawItem.id === "string" && rawItem.id.trim()
        ? rawItem.id.trim().slice(0, 32)
        : `rot_${index + 1}_${Date.now().toString(36)}`;

    const type = ["status", "platform", "combined"].includes(rawItem.type)
        ? rawItem.type
        : "status";

    let status = typeof rawItem.status === "string" && STATUS_OPTIONS.includes(rawItem.status.toLowerCase())
        ? rawItem.status.toLowerCase()
        : null;

    let platform = typeof rawItem.platform === "string" && PLATFORM_CONFIGS[rawItem.platform.toLowerCase()]
        ? rawItem.platform.toLowerCase()
        : null;

    if (type === "status" && !status) status = "online";
    if (type === "platform" && !platform) platform = "mobile";
    if (type === "combined") {
        if (!status) status = "online";
        if (!platform) platform = "mobile";
    }

    const durationMinutes = Number.isFinite(Number(rawItem.durationMinutes)) && Number(rawItem.durationMinutes) > 0
        ? Math.min(1440, Math.max(0.1, Number(rawItem.durationMinutes)))
        : Number.isFinite(Number(rawItem.durationSeconds)) && Number(rawItem.durationSeconds) > 0
            ? Math.max(0.1, Number(rawItem.durationSeconds) / 60)
            : 5;

    const durationMs = Math.round(durationMinutes * 60 * 1000);

    const name = typeof rawItem.name === "string" && rawItem.name.trim()
        ? rawItem.name.trim().slice(0, 64)
        : type === "status"
            ? `สถานะ ${status.toUpperCase()} (${durationMinutes} นาที)`
            : type === "platform"
                ? `แพลตฟอร์ม ${PLATFORM_CONFIGS[platform]?.name || platform} (${durationMinutes} นาที)`
                : `สถานะ ${status.toUpperCase()} + ${PLATFORM_CONFIGS[platform]?.name || platform}`;

    const enabled = rawItem.enabled !== false;

    return {
        id,
        name,
        type,
        status,
        platform,
        durationMinutes,
        durationMs,
        enabled
    };
}

class PresenceScheduler {
    constructor(options = {}) {
        this.items = [];
        this.currentIndex = -1;
        this.timer = null;
        this.isRunning = false;
        this.stepExpiresAt = null;
        this.lastAction = null;
        this.onStep = options.onStep || (async () => {});
        this.now = options.now || (() => Date.now());
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;

        if (Array.isArray(options.items)) {
            this.setItems(options.items);
        } else {
            this.setItems(DEFAULT_ROTATION_ITEMS);
        }
    }

    setItems(rawItems) {
        if (!Array.isArray(rawItems)) {
            throw new TypeError("Items must be an array");
        }
        const cleaned = rawItems
            .map((item, idx) => sanitizeItem(item, idx))
            .filter(Boolean);

        this.items = cleaned.length > 0
            ? cleaned
            : DEFAULT_ROTATION_ITEMS.map((item, idx) => sanitizeItem(item, idx));

        return this.items;
    }

    getEnabledItems() {
        return this.items.filter(item => item.enabled);
    }

    findNextEnabledIndex(fromIndex = -1) {
        if (!this.items.length) return -1;
        const total = this.items.length;
        for (let i = 1; i <= total; i++) {
            const checkIndex = (fromIndex + i) % total;
            if (this.items[checkIndex].enabled) {
                return checkIndex;
            }
        }
        return -1;
    }

    async start(onStepCallback) {
        if (typeof onStepCallback === "function") {
            this.onStep = onStepCallback;
        }

        const enabled = this.getEnabledItems();
        if (!enabled.length) {
            this.stop();
            return { success: false, reason: "no_enabled_items" };
        }

        this.stopTimer();
        this.isRunning = true;

        const nextIndex = this.findNextEnabledIndex(-1);
        if (nextIndex === -1) {
            this.isRunning = false;
            return { success: false, reason: "no_enabled_items" };
        }

        return this.executeStep(nextIndex);
    }

    stop() {
        this.stopTimer();
        this.isRunning = false;
        this.stepExpiresAt = null;
        return { success: true };
    }

    stopTimer() {
        if (this.timer) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
    }

    async executeStep(index) {
        if (!this.isRunning || !this.items[index]) return;

        this.currentIndex = index;
        const item = this.items[index];
        const startedAt = this.now();
        this.stepExpiresAt = startedAt + item.durationMs;

        let result = null;
        try {
            result = await this.onStep(item, index);
            this.lastAction = {
                timestamp: startedAt,
                itemId: item.id,
                name: item.name,
                type: item.type,
                status: item.status,
                platform: item.platform,
                ok: true,
                result
            };
        } catch (err) {
            this.lastAction = {
                timestamp: startedAt,
                itemId: item.id,
                name: item.name,
                ok: false,
                error: err?.message || String(err)
            };
        }

        // Schedule the next step after item.durationMs
        this.stopTimer();
        if (this.isRunning) {
            this.timer = this.setTimer(() => {
                this.timer = null;
                const nextIndex = this.findNextEnabledIndex(this.currentIndex);
                if (nextIndex !== -1 && this.isRunning) {
                    this.executeStep(nextIndex);
                } else {
                    this.stop();
                }
            }, item.durationMs);

            this.timer?.unref?.();
        }

        return {
            success: true,
            activeItem: item,
            expiresAt: this.stepExpiresAt,
            lastAction: this.lastAction
        };
    }

    get currentItem() {
        return this.isRunning && this.currentIndex >= 0 && this.items[this.currentIndex]
            ? this.items[this.currentIndex]
            : null;
    }

    getNextItem() {
        const nextIndex = this.isRunning && this.currentIndex >= 0
            ? this.findNextEnabledIndex(this.currentIndex)
            : this.findNextEnabledIndex(-1);
        return nextIndex >= 0 && this.items[nextIndex] ? this.items[nextIndex] : null;
    }

    async step() {
        if (!this.isRunning) return { success: false, reason: "not_running" };
        const nextIndex = this.findNextEnabledIndex(this.currentIndex);
        if (nextIndex === -1) {
            this.stop();
            return { success: false, reason: "no_next_enabled_item" };
        }
        return this.executeStep(nextIndex);
    }

    getState() {
        const now = this.now();
        const activeItem = this.isRunning && this.currentIndex >= 0 && this.items[this.currentIndex]
            ? this.items[this.currentIndex]
            : null;

        const nextIndex = this.isRunning && this.currentIndex >= 0
            ? this.findNextEnabledIndex(this.currentIndex)
            : this.findNextEnabledIndex(-1);

        const nextItem = nextIndex >= 0 && this.items[nextIndex]
            ? this.items[nextIndex]
            : null;

        const remainingMs = this.stepExpiresAt && this.isRunning
            ? Math.max(0, this.stepExpiresAt - now)
            : 0;

        return {
            isRunning: this.isRunning,
            currentIndex: this.currentIndex,
            activeItem,
            currentItem: activeItem,
            nextItem,
            stepExpiresAt: this.stepExpiresAt,
            expiresAt: this.stepExpiresAt,
            remainingSeconds: Math.ceil(remainingMs / 1000),
            totalItems: this.items.length,
            enabledCount: this.getEnabledItems().length,
            lastAction: this.lastAction,
            items: this.items
        };
    }
}

module.exports = {
    sanitizeItem,
    PresenceScheduler
};
