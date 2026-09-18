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
  var MAX_CACHE_SIZE = 600;

  var shadowCache = new Map();
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

  function trimCache() {
    if (shadowCache.size > MAX_CACHE_SIZE) {
      var oldestKey = shadowCache.keys().next().value;
      if (oldestKey !== undefined) shadowCache.delete(oldestKey);
    }
    if (deletedCache.size > MAX_CACHE_SIZE) {
      var oldestDelKey = deletedCache.keys().next().value;
      if (oldestDelKey !== undefined) {
        deletedCache.delete(oldestDelKey);
        deletedSet.delete(oldestDelKey);
      }
    }
    if (editedSet.size > MAX_CACHE_SIZE) {
      var oldestEditKey = editedSet.keys().next().value;
      if (oldestEditKey !== undefined) editedSet.delete(oldestEditKey);
    }
  }

  function authorToGateway(a) {
    if (!a) return { id: "0", username: "Unknown", discriminator: "0" };
    return {
      id: String(a.id || "0"),
      username: String(a.username || "Unknown"),
      discriminator: a.discriminator && a.discriminator !== "???" ? String(a.discriminator) : "0",
      avatar: a.avatar || null,
      avatar_decoration_data: a.avatarDecorationData || a.avatar_decoration_data || null,
      bot: Boolean(a.bot),
      global_name: a.globalName || a.global_name || a.username || "Unknown"
    };
  }

  function embedToGateway(e) {
    if (!e || typeof e !== "object") return e;
    return Object.assign({}, e, {
      title: e.rawTitle || e.title,
      description: e.rawDescription || e.description,
      fields: Array.isArray(e.fields) ? e.fields.map(function (f) {
        return {
          name: f.rawName || f.name || "",
          value: f.rawValue || f.value || "",
          inline: Boolean(f.inline)
        };
      }) : undefined,
      author: e.author ? {
        name: e.author.name,
        url: e.author.url,
        icon_url: e.author.iconURL || e.author.icon_url,
        proxy_icon_url: e.author.iconProxyURL || e.author.proxy_icon_url
      } : undefined,
      image: e.image ? {
        url: e.image.url,
        proxy_url: e.image.proxyURL || e.image.proxy_url,
        width: e.image.width,
        height: e.image.height
      } : undefined,
      thumbnail: e.thumbnail ? {
        url: e.thumbnail.url,
        proxy_url: e.thumbnail.proxyURL || e.thumbnail.proxy_url,
        width: e.thumbnail.width,
        height: e.thumbnail.height
      } : undefined
    });
  }

  function messageToGateway(record) {
    if (!record || typeof record !== "object") return null;
    var author = record.author;
    var attachments = record.attachments;
    var embeds = record.embeds;
    var mentions = record.mentions;
    var mentionRoles = record.mentionRoles || record.mention_roles;

    return {
      id: String(record.id),
      channel_id: String(record.channel_id || record.channelId),
      guild_id: record.guild_id || record.guildId || null,
      content: String(record.content || ""),
      author: authorToGateway(author),
      attachments: Array.isArray(attachments) ? attachments.map(function (a) {
        return {
          id: String(a.id || ""),
          filename: a.filename || "attachment",
          url: a.url || "",
          proxy_url: a.proxyURL || a.proxy_url || a.url || "",
          size: a.size || 0,
          content_type: a.contentType || a.content_type || "image/png",
          width: a.width,
          height: a.height
        };
      }) : [],
      embeds: Array.isArray(embeds) ? embeds.map(embedToGateway) : [],
      mentions: Array.isArray(mentions) ? mentions : [],
      mention_roles: Array.isArray(mentionRoles) ? mentionRoles : [],
      pinned: Boolean(record.pinned),
      timestamp: record.timestamp ? new Date(record.timestamp).toISOString() : new Date().toISOString(),
      flags: typeof record.flags === "number" ? record.flags : 0,
      components: Array.isArray(record.components) ? record.components : [],
      sticker_items: record.sticker_items || record.stickerItems || record.stickers || [],
      message_reference: record.message_reference || record.messageReference || null,
      type: typeof record.type === "number" ? record.type : 0
    };
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
        React.createElement(Text, { style: { fontSize: 13, color: "#949BA4" } }, "Desktop Vencord UI with red/yellow backgrounds, strikethrough edits, and native delete.")
      ),
      FormSection ? React.createElement(
        FormSection,
        { title: "Visual & Styling (Vencord PC Theme)" },
        React.createElement(FormSwitchRow, {
          label: "Vencord Background Highlights",
          subLabel: "Soft red highlight on deleted messages, amber on edits",
          value: opts.colorHighlights !== false,
          onValueChange: function (v) { opts.colorHighlights = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Strikethrough Edit Diff",
          subLabel: "Show ~~old text~~ (edited) in Vencord desktop style",
          value: opts.strikethroughEdits !== false,
          onValueChange: function (v) { opts.strikethroughEdits = v; }
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
          subLabel: "Keep deleted messages visible inline",
          value: opts.logDeleted !== false,
          onValueChange: function (v) { opts.logDeleted = v; }
        }),
        React.createElement(FormDivider, null),
        React.createElement(FormSwitchRow, {
          label: "Log Edited Messages",
          subLabel: "Keep full edit history visible",
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
          subLabel: shadowCache.size + " in shadow cache, " + deletedCache.size + " deleted logged",
          onPress: function () {
            shadowCache.clear();
            deletedCache.clear();
            deletedSet.clear();
            editedSet.clear();
            if (toasts && toasts.showToast) {
              toasts.showToast("Cleared Lucid cache successfully!");
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
      if (opts.strikethroughEdits === undefined) opts.strikethroughEdits = true;
      if (opts.ignoreBots === undefined) opts.ignoreBots = false;
      if (opts.ignoreSelf === undefined) opts.ignoreSelf = false;

      var RED_BG = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f047471f") : "#f047471f";
      var RED_GUTTER = ReactNative && ReactNative.processColor ? ReactNative.processColor("#f04747") : "#f04747";
      var YELLOW_BG = ReactNative && ReactNative.processColor ? ReactNative.processColor("#faa61a18") : "#faa61a18";
      var YELLOW_GUTTER = ReactNative && ReactNative.processColor ? ReactNative.processColor("#faa61a") : "#faa61a";

      // 1. HOOK NATIVE DELETE ACTION
      if (before && MessageActions && MessageActions.deleteMessage) {
        var unpatchDelete = before("deleteMessage", MessageActions, function (args) {
          try {
            var channelId = args[0];
            var messageId = args[1];
            if (!messageId) return;

            manualDeletes.add(messageId);
            deletedCache.delete(messageId);
            shadowCache.delete(messageId);
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
          } catch (err) {
            console.error(TAG, "deleteMessage hook error:", err);
          }
        });
        cleanups.push(unpatchDelete);
      }

      // 2. FLUX DISPATCHER LISTENER
      if (!before || !FluxDispatcher) {
        console.warn(TAG, "FluxDispatcher or patcher not found!");
        return;
      }

      var unpatchFlux = before("dispatch", FluxDispatcher, function (args) {
        try {
          var event = args[0];
          if (!event || !event.type || event.otherPluginBypass) return;

          var currentUserId = getCurrentUserId();

          // 2A. MESSAGE_CREATE: Cache all incoming messages immediately
          if (event.type === "MESSAGE_CREATE") {
            var msg = event.message;
            if (msg && msg.id) {
              var gateway = messageToGateway(msg);
              if (gateway) {
                shadowCache.set(msg.id, gateway);
                trimCache();
              }
            }
            return;
          }

          // 2B. MESSAGE_DELETE
          if (event.type === "MESSAGE_DELETE" && opts.logDeleted) {
            var channelId = event.channelId;
            var messageId = event.id;
            if (!channelId || !messageId) return;

            if (manualDeletes.has(messageId) || event.manualDelete) {
              manualDeletes.delete(messageId);
              deletedCache.delete(messageId);
              shadowCache.delete(messageId);
              deletedSet.delete(messageId);
              return;
            }

            var rawOrig =
              shadowCache.get(messageId) ||
              (ChannelMessages && ChannelMessages.get && ChannelMessages.get(channelId) && ChannelMessages.get(channelId).get(messageId)) ||
              (MessageStore && MessageStore.getMessage && MessageStore.getMessage(channelId, messageId)) ||
              (MessageStore && MessageStore.getMessages && MessageStore.getMessages(channelId) && MessageStore.getMessages(channelId).get && MessageStore.getMessages(channelId).get(messageId)) ||
              deletedCache.get(messageId);

            var original = messageToGateway(rawOrig);
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
            trimCache();

            var guildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(channelId) && ChannelStore.getChannel(channelId).guild_id) || original.guild_id;

            var deletedTag = "`(deleted)` ";
            var finalContent = original.content && original.content.indexOf(deletedTag) === 0
              ? original.content
              : (deletedTag + (original.content || "")).trim();

            event.type = "MESSAGE_UPDATE";
            event.channelId = channelId;
            event.optimistic = false;
            event.isPushNotification = false;
            event.message = Object.assign({}, original, {
              content: finalContent,
              guild_id: guildId,
              was_deleted: true,
              edited_timestamp: null
            });

            return args;
          }

          /* 2C. MESSAGE_DELETE_BULK */
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

              var rawBulk =
                shadowCache.get(id) ||
                (ChannelMessages && ChannelMessages.get && ChannelMessages.get(bulkChannelId) && ChannelMessages.get(bulkChannelId).get(id)) ||
                (MessageStore && MessageStore.getMessage && MessageStore.getMessage(bulkChannelId, id));

              var origBulk = messageToGateway(rawBulk);
              if (!origBulk || (origBulk.author && origBulk.author.bot)) continue;

              deletedCache.set(id, origBulk);
              deletedSet.add(id);
              trimCache();

              var dTag = "`(deleted)` ";
              var bContent = origBulk.content && origBulk.content.indexOf(dTag) === 0
                ? origBulk.content
                : (dTag + (origBulk.content || "")).trim();

              FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                channelId: bulkChannelId,
                message: Object.assign({}, origBulk, {
                  content: bContent,
                  was_deleted: true
                }),
                otherPluginBypass: true
              });
            }
            return;
          }

          /* 2D. MESSAGE_UPDATE (Edits) */
          if (event.type === "MESSAGE_UPDATE" && opts.logEdited) {
            var updateMsg = event.message;
            if (!updateMsg || !updateMsg.edited_timestamp || updateMsg.edited_timestamp === "invalid_timestamp") return;

            var editChannelId = updateMsg.channel_id || event.channelId;
            var editMessageId = updateMsg.id || event.id;
            if (!editChannelId || !editMessageId) return;

            var rawEdit =
              shadowCache.get(editMessageId) ||
              (ChannelMessages && ChannelMessages.get && ChannelMessages.get(editChannelId) && ChannelMessages.get(editChannelId).get(editMessageId)) ||
              (MessageStore && MessageStore.getMessage && MessageStore.getMessage(editChannelId, editMessageId));

            var origEdit = messageToGateway(rawEdit);
            if (!origEdit || !origEdit.author || !origEdit.author.id) return;

            if (opts.ignoreBots && origEdit.author.bot) return;
            if (opts.ignoreSelf && origEdit.author.id === currentUserId) return;

            var oldText = origEdit.content || "";
            var newText = updateMsg.content || "";

            var hadAttachments = origEdit.attachments && origEdit.attachments.length > 0;
            var lostAttachments = hadAttachments && (!updateMsg.attachments || updateMsg.attachments.length < origEdit.attachments.length);

            if (oldText === newText && !lostAttachments) return;
            if (oldText.indexOf("~~") !== -1 && oldText.endsWith(newText)) return;

            editedSet.add(editMessageId);
            trimCache();

            var formattedContent = opts.strikethroughEdits && oldText !== newText
              ? ("~~" + oldText + "~~ `(edited)`\n" + newText)
              : (oldText !== newText ? (oldText + "\n`(edited)` " + newText) : oldText);

            var preservedAttachments = opts.preserveMedia ? mergeAttachments(origEdit, updateMsg) : (updateMsg.attachments || []);

            var updatedGateway = messageToGateway(Object.assign({}, origEdit, updateMsg, {
              content: formattedContent,
              attachments: preservedAttachments
            }));

            if (updatedGateway) shadowCache.set(editMessageId, updatedGateway);

            event.message = Object.assign({}, updatedGateway, {
              edited_timestamp: "invalid_timestamp"
            });

            return args;
          }
        } catch (err) {
          console.error(TAG, "Dispatch error:", err);
        }
      });
      cleanups.push(unpatchFlux);

      // 3. ROW STYLING (Vencord PC Red / Yellow Backgrounds)
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
      shadowCache.clear();
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
