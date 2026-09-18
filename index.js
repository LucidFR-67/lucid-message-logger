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
  var MAX_CACHE_SIZE = 1200;

  // Master storage structures
  var shadowMessages = new Map();
  var fakedMessages = new Map();
  var editHistory = new Map();
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

  var ChannelMessages = (findByProps && findByProps("_channelMessages")) || rawFind(function(m) { return m && (m._channelMessages !== undefined || (typeof m.get === "function" && typeof m.commit === "function")); });
  var MessageStore = (findByProps && findByProps("getMessage", "getMessages")) || (findByStoreName && findByStoreName("MessageStore"));
  var ChannelStore = (findByProps && findByProps("getChannel", "getDMFromUserId")) || (findByStoreName && findByStoreName("ChannelStore"));
  var UserStore = (findByStoreName && findByStoreName("UserStore")) || (findByProps && findByProps("getCurrentUser"));
  var AuthStore = (findByStoreName && findByStoreName("AuthenticationStore")) || (findByProps && findByProps("getToken"));
  var MessageActions = (findByProps && findByProps("deleteMessage", "startEditMessage")) || (findByProps && findByProps("deleteMessage"));
  var MessageRecordUtils = (findByProps && findByProps("updateMessageRecord", "createMessageRecord")) || rawFind(function(m) { return typeof m?.updateMessageRecord === "function"; });

  function getCurrentUserId() {
    return (UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser().id) ||
           (AuthStore && AuthStore.getId && AuthStore.getId()) ||
           (AuthStore && AuthStore.getCurrentUser && AuthStore.getCurrentUser().id);
  }

  function evictOldest(map, max) {
    while (map.size > max) {
      var key = map.keys().next().value;
      if (key === undefined) break;
      map.delete(key);
    }
  }

  function rememberMessage(msg) {
    if (!msg || !msg.id) return;
    shadowMessages.set(String(msg.id), msg);
    evictOldest(shadowMessages, MAX_CACHE_SIZE);
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

  function reinsertMessageIntoStore(channelId, originalMsg) {
    if (!ChannelMessages || !channelId || !originalMsg) return false;
    try {
      var record = ChannelMessages.get(channelId);
      if (record && typeof record.receiveMessage === "function") {
        var next = record.receiveMessage(originalMsg);
        ChannelMessages.commit(next);
        return true;
      }
    } catch (err) {
      console.warn(TAG, "Failed ChannelMessages.receiveMessage:", err);
    }
    return false;
  }

  function handleRow(row, opts, RED_BG, RED_GUTTER, YELLOW_BG, YELLOW_GUTTER, RED_TEXT) {
    if (!row || row.type !== 1) return;
    var msg = row.message;
    if (!msg || !msg.id) return;

    var isDeleted = fakedMessages.has(msg.id) || Boolean(msg.was_deleted);
    var isEdited = editHistory.has(msg.id);

    if (!isDeleted && !isEdited) return;

    if (isDeleted) {
      msg.edited = "(deleted)";
      if (opts.colorHighlights !== false) {
        msg.textColor = RED_TEXT;
        row.backgroundHighlight = {
          backgroundColor: RED_BG,
          gutterColor: RED_GUTTER
        };
      }
    } else if (isEdited && opts.colorHighlights !== false) {
      row.backgroundHighlight = {
        backgroundColor: YELLOW_BG,
        gutterColor: YELLOW_GUTTER
      };
    }
  }

  function Settings() {
    if (!React) return null;
    var opts = storage.options || (storage.options = {});
    var Forms = ui.components && ui.components.Forms;
    var General = ui.components && ui.components.General;
    var ScrollView = (General && General.ScrollView) || (ReactNative && ReactNative.ScrollView) || "ScrollView";
    var View = (General && General.View) || (ReactNative && ReactNative.View) || "View";
    var Text = (General && General.Text) || (ReactNative && ReactNative.Text) || "Text";
    var FormSection = Forms && Forms.FormSection;
    var FormSwitchRow = Forms && Forms.FormSwitchRow;
    var FormRow = Forms && Forms.FormRow;
    var FormDivider = Forms && Forms.FormDivider;

    return React.createElement(
      ScrollView,
      { style: { flex: 1, padding: 12 } },
      React.createElement(
        View,
        { style: { marginBottom: 16, padding: 14, backgroundColor: "#1e1f22", borderRadius: 8 } },
        React.createElement(Text, { style: { fontSize: 18, fontWeight: "bold", color: "#f04747", marginBottom: 4 } }, "Lucid Message Logger (Vencord Edition)"),
        React.createElement(Text, { style: { fontSize: 13, color: "#949BA4" } }, "Direct store reinsertion + Vencord PC red/yellow highlights & native delete.")
      ),
      FormSection ? React.createElement(
        FormSection,
        { title: "Appearance & Styling" },
        React.createElement(FormSwitchRow, {
          label: "Vencord Background Highlights",
          subLabel: "Soft red highlight on deleted messages, amber on edits",
          value: opts.colorHighlights !== false,
          onValueChange: function (v) { opts.colorHighlights = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Preserve Deleted Images & Media",
          subLabel: "Retain attachments and stickers even after deletion",
          value: opts.preserveMedia !== false,
          onValueChange: function (v) { opts.preserveMedia = v; }
        })
      ) : null,
      FormSection ? React.createElement(
        FormSection,
        { title: "Logging Options" },
        React.createElement(FormSwitchRow, {
          label: "Log Deleted Messages",
          subLabel: "Keep deleted messages visible in chat",
          value: opts.logDeleted !== false,
          onValueChange: function (v) { opts.logDeleted = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Log Edited Messages",
          subLabel: "Show old text and edit history",
          value: opts.logEdited !== false,
          onValueChange: function (v) { opts.logEdited = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Ignore Bots",
          subLabel: "Do not log bot deletions or edits",
          value: Boolean(opts.ignoreBots),
          onValueChange: function (v) { opts.ignoreBots = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Ignore My Own Messages",
          subLabel: "Do not log your own deletions or edits",
          value: Boolean(opts.ignoreSelf),
          onValueChange: function (v) { opts.ignoreSelf = v; }
        })
      ) : null,
      FormSection ? React.createElement(
        FormSection,
        { title: "Diagnostics & Storage" },
        React.createElement(FormRow, {
          label: "Clear Memory Cache",
          subLabel: fakedMessages.size + " deleted kept inline (" + shadowMessages.size + " messages cached)",
          onPress: function () {
            var count = fakedMessages.size;
            fakedMessages.clear();
            editHistory.clear();
            shadowMessages.clear();
            if (toasts && toasts.showToast) {
              toasts.showToast("Cleared " + count + " logged messages from Lucid cache!");
            }
          }
        })
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

      var RED_BG = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f047471f") : "#f047471f";
      var RED_GUTTER = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f04747") : "#f04747";
      var YELLOW_BG = ReactNative && ReactNative.processColor ? ReactNative.processColor("#faa61a18") : "#faa61a18";
      var YELLOW_GUTTER = ReactNative && ReactNative.processColor ? ReactNative.processColor("#faa61a") : "#faa61a";
      var RED_TEXT = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f04747") : "#f04747";

      // 1. NATIVE DELETE ACTION
      if (before && MessageActions && MessageActions.deleteMessage) {
        var unpatchDelete = before("deleteMessage", MessageActions, function (args) {
          try {
            var channelId = args[0];
            var messageId = args[1];
            if (!messageId) return;

            manualDeletes.add(messageId);
            fakedMessages.delete(messageId);
            editHistory.delete(messageId);
            shadowMessages.delete(messageId);

            if (ChannelMessages && ChannelMessages.get) {
              var record = ChannelMessages.get(channelId);
              if (record) {
                try {
                  if (typeof record.remove === "function") {
                    ChannelMessages.commit(record.remove(messageId));
                  } else if (typeof record.delete === "function") {
                    record.delete(messageId);
                  }
                } catch (e) {}
              }
            }

            if (FluxDispatcher && FluxDispatcher.dispatch) {
              FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId: channelId,
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

      // 2. PRESERVE WAS_DELETED IN MESSAGERECORDUTILS
      if (after && MessageRecordUtils) {
        if (MessageRecordUtils.createMessageRecord) {
          cleanups.push(
            after("createMessageRecord", MessageRecordUtils, function (args, record) {
              var msg = args && args[0];
              if ((msg && msg.was_deleted) || (record && record.was_deleted)) {
                if (record) record.was_deleted = true;
              }
            })
          );
        }
        if (MessageRecordUtils.updateMessageRecord) {
          cleanups.push(
            after("updateMessageRecord", MessageRecordUtils, function (args, record) {
              var oldRec = args && args[0];
              var newRec = args && args[1];
              if ((oldRec && oldRec.was_deleted) || (newRec && newRec.was_deleted)) {
                if (record) record.was_deleted = true;
              }
            })
          );
        }
      }

      // 3. FLUX EVENT LISTENERS (BOTH SUBSCRIBE & DISPATCH HOOKS FOR 100% COVERAGE)
      if (FluxDispatcher) {
        // 3A. Shadow cache populator
        var handleCreate = function (ev) {
          if (ev && ev.message) rememberMessage(ev.message);
        };
        var handleLoadSuccess = function (ev) {
          if (ev && Array.isArray(ev.messages)) {
            for (var i = 0; i < ev.messages.length; i++) rememberMessage(ev.messages[i]);
          }
        };

        FluxDispatcher.subscribe("MESSAGE_CREATE", handleCreate);
        cleanups.push(function () { FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleCreate); });

        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", handleLoadSuccess);
        cleanups.push(function () { FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", handleLoadSuccess); });

        // 3B. Subscription listener for MESSAGE_DELETE (re-inserts message if deleted)
        var handleDeleteSubscribe = function (ev) {
          if (!ev || !opts.logDeleted) return;
          var messageId = ev.id;
          var channelId = ev.channelId || ev.channel_id;
          if (!messageId || !channelId) return;

          if (manualDeletes.has(messageId) || ev.manualDelete) {
            manualDeletes.delete(messageId);
            fakedMessages.delete(messageId);
            return;
          }

          var original = shadowMessages.get(messageId);
          if (!original) return;

          var author = original.author;
          var isBot = Boolean(author && (author.bot || (author.isNonUserBot && author.isNonUserBot())));
          if (isBot && (original.flags === 64 || (original.flags & 64) === 64)) return;
          if (opts.ignoreBots && isBot) return;
          if (opts.ignoreSelf && author && author.id === getCurrentUserId()) return;

          // Re-insert into store
          var success = reinsertMessageIntoStore(channelId, original);
          fakedMessages.set(messageId, channelId);
          evictOldest(fakedMessages, MAX_CACHE_SIZE);
        };

        FluxDispatcher.subscribe("MESSAGE_DELETE", handleDeleteSubscribe);
        cleanups.push(function () { FluxDispatcher.unsubscribe("MESSAGE_DELETE", handleDeleteSubscribe); });

        // 3C. Dispatch hook for real-time interception & Edits
        if (before) {
          var unpatchFlux = before("dispatch", FluxDispatcher, function (args) {
            try {
              var ev = args[0];
              if (!ev || !ev.type || ev.otherPluginBypass) return;

              var currentUserId = getCurrentUserId();

              if (ev.type === "MESSAGE_CREATE" && ev.message) {
                rememberMessage(ev.message);
                return;
              }

              if (ev.type === "LOAD_MESSAGES_SUCCESS" && Array.isArray(ev.messages)) {
                for (var m = 0; m < ev.messages.length; m++) rememberMessage(ev.messages[m]);
                return;
              }

              /* MESSAGE_DELETE: Prevent deletion & keep inline */
              if (ev.type === "MESSAGE_DELETE" && opts.logDeleted) {
                var delMessageId = ev.id;
                var delChannelId = ev.channelId || ev.channel_id;
                if (!delMessageId || !delChannelId) return;

                if (manualDeletes.has(delMessageId) || ev.manualDelete) {
                  manualDeletes.delete(delMessageId);
                  fakedMessages.delete(delMessageId);
                  return;
                }

                var orig =
                  shadowMessages.get(delMessageId) ||
                  (ChannelMessages && ChannelMessages.get && ChannelMessages.get(delChannelId) && ChannelMessages.get(delChannelId).get && ChannelMessages.get(delChannelId).get(delMessageId)) ||
                  (MessageStore && MessageStore.getMessage && MessageStore.getMessage(delChannelId, delMessageId));

                if (!orig) return;

                var author = orig.author;
                var isBot = Boolean(author && (author.bot || (author.isNonUserBot && author.isNonUserBot())));
                if (isBot && (orig.flags === 64 || (orig.flags & 64) === 64)) return;
                if (opts.ignoreBots && isBot) return;
                if (opts.ignoreSelf && author && author.id === currentUserId) return;

                // Cache for reinsertion
                rememberMessage(orig);
                fakedMessages.set(delMessageId, delChannelId);
                evictOldest(fakedMessages, MAX_CACHE_SIZE);

                // Try in-place store re-insert
                reinsertMessageIntoStore(delChannelId, orig);

                // Convert deletion into an update event
                ev.type = "MESSAGE_UPDATE";
                ev.channelId = orig.channel_id || orig.channelId || delChannelId;
                ev.message = Object.assign({}, orig, {
                  id: delMessageId,
                  channel_id: orig.channel_id || orig.channelId || delChannelId,
                  was_deleted: true
                });
                ev.optimistic = false;
                ev.sendMessageOptions = {};
                ev.isPushNotification = false;

                return args;
              }

              /* MESSAGE_UPDATE (Edits) */
              if (ev.type === "MESSAGE_UPDATE" && opts.logEdited) {
                var updateMsg = ev.message;
                if (!updateMsg) return;

                if (!updateMsg.edited_timestamp || updateMsg.edited_timestamp === "invalid_timestamp") return;

                var editChId = updateMsg.channel_id || ev.channelId || ev.channel_id;
                var editMsgId = updateMsg.id || ev.id;
                if (!editChId || !editMsgId) return;

                var origEdit =
                  shadowMessages.get(editMsgId) ||
                  (ChannelMessages && ChannelMessages.get && ChannelMessages.get(editChId) && ChannelMessages.get(editChId).get && ChannelMessages.get(editChId).get(editMsgId)) ||
                  (MessageStore && MessageStore.getMessage && MessageStore.getMessage(editChId, editMsgId));

                if (!origEdit || !origEdit.author || !origEdit.author.id) return;

                if (opts.ignoreBots && (origEdit.author.bot || (origEdit.author.isNonUserBot && origEdit.author.isNonUserBot()))) return;
                if (opts.ignoreSelf && origEdit.author.id === currentUserId) return;

                var oldContent = origEdit.content || "";
                var newContent = updateMsg.content || "";

                var hadAttachments = origEdit.attachments && origEdit.attachments.length > 0;
                var lostAttachments = hadAttachments && (!updateMsg.attachments || updateMsg.attachments.length < origEdit.attachments.length);

                if (oldContent === newContent && !lostAttachments) return;
                if (oldContent.indexOf("~~") !== -1 && oldContent.endsWith(newContent)) return;

                editHistory.set(editMsgId, oldContent);
                evictOldest(editHistory, MAX_CACHE_SIZE);

                var preservedAttachments = opts.preserveMedia !== false ? mergeAttachments(origEdit, updateMsg) : (updateMsg.attachments || []);
                var formattedContent = oldContent !== newContent
                  ? ("~~" + oldContent + "~~ `(edited)`\n" + newContent)
                  : oldContent;

                ev.message = Object.assign({}, origEdit, updateMsg, {
                  content: formattedContent,
                  attachments: preservedAttachments,
                  edited_timestamp: "invalid_timestamp"
                });

                rememberMessage(ev.message);
                return args;
              }
            } catch (e) {
              console.error(TAG, "Flux dispatch error:", e);
            }
          });
          cleanups.push(unpatchFlux);
        }
      }

      // 4. ROW STYLING (Red for Deleted, Yellow for Edited)
      var DCDChatManager = ReactNative && ReactNative.NativeModules && ReactNative.NativeModules.DCDChatManager;
      var applyHook = function (target) {
        cleanups.push(
          before("updateRows", target, function (args) {
            if (!fakedMessages.size && !editHistory.size) return;
            var raw = args && args[1];
            if (!raw) return;

            if (typeof raw === "string") {
              try {
                var rows = JSON.parse(raw);
                var mutated = false;
                for (var i = 0; i < rows.length; i++) {
                  var row = rows[i];
                  if (row && row.type === 1 && row.message) {
                    if (fakedMessages.has(row.message.id) || row.message.was_deleted || editHistory.has(row.message.id)) {
                      handleRow(row, opts, RED_BG, RED_GUTTER, YELLOW_BG, YELLOW_GUTTER, RED_TEXT);
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
                handleRow(raw[j], opts, RED_BG, RED_GUTTER, YELLOW_BG, YELLOW_GUTTER, RED_TEXT);
              }
            } else if (raw && typeof raw === "object" && Array.isArray(raw.rows)) {
              for (var r = 0; r < raw.rows.length; r++) {
                handleRow(raw.rows[r], opts, RED_BG, RED_GUTTER, YELLOW_BG, YELLOW_GUTTER, RED_TEXT);
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
            if (!fakedMessages.size && !editHistory.size) return;
            var row = (rowObj && rowObj.row) || rowObj;
            handleRow(row, opts, RED_BG, RED_GUTTER, YELLOW_BG, YELLOW_GUTTER, RED_TEXT);
          })
        );
      }
    },

    onUnload: function () {
      for (var i = 0; i < cleanups.length; i++) {
        try { cleanups[i](); } catch (e) {}
      }
      cleanups.length = 0;
      shadowMessages.clear();
      fakedMessages.clear();
      editHistory.clear();
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
