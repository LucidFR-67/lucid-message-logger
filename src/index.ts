import { before, after } from "@vendetta/patcher";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { Forms, General } from "@vendetta/ui/components";

const TAG = "[LucidLogger]";
const MAX_CACHE_SIZE = 500;

// Tracking maps and sets
const deletedCache = new Map<string, any>();
const deletedSet = new Set<string>();
const editedSet = new Set<string>();
const manualDeletes = new Set<string>();
const cleanups: (() => void)[] = [];

// Discord internal stores & actions
const MessageStore = findByProps("getMessage", "getMessages");
const ChannelMessages = findByProps("_channelMessages");
const ChannelStore = findByProps("getChannel", "getDMFromUserId");
const UserStore = findByStoreName("UserStore");
const AuthStore = findByStoreName("AuthenticationStore") || findByProps("getToken");
const MessageActions = findByProps("deleteMessage", "startEditMessage") || findByProps("deleteMessage");

function getCurrentUserId(): string | undefined {
    return UserStore?.getCurrentUser?.()?.id || AuthStore?.getId?.() || AuthStore?.getCurrentUser?.()?.id;
}

function trimLRUCache() {
    if (deletedCache.size > MAX_CACHE_SIZE) {
        const oldestKey = deletedCache.keys().next().value;
        if (oldestKey) {
            deletedCache.delete(oldestKey);
            deletedSet.delete(oldestKey);
        }
    }
    if (editedSet.size > MAX_CACHE_SIZE) {
        const oldestKey = editedSet.keys().next().value;
        if (oldestKey) editedSet.delete(oldestKey);
    }
}

function mergeAttachments(original: any, updated: any): any[] {
    const origList: any[] = original?.attachments ?? [];
    const updateList: any[] = updated?.attachments ?? [];
    if (!origList.length) return updateList;
    if (!updateList.length) return origList;

    const map = new Map<string, any>();
    for (const a of origList) if (a?.id) map.set(a.id, a);
    for (const a of updateList) if (a?.id) map.set(a.id, a);
    return Array.from(map.values());
}

function recordToGateway(msg: any): any {
    if (!msg) return null;
    return {
        id: msg.id,
        channel_id: msg.channel_id || msg.channelId,
        guild_id: msg.guild_id || msg.guildId,
        content: msg.content ?? "",
        author: msg.author ? {
            id: msg.author.id,
            username: msg.author.username,
            discriminator: msg.author.discriminator ?? "0",
            avatar: msg.author.avatar,
            bot: !!(msg.author.bot || msg.author.isNonUserBot?.()),
            global_name: msg.author.globalName || msg.author.global_name,
        } : { id: "0", username: "Unknown" },
        attachments: msg.attachments ?? [],
        embeds: msg.embeds ?? [],
        mentions: msg.mentions ?? [],
        mention_roles: msg.mentionRoles ?? msg.mention_roles ?? [],
        pinned: !!msg.pinned,
        timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
        flags: msg.flags ?? 0,
        components: msg.components ?? [],
        sticker_items: msg.sticker_items ?? msg.stickerItems ?? msg.stickers ?? [],
        message_reference: msg.message_reference || msg.messageReference || null,
    };
}

