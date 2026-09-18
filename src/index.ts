// Lucid Message Logger - Ultra-optimized, Vencord PC-styled message logger for Vendetta / Bunny / Revenge
import { patcher, metro, common, ui, plugin } from "@vendetta";

const { before, after, instead } = patcher;
const { findByProps, findByStoreName, findByName } = metro;
const { FluxDispatcher, React, ReactNative } = common;
const { storage } = plugin;
const { toasts } = ui;

const TAG = "[LucidLogger]";
const MAX_CACHE_SIZE = 1500;

const deletedMessageMap = new Map();
const editedMessageMap = new Map();
const manualDeletes = new Set();
const cleanups: Array<() => void> = [];

function rawFind(predicate: (m: any) => boolean) {
  if (typeof window === "undefined" || !(window as any).modules) return undefined;
  const mods = (window as any).modules;
  for (const id in mods) {
    const def = mods[id];
    if (!def || !def.isInitialized) continue;
    const exports = def.publicModule && def.publicModule.exports;
    if (!exports) continue;
    try {
      if (predicate(exports)) return exports;
      if (exports.default != null && predicate(exports.default)) return exports.default;
    } catch (e) {}
  }
  return undefined;
}

function isNativeUpdateRows(m: any) {
  return typeof m === "object" && m !== null && typeof m.updateRows === "function";
}

const ChannelStore = (findByProps && findByProps("getChannel", "getDMFromUserId")) || (findByStoreName && findByStoreName("ChannelStore"));
const ChannelMessages = (findByProps && findByProps("_channelMessages")) || rawFind(m => m && m._channelMessages !== undefined);
const MessageStore = (findByProps && findByProps("getMessage", "getMessages")) || (findByStoreName && findByStoreName("MessageStore"));
const UserStore = (findByStoreName && findByStoreName("UserStore")) || (findByProps && findByProps("getCurrentUser"));
const AuthStore = (findByStoreName && findByStoreName("AuthenticationStore")) || (findByProps && findByProps("getToken"));
const MessageActions = (findByProps && findByProps("deleteMessage", "startEditMessage")) || (findByProps && findByProps("deleteMessage"));
const MessageRecordUtils = (findByProps && findByProps("updateMessageRecord", "createMessageRecord")) || rawFind(m => typeof m?.updateMessageRecord === "function");
const MessageRecord = (findByName && findByName("MessageRecord", false)) || (findByProps && findByProps("MessageRecord") && findByProps("MessageRecord").MessageRecord);

function getCurrentUserId() {
  return (UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser().id) ||
         (AuthStore && AuthStore.getId && AuthStore.getId()) ||
         (AuthStore && AuthStore.getCurrentUser && AuthStore.getCurrentUser().id);
}

