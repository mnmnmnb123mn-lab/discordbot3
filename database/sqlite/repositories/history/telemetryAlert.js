"use strict";

const { canSendAlert, recordAlertSent } = require("../../maintenance/quota");
const { sendWebhookEvent } = require("../../../../discord/core/webhooks");

function notifyBufferDropped(repoName, dropCount, maxCap, totalDropped) {
    const alertKey = `sqlite_buffer_dropped_${repoName}`;
    if (!canSendAlert(alertKey)) return;
    recordAlertSent(alertKey);

    try {
        sendWebhookEvent({
            target: "ALERT",
            severity: "WARNING",
            category: "DATA",
            code: "sqlite.telemetry.buffer_dropped",
            title: `⚠️ คิวพักข้อมูล Telemetry ล้น (${repoName})`,
            description: `คิวพักข้อมูล Write-Behind ของ ${repoName} เต็มความจุ (${maxCap} รายการ) ระบบได้ตัดทิ้งข้อมูลเก่าที่สุด ${dropCount} รายการเพื่อป้องกันภาวะหน่วยความจำล้น (RAM Exhaustion)`,
            context: {
                "Repository": repoName,
                "จำนวนที่ตัดทิ้งรอบนี้": `${dropCount} รายการ`,
                "ความจุสูงสุดของคิว": `${maxCap} รายการ`,
                "ยอดรวมที่ตัดทิ้งสะสม": `${totalDropped} รายการ`,
                "เวลาที่เกิด": new Date().toISOString()
            }
        }).catch(() => {});
    } catch (_) {}
}

module.exports = {
    notifyBufferDropped
};