function Settings() {
    const opts = (storage.options ??= {});
    const { ScrollView, View, Text } = General || ReactNative || ({} as any);
    const { FormSection, FormSwitchRow, FormRow, FormDivider } = Forms || ({} as any);

    return React.createElement(ScrollView, { style: { flex: 1, padding: 12 } },
        React.createElement(View, { style: { marginBottom: 16, padding: 14, backgroundColor: "#1e1f22", borderRadius: 8 } },
            React.createElement(Text, { style: { fontSize: 18, fontWeight: "bold", color: "#5865F2", marginBottom: 4 } }, "Lucid Message Logger"),
            React.createElement(Text, { style: { fontSize: 13, color: "#949BA4" } }, "⚡ Ultra-optimized inline message logger with red/yellow backgrounds & native delete support.")
        ),
        FormSection ? React.createElement(FormSection, { title: "Visual & Styling" },
            React.createElement(FormSwitchRow, {
                label: "Colored Background Highlights",
                subLabel: "Show soft red background on deleted messages and yellow on edits",
                value: opts.colorHighlights ?? true,
                onValueChange: (v: boolean) => { opts.colorHighlights = v; }
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: "Preserve Deleted Images & Media",
                subLabel: "Retain images, attachments, and stickers if deleted or edited out",
                value: opts.preserveMedia ?? true,
                onValueChange: (v: boolean) => { opts.preserveMedia = v; }
            })
        ) : null,
        FormSection ? React.createElement(FormSection, { title: "Logging Features" },
            React.createElement(FormSwitchRow, {
                label: "Log Deleted Messages",
                subLabel: "Keep deleted messages visible inline with [ DELETED ] tag",
                value: opts.logDeleted ?? true,
                onValueChange: (v: boolean) => { opts.logDeleted = v; }
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: "Log Edited Messages",
                subLabel: "Keep edit history visible with [ EDITED ] tag",
                value: opts.logEdited ?? true,
                onValueChange: (v: boolean) => { opts.logEdited = v; }
            })
        ) : null,
        FormSection ? React.createElement(FormSection, { title: "Filters & Ignored" },
            React.createElement(FormSwitchRow, {
                label: "Ignore Bots",
                subLabel: "Do not log bot deletions or edits",
                value: opts.ignoreBots ?? false,
                onValueChange: (v: boolean) => { opts.ignoreBots = v; }
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: "Ignore My Own Messages",
                subLabel: "Do not log your own deletions or edits",
                value: opts.ignoreSelf ?? false,
                onValueChange: (v: boolean) => { opts.ignoreSelf = v; }
            })
        ) : null,
        FormSection ? React.createElement(FormSection, { title: "Storage & Actions" },
            React.createElement(FormRow, {
                label: "Clear Active Memory Cache",
                subLabel: `Currently tracking ${deletedCache.size} deleted messages in RAM`,
                onPress: () => {
                    const count = deletedCache.size;
                    deletedCache.clear();
                    deletedSet.clear();
                    editedSet.clear();
                    showToast?.(`Cleared ${count} messages from Lucid cache!`);
                }
            })
        ) : null
    );
}

