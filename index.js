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
  var MAX_CACHE_SIZE = 800;

  var deletedMessagesMap = new Map();
  var editedMessagesMap = new Map();
  var manualDeletes = new Set();
  var cleanups = [];

  var MessageStore = findByProps ? findByProps("getMessage", "getMessages") : null;
  var ChannelMessages = findByProps ? findByProps("_channelMessages") : null;
  var ChannelStore = findByProps ? findByProps("getChannel", "getDMFromUserId") : null;
  var UserStore = findByStoreName ? findByStoreName("UserStore") : null;
  var AuthStore = (findByStoreName && findByStoreName("AuthenticationStore")) || (findByProps && findByProps("getToken"));
  var MessageActions = (findByProps && findByProps("deleteMessage", "startEditMessage")) || (findByProps && findByProps("deleteMessage"));
  var MessageRecordUtils = findByProps ? findByProps("updateMessageRecord", "createMessageRecord") : null;

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

  function authorToGateway(a) {
    if (!a || typeof a !== "object") return a;
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

  function recordToGateway(record) {
    if (!record || typeof record !== "object") return record;
    return Object.assign({}, record, {
      author: authorToGateway(record.author),
      embeds: Array.isArray(record.embeds) ? record.embeds.map(embedToGateway) : record.embeds,
      attachments: Array.isArray(record.attachments) ? record.attachments : []
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
    if (!msg) return;

    var isDeleted = deletedMessagesMap.has(msg.id) || Boolean(msg.was_deleted);
    var isEdited = editedMessagesMap.has(msg.id);

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
        React.createElement(Text, { style: { fontSize: 13, color: "#949BA4" } }, "Desktop Vencord UI with red/yellow highlights, deleted retention, and native delete.")
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
          subLabel: deletedMessagesMap.size + " deleted messages currently logged in RAM",
          onPress: function () {
            var count = deletedMessagesMap.size;
            deletedMessagesMap.clear();
            editedMessagesMap.clear();
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

      // 1. PATCH NATIVE DELETE ACTION
      if (before && MessageActions && MessageActions.deleteMessage) {
        var unpatchDelete = before("deleteMessage", MessageActions, function (args) {
          try {
            var channelId = args[0];
            var messageId = args[1];
            if (!messageId) return;

            manualDeletes.add(messageId);
            deletedMessagesMap.delete(messageId);
            editedMessagesMap.delete(messageId);

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

      // 2. PATCH MESSAGE RECORD CREATION/UPDATE (Preserves was_deleted flag in Discord Store)
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

      // 3. PATCH FLUX DISPATCHER
      if (!before || !FluxDispatcher) {
        console.warn(TAG, "FluxDispatcher or patcher not found!");
        return;
      }

      var unpatchFlux = before("dispatch", FluxDispatcher, function (args) {
        try {
          var ev = args[0];
          if (!ev || !ev.type || ev.otherPluginBypass) return;

          var currentUserId = getCurrentUserId();

          /* 3A. MESSAGE_DELETE */
          if (ev.type === "MESSAGE_DELETE" && opts.logDeleted) {
            if (ev.manualDelete || manualDeletes.has(ev.id)) {
              manualDeletes.delete(ev.id);
              deletedMessagesMap.delete(ev.id);
              return;
            }

            var orig =
              (ChannelMessages && ChannelMessages.get && ChannelMessages.get(ev.channelId) && ChannelMessages.get(ev.channelId).get && ChannelMessages.get(ev.channelId).get(ev.id)) ||
              (MessageStore && MessageStore.getMessage && MessageStore.getMessage(ev.channelId, ev.id)) ||
              (deletedMessagesMap.get(ev.id) && deletedMessagesMap.get(ev.id).original);

            if (!orig || !orig.author || !orig.author.id) return;

            // Ephemeral message dismiss check (flags: 64)
            if (orig.author.bot && (orig.flags === 64 || (orig.flags & 64) === 64)) return;

            // Empty message check
            if (!orig.content && (!orig.attachments || !orig.attachments.length) && (!orig.embeds || !orig.embeds.length)) return;

            if (opts.ignoreBots && (orig.author.bot || (orig.author.isNonUserBot && orig.author.isNonUserBot()))) return;
            if (opts.ignoreSelf && orig.author.id === currentUserId) return;

            if (deletedMessagesMap.has(ev.id)) {
              ev.type = "MESSAGE_UPDATE";
              ev.channelId = orig.channel_id || ev.channelId;
              ev.message = {
                id: ev.id,
                channel_id: orig.channel_id || ev.channelId,
                was_deleted: true
              };
              return args;
            }

            var guildId = (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(orig.channel_id || ev.channelId) && ChannelStore.getChannel(orig.channel_id || ev.channelId).guild_id) || orig.guild_id;
            var gatewayOrig = recordToGateway(orig);

            ev.message = Object.assign({}, gatewayOrig, {
              content: orig.content,
              channel_id: orig.channel_id || ev.channelId,
              guild_id: guildId,
              was_deleted: true,
              message_reference: orig.message_reference || orig.messageReference || null
            });

            ev.type = "MESSAGE_UPDATE";
            ev.channelId = orig.channel_id || ev.channelId;
            ev.optimistic = false;
            ev.sendMessageOptions = {};
            ev.isPushNotification = false;

            deletedMessagesMap.set(ev.id, { message: args, original: orig });
            trimMap(deletedMessagesMap);

            return args;
          }

          /* 3B. MESSAGE_DELETE_BULK */
          if (ev.type === "MESSAGE_DELETE_BULK" && opts.logDeleted) {
            if (!Array.isArray(ev.ids)) return;

            for (var k = 0; k < ev.ids.length; k++) {
              var id = ev.ids[k];
              if (manualDeletes.has(id)) {
                manualDeletes.delete(id);
                continue;
              }

              var origBulk =
                (ChannelMessages && ChannelMessages.get && ChannelMessages.get(ev.channelId) && ChannelMessages.get(ev.channelId).get && ChannelMessages.get(ev.channelId).get(id)) ||
                (MessageStore && MessageStore.getMessage && MessageStore.getMessage(ev.channelId, id));

              if (!origBulk || !origBulk.author || !origBulk.author.id) continue;
              if (opts.ignoreBots && (origBulk.author.bot || (origBulk.author.isNonUserBot && origBulk.author.isNonUserBot()))) continue;
              if (opts.ignoreSelf && origBulk.author.id === currentUserId) continue;

              deletedMessagesMap.set(id, { original: origBulk });
              trimMap(deletedMessagesMap);

              var gatewayBulk = recordToGateway(origBulk);
              FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                channelId: ev.channelId,
                message: Object.assign({}, gatewayBulk, {
                  was_deleted: true
                }),
                otherPluginBypass: true
              });
            }
            return;
          }

          /* 3C. MESSAGE_UPDATE */
          if (ev.type === "MESSAGE_UPDATE" && opts.logEdited) {
            var msg = ev.message;
            if (!msg) return;

            if (!msg.edited_timestamp || msg.edited_timestamp === "invalid_timestamp") return;

            var chId = msg.channel_id || ev.channelId;
            var msgId = msg.id || ev.id;
            if (!chId || !msgId) return;

            var origEdit =
              (MessageStore && MessageStore.getMessage && MessageStore.getMessage(chId, msgId)) ||
              (ChannelMessages && ChannelMessages.get && ChannelMessages.get(chId) && ChannelMessages.get(chId).get && ChannelMessages.get(chId).get(msgId));

            if (!origEdit || !origEdit.author || !origEdit.author.id) return;

            if (opts.ignoreBots && (origEdit.author.bot || (origEdit.author.isNonUserBot && origEdit.author.isNonUserBot()))) return;
            if (opts.ignoreSelf && origEdit.author.id === currentUserId) return;

            var oldContent = origEdit.content || "";
            var newContent = msg.content || "";

            var hadAttachments = origEdit.attachments && origEdit.attachments.length > 0;
            var lostAttachments = hadAttachments && (!msg.attachments || msg.attachments.length < origEdit.attachments.length);

            if (oldContent === newContent && !lostAttachments) return;
            if (oldContent.indexOf("~~") !== -1 && oldContent.endsWith(newContent)) return;

            editedMessagesMap.set(msgId, { original: origEdit });
            trimMap(editedMessagesMap);

            var gatewayOrigEdit = recordToGateway(origEdit);
            var preservedAttachments = opts.preserveMedia !== false ? mergeAttachments(origEdit, msg) : (msg.attachments || []);

            var formattedContent = oldContent !== newContent
              ? ("~~" + oldContent + "~~ `(edited)`\n" + newContent)
              : oldContent;

            ev.message = Object.assign({}, gatewayOrigEdit, msg, {
              content: formattedContent,
              attachments: preservedAttachments,
              guild_id: (ChannelStore && ChannelStore.getChannel && ChannelStore.getChannel(chId) && ChannelStore.getChannel(chId).guild_id) || msg.guild_id,
              edited_timestamp: "invalid_timestamp",
              message_reference: msg.message_reference || origEdit.messageReference || origEdit.message_reference || null
            });

            return args;
          }
        } catch (e) {
          console.error(TAG, "Flux dispatch error:", e);
        }
      });
      cleanups.push(unpatchFlux);

      // 4. PATCH ROW STYLING (Applies red/yellow background and (deleted) label to chat rows)
      var DCDChatManager = ReactNative && ReactNative.NativeModules && ReactNative.NativeModules.DCDChatManager;
      var applyHook = function (target) {
        cleanups.push(
          before("updateRows", target, function (args) {
            if (!deletedMessagesMap.size && !editedMessagesMap.size) return;
            var raw = args && args[1];
            if (!raw) return;

            if (typeof raw === "string") {
              try {
                var rows = JSON.parse(raw);
                var mutated = false;
                for (var i = 0; i < rows.length; i++) {
                  var row = rows[i];
                  if (row && row.type === 1 && row.message) {
                    if (deletedMessagesMap.has(row.message.id) || row.message.was_deleted || editedMessagesMap.has(row.message.id)) {
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

      var chatModule = (findByProps && findByProps("updateRows", "getConstants")) || (findByProps && findByProps("updateRows"));
      if (chatModule && chatModule !== DCDChatManager) {
        applyHook(chatModule);
      }

      var RowManager = (findByName && findByName("RowManager", false)) || (findByProps && findByProps("RowManager") && findByProps("RowManager").RowManager);
      if (after && RowManager && RowManager.prototype && RowManager.prototype.generate) {
        cleanups.push(
          after("generate", RowManager.prototype, function (_args, rowObj) {
            if (!deletedMessagesMap.size && !editedMessagesMap.size) return;
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
      deletedMessagesMap.clear();
      editedMessagesMap.clear();
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
