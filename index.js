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
  var deleteable = [];
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
  var MessageStore = (findByStoreName && findByStoreName("MessageStore")) || (findByProps && findByProps("getMessage", "getMessages"));
  var UserStore = (findByStoreName && findByStoreName("UserStore")) || (findByProps && findByProps("getCurrentUser"));
  var AuthStore = (findByStoreName && findByStoreName("AuthenticationStore")) || (findByProps && findByProps("getToken"));
  var MessageActions = (findByProps && findByProps("deleteMessage", "startEditMessage")) || (findByProps && findByProps("deleteMessage"));

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

    if (MessageStore) {
      try {
        if (typeof MessageStore.getMessage === "function") {
          var m = MessageStore.getMessage(channelId, messageId);
          if (m) return m;
        }
        if (typeof MessageStore.getMessages === "function") {
          var msgs = MessageStore.getMessages(channelId);
          if (msgs && typeof msgs.get === "function") {
            var m2 = msgs.get(messageId);
            if (m2) return m2;
          }
        }
      } catch (e) {}
    }

    if (ChannelMessages) {
      try {
        if (typeof ChannelMessages.get === "function") {
          var ch = ChannelMessages.get(channelId);
          if (ch && typeof ch.get === "function") {
            var m3 = ch.get(messageId);
            if (m3) return m3;
          }
        }
        if (ChannelMessages._channelMessages && ChannelMessages._channelMessages[channelId]) {
          var chObj = ChannelMessages._channelMessages[channelId];
          if (typeof chObj.get === "function") {
            var m4 = chObj.get(messageId);
            if (m4) return m4;
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

    var isDeleted = deletedMessageMap.has(msg.id);
    var isEdited = editedMessageMap.has(msg.id);

    if (!isDeleted && !isEdited) return;

    if (isDeleted) {
      msg.edited = "(deleted)";
      if (opts.colorHighlights !== false) {
        if (ReactNative && ReactNative.processColor) {
          msg.textColor = ReactNative.processColor("#f04747");
          row.backgroundHighlight = {
            backgroundColor: ReactNative.processColor("#f047471f"),
            gutterColor: ReactNative.processColor("#f04747")
          };
        } else {
          msg.textColor = "#f04747";
          row.backgroundHighlight = {
            backgroundColor: "#f047471f",
            gutterColor: "#f04747"
          };
        }
      }
    } else if (isEdited && opts.colorHighlights !== false) {
      if (ReactNative && ReactNative.processColor) {
        row.backgroundHighlight = {
          backgroundColor: ReactNative.processColor("#faa61a18"),
          gutterColor: ReactNative.processColor("#faa61a")
        };
      } else {
        row.backgroundHighlight = {
          backgroundColor: "#faa61a18",
          gutterColor: "#faa61a"
        };
      }
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
            deleteable.length = 0;
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

      // 3. FLUX DISPATCHER HOOK (BULLETPROOF AUTOMOD REWRITE ENGINE)
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
              MESSAGE_DELETE (AutoMod Edit Failed Engine)
          ==========================================================*/
          if (ev.type === "MESSAGE_DELETE" && opts.logDeleted) {
            var msgId = ev.id || ev.messageId || (ev.message && ev.message.id);
            var chId = ev.channelId || ev.channel_id || (ev.message && (ev.message.channel_id || ev.message.channelId));

            if (!msgId || !chId) return args;

            // If user clicked native delete button
            if (manualDeletes.has(msgId)) {
              manualDeletes.delete(msgId);
              deletedMessageMap.delete(msgId);
              return args;
            }

            if (deleteable.indexOf(msgId) !== -1) {
              deleteable.splice(deleteable.indexOf(msgId), 1);
              deletedMessageMap.delete(msgId);
              return args;
            }
            deleteable.push(msgId);
            if (deleteable.length > 500) deleteable.shift();

            var message = getOriginalMessage(chId, msgId);
            var authorId = message && message.author && message.author.id;

            if (opts.ignoreBots && message && message.author && message.author.bot) return args;
            if (opts.ignoreSelf && authorId === currentUserId) return args;

            deletedMessageMap.set(msgId, {
              channelId: chId,
              timestamp: Date.now()
            });
            trimMap(deletedMessageMap);

            args[0] = {
              type: "MESSAGE_EDIT_FAILED_AUTOMOD",
              messageData: {
                type: 1,
                message: {
                  channelId: chId,
                  messageId: msgId,
                },
              },
              errorResponseBody: {
                code: 200000,
                message: "(deleted)",
              },
            };
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

              deletedMessageMap.set(bId, { channelId: bulkChannelId, timestamp: Date.now() });
              trimMap(deletedMessageMap);

              FluxDispatcher.dispatch({
                type: "MESSAGE_EDIT_FAILED_AUTOMOD",
                messageData: {
                  type: 1,
                  message: {
                    channelId: bulkChannelId,
                    messageId: bId,
                  },
                },
                errorResponseBody: {
                  code: 200000,
                  message: "(deleted)",
                },
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
            if (deletedMessageMap.has(msg.id || ev.id)) return args;

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

      // 4. ROW STYLING (Vencord PC Red / Yellow Backgrounds)
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
                    if (deletedMessageMap.has(row.message.id) || editedMessageMap.has(row.message.id)) {
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
      deleteable.length = 0;
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