export default {
    onLoad: () => {
        storage.options ??= {};
        const opts = storage.options;
        opts.logDeleted ??= true;
        opts.logEdited ??= true;
        opts.preserveMedia ??= true;
        opts.colorHighlights ??= true;
        opts.ignoreBots ??= false;
        opts.ignoreSelf ??= false;

        // Processed colors for Discord React Native
        const RED_BG = ReactNative?.processColor ? ReactNative.processColor("#da373c26") : "#da373c26";
        const RED_GUTTER = ReactNative?.processColor ? ReactNative.processColor("#da373cf2") : "#da373cf2";
        const YELLOW_BG = ReactNative?.processColor ? ReactNative.processColor("#f0b2321e") : "#f0b2321e";
        const YELLOW_GUTTER = ReactNative?.processColor ? ReactNative.processColor("#f0b232e6") : "#f0b232e6";

        // 1. PATCH NATIVE DELETE ACTION (Allows user to delete logged/deleted messages natively)
        if (MessageActions?.deleteMessage) {
            const unpatchDelete = before("deleteMessage", MessageActions, (args: any[]) => {
                try {
                    const [channelId, messageId] = args;
                    if (!messageId) return;

                    manualDeletes.add(messageId);

                    // If message is in our deleted cache, purge it immediately
                    if (deletedCache.has(messageId)) {
                        deletedCache.delete(messageId);
                        deletedSet.delete(messageId);
                        editedSet.delete(messageId);

                        const record = ChannelMessages?.get?.(channelId);
                        if (record) {
                            try {
                                if (typeof record.remove === "function") {
                                    ChannelMessages.commit(record.remove(messageId));
                                } else if (typeof record.delete === "function") {
                                    record.delete(messageId);
                                }
                            } catch {}
                        }

                        FluxDispatcher.dispatch({
                            type: "MESSAGE_DELETE",
                            channelId,
                            id: messageId,
                            otherPluginBypass: true,
                            manualDelete: true
                        });
                    }
                } catch (err) {
                    console.error(TAG, "deleteMessage hook error:", err);
                }
            });
            cleanups.push(unpatchDelete);
        }

        // 2. PATCH FLUX DISPATCHER
        const unpatchFlux = before("dispatch", FluxDispatcher, (args: any[]) => {
            try {
                const event = args[0];
                if (!event || !event.type || event.otherPluginBypass) return;

                const currentUserId = getCurrentUserId();

                // 2A. MESSAGE_DELETE
                if (event.type === "MESSAGE_DELETE" && opts.logDeleted) {
                    const channelId = event.channelId;
                    const messageId = event.id;
                    if (!channelId || !messageId) return;

                    // If user manually deleted this message, let it pass through and vanish
                    if (manualDeletes.has(messageId) || event.manualDelete) {
                        manualDeletes.delete(messageId);
                        deletedCache.delete(messageId);
                        deletedSet.delete(messageId);
                        return;
                    }

                    const original =
                        MessageStore?.getMessage?.(channelId, messageId) ||
                        ChannelMessages?.get?.(channelId)?.get?.(messageId) ||
                        deletedCache.get(messageId);

                    if (!original || !original.author?.id) return;

                    // Skip ephemeral bot messages
                    if ((original.flags & 64) === 64) return;
                    if (opts.ignoreBots && (original.author.bot || original.author.isNonUserBot?.())) return;
                    if (opts.ignoreSelf && original.author.id === currentUserId) return;

                    const hasContent = original.content && original.content.trim().length > 0;
                    const hasMedia = (original.attachments && original.attachments.length > 0) || (original.embeds && original.embeds.length > 0);
                    if (!hasContent && !hasMedia) return;

                    if (deletedCache.has(messageId)) {
                        event.type = "MESSAGE_UPDATE";
                        event.message = {
                            id: messageId,
                            channel_id: channelId,
                            was_deleted: true,
                            flags: original.flags,
                        };
                        return args;
                    }

                    deletedCache.set(messageId, original);
                    deletedSet.add(messageId);
                    trimLRUCache();

                    const unixNow = Math.floor(Date.now() / 1000);
                    const deletedTag = ``[ DELETED ]` <t:${unixNow}:R>\n`;
                    const gatewayRecord = recordToGateway(original);

                    event.type = "MESSAGE_UPDATE";
                    event.channelId = channelId;
                    event.optimistic = false;
                    event.isPushNotification = false;
                    event.message = {
                        ...gatewayRecord,
                        content: `${deletedTag}${original.content || ""}`.trim(),
                        was_deleted: true,
                        edited_timestamp: null,
                    };

                    return args;
                }

                // 2B. MESSAGE_DELETE_BULK
                if (event.type === "MESSAGE_DELETE_BULK" && opts.logDeleted) {
                    const ids: string[] = event.ids || [];
                    const channelId = event.channelId;
                    if (!ids.length || !channelId) return;

                    for (const id of ids) {
                        if (manualDeletes.has(id)) {
                            manualDeletes.delete(id);
                            continue;
                        }

                        const original = MessageStore?.getMessage?.(channelId, id) || ChannelMessages?.get?.(channelId)?.get?.(id);
                        if (!original || original.author?.bot) continue;

                        const unixNow = Math.floor(Date.now() / 1000);
                        const deletedTag = ``[ DELETED ]` <t:${unixNow}:R>\n`;
                        const gatewayRecord = recordToGateway(original);

                        deletedCache.set(id, original);
                        deletedSet.add(id);
                        trimLRUCache();

                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            channelId,
                            message: {
                                ...gatewayRecord,
                                content: `${deletedTag}${original.content || ""}`.trim(),
                                was_deleted: true,
                            },
                            otherPluginBypass: true,
                        });
                    }
                    return;
                }

                // 2C. MESSAGE_UPDATE (Edits)
                if (event.type === "MESSAGE_UPDATE" && opts.logEdited) {
                    const updateMsg = event.message;
                    if (!updateMsg || !updateMsg.edited_timestamp || updateMsg.edited_timestamp === "invalid_timestamp") return;

                    const channelId = updateMsg.channel_id || event.channelId;
                    const messageId = updateMsg.id || event.id;
                    if (!channelId || !messageId) return;

                    const original = MessageStore?.getMessage?.(channelId, messageId) || ChannelMessages?.get?.(channelId)?.get?.(messageId);
                    if (!original || !original.author?.id) return;

                    if (opts.ignoreBots && original.author.bot) return;
                    if (opts.ignoreSelf && original.author.id === currentUserId) return;

                    const oldText = original.content || "";
                    const newText = updateMsg.content || "";

                    const hadAttachments = original.attachments && original.attachments.length > 0;
                    const lostAttachments = hadAttachments && (!updateMsg.attachments || updateMsg.attachments.length < original.attachments.length);

                    if (oldText === newText && !lostAttachments) return;
                    if (oldText.includes("`[ EDITED ]`") && oldText.endsWith(newText)) return;

                    editedSet.add(messageId);
                    trimLRUCache();

                    const unixNow = Math.floor(Date.now() / 1000);
                    const editTag = `\n`[ EDITED ]` <t:${unixNow}:R> `;
                    const gatewayRecord = recordToGateway(original);
                    const preservedAttachments = opts.preserveMedia ? mergeAttachments(original, updateMsg) : (updateMsg.attachments || []);

                    event.message = {
                        ...gatewayRecord,
                        ...updateMsg,
                        content: oldText !== newText ? `${oldText}${editTag}${newText}` : oldText,
                        attachments: preservedAttachments,
                        sticker_items: original.sticker_items || original.stickers || updateMsg.sticker_items || [],
                        edited_timestamp: "invalid_timestamp",
                    };

                    return args;
                }
            } catch (err) {
                console.error(TAG, "Dispatch error:", err);
            }
        });
        cleanups.push(unpatchFlux);

        // 3. ROW STYLING (Red Background for Deleted, Yellow Background for Edited)
        const applyRowHighlight = (row: any) => {
            if (!opts.colorHighlights || !row?.message?.id) return;
            const id = row.message.id;

            if (deletedSet.has(id)) {
                row.backgroundHighlight ??= {};
                row.backgroundHighlight.backgroundColor = RED_BG;
                row.backgroundHighlight.gutterColor = RED_GUTTER;
            } else if (editedSet.has(id)) {
                row.backgroundHighlight ??= {};
                row.backgroundHighlight.backgroundColor = YELLOW_BG;
                row.backgroundHighlight.gutterColor = YELLOW_GUTTER;
            }
        };

        // 3A. Patch Native Chat Module updateRows
        const ChatManager = ReactNative?.NativeModules?.DCDChatManager || findByProps("updateRows");
        if (ChatManager?.updateRows) {
            const unpatchChat = before("updateRows", ChatManager, (args: any[]) => {
                if (!opts.colorHighlights || (!deletedSet.size && !editedSet.size)) return;
                try {
                    const rows = typeof args[1] === "string" ? JSON.parse(args[1]) : args[1];
                    let modified = false;
                    for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        const id = row?.message?.id;
                        if (!id) continue;
                        if (deletedSet.has(id)) {
                            row.backgroundHighlight = { backgroundColor: RED_BG, gutterColor: RED_GUTTER };
                            modified = true;
                        } else if (editedSet.has(id)) {
                            row.backgroundHighlight = { backgroundColor: YELLOW_BG, gutterColor: YELLOW_GUTTER };
                            modified = true;
                        }
                    }
                    if (modified) {
                        args[1] = typeof args[1] === "string" ? JSON.stringify(rows) : rows;
                    }
                } catch {}
            });
            cleanups.push(unpatchChat);
        }

        // 3B. Patch RowManager.prototype.generate (if present)
        const RowManager = findByProps("RowManager")?.RowManager || findByProps("generate")?.RowManager;
        if (RowManager?.prototype?.generate) {
            const unpatchRow = after("generate", RowManager.prototype, (_args: any[], row: any) => {
                try {
                    applyRowHighlight(row);
                } catch {}
            });
            cleanups.push(unpatchRow);
        }
    },

    onUnload: () => {
        for (const cleanup of cleanups) {
            try { cleanup(); } catch {}
        }
        cleanups.length = 0;
        deletedCache.clear();
        deletedSet.clear();
        editedSet.clear();
        manualDeletes.clear();
    },

    settings: Settings
};
