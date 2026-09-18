(function (vendettaGlobal) {
  "use strict";

  var v = typeof vendetta !== "undefined" ? vendetta : (typeof window !== "undefined" ? window.vendetta : vendettaGlobal) || {};
  var patcher = v.patcher || {};
  var metro = v.metro || {};
  var common = metro.common || {};
  var ui = v.ui || {};
  var plugin = v.plugin || {};
  var storage = plugin.storage || v.storage || {};
  var toasts = ui.toasts || {};

  var before = patcher.before;
  var after = patcher.after;
  var instead = patcher.instead;
  var findByProps = metro.findByProps;
  var findByStoreName = metro.findByStoreName;
  var findByName = metro.findByName;
  var FluxDispatcher = common.FluxDispatcher;
  var React = common.React;
  var ReactNative = common.ReactNative;

  var TAG = "[LucidLogger]";
  var MAX_CACHE_SIZE = 1500;

  var deletedMessageMap = new Map();
  var editedMessageMap = new Map();
  var manualDeletes = new Set();
  var cleanups = [];

  function rawFind(predicate) {
    if (typeof window === "undefined" || !window.modules) return undefined;
    var mods = window.modules;
    for (var id in mods) {
      var def = mods[id];
      if (!def || !def.isInitialized) continue;
      var exports = def.publicModule && def.publicModule.exports;
      if (!exports) continue;
      try {
        if (predicate(exports)) return exports;
        if (exports.default != null && predicate(exports.default)) return exports.default;
      } catch (e) {}
    }
    return undefined;
  }

  function isNativeUpdateRows(m) {
    return typeof m === "object" && m !== null && typeof m.updateRows === "function";
  }

  var ChannelStore = (findByProps && findByProps("getChannel", "getDMFromUserId")) || (findByStoreName && findByStoreName("ChannelStore"));
  var ChannelMessages = (findByProps && findByProps("_channelMessages")) || rawFind(function (m) { return m && m._channelMessages !== undefined; });
  var MessageStore = (findByProps && findByProps("getMessage", "getMessages")) || (findByStoreName && findByStoreName("MessageStore"));
  var UserStore = (findByStoreName && findByStoreName("UserStore")) || (findByProps && findByProps("getCurrentUser"));
  var AuthStore = (findByStoreName && findByStoreName("AuthenticationStore")) || (findByProps && findByProps("getToken"));
  var MessageActions = (findByProps && findByProps("deleteMessage", "startEditMessage")) || (findByProps && findByProps("deleteMessage"));
  var MessageRecordUtils = (findByProps && findByProps("updateMessageRecord", "createMessageRecord")) || rawFind(function (m) { return typeof m?.updateMessageRecord === "function"; });
  var MessageRecord = (findByName && findByName("MessageRecord", false)) || (findByProps && findByProps("MessageRecord") && findByProps("MessageRecord").MessageRecord);

  function getCurrentUserId() {
    return (UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser().id) ||
           (AuthStore && AuthStore.getId && AuthStore.getId()) ||
           (AuthStore && AuthStore.getCurrentUser && AuthStore.getCurrentUser().id);
  }

  function trimMap(map) {
    if (map.size > MAX_CACHE_SIZE) {
      var oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  function getOriginalMessage(channelId, messageId) {
    if (!messageId) return undefined;

    // 1. ChannelMessages store
    if (ChannelMessages) {
      try {
        if (typeof ChannelMessages.get === "function") {
          var ch = ChannelMessages.get(channelId);
          if (ch && typeof ch.get === "function") {
            var m = ch.get(messageId);
            if (m) return m;
          }
        }
        if (ChannelMessages._channelMessages && ChannelMessages._channelMessages[channelId]) {
          var chObj = ChannelMessages._channelMessages[channelId];
          if (typeof chObj.get === "function") {
            var m2 = chObj.get(messageId);
            if (m2) return m2;
          }
          if (chObj._map && chObj._map[messageId]) return chObj._map[messageId];
          if (Array.isArray(chObj._array)) {
            for (var i = 0; i < chObj._array.length; i++) {
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
          var m3 = MessageStore.getMessage(channelId, messageId);
          if (m3) return m3;
        }
        if (typeof MessageStore.getMessages === "function") {
          var msgs = MessageStore.getMessages(channelId);
          if (msgs && typeof msgs.get === "function") {
            var m4 = msgs.get(messageId);
            if (m4) return m4;
          }
        }
      } catch (e) {}
    }

    // 3. Cache
    if (deletedMessageMap.has(messageId)) {
      var cached = deletedMessageMap.get(messageId);
      if (cached && cached.original) return cached.original;
    }
    if (editedMessageMap.has(messageId)) {
      var cachedEdit = editedMessageMap.get(messageId);
      if (cachedEdit && cachedEdit.original) return cachedEdit.original;
    }

    return undefined;
  }

  function authorToGateway(a) {
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

  function embedToGateway(e) {
    if (!e || typeof e !== "object") return e;
    return Object.assign({}, e, {
      title: e.rawTitle !== undefined ? e.rawTitle : e.title,
      description: e.rawDescription !== undefined ? e.rawDescription : e.description,
      fields: Array.isArray(e.fields) ? e.fields.map(function (f) {
        return {
          name: f.rawName !== undefined ? f.rawName : (f.name || ""),
          value: f.rawValue !== undefined ? f.rawValue : (f.value || ""),
          inline: Boolean(f.inline)
        };
      }) : undefined,
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

  function recordToGateway(record) {
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

  function mergeAttachments(original, updated) {
    var origList = (original && original.attachments) || [];
    var updateList = (updated && updated.attachments) || [];
    if (!origList.length) return updateList;
    if (!updateList.length) return origList;

    var map = new Map();
    for (var i = 0; i < origList.length; i++) {
      var a = origList[i];
      if (a && a.id) map.set(a.id, a);
    }
    for (var j = 0; j < updateList.length; j++) {
      var u = updateList[j];
      if (u && u.id) map.set(u.id, u);
    }
    return Array.from(map.values());
  }

  function handleRow(row, opts) {
    if (!row || row.type !== 1) return;
    var msg = row.message;
    if (!msg || !msg.id) return;

    var isDeleted = deletedMessageMap.has(msg.id) || Boolean(msg.was_deleted);
    var isEdited = editedMessageMap.has(msg.id);

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
    var opts = storage.options || (storage.options = {});
    var Forms = (ui && ui.components && ui.components.Forms) || (findByProps && findByProps("FormSection", "FormSwitchRow"));
    var General = (ui && ui.components && ui.components.General) || {};
    var ScrollView = (General && General.ScrollView) || (ReactNative && ReactNative.ScrollView) || "ScrollView";
    var View = (General && General.View) || (ReactNative && ReactNative.View) || "View";
    var Text = (General && General.Text) || (ReactNative && ReactNative.Text) || "Text";
    var FormSection = (Forms && Forms.FormSection) || View;
    var FormSwitchRow = (Forms && Forms.FormSwitchRow);
    var FormRow = (Forms && Forms.FormRow);
    var FormDivider = (Forms && Forms.FormDivider) || View;

    var useReducer = React.useReducer || function (f, s) { return [s, function () {}]; };
    var forceUpdate = useReducer(function (x) { return x + 1; }, 0)[1];

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
          onValueChange: function (v) { opts.colorHighlights = v; forceUpdate(); }
        }) : null,
        FormDivider ? React.createElement(FormDivider, null) : null,
        FormSwitchRow ? React.createElement(FormSwitchRow, {
          label: "Preserve Deleted Images & Media",
          subLabel: "Retain attachments and stickers even after deletion",
          value: opts.preserveMedia !== false,
          onValueChange: function (v) { opts.preserveMedia = v; forceUpdate(); }
        }) : null
      ) : null,
      FormSection ? React.createElement(
        FormSection,
        { title: "Logging Options" },
        FormSwitchRow ? React.createElement(FormSwitchRow, {
          label: "Log Deleted Messages",
          subLabel: "Keep deleted messages visible in chat",
          value: opts.logDeleted !== false,
          onValueChange: function (v) { opts.logDeleted = v; forceUpdate(); }
        }) : null,
        FormDivider ? React.createElement(FormDivider, null) : null,
        FormSwitchRow ? React.createElement(FormSwitchRow, {
          label: "Log Edited Messages",
          subLabel: "Show old text and edit history",
          value: opts.logEdited !== false,
          onValueChange: function (v) { opts.logEdited = v; forceUpdate(); }
        }) : null,
        FormDivider ? React.createElement(FormDivider, null) : null,
        FormSwitchRow ? React.createElement(FormSwitchRow, {
          label: "Ignore Bots",
          subLabel: "Do not log bot deletions or edits",
          value: Boolean(opts.ignoreBots),
          onValueChange: function (v) { opts.ignoreBots = v; forceUpdate(); }
        }) : null,
        FormDivider ? React.createElement(FormDivider, null) : null,
        FormSwitchRow ? React.createElement(FormSwitchRow, {
          label: "Ignore My Own Messages",
          subLabel: "Do not log your own deletions or edits",
          value: Boolean(opts.ignoreSelf),
          onValueChange: function (v) { opts.ignoreSelf = v; forceUpdate(); }
        }) : null
      ) : null,
      FormSection ? React.createElement(
        FormSection,
        { title: "Diagnostics & Storage" },
        FormRow ? React.createElement(FormRow, {
          label: "Clear Memory Cache",
          subLabel: deletedMessageMap.size + " deleted messages logged in RAM",
          onPress: function () {
            var count = deletedMessageMap.size;
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

  var pluginObject = {
    onLoad: function () {
      if (!storage.options) storage.options = {};
      var opts = storage.options;
      if (opts.logDeleted === undefined) opts.logDeleted = true;
      if (opts.logEdited === undefined) opts.logEdited = true;
      if (opts.preserveMedia === undefined) opts.preserveMedia = true;
      if (opts.colorHighlights === undefined) opts.colorHighlights = true;
      if (opts.ignoreBots === undefined) opts.ignoreBots = false;
      if (opts.ignoreSelf === undefined) opts.ignoreSelf = false;

      // 1. NATIVE DELETE INTERCEPTION
      if (before && MessageActions && MessageActions.deleteMessage) {
        var unpatchDelete = before("deleteMessage", MessageActions, function (args) {
          try {
            var messageId = args && args[1];
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

      // 2. SELF-EDIT HISTORY FIX (STRIP `(edited)` TAG WHEN STARTING EDIT)
      if (before && MessageActions && MessageActions.startEditMessage) {
        var unpatchStartEdit = before("startEditMessage", MessageActions, function (args) {
          var msgContent = args && args[2];
          if (typeof msgContent === "string" && msgContent.indexOf("`(edited)`\n") !== -1) {
            var parts = msgContent.split("`(edited)`\n");
            args[2] = parts[parts.length - 1];
            return args;
          }
        });
        cleanups.push(unpatchStartEdit);
      }

      // 3. PRESERVE was_deleted IN MESSAGERECORDUTILS (CREATE & UPDATE)
      if (MessageRecordUtils) {
        if (after && MessageRecordUtils.createMessageRecord) {
          cleanups.push(
            after("createMessageRecord", MessageRecordUtils, function (args, record) {
              var msg = args && args[0];
              if (msg && msg.was_deleted && record) {
                record.was_deleted = true;
              }
            })
          );
        }

        if (instead && MessageRecordUtils.updateMessageRecord) {
          cleanups.push(
            instead("updateMessageRecord", MessageRecordUtils, function (args, origFunc) {
              var oldRec = args && args[0];
              var newRec = args && args[1];
              if (newRec && newRec.was_deleted) {
                var reactions = oldRec ? oldRec.reactions : undefined;
                return MessageRecordUtils.createMessageRecord(newRec, reactions);
              }
              return origFunc.apply(this, args);
            })
          );
        }
      }

      if (after && MessageRecord && typeof MessageRecord.default === "function") {
        cleanups.push(
          after("default", MessageRecord, function (args, record) {
            var props = args && args[0];
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

      var unpatchFlux = before("dispatch", FluxDispatcher, function (args) {
        try {
          var ev = args[0];
          if (!ev || !ev.type || ev.otherPluginBypass) return args;

          var currentUserId = getCurrentUserId();

          /* =========================================================
              MESSAGE_DELETE (Dual-stage rewrite engine)
          ==========================================================*/
          if (ev.type === "MESSAGE_DELETE" && opts.logDeleted) {
            var msgId = ev.id || ev.messageId || (ev.message && ev.message.id);
            var chId = ev.channelId || ev.channel_id || (ev.message && (ev.message.channel_id || ev.message.channelId));

            if (!msgId) return args;

            // If user clicked native delete button
            if (manualDeletes.has(msgId)) {
              manualDeletes.delete(msgId);
              deletedMessageMap.delete(msgId);
              return args;
            }

            // Dual-stage dispatch handling
            var existing = deletedMessageMap.get(msgId);
            if (existing) {
              if (existing.stage === 2) {
                return args;
              }
              if (existing.stage === 1) {
                existing.stage = 2;
                return existing.message || args;
              }
            }

            var orig = getOriginalMessage(chId, msgId);
            if (!orig) return args;

            var authorId = (orig.author && orig.author.id) || (orig.author && orig.author.userId);
            var authorUsername = orig.author && (orig.author.username || orig.author.globalName || orig.author.global_name);
            if (!authorId || !authorUsername) return args;

            // Bot ephemeral check
            if (orig.author.bot && (orig.flags === 64 || (orig.flags & 64) === 64)) return args;
            if (opts.ignoreBots && orig.author.bot) return args;
            if (opts.ignoreSelf && authorId === currentUserId) return args;

            var hasContent = typeof orig.content === "string" && orig.content.length > 0;
            var hasAttachments = Array.isArray(orig.attachments) && orig.attachments.length > 0;
            var hasEmbeds = Array.isArray(orig.embeds) && orig.embeds.length > 0;
            var hasStickers = Array.isArray(orig.sticker_items || orig.stickers) && (orig.sticker_items || orig.stickers).length > 0;

            if (!hasContent && !hasAttachments && !hasEmbeds && !hasStickers) return args;

            var targetChannelId = orig.channel_id || orig.channelId || chId;
            var guildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(targetChannelId) && ChannelStore.getChannel(targetChannelId).guild_id) || orig.guild_id || orig.guildId;

            var gatewayOrig = recordToGateway(orig);

            var updatePayload = Object.assign({}, gatewayOrig, {
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
            var bulkChannelId = ev.channelId || ev.channel_id;

            for (var k = 0; k < ev.ids.length; k++) {
              var bId = ev.ids[k];
              if (manualDeletes.has(bId)) {
                manualDeletes.delete(bId);
                continue;
              }

              var origBulk = getOriginalMessage(bulkChannelId, bId);
              if (!origBulk || !origBulk.author || !origBulk.author.id) continue;
              if (opts.ignoreBots && origBulk.author.bot) continue;
              if (opts.ignoreSelf && origBulk.author.id === currentUserId) continue;

              var bGuildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(bulkChannelId) && ChannelStore.getChannel(bulkChannelId).guild_id) || origBulk.guild_id;
              var gatewayBulk = recordToGateway(origBulk);

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
            var msg = ev.message;
            if (!msg) return args;
            if (msg.was_deleted) return args;

            if (!msg.edited_timestamp || msg.edited_timestamp === "invalid_timestamp") return args;

            var editChId = msg.channel_id || msg.channelId || ev.channelId;
            var editMsgId = msg.id || ev.id;
            if (!editChId || !editMsgId) return args;

            var origEdit = getOriginalMessage(editChId, editMsgId);
            if (!origEdit || !origEdit.author || !origEdit.author.id) return args;

            if (opts.ignoreBots && origEdit.author.bot) return args;
            if (opts.ignoreSelf && origEdit.author.id === currentUserId) return args;

            var oldContent = typeof origEdit.content === "string" ? origEdit.content : "";
            var newContent = typeof msg.content === "string" ? msg.content : "";

            var hadAttachments = Array.isArray(origEdit.attachments) && origEdit.attachments.length > 0;
            var lostAttachments = hadAttachments && (!Array.isArray(msg.attachments) || msg.attachments.length < origEdit.attachments.length);

            if (oldContent === newContent && !lostAttachments) return args;
            if (oldContent.indexOf("`(edited)`\n") !== -1 && oldContent.endsWith(newContent)) return args;

            editedMessageMap.set(editMsgId, { original: origEdit });
            trimMap(editedMessageMap);

            var gatewayOrigEdit = recordToGateway(origEdit);
            var preservedAttachments = opts.preserveMedia !== false ? mergeAttachments(origEdit, msg) : (msg.attachments || []);

            var formattedContent = oldContent !== newContent
              ? ("~~" + oldContent + "~~ `(edited)`\n" + newContent)
              : oldContent;

            var editGuildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(editChId) && ChannelStore.getChannel(editChId).guild_id) || msg.guild_id || origEdit.guild_id;

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
      var DCDChatManager = ReactNative && ReactNative.NativeModules && ReactNative.NativeModules.DCDChatManager;
      var applyHook = function (target) {
        if (!target || typeof target.updateRows !== "function") return;
        cleanups.push(
          before("updateRows", target, function (args) {
            if (!deletedMessageMap.size && !editedMessageMap.size) return;
            var raw = args && args[1];
            if (!raw) return;

            if (typeof raw === "string") {
              try {
                var rows = JSON.parse(raw);
                var mutated = false;
                for (var i = 0; i < rows.length; i++) {
                  var row = rows[i];
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
              for (var j = 0; j < raw.length; j++) {
                handleRow(raw[j], opts);
              }
            } else if (raw && typeof raw === "object" && Array.isArray(raw.rows)) {
              for (var r = 0; r < raw.rows.length; r++) {
                handleRow(raw.rows[r], opts);
              }
            }
          })
        );
      };

      if (DCDChatManager && DCDChatManager.updateRows) {
        applyHook(DCDChatManager);
      }

      var nativeChat = rawFind(isNativeUpdateRows) || (findByProps && findByProps("updateRows", "getConstants")) || (findByProps && findByProps("updateRows"));
      if (nativeChat && nativeChat !== DCDChatManager) {
        applyHook(nativeChat);
      }

      var RowManager = (findByName && findByName("RowManager", false)) || (findByProps && findByProps("RowManager") && findByProps("RowManager").RowManager);
      if (after && RowManager && RowManager.prototype && RowManager.prototype.generate) {
        cleanups.push(
          after("generate", RowManager.prototype, function (_args, rowObj) {
            if (!deletedMessageMap.size && !editedMessageMap.size) return;
            var row = (rowObj && rowObj.row) || rowObj;
            handleRow(row, opts);
          })
        );
      }
    },

    onUnload: function () {
      for (var i = 0; i < cleanups.length; i++) {
        try { cleanups[i](); } catch (e) {}
      }
      cleanups.length = 0;
      deletedMessageMap.clear();
      editedMessageMap.clear();
      manualDeletes.clear();
    },

    settings: Settings
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = pluginObject;
  }
  if (typeof exports !== "undefined") {
    exports.default = pluginObject;
  }
  return pluginObject;
})(typeof vendetta !== "undefined" ? vendetta : (typeof window !== "undefined" ? window.vendetta : undefined));