function trimMap(map: Map<any, any>) {
  if (map.size > MAX_CACHE_SIZE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function getOriginalMessage(channelId: string, messageId: string) {
  if (!messageId) return undefined;

  // 1. ChannelMessages store
  if (ChannelMessages) {
    try {
      if (typeof ChannelMessages.get === "function") {
        const ch = ChannelMessages.get(channelId);
        if (ch && typeof ch.get === "function") {
          const m = ch.get(messageId);
          if (m) return m;
        }
      }
      if (ChannelMessages._channelMessages && ChannelMessages._channelMessages[channelId]) {
        const chObj = ChannelMessages._channelMessages[channelId];
        if (typeof chObj.get === "function") {
          const m2 = chObj.get(messageId);
          if (m2) return m2;
        }
        if (chObj._map && chObj._map[messageId]) return chObj._map[messageId];
        if (Array.isArray(chObj._array)) {
          for (let i = 0; i < chObj._array.length; i++) {
            if (chObj._array[i] && chObj._array[i].id === messageId) return chObj._array[i];
          }
        }
      }
    } catch (e) {}
  }

  // 2. MessageStore
  if (MessageStore) {
    try {
      if (typeof MessageStore.getMessage === "function") {
        const m3 = MessageStore.getMessage(channelId, messageId);
        if (m3) return m3;
      }
      if (typeof MessageStore.getMessages === "function") {
        const msgs = MessageStore.getMessages(channelId);
        if (msgs && typeof msgs.get === "function") {
          const m4 = msgs.get(messageId);
          if (m4) return m4;
        }
      }
    } catch (e) {}
  }

  // 3. Cache
  if (deletedMessageMap.has(messageId)) {
    const cached = deletedMessageMap.get(messageId);
    if (cached && cached.original) return cached.original;
  }
  if (editedMessageMap.has(messageId)) {
    const cachedEdit = editedMessageMap.get(messageId);
    if (cachedEdit && cachedEdit.original) return cachedEdit.original;
  }

  return undefined;
}

function authorToGateway(a: any) {
  if (!a || typeof a !== "object") return a;
  return {
    id: a.id,
    username: a.username || "Unknown",
    discriminator: a.discriminator && a.discriminator !== "???" ? String(a.discriminator) : "0",
    avatar: a.avatar !== undefined ? a.avatar : null,
    avatar_decoration_data: a.avatarDecorationData !== undefined ? a.avatarDecorationData : (a.avatar_decoration_data !== undefined ? a.avatar_decoration_data : null),
    bot: Boolean(a.bot),
    global_name: a.globalName || a.global_name || a.username || "Unknown"
  };
}

function embedToGateway(e: any) {
  if (!e || typeof e !== "object") return e;
  return Object.assign({}, e, {
    title: e.rawTitle !== undefined ? e.rawTitle : e.title,
    description: e.rawDescription !== undefined ? e.rawDescription : e.description,
    fields: Array.isArray(e.fields) ? e.fields.map((f: any) => ({
      name: f.rawName !== undefined ? f.rawName : (f.name || ""),
      value: f.rawValue !== undefined ? f.rawValue : (f.value || ""),
      inline: Boolean(f.inline)
    })) : undefined,
    author: e.author ? {
      name: e.author.name,
      url: e.author.url,
      icon_url: e.author.iconURL !== undefined ? e.author.iconURL : e.author.icon_url,
      proxy_icon_url: e.author.iconProxyURL !== undefined ? e.author.iconProxyURL : e.author.proxy_icon_url
    } : undefined,
    image: e.image ? {
      url: e.image.url,
      proxy_url: e.image.proxyURL !== undefined ? e.image.proxyURL : e.image.proxy_url,
      width: e.image.width,
      height: e.image.height
    } : undefined,
    thumbnail: e.thumbnail ? {
      url: e.thumbnail.url,
      proxy_url: e.thumbnail.proxyURL !== undefined ? e.thumbnail.proxyURL : e.thumbnail.proxy_url,
      width: e.thumbnail.width,
      height: e.thumbnail.height
    } : undefined
  });
}

function recordToGateway(record: any) {
  if (!record || typeof record !== "object") return record;
  return Object.assign({}, record, {
    id: record.id,
    channel_id: record.channel_id || record.channelId,
    guild_id: record.guild_id || record.guildId,
    content: record.content !== undefined && record.content !== null ? record.content : "",
    author: authorToGateway(record.author),
    embeds: Array.isArray(record.embeds) ? record.embeds.map(embedToGateway) : record.embeds,
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    sticker_items: record.sticker_items || record.stickers || []
  });
}

function mergeAttachments(original: any, updated: any) {
  const origList = (original && original.attachments) || [];
  const updateList = (updated && updated.attachments) || [];
  if (!origList.length) return updateList;
  if (!updateList.length) return origList;

  const map = new Map();
  for (let i = 0; i < origList.length; i++) {
    const a = origList[i];
    if (a && a.id) map.set(a.id, a);
  }
  for (let j = 0; j < updateList.length; j++) {
    const u = updateList[j];
    if (u && u.id) map.set(u.id, u);
  }
  return Array.from(map.values());
}

function handleRow(row: any, opts: any) {
  if (!row || row.type !== 1) return;
  const msg = row.message;
  if (!msg || !msg.id) return;

  const isDeleted = deletedMessageMap.has(msg.id) || Boolean(msg.was_deleted);
  const isEdited = editedMessageMap.has(msg.id);

  if (!isDeleted && !isEdited) return;

  if (isDeleted) {
    msg.edited = "(deleted)";
    if (opts.colorHighlights !== false) {
      msg.textColor = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f04747") : "#f04747";
      row.backgroundHighlight = {
        backgroundColor: ReactNative && ReactNative.processColor ? ReactNative.processColor("#f047471f") : "#f047471f",
        gutterColor: ReactNative && ReactNative.processColor ? ReactNative.processColor("#f04747") : "#f04747"
      };
    }
  } else if (isEdited && opts.colorHighlights !== false) {
    row.backgroundHighlight = {
      backgroundColor: ReactNative && ReactNative.processColor ? ReactNative.processColor("#faa61a18") : "#faa61a18",
      gutterColor: ReactNative && ReactNative.processColor ? ReactNative.processColor("#faa61a") : "#faa61a"
    };
  }
}

function Settings() {
  if (!React) return null;
  const opts = storage.options || (storage.options = {});
  const Forms = (ui && (ui as any).components && (ui as any).components.Forms) || (findByProps && findByProps("FormSection", "FormSwitchRow"));
  const General = (ui && (ui as any).components && (ui as any).components.General) || {};
  const ScrollView = (General && General.ScrollView) || (ReactNative && ReactNative.ScrollView) || "ScrollView";
  const View = (General && General.View) || (ReactNative && ReactNative.View) || "View";
  const Text = (General && General.Text) || (ReactNative && ReactNative.Text) || "Text";
  const FormSection = (Forms && Forms.FormSection) || View;
  const FormSwitchRow = (Forms && Forms.FormSwitchRow);
  const FormRow = (Forms && Forms.FormRow);
  const FormDivider = (Forms && Forms.FormDivider) || View;

  const useReducer = (React as any).useReducer || function (f: any, s: any) { return [s, function () {}]; };
  const forceUpdate = useReducer((x: number) => x + 1, 0)[1];

  return React.createElement(
    ScrollView,
    { style: { flex: 1, padding: 12 } },
    React.createElement(
      View,
      { style: { marginBottom: 16, padding: 14, backgroundColor: "#1e1f22", borderRadius: 8 } },
      React.createElement(Text, { style: { fontSize: 18, fontWeight: "bold", color: "#f04747", marginBottom: 4 } }, "Lucid Message Logger"),
      React.createElement(Text, { style: { fontSize: 13, color: "#949BA4" } }, "Vencord PC style deleted/edited message logger with guaranteed capture & highlights.")
    ),
    FormSection ? React.createElement(
      FormSection,
      { title: "Appearance & Styling" },
      FormSwitchRow ? React.createElement(FormSwitchRow, {
        label: "Vencord Background Highlights",
        subLabel: "Soft red highlight on deleted messages, amber on edits",
        value: opts.colorHighlights !== false,
        onValueChange: (v: boolean) => { opts.colorHighlights = v; forceUpdate(); }
      }) : null,
      FormDivider ? React.createElement(FormDivider, null) : null,
      FormSwitchRow ? React.createElement(FormSwitchRow, {
        label: "Preserve Deleted Images & Media",
        subLabel: "Retain attachments and stickers even after deletion",
        value: opts.preserveMedia !== false,
        onValueChange: (v: boolean) => { opts.preserveMedia = v; forceUpdate(); }
      }) : null
    ) : null,
    FormSection ? React.createElement(
      FormSection,
      { title: "Logging Options" },
      FormSwitchRow ? React.createElement(FormSwitchRow, {
        label: "Log Deleted Messages",
        subLabel: "Keep deleted messages visible in chat",
        value: opts.logDeleted !== false,
        onValueChange: (v: boolean) => { opts.logDeleted = v; forceUpdate(); }
      }) : null,
      FormDivider ? React.createElement(FormDivider, null) : null,
      FormSwitchRow ? React.createElement(FormSwitchRow, {
        label: "Log Edited Messages",
        subLabel: "Show old text and edit history",
        value: opts.logEdited !== false,
        onValueChange: (v: boolean) => { opts.logEdited = v; forceUpdate(); }
      }) : null,
      FormDivider ? React.createElement(FormDivider, null) : null,
      FormSwitchRow ? React.createElement(FormSwitchRow, {
        label: "Ignore Bots",
        subLabel: "Do not log bot deletions or edits",
        value: Boolean(opts.ignoreBots),
        onValueChange: (v: boolean) => { opts.ignoreBots = v; forceUpdate(); }
      }) : null,
      FormDivider ? React.createElement(FormDivider, null) : null,
      FormSwitchRow ? React.createElement(FormSwitchRow, {
        label: "Ignore My Own Messages",
        subLabel: "Do not log your own deletions or edits",
        value: Boolean(opts.ignoreSelf),
        onValueChange: (v: boolean) => { opts.ignoreSelf = v; forceUpdate(); }
      }) : null
    ) : null,
    FormSection ? React.createElement(
      FormSection,
      { title: "Diagnostics & Storage" },
      FormRow ? React.createElement(FormRow, {
        label: "Clear Memory Cache",
        subLabel: deletedMessageMap.size + " deleted messages logged in RAM",
        onPress: () => {
          const count = deletedMessageMap.size;
          deletedMessageMap.clear();
          editedMessageMap.clear();
          forceUpdate();
          if (toasts && toasts.showToast) {
            toasts.showToast("Cleared " + count + " logged messages from Lucid cache!");
          }
        }
      }) : null
    ) : null
  );
}

export default {
  onLoad() {
    if (!storage.options) storage.options = {};
    const opts = storage.options;
    if (opts.logDeleted === undefined) opts.logDeleted = true;
    if (opts.logEdited === undefined) opts.logEdited = true;
    if (opts.preserveMedia === undefined) opts.preserveMedia = true;
    if (opts.colorHighlights === undefined) opts.colorHighlights = true;
    if (opts.ignoreBots === undefined) opts.ignoreBots = false;
    if (opts.ignoreSelf === undefined) opts.ignoreSelf = false;

    // 1. NATIVE DELETE INTERCEPTION
    if (before && MessageActions && MessageActions.deleteMessage) {
      const unpatchDelete = before("deleteMessage", MessageActions, (args: any) => {
        try {
          const messageId = args && args[1];
          if (!messageId) return;

          manualDeletes.add(messageId);
          deletedMessageMap.delete(messageId);
          editedMessageMap.delete(messageId);
        } catch (err) {
          console.error(TAG, "deleteMessage hook error:", err);
        }
      });
      cleanups.push(unpatchDelete);
    }

    // 2. SELF-EDIT HISTORY FIX
    if (before && MessageActions && MessageActions.startEditMessage) {
      const unpatchStartEdit = before("startEditMessage", MessageActions, (args: any) => {
        const msgContent = args && args[2];
        if (typeof msgContent === "string" && msgContent.indexOf("`(edited)`\n") !== -1) {
          const parts = msgContent.split("`(edited)`\n");
          args[2] = parts[parts.length - 1];
          return args;
        }
      });
      cleanups.push(unpatchStartEdit);
    }

    // 3. PRESERVE was_deleted IN MESSAGERECORDUTILS
    if (MessageRecordUtils) {
      if (after && MessageRecordUtils.createMessageRecord) {
        cleanups.push(
          after("createMessageRecord", MessageRecordUtils, (args: any, record: any) => {
            const msg = args && args[0];
            if (msg && msg.was_deleted && record) {
              record.was_deleted = true;
            }
          })
        );
      }

      if (instead && MessageRecordUtils.updateMessageRecord) {
        cleanups.push(
          instead("updateMessageRecord", MessageRecordUtils, function (args: any, origFunc: any) {
            const oldRec = args && args[0];
            const newRec = args && args[1];
            if (newRec && newRec.was_deleted) {
              const reactions = oldRec ? oldRec.reactions : undefined;
              return MessageRecordUtils.createMessageRecord(newRec, reactions);
            }
            return origFunc.apply(this, args);
          })
        );
      }
    }

    if (after && MessageRecord && typeof MessageRecord.default === "function") {
      cleanups.push(
        after("default", MessageRecord, (args: any, record: any) => {
          const props = args && args[0];
          if (props && props.was_deleted && record) {
            record.was_deleted = true;
          }
        })
      );
    }

    // 4. FLUX DISPATCHER HOOK (DELETE & EDIT REWRITING ENGINE)
    if (!before || !FluxDispatcher) {
      console.warn(TAG, "FluxDispatcher not found!");
      return;
    }

    const unpatchFlux = before("dispatch", FluxDispatcher, (args: any) => {
      try {
        const ev = args[0];
        if (!ev || !ev.type || ev.otherPluginBypass) return args;

        const currentUserId = getCurrentUserId();

        /* =========================================================
            MESSAGE_DELETE (Dual-stage rewrite engine)
        ==========================================================*/
        if (ev.type === "MESSAGE_DELETE" && opts.logDeleted) {
          const msgId = ev.id || ev.messageId || (ev.message && ev.message.id);
          const chId = ev.channelId || ev.channel_id || (ev.message && (ev.message.channel_id || ev.message.channelId));

          if (!msgId) return args;

          if (manualDeletes.has(msgId)) {
            manualDeletes.delete(msgId);
            deletedMessageMap.delete(msgId);
            return args;
          }

          const existing = deletedMessageMap.get(msgId);
          if (existing) {
            if (existing.stage === 2) {
              return args;
            }
            if (existing.stage === 1) {
              existing.stage = 2;
              return existing.message || args;
            }
          }

          const orig = getOriginalMessage(chId, msgId);
          if (!orig) return args;

          const authorId = (orig.author && orig.author.id) || (orig.author && orig.author.userId);
          const authorUsername = orig.author && (orig.author.username || orig.author.globalName || orig.author.global_name);
          if (!authorId || !authorUsername) return args;

          if (orig.author.bot && (orig.flags === 64 || (orig.flags & 64) === 64)) return args;
          if (opts.ignoreBots && orig.author.bot) return args;
          if (opts.ignoreSelf && authorId === currentUserId) return args;

          const hasContent = typeof orig.content === "string" && orig.content.length > 0;
          const hasAttachments = Array.isArray(orig.attachments) && orig.attachments.length > 0;
          const hasEmbeds = Array.isArray(orig.embeds) && orig.embeds.length > 0;
          const hasStickers = Array.isArray(orig.sticker_items || orig.stickers) && (orig.sticker_items || orig.stickers).length > 0;

          if (!hasContent && !hasAttachments && !hasEmbeds && !hasStickers) return args;

          const targetChannelId = orig.channel_id || orig.channelId || chId;
          const guildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(targetChannelId) && ChannelStore.getChannel(targetChannelId).guild_id) || orig.guild_id || orig.guildId;

          const gatewayOrig = recordToGateway(orig);

          const updatePayload = Object.assign({}, gatewayOrig, {
            id: msgId,
            content: orig.content || "",
            channel_id: targetChannelId,
            guild_id: guildId,
            type: orig.type !== undefined ? orig.type : 0,
            flags: 64,
            state: "SENT",
            timestamp: orig.timestamp || new Date().toISOString(),
            was_deleted: true,
            attachments: Array.isArray(orig.attachments) ? orig.attachments : [],
            embeds: Array.isArray(orig.embeds) ? orig.embeds.map(embedToGateway) : [],
            sticker_items: orig.sticker_items || orig.stickers || [],
            message_reference: orig.message_reference || orig.messageReference || null
          });

          args[0] = {
            type: "MESSAGE_UPDATE",
            channelId: targetChannelId,
            message: updatePayload,
            optimistic: false,
            sendMessageOptions: {},
            isPushNotification: false
          };

          deletedMessageMap.set(msgId, {
            message: args,
            original: orig,
            stage: 1
          });
          trimMap(deletedMessageMap);

          return args;
        }

        /* =========================================================
            MESSAGE_DELETE_BULK
        ==========================================================*/
        if (ev.type === "MESSAGE_DELETE_BULK" && opts.logDeleted) {
          if (!Array.isArray(ev.ids)) return args;
          const bulkChannelId = ev.channelId || ev.channel_id;

          for (let k = 0; k < ev.ids.length; k++) {
            const bId = ev.ids[k];
            if (manualDeletes.has(bId)) {
              manualDeletes.delete(bId);
              continue;
            }

            const origBulk = getOriginalMessage(bulkChannelId, bId);
            if (!origBulk || !origBulk.author || !origBulk.author.id) continue;
            if (opts.ignoreBots && origBulk.author.bot) continue;
            if (opts.ignoreSelf && origBulk.author.id === currentUserId) continue;

            const bGuildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(bulkChannelId) && ChannelStore.getChannel(bulkChannelId).guild_id) || origBulk.guild_id;
            const gatewayBulk = recordToGateway(origBulk);

            deletedMessageMap.set(bId, {
              original: origBulk,
              stage: 2
            });
            trimMap(deletedMessageMap);

            FluxDispatcher.dispatch({
              type: "MESSAGE_UPDATE",
              channelId: bulkChannelId,
              message: Object.assign({}, gatewayBulk, {
                id: bId,
                content: origBulk.content || "",
                channel_id: bulkChannelId,
                guild_id: bGuildId,
                type: origBulk.type !== undefined ? origBulk.type : 0,
                flags: 64,
                state: "SENT",
                timestamp: origBulk.timestamp || new Date().toISOString(),
                was_deleted: true
              }),
              otherPluginBypass: true
            });
          }
          return args;
        }

        /* =========================================================
            MESSAGE_UPDATE (Edits)
        ==========================================================*/
        if (ev.type === "MESSAGE_UPDATE" && opts.logEdited) {
          const msg = ev.message;
          if (!msg) return args;
          if (msg.was_deleted) return args;

          if (!msg.edited_timestamp || msg.edited_timestamp === "invalid_timestamp") return args;

          const editChId = msg.channel_id || msg.channelId || ev.channelId;
          const editMsgId = msg.id || ev.id;
          if (!editChId || !editMsgId) return args;

          const origEdit = getOriginalMessage(editChId, editMsgId);
          if (!origEdit || !origEdit.author || !origEdit.author.id) return args;

          if (opts.ignoreBots && origEdit.author.bot) return args;
          if (opts.ignoreSelf && origEdit.author.id === currentUserId) return args;

          const oldContent = typeof origEdit.content === "string" ? origEdit.content : "";
          const newContent = typeof msg.content === "string" ? msg.content : "";

          const hadAttachments = Array.isArray(origEdit.attachments) && origEdit.attachments.length > 0;
          const lostAttachments = hadAttachments && (!Array.isArray(msg.attachments) || msg.attachments.length < origEdit.attachments.length);

          if (oldContent === newContent && !lostAttachments) return args;
          if (oldContent.indexOf("`(edited)`\n") !== -1 && oldContent.endsWith(newContent)) return args;

          editedMessageMap.set(editMsgId, { original: origEdit });
          trimMap(editedMessageMap);

          const gatewayOrigEdit = recordToGateway(origEdit);
          const preservedAttachments = opts.preserveMedia !== false ? mergeAttachments(origEdit, msg) : (msg.attachments || []);

          const formattedContent = oldContent !== newContent
            ? ("~~" + oldContent + "~~ `(edited)`\n" + newContent)
            : oldContent;

          const editGuildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(editChId) && ChannelStore.getChannel(editChId).guild_id) || msg.guild_id || origEdit.guild_id;

          ev.message = Object.assign({}, gatewayOrigEdit, msg, {
            content: formattedContent,
            attachments: preservedAttachments,
            guild_id: editGuildId,
            edited_timestamp: "invalid_timestamp",
            message_reference: msg.message_reference || origEdit.messageReference || origEdit.message_reference || null
          });

          return args;
        }
      } catch (e) {
        console.error(TAG, "Flux dispatch error:", e);
      }
      return args;
    });
    cleanups.push(unpatchFlux);

    // 5. ROW STYLING (Vencord PC Red / Yellow Backgrounds)
    const DCDChatManager = ReactNative && ReactNative.NativeModules && ReactNative.NativeModules.DCDChatManager;
    const applyHook = (target: any) => {
      if (!target || typeof target.updateRows !== "function") return;
      cleanups.push(
        before("updateRows", target, (args: any) => {
          if (!deletedMessageMap.size && !editedMessageMap.size) return;
          const raw = args && args[1];
          if (!raw) return;

          if (typeof raw === "string") {
            try {
              const rows = JSON.parse(raw);
              let mutated = false;
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (row && row.type === 1 && row.message) {
                  if (deletedMessageMap.has(row.message.id) || row.message.was_deleted || editedMessageMap.has(row.message.id)) {
                    handleRow(row, opts);
                    mutated = true;
                  }
                }
              }
              if (mutated) {
                args[1] = JSON.stringify(rows);
                return args;
              }
            } catch (err) {}
          } else if (Array.isArray(raw)) {
            for (let j = 0; j < raw.length; j++) {
              handleRow(raw[j], opts);
            }
          } else if (raw && typeof raw === "object" && Array.isArray(raw.rows)) {
            for (let r = 0; r < raw.rows.length; r++) {
              handleRow(raw.rows[r], opts);
            }
          }
        })
      );
    };

    if (DCDChatManager && DCDChatManager.updateRows) {
      applyHook(DCDChatManager);
    }

    const nativeChat = rawFind(isNativeUpdateRows) || (findByProps && findByProps("updateRows", "getConstants")) || (findByProps && findByProps("updateRows"));
    if (nativeChat && nativeChat !== DCDChatManager) {
      applyHook(nativeChat);
    }

    const RowManager = (findByName && findByName("RowManager", false)) || (findByProps && findByProps("RowManager") && findByProps("RowManager").RowManager);
    if (after && RowManager && RowManager.prototype && RowManager.prototype.generate) {
      cleanups.push(
        after("generate", RowManager.prototype, (_args: any, rowObj: any) => {
          if (!deletedMessageMap.size && !editedMessageMap.size) return;
          const row = (rowObj && rowObj.row) || rowObj;
          handleRow(row, opts);
        })
      );
    }
  },

  onUnload() {
    for (let i = 0; i < cleanups.length; i++) {
      try { cleanups[i](); } catch (e) {}
    }
    cleanups.length = 0;
    deletedMessageMap.clear();
    editedMessageMap.clear();
    manualDeletes.clear();
  },

  settings: Settings
};
