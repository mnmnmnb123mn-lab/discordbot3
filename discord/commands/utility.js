/* eslint-disable complexity -- Utility command flows are behavior-sensitive; refactor separately. */
/*
================================================================================
⚠️ [AI COGNITIVE DIRECTIVE] ⚠️
DO NOT REMOVE: activeRestores, activeBackups Sets — race condition guards.
DO NOT REMOVE: finally blocks — they MUST unlock Sets after every operation.
DO NOT SIMPLIFY: Restore loop — delay + setImmediate required (เฟส 19+21).
================================================================================
*/

const {
    MessageEmbed,
    MessageActionRow,
    MessageButton,
    getLegacyChannelType,
    resolveChannelType
} = require("../core/discordCompat");
const { PermissionFlagsBits } = require("discord.js");
const crypto = require("node:crypto");
const config = require("../config.json");
const {
    requireMemberPermission,
    requireBotPermission,
    safeDefer,
    sanitizeUserMessage,
    markCommandAccepted
} = require("../guards/commandGuards");
const guildBackup = require("./guildBackup");

// Race Condition Guards
const activeEmojiCopies = new Set();
const { activeRestores, activeBackups, handleBackup, handleRestore, handleRestoreConfirm } = guildBackup;


async function handle(interaction) {
    const cmd = interaction.commandName;
    if (cmd === "say")        return handleSay(interaction);
    if (cmd === "announce")   return handleAnnounce(interaction);
    if (cmd === "copy-emojis") return handleSteal(interaction);
    if (cmd === "backup")     return handleBackup(interaction);
    if (cmd === "restore")    return handleRestore(interaction);
}

// ════════════════════════════════════════════════════════════════════════════
//  📢  SAY (Administrator only)
// ════════════════════════════════════════════════════════════════════════════
async function handleSay(interaction) {
    if (!await requireMemberPermission(interaction, PermissionFlagsBits.Administrator, `> ${config.emojis.no_entry} ต้องเป็น Administrator เพื่อใช้คำสั่งนี้`)) return;
    if (!await requireBotPermission(interaction, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel], `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่องนี้ (ขาด SEND_MESSAGES หรือ VIEW_CHANNEL)`, interaction.channel)) return;

    const rawMsg = interaction.options.getString("message");
    const msg = sanitizeUserMessage(rawMsg, { maxLength: 2000 });
    if (!msg) return interaction.reply({
        content: `> ${config.emojis.error} ข้อความว่างหรือถูกบล็อกทั้งหมด`,
        ephemeral: true
    });

    markCommandAccepted(interaction);

    if (!await safeDefer(interaction, { ephemeral: true })) return null;
    await interaction.channel.send({
        content: msg,
        allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
    });
    return interaction.editReply({ content: `> ${config.emojis.success} ส่งเรียบร้อย` });
}

