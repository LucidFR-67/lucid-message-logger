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
  var FluxDispatcher = common.FluxDispatcher;
  var React = common.React;
  var ReactNative = common.ReactNative;

  var TAG = "[LucidLogger]";
  var MAX_CACHE_SIZE = 500;

  var deletedCache = new Map();
  var deletedSet = new Set();
  var editedSet = new Set();
  var manualDeletes = new Set();
  var cleanups = [];

  var MessageStore = findByProps ? findByProps("getMessage", "getMessages") : null;
  var ChannelMessages = findByProps ? findByProps("_channelMessages") : null;
  var ChannelStore = findByProps ? findByProps("getChannel", "getDMFromUserId") : null;
  var UserStore = findByStoreName ? findByStoreName("UserStore") : null;
  var AuthStore = (findByStoreName && findByStoreName("AuthenticationStore")) || (findByProps && findByProps("getToken"));
  var MessageActions = (findByProps && findByProps("deleteMessage", "startEditMessage")) || (findByProps && findByProps("deleteMessage"));

  function getCurrentUserId() {
    return (UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser().id) ||
           (AuthStore && AuthStore.getId && AuthStore.getId()) ||
           (AuthStore && AuthStore.getCurrentUser && AuthStore.getCurrentUser().id);
  }

  function trimLRUCache() {
    if (deletedCache.size > MAX_CACHE_SIZE) {
      var oldestKey = deletedCache.keys().next().value;
      if (oldestKey !== undefined) {
        deletedCache.delete(oldestKey);
        deletedSet.delete(oldestKey);
      }
    }
    if (editedSet.size > MAX_CACHE_SIZE) {
      var oldestEditKey = editedSet.keys().next().value;
      if (oldestEditKey !== undefined) editedSet.delete(oldestEditKey);
    }
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

  function recordToGateway(msg) {
    if (!msg) return null;
    return {
      id: msg.id,
      channel_id: msg.channel_id || msg.channelId,
      guild_id: msg.guild_id || msg.guildId,
      content: msg.content !== undefined && msg.content !== null ? msg.content : "",
      author: msg.author ? {
        id: msg.author.id,
        username: msg.author.username,
        discriminator: msg.author.discriminator !== undefined ? msg.author.discriminator : "0",
        avatar: msg.author.avatar,
        bot: Boolean(msg.author.bot || (msg.author.isNonUserBot && msg.author.isNonUserBot())),
        global_name: msg.author.globalName || msg.author.global_name
      } : { id: "0", username: "Unknown" },
      attachments: msg.attachments || [],
      embeds: msg.embeds || [],
      mentions: msg.mentions || [],
      mention_roles: msg.mentionRoles || msg.mention_roles || [],
      pinned: Boolean(msg.pinned),
      timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString(),
      flags: msg.flags !== undefined ? msg.flags : 0,
      components: msg.components || [],
      sticker_items: msg.sticker_items || msg.stickerItems || msg.stickers || [],
      message_reference: msg.message_reference || msg.messageReference || null
    };
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
        React.createElement(Text, { style: { fontSize: 18, fontWeight: "bold", color: "#5865F2", marginBottom: 4 } }, "Lucid Message Logger"),
        React.createElement(Text, { style: { fontSize: 13, color: "#949BA4" } }, "⚡ Inline message logger with red/yellow backgrounds & native delete support.")
      ),
      FormSection ? React.createElement(
        FormSection,
        { title: "Visual & Styling" },
        React.createElement(FormSwitchRow, {
          label: "Colored Background Highlights",
          subLabel: "Red background on deleted messages & yellow on edits",
          value: opts.colorHighlights !== false,
          onValueChange: function (v) { opts.colorHighlights = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Preserve Deleted Images & Media",
          subLabel: "Retain images, attachments, and stickers if deleted or edited out",
          value: opts.preserveMedia !== false,
          onValueChange: function (v) { opts.preserveMedia = v; }
        })
      ) : null,
      FormSection ? React.createElement(
        FormSection,
        { title: "Logging Features" },
        React.createElement(FormSwitchRow, {
          label: "Log Deleted Messages",
          subLabel: "Keep deleted messages visible inline with [ DELETED ] tag",
          value: opts.logDeleted !== false,
          onValueChange: function (v) { opts.logDeleted = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Log Edited Messages",
          subLabel: "Keep edit history visible with [ EDITED ] tag",
          value: opts.logEdited !== false,
          onValueChange: function (v) { opts.logEdited = v; }
        })
      ) : null,
      FormSection ? React.createElement(
        FormSection,
        { title: "Filters & Ignored" },
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
        { title: "Storage & Actions" },
        React.createElement(FormRow, {
          label: "Clear Active Memory Cache",
          subLabel: "Currently tracking " + deletedCache.size + " deleted messages in RAM",
          onPress: function () {
            var count = deletedCache.size;
            deletedCache.clear();
            deletedSet.clear();
            editedSet.clear();
            if (toasts && toasts.showToast) {
              toasts.showToast("Cleared " + count + " messages from Lucid cache!");
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

      var RED_BG = ReactNative && ReactNative.processColor ? ReactNative.processColor("#da373c26") : "#da373c26";
      var RED_GUTTER = ReactNative && ReactNative.processColor ? ReactNative.processColor("#da373cf2") : "#da373cf2";
      var YELLOW_BG = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f0b2321e") : "#f0b2321e";
      var YELLOW_GUTTER = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f0b232e6") : "#f0b232e6";

      // 1. PATCH NATIVE DELETE ACTION
      if (before && MessageActions && MessageActions.deleteMessage) {
        var unpatchDelete = before("deleteMessage", MessageActions, function (args) {
          try {
            var channelId = args[0];
            var messageId = args[1];
            if (!messageId) return;

            manualDeletes.add(messageId);

            if (deletedCache.has(messageId)) {
              deletedCache.delete(messageId);
              deletedSet.delete(messageId);
              editedSet.delete(messageId);

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
            }
          } catch (err) {
            console.error(TAG, "deleteMessage hook error:", err);
          }
        });
        cleanups.push(unpatchDelete);
      }

      // 2. PATCH FLUX DISPATCHER
      if (!before || !FluxDispatcher) {
        console.warn(TAG, "FluxDispatcher or patcher not found!");
        return;
      }

      var unpatchFlux = before("dispatch", FluxDispatcher, function (args) {
        try {
          var event = args[0];
          if (!event || !event.type || event.otherPluginBypass) return;

          var currentUserId = getCurrentUserId();

          /* 2A. MESSAGE_DELETE */
          if (event.type === "MESSAGE_DELETE" && opts.logDeleted) {
            var channelId = event.channelId;
            var messageId = event.id;
            if (!channelId || !messageId) return;

            if (manualDeletes.has(messageId) || event.manualDelete) {
              manualDeletes.delete(messageId);
              deletedCache.delete(messageId);
              deletedSet.delete(messageId);
              return;
            }

            var original =
              (MessageStore && MessageStore.getMessage && MessageStore.getMessage(channelId, messageId)) ||
              (ChannelMessages && ChannelMessages.get && ChannelMessages.get(channelId) && ChannelMessages.get(channelId).get(messageId)) ||
              deletedCache.get(messageId);

            if (!original || !original.author || !original.author.id) return;

            if ((original.flags & 64) === 64) return;
            if (opts.ignoreBots && (original.author.bot || (original.author.isNonUserBot && original.author.isNonUserBot()))) return;
            if (opts.ignoreSelf && original.author.id === currentUserId) return;

            var hasContent = original.content && original.content.trim().length > 0;
            var hasMedia = (original.attachments && original.attachments.length > 0) || (original.embeds && original.embeds.length > 0);
            if (!hasContent && !hasMedia) return;

            if (deletedCache.has(messageId)) {
              event.type = "MESSAGE_UPDATE";
              event.message = {
                id: messageId,
                channel_id: channelId,
                was_deleted: true,
                flags: original.flags
              };
              return args;
            }

            deletedCache.set(messageId, original);
            deletedSet.add(messageId);
            trimLRUCache();

            var unixNow = Math.floor(Date.now() / 1000);
            var deletedTag = "`[ DELETED ]` <t:" + unixNow + ":R>\n";
            var gatewayRecord = recordToGateway(original);

            event.type = "MESSAGE_UPDATE";
            event.channelId = channelId;
            event.optimistic = false;
            event.isPushNotification = false;
            event.message = Object.assign({}, gatewayRecord, {
              content: (deletedTag + (original.content || "")).trim(),
              was_deleted: true,
              edited_timestamp: null
            });

            return args;
          }

          /* 2B. MESSAGE_DELETE_BULK */
          if (event.type === "MESSAGE_DELETE_BULK" && opts.logDeleted) {
            var ids = event.ids || [];
            var bulkChannelId = event.channelId;
            if (!ids.length || !bulkChannelId) return;

            for (var k = 0; k < ids.length; k++) {
              var id = ids[k];
              if (manualDeletes.has(id)) {
                manualDeletes.delete(id);
                continue;
              }

              var origBulk =
                (MessageStore && MessageStore.getMessage && MessageStore.getMessage(bulkChannelId, id)) ||
                (ChannelMessages && ChannelMessages.get && ChannelMessages.get(bulkChannelId) && ChannelMessages.get(bulkChannelId).get(id));

              if (!origBulk || (origBulk.author && origBulk.author.bot)) continue;

              var unixNowBulk = Math.floor(Date.now() / 1000);
              var deletedTagBulk = "`[ DELETED ]` <t:" + unixNowBulk + ":R>\n";
              var gatewayRecordBulk = recordToGateway(origBulk);

              deletedCache.set(id, origBulk);
              deletedSet.add(id);
              trimLRUCache();

              FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                channelId: bulkChannelId,
                message: Object.assign({}, gatewayRecordBulk, {
                  content: (deletedTagBulk + (origBulk.content || "")).trim(),
                  was_deleted: true
                }),
                otherPluginBypass: true
              });
            }
            return;
          }

          /* 2C. MESSAGE_UPDATE (Edits) */
          if (event.type === "MESSAGE_UPDATE" && opts.logEdited) {
            var updateMsg = event.message;
            if (!updateMsg || !updateMsg.edited_timestamp || updateMsg.edited_timestamp === "invalid_timestamp") return;

            var editChannelId = updateMsg.channel_id || event.channelId;
            var editMessageId = updateMsg.id || event.id;
            if (!editChannelId || !editMessageId) return;

            var origEdit =
              (MessageStore && MessageStore.getMessage && MessageStore.getMessage(editChannelId, editMessageId)) ||
              (ChannelMessages && ChannelMessages.get && ChannelMessages.get(editChannelId) && ChannelMessages.get(editChannelId).get(editMessageId));

            if (!origEdit || !origEdit.author || !origEdit.author.id) return;

            if (opts.ignoreBots && origEdit.author.bot) return;
            if (opts.ignoreSelf && origEdit.author.id === currentUserId) return;

            var oldText = origEdit.content || "";
            var newText = updateMsg.content || "";

            var hadAttachments = origEdit.attachments && origEdit.attachments.length > 0;
            var lostAttachments = hadAttachments && (!updateMsg.attachments || updateMsg.attachments.length < origEdit.attachments.length);

            if (oldText === newText && !lostAttachments) return;
            if (oldText.indexOf("`[ EDITED ]`") !== -1 && oldText.endsWith(newText)) return;

            editedSet.add(editMessageId);
            trimLRUCache();

            var unixNowEdit = Math.floor(Date.now() / 1000);
            var editTag = "\n`[ EDITED ]` <t:" + unixNowEdit + ":R> ";
            var gatewayRecordEdit = recordToGateway(origEdit);
            var preservedAttachments = opts.preserveMedia ? mergeAttachments(origEdit, updateMsg) : (updateMsg.attachments || []);

            event.message = Object.assign({}, gatewayRecordEdit, updateMsg, {
              content: oldText !== newText ? (oldText + editTag + newText) : oldText,
              attachments: preservedAttachments,
              sticker_items: origEdit.sticker_items || origEdit.stickers || updateMsg.sticker_items || [],
              edited_timestamp: "invalid_timestamp"
            });

            return args;
          }
        } catch (err) {
          console.error(TAG, "Dispatch error:", err);
        }
      });
      cleanups.push(unpatchFlux);

      // 3. ROW STYLING (Red for Deleted, Yellow for Edited)
      var ChatManager = (ReactNative && ReactNative.NativeModules && ReactNative.NativeModules.DCDChatManager) || (findByProps && findByProps("updateRows"));
      if (before && ChatManager && ChatManager.updateRows) {
        var unpatchChat = before("updateRows", ChatManager, function (args) {
          if (!opts.colorHighlights || (!deletedSet.size && !editedSet.size)) return;
          try {
            var rows = typeof args[1] === "string" ? JSON.parse(args[1]) : args[1];
            var modified = false;
            for (var r = 0; r < rows.length; r++) {
              var row = rows[r];
              var rId = row && row.message && row.message.id;
              if (!rId) continue;
              if (deletedSet.has(rId)) {
                row.backgroundHighlight = { backgroundColor: RED_BG, gutterColor: RED_GUTTER };
                modified = true;
              } else if (editedSet.has(rId)) {
                row.backgroundHighlight = { backgroundColor: YELLOW_BG, gutterColor: YELLOW_GUTTER };
                modified = true;
              }
            }
            if (modified) {
              args[1] = typeof args[1] === "string" ? JSON.stringify(rows) : rows;
            }
          } catch (e) {}
        });
        cleanups.push(unpatchChat);
      }

      var RowManager = (findByProps && findByProps("RowManager") && findByProps("RowManager").RowManager) || (findByProps && findByProps("generate") && findByProps("generate").RowManager);
      if (after && RowManager && RowManager.prototype && RowManager.prototype.generate) {
        var unpatchRow = after("generate", RowManager.prototype, function (_args, row) {
          try {
            if (!opts.colorHighlights || !row || !row.message || !row.message.id) return;
            var id = row.message.id;
            if (deletedSet.has(id)) {
              row.backgroundHighlight = { backgroundColor: RED_BG, gutterColor: RED_GUTTER };
            } else if (editedSet.has(id)) {
              row.backgroundHighlight = { backgroundColor: YELLOW_BG, gutterColor: YELLOW_GUTTER };
            }
          } catch (e) {}
        });
        cleanups.push(unpatchRow);
      }
    },

    onUnload: function () {
      for (var i = 0; i < cleanups.length; i++) {
        try { cleanups[i](); } catch (e) {}
      }
      cleanups.length = 0;
      deletedCache.clear();
      deletedSet.clear();
      editedSet.clear();
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