// ════════════════════════════════════════════════════════════════════════════
//  📣  ANNOUNCE (Custom Embed & Target Channel Renovation)
// ════════════════════════════════════════════════════════════════════════════
function isValidHttpUrl(str) {
    if (!str || typeof str !== "string") return false;
    try {
        const u = new URL(str);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

function resolveEmbedColor(colorHex, fallback) {
    if (!colorHex || typeof colorHex !== "string") return fallback;
    const cleaned = colorHex.trim().replace(/^#/, "");
    return /^[0-9A-Fa-f]{6}$/.test(cleaned) ? `#${cleaned}` : fallback;
}

function applyEmbedAuthor(embed, name, iconUrl) {
    if (!name) return;
    embed.setAuthor({
        name,
        iconURL: (iconUrl && isValidHttpUrl(iconUrl)) ? iconUrl.trim() : undefined
    });
}

function applyEmbedFooter(embed, text, iconUrl) {
    if (!text) return;
    embed.setFooter({
        text,
        iconURL: (iconUrl && isValidHttpUrl(iconUrl)) ? iconUrl.trim() : undefined
    });
}

function buildAnnouncementEmbed(options) {
    const embed = new MessageEmbed()
        .setColor(resolveEmbedColor(options.colorHex, config.system.themeColors.primary || "#5865F2"))
        .setDescription(options.messageText);

    if (options.title) {
        embed.setTitle(options.title);
    }
    if (options.url && isValidHttpUrl(options.url)) {
        embed.setURL(options.url.trim());
    }
    applyEmbedAuthor(embed, options.authorName, options.authorIcon);
    if (options.thumbnailUrl && isValidHttpUrl(options.thumbnailUrl)) {
        embed.setThumbnail(options.thumbnailUrl.trim());
    }
    if (options.imageUrl && isValidHttpUrl(options.imageUrl)) {
        embed.setImage(options.imageUrl.trim());
    }
    applyEmbedFooter(embed, options.footerText, options.footerIcon);
    if (options.timestamp === true) {
        embed.setTimestamp();
    }
    return embed;
}

function buildAnnouncementComponents(buttonText, buttonUrl) {
    if (!buttonText || !buttonUrl || !isValidHttpUrl(buttonUrl)) {
        return [];
    }
    const button = new MessageButton()
        .setLabel(buttonText.slice(0, 80))
        .setStyle("LINK")
        .setURL(buttonUrl.trim());
    return [new MessageActionRow().addComponents(button)];
}

async function validateAnnounceTarget(interaction) {
    if (!await requireMemberPermission(
        interaction,
        PermissionFlagsBits.Administrator,
        `> ⛔ คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`
    )) return null;

    const targetChannel = interaction.options.getChannel("channel") || interaction.channel;
    if (!targetChannel || typeof targetChannel.send !== "function") {
        await interaction.reply({
            content: `> ${config.emojis.error} ช่องเป้าหมายต้องเป็นห้องข้อความที่ส่งข้อความได้`,
            ephemeral: true
        });
        return null;
    }

    if (!await requireBotPermission(
        interaction,
        [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks],
        `> ${config.emojis.error} บอทไม่มีสิทธิ์ส่งข้อความในช่อง <#${targetChannel.id}> (ต้องการสิทธิ์ ส่งข้อความ, ดูช่อง, และ แนบลิงก์)`,
        targetChannel
    )) return null;

    return targetChannel;
}

function buildAnnouncePayload(interaction) {
    const rawMessage = interaction.options.getString("message");
    if (!rawMessage?.trim()) return null;

    const messageText = sanitizeUserMessage(rawMessage.replaceAll(String.raw`\n`, "\n"), { maxLength: 4096 });
    const rawTitle = interaction.options.getString("title");
    const rawContent = interaction.options.getString("content");
    const authorName = interaction.options.getString("author_name");
    const footerText = interaction.options.getString("footer");

    const embed = buildAnnouncementEmbed({
        messageText,
        title: rawTitle ? sanitizeUserMessage(rawTitle, { maxLength: 256 }) : null,
        colorHex: interaction.options.getString("color"),
        imageUrl: interaction.options.getString("image"),
        thumbnailUrl: interaction.options.getString("thumbnail"),
        footerText: footerText ? sanitizeUserMessage(footerText, { maxLength: 2048 }) : null,
        footerIcon: interaction.options.getString("footer_icon"),
        authorName: authorName ? sanitizeUserMessage(authorName, { maxLength: 256 }) : null,
        authorIcon: interaction.options.getString("author_icon"),
        url: interaction.options.getString("url"),
        timestamp: interaction.options.getBoolean("timestamp")
    });

    const components = buildAnnouncementComponents(
        interaction.options.getString("button_text"),
        interaction.options.getString("button_url")
    );

    const content = rawContent ? sanitizeUserMessage(rawContent, { maxLength: 2000 }) : null;

    return {
        content: content || undefined,
        embeds: [embed],
        components: components.length > 0 ? components : undefined,
        allowedMentions: { parse: ["users", "roles", "everyone"], repliedUser: false }
    };
}

async function handleAnnounce(interaction) {
    const targetChannel = await validateAnnounceTarget(interaction);
    if (!targetChannel) return;

    const payload = buildAnnouncePayload(interaction);
    if (!payload) {
        return interaction.reply({ content: `> ${config.emojis.error} ข้อความประกาศต้องไม่ว่าง`, ephemeral: true });
    }

    markCommandAccepted(interaction);

    if (!await safeDefer(interaction, { ephemeral: true })) return null;

    try {
        const sentMsg = await targetChannel.send(payload);

        const successText = targetChannel.id === interaction.channel.id
            ? `> ${config.emojis.success} ส่งประกาศเรียบร้อยแล้ว`
            : `> ${config.emojis.success} ส่งประกาศไปยังห้อง <#${targetChannel.id}> เรียบร้อยแล้ว`;

        return interaction.editReply({
            content: sentMsg?.url ? `${successText} • [เปิดดูข้อความ](${sentMsg.url})` : successText
        });
    } catch (err) {
        return interaction.editReply({
            content: `> ${config.emojis.error} ส่งประกาศไม่สำเร็จ: ${err?.message || "เกิดข้อผิดพลาด"}`
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  😀  COPY-EMOJIS (STEAL RENOVATION — 3-Stage Lifecycle + Smart Quota + Showcase)
// ════════════════════════════════════════════════════════════════════════════

function parseCustomEmojis(text) {
    if (!text || typeof text !== "string") return [];
    const regex = /<(a?):([a-zA-Z0-9_]+):(\d+)>/g;
    const seenEmojiIds = new Set();
    const results = [];
    for (const match of text.matchAll(regex)) {
        const isAnimated = match[1] === "a";
        let name = match[2];
        const id = match[3];
        if (seenEmojiIds.has(id)) continue;
        seenEmojiIds.add(id);

        if (name.length < 2) {
            name = name.padEnd(2, "_");
        } else if (name.length > 32) {
            name = name.slice(0, 32);
        }

        results.push({
            isAnimated,
            name,
            id,
            raw: match[0],
            url: `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? "gif" : "png"}`
        });
    }
    return results;
}

function calculateEmojiQuotas(guild) {
    const emojiManager = guild?.emojis;
    const tier = guild?.premiumTier || 0;
    const tierQuotas = { 3: 250, 2: 150, 1: 100 };
    const maxPerType = tierQuotas[tier] || 50;
    const staticCount = emojiManager?.cache?.filter?.(e => !e.animated)?.size || 0;
    const animatedCount = emojiManager?.cache?.filter?.(e => e.animated)?.size || 0;
    const staticFree = Math.max(0, maxPerType - staticCount);
    const animatedFree = Math.max(0, maxPerType - animatedCount);

    return {
        tier,
        maxPerType,
        staticCount,
        animatedCount,
        staticFree,
        animatedFree
    };
}

function checkSmartEmojiQuota(quotas, parsedEmojis) {
    const reqStatic = parsedEmojis.filter(e => !e.isAnimated).length;
    const reqAnimated = parsedEmojis.filter(e => e.isAnimated).length;

    if (quotas.staticFree === 0 && quotas.animatedFree === 0) {
        return {
            allowed: false,
            reason: "ALL_FULL",
            title: "โควตาอิโมจิของเซิร์ฟเวอร์เต็มทั้งหมดแล้ว",
            description:
                `> ${config.emojis.error} **เซิร์ฟเวอร์นี้มีอิโมจิเต็มโควตาทั้งหมดแล้ว!**\n` +
                `> 🖼️ อิโมจิทั่วไป: **${quotas.staticCount}/${quotas.maxPerType}** | ✨ อิโมจิเคลื่อนไหว: **${quotas.animatedCount}/${quotas.maxPerType}**\n\n` +
                `💡 *กรุณาลบอิโมจิที่ไม่ใช้งาน หรือบูสต์เซิร์ฟเวอร์เพื่อเพิ่มขีดจำกัดโควตา*`
        };
    }

    if (reqStatic > 0 && reqAnimated === 0 && quotas.staticFree === 0) {
        return {
            allowed: false,
            reason: "STATIC_FULL",
            title: "ช่องเก็บอิโมจิทั่วไป (Static) เต็มแล้ว",
            description:
                `> ${config.emojis.error} **ช่องอิโมจิทั่วไปเต็มแล้ว (${quotas.staticCount}/${quotas.maxPerType})** ไม่สามารถนำเข้าได้\n` +
                `> คุณระบุอิโมจิทั่วไปมา **${reqStatic}** ตัว แต่ไม่มีช่องว่างเหลือเลย\n\n` +
                `💡 *มีช่องอิโมจิเคลื่อนไหวว่างเหลืออยู่ **${quotas.animatedFree}** ช่อง คุณสามารถนำเข้าอิโมจิแบบขยับได้แทน*`
        };
    }

    if (reqAnimated > 0 && reqStatic === 0 && quotas.animatedFree === 0) {
        return {
            allowed: false,
            reason: "ANIMATED_FULL",
            title: "ช่องเก็บอิโมจิเคลื่อนไหว (Animated) เต็มแล้ว",
            description:
                `> ${config.emojis.error} **ช่องอิโมจิเคลื่อนไหวเต็มแล้ว (${quotas.animatedCount}/${quotas.maxPerType})** ไม่สามารถนำเข้าได้\n` +
                `> คุณระบุอิโมจิเคลื่อนไหวมา **${reqAnimated}** ตัว แต่ไม่มีช่องว่างเหลือเลย\n\n` +
                `💡 *มีช่องอิโมจิทั่วไปว่างเหลืออยู่ **${quotas.staticFree}** ช่อง คุณสามารถนำเข้าอิโมจิแบบภาพนิ่งแทน*`
        };
    }

    return {
        allowed: true,
        reqStatic,
        reqAnimated,
        willSkipStatic: Math.max(0, reqStatic - quotas.staticFree),
        willSkipAnimated: Math.max(0, reqAnimated - quotas.animatedFree)
    };
}

function renderEmojiProgressBar(current, total, barLength = 10) {
    const validTotal = Math.max(1, total || 1);
    const ratio = Math.min(1, Math.max(0, current / validTotal));
    const filled = Math.min(barLength, Math.round(ratio * barLength));
    const empty = barLength - filled;
    const bar = "▰".repeat(filled) + "▱".repeat(empty);
    const percent = Math.round(ratio * 100);
    return `${bar} \`${percent}%\``;
}

function buildEmojiNoticeEmbed({ title, description, color = config.system.themeColors.error, guild, user }) {
    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(title)
        .setDescription(description);

    const guildIcon = guild?.iconURL?.({ dynamic: true });
    if (guildIcon) {
        embed.setThumbnail(guildIcon);
    }
    if (user?.tag) {
        embed.setFooter({
            text: `ผู้สั่งการ: ${user.tag}`,
            iconURL: user.displayAvatarURL?.({ dynamic: true }) || undefined
        });
    }
    return embed;
}

function buildEmojiProgressEmbed({ current, total, added, skipped, failed, currentEmojiName, isAnimated, guild, user }) {
    const bar = renderEmojiProgressBar(current, total, 10);
    return new MessageEmbed()
        .setColor(config.system.themeColors.warning || "#FEE75C")
        .setAuthor({
            name: "ระบบนำเข้าอิโมจิกำลังทำงาน...",
            iconURL: guild?.iconURL?.({ dynamic: true }) || undefined
        })
        .setTitle(`${config.emojis.loading || "⏳"} กำลังดึงและสร้างอิโมจิ (${current}/${total})`)
        .setDescription(
            `> ${bar}\n\n` +
            `> ⏳ **กำลังนำเข้า:** \`:${currentEmojiName || "emoji"}:\` (${isAnimated ? "เคลื่อนไหว ✨" : "ทั่วไป 🖼️"})\n` +
            `> ⚡ **สถานะปัจจุบัน:** ${config.emojis.success || "✅"} สำเร็จ \`${added}\` | ${config.emojis.warning || "⚠️"} ข้าม \`${skipped}\` | ${config.emojis.error || "❌"} พลาด \`${failed}\``
        )
        .setFooter({
            text: `ผู้สั่งการ: ${user?.tag || "ผู้ดูแลระบบ"} • ระบบความปลอดภัยหน่วงเวลา 1.2 วินาที`,
            iconURL: user?.displayAvatarURL?.({ dynamic: true }) || undefined
        })
        .setTimestamp();
}

function formatEmojiShowcase(emojis, isAnimated) {
    if (!emojis || emojis.length === 0) return null;
    let text = "";
    let shownCount = 0;
    for (const e of emojis) {
        const item = isAnimated ? `<a:${e.name}:${e.id}> ` : `<:${e.name}:${e.id}> `;
        if ((text + item).length > 950) {
            text += `\n*...และอีก ${emojis.length - shownCount} ตัว*`;
            break;
        }
        text += item;
        shownCount++;
    }
    return text.trim();
}

function formatFailedEmojiList(emojis) {
    if (!emojis || emojis.length === 0) return null;
    const lines = emojis.slice(0, 8).map(e => `• \`:${e.name}:\` — ${e.reason || "เกิดข้อผิดพลาด"}`);
    let res = lines.join("\n");
    if (emojis.length > 8) {
        res += `\n*...และอีก ${emojis.length - 8} ตัว*`;
    }
    return res.slice(0, 1024);
}

function formatSkippedEmojiList(emojis) {
    if (!emojis || emojis.length === 0) return null;
    const lines = emojis.slice(0, 8).map(e => `• \`:${e.name}:\` (${e.isAnimated ? "เคลื่อนไหว ✨" : "ทั่วไป 🖼️"})`);
    let res = lines.join("\n");
    if (emojis.length > 8) {
        res += `\n*...และอีก ${emojis.length - 8} ตัว*`;
    }
    return res.slice(0, 1024);
}

function getEmojiResultTheme(added, total) {
    if (added === total) {
        return {
            color: config.system.themeColors.success || "#57F287",
            title: `${config.emojis.success || "✅"} นำเข้าอิโมจิเสร็จสมบูรณ์ 100%`
        };
    }
    if (added > 0) {
        return {
            color: config.system.themeColors.warning || "#FEE75C",
            title: `${config.emojis.warning || "⚠️"} นำเข้าอิโมจิสำเร็จบางส่วน`
        };
    }
    return {
        color: config.system.themeColors.error || "#ED4245",
        title: `${config.emojis.error || "❌"} นำเข้าอิโมจิไม่สำเร็จ`
    };
}

function buildEmojiResultFields({ createdStatic, createdAnimated, skippedEmojis, failedEmojis }) {
    const fields = [];
    if (createdStatic.length > 0) {
        fields.push({
            name: `🖼️ อิโมจิทั่วไป (Static) — ${createdStatic.length} ตัว`,
            value: formatEmojiShowcase(createdStatic, false) || "—",
            inline: false
        });
    }
    if (createdAnimated.length > 0) {
        fields.push({
            name: `✨ อิโมจิเคลื่อนไหว (Animated) — ${createdAnimated.length} ตัว`,
            value: formatEmojiShowcase(createdAnimated, true) || "—",
            inline: false
        });
    }
    if (skippedEmojis.length > 0) {
        fields.push({
            name: `⚠️ ข้ามเนื่องจากโควตาเต็ม — ${skippedEmojis.length} ตัว`,
            value: formatSkippedEmojiList(skippedEmojis) || "—",
            inline: false
        });
    }
    if (failedEmojis.length > 0) {
        fields.push({
            name: `❌ รายการที่ล้มเหลว — ${failedEmojis.length} ตัว`,
            value: formatFailedEmojiList(failedEmojis) || "—",
            inline: false
        });
    }
    return fields;
}

function buildEmojiResultEmbed({ total, added, skipped, failed, createdStatic, createdAnimated, skippedEmojis, failedEmojis, guild, user }) {
    const theme = getEmojiResultTheme(added, total);

    const embed = new MessageEmbed()
        .setColor(theme.color)
        .setAuthor({
            name: "ผลการนำเข้าอิโมจิเข้าสู่เซิร์ฟเวอร์",
            iconURL: guild?.iconURL?.({ dynamic: true }) || undefined
        })
        .setTitle(theme.title)
        .setDescription(
            `> 📊 **สรุปการดำเนินการ:** นำเข้าสำเร็จ **${added}** จากทั้งหมด **${total}** ตัว\n` +
            `> 🟢 **สำเร็จ:** \`${added}\` ตัว | 🟡 **ข้าม (โควตาเต็ม):** \`${skipped}\` ตัว | 🔴 **ล้มเหลว:** \`${failed}\` ตัว`
        )
        .setFooter({
            text: `ผู้สั่งการ: ${user?.tag || "ผู้ดูแลระบบ"} • ดำเนินการเสร็จสิ้น`,
            iconURL: user?.displayAvatarURL?.({ dynamic: true }) || undefined
        })
        .setTimestamp();

    const fields = buildEmojiResultFields({ createdStatic, createdAnimated, skippedEmojis, failedEmojis });
    if (fields.length > 0) {
        embed.addFields(fields);
    }

    return embed;
}

function validateStealInput(interaction, rawText) {
    const matches = parseCustomEmojis(rawText);
    if (matches.length === 0) {
        return {
            ok: false,
            matches: [],
            noticeEmbed: buildEmojiNoticeEmbed({
                title: "ไม่พบอิโมจิ Custom ในข้อความที่ระบุ",
                description:
                    `> ${config.emojis.warning} กรุณาวางอิโมจิที่เป็น Custom ของ Discord เช่น \`<:name:id>\` หรือ \`<a:name:id>\`\n` +
                    `> 💡 *ไม่รองรับอิโมจิมาตรฐานของระบบ (Unicode Standard Emojis เช่น 😀, 🎉)*`,
                color: config.system.themeColors.warning || "#FEE75C",
                guild: interaction.guild,
                user: interaction.user
            })
        };
    }

    if (matches.length > 50) {
        return {
            ok: false,
            matches,
            noticeEmbed: buildEmojiNoticeEmbed({
                title: "จำนวนอิโมจิเกินขีดจำกัด",
                description:
                    `> ${config.emojis.error} สามารถนำเข้าได้สูงสุด **50 ตัว** ต่อครั้ง (คุณระบุมา \`${matches.length}\` ตัว)\n` +
                    `> 💡 *กรุณาแบ่งการนำเข้าเป็นชุดละไม่เกิน 50 ตัว*`,
                color: config.system.themeColors.error || "#ED4245",
                guild: interaction.guild,
                user: interaction.user
            })
        };
    }

    if (activeEmojiCopies.has(interaction.guild.id)) {
        return {
            ok: false,
            matches,
            noticeEmbed: buildEmojiNoticeEmbed({
                title: "เซิร์ฟเวอร์กำลังดำเนินการคัดลอกอิโมจิอยู่",
                description:
                    `> ${config.emojis.warning} มีกระบวนการคัดลอกอิโมจิกำลังทำงานอยู่ในเซิร์ฟเวอร์นี้\n` +
                    `> 💡 *กรุณารอให้กระบวนการก่อนหน้าเสร็จสิ้นก่อนเริ่มคำสั่งใหม่*`,
                color: config.system.themeColors.warning || "#FEE75C",
                guild: interaction.guild,
                user: interaction.user
            })
        };
    }

    return { ok: true, matches };
}

function resolveEmojiCreateFailureReason(err) {
    if (err?.code === 40005 || err?.message?.includes("large")) {
        return "ไฟล์ใหญ่เกินขนาดที่อนุญาต (สูงสุด 256KB)";
    }
    if (err?.code === 50035 || err?.message?.includes("name")) {
        return "ชื่ออิโมจิไม่ถูกต้องตามกฎ";
    }
    if (err?.message) {
        return err.message.slice(0, 100);
    }
    return "Discord ปฏิเสธการสร้าง";
}

async function createSingleEmoji(interaction, item) {
    try {
        const created = await interaction.guild.emojis.create({
            attachment: item.url,
            name: item.name,
            reason: `คัดลอกโดย ${interaction.user.tag} (${interaction.user.id}) ผ่านคำสั่ง /copy-emojis`
        });
        return { success: true, created: created || item };
    } catch (err) {
        return { success: false, reason: resolveEmojiCreateFailureReason(err) };
    }
}

function isEmojiQuotaExceeded(item, staticCount, animatedCount, quotas) {
    return item.isAnimated
        ? animatedCount >= quotas.animatedFree
        : staticCount >= quotas.staticFree;
}

function applyEmojiImportResult(res, item, state) {
    if (res.success) {
        state.added++;
        if (item.isAnimated) {
            state.animatedAdded++;
            state.createdAnimated.push(res.created);
        } else {
            state.staticAdded++;
            state.createdStatic.push(res.created);
        }
    } else {
        state.failed++;
        state.failedEmojis.push({ ...item, reason: res.reason });
    }
}

async function maybeReportCopyProgress(interaction, { processed, matches, state }) {
    if (processed >= matches.length) return;
    const isPeriodic = processed % 2 === 0;
    const isSmallBatch = matches.length <= 5;
    if (!isSmallBatch && !isPeriodic) return;

    const nextItem = matches[processed];
    const progressEmbed = buildEmojiProgressEmbed({
        current: processed,
        total: matches.length,
        added: state.added,
        skipped: state.skipped,
        failed: state.failed,
        currentEmojiName: nextItem.name,
        isAnimated: nextItem.isAnimated,
        guild: interaction.guild,
        user: interaction.user
    });
    await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});
}

async function executeEmojiCopyWorkflow(interaction, { matches, quotas, delayMs }) {
    const state = {
        added: 0,
        failed: 0,
        skipped: 0,
        staticAdded: 0,
        animatedAdded: 0,
        createdStatic: [],
        createdAnimated: [],
        skippedEmojis: [],
        failedEmojis: []
    };

    const initialEmbed = buildEmojiProgressEmbed({
        current: 0,
        total: matches.length,
        added: 0,
        skipped: 0,
        failed: 0,
        currentEmojiName: matches[0]?.name,
        isAnimated: matches[0]?.isAnimated,
        guild: interaction.guild,
        user: interaction.user
    });
    await interaction.editReply({ embeds: [initialEmbed] }).catch(() => {});

    for (let i = 0; i < matches.length; i++) {
        const item = matches[i];

        if (isEmojiQuotaExceeded(item, state.staticAdded, state.animatedAdded, quotas)) {
            state.skipped++;
            state.skippedEmojis.push(item);
            continue;
        }

        const res = await createSingleEmoji(interaction, item);
        if (delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
        }

        applyEmojiImportResult(res, item, state);
        await maybeReportCopyProgress(interaction, { processed: i + 1, matches, state });
    }

    return buildEmojiResultEmbed({
        total: matches.length,
        added: state.added,
        skipped: state.skipped,
        failed: state.failed,
        createdStatic: state.createdStatic,
        createdAnimated: state.createdAnimated,
        skippedEmojis: state.skippedEmojis,
        failedEmojis: state.failedEmojis,
        guild: interaction.guild,
        user: interaction.user
    });
}

async function handleSteal(interaction, { delayMs = 1200 } = {}) {
    if (!await requireMemberPermission(
        interaction,
        PermissionFlagsBits.Administrator,
        `> ⛔ คำสั่งนี้จำเป็นต้องใช้สิทธิ์ผู้ดูแลระบบ (Administrator) เท่านั้น`
    )) return;

    if (!await requireBotPermission(
        interaction,
        PermissionFlagsBits.ManageGuildExpressions,
        `> ${config.emojis.error} บอทไม่มีสิทธิ์จัดการอิโมจิและสติกเกอร์ (ต้องการสิทธิ์ MANAGE_GUILD_EXPRESSIONS)`
    )) return;

    const validation = validateStealInput(interaction, interaction.options.getString("emojis"));
    if (!validation.ok) {
        return interaction.reply({ embeds: [validation.noticeEmbed], ephemeral: true });
    }

    if (typeof interaction.guild?.emojis?.fetch === "function") {
        await interaction.guild.emojis.fetch().catch(() => null);
    }

    const quotas = calculateEmojiQuotas(interaction.guild);
    const quotaCheck = checkSmartEmojiQuota(quotas, validation.matches);

    if (!quotaCheck.allowed) {
        const noticeEmbed = buildEmojiNoticeEmbed({
            title: quotaCheck.title,
            description: quotaCheck.description,
            color: config.system.themeColors.error || "#ED4245",
            guild: interaction.guild,
            user: interaction.user
        });
        return interaction.reply({ embeds: [noticeEmbed], ephemeral: true });
    }

    markCommandAccepted(interaction);
    activeEmojiCopies.add(interaction.guild.id);

    try {
        if (!await safeDefer(interaction)) return null;
        const resultEmbed = await executeEmojiCopyWorkflow(interaction, {
            matches: validation.matches,
            quotas,
            delayMs
        });
        return interaction.editReply({ embeds: [resultEmbed] });
    } finally {
        activeEmojiCopies.delete(interaction.guild.id);
    }
}

function getRuntimeDiagnostics() {
    return {
        activeRestores: activeRestores.size,
        activeBackups: activeBackups.size,
        activeEmojiCopies: activeEmojiCopies.size
    };
}

module.exports = {
    handle,
    handleRestoreConfirm,
    getRuntimeDiagnostics,
    _test: {
        ...guildBackup._test,
        handleSay,
        handleAnnounce,
        buildAnnouncementEmbed,
        buildAnnouncementComponents,
        isValidHttpUrl,
        resolveEmbedColor,
        handleSteal,
        parseCustomEmojis,
        calculateEmojiQuotas,
        checkSmartEmojiQuota,
        renderEmojiProgressBar,
        buildEmojiNoticeEmbed,
        buildEmojiProgressEmbed,
        buildEmojiResultEmbed,
        formatEmojiShowcase,
        formatFailedEmojiList,
        formatSkippedEmojiList,
        activeEmojiCopies
    }
};
