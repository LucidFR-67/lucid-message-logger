# ⚡ Lucid Message Logger

An ultra-optimized, crash-proof inline deleted & edited message logger for Android Discord client mods (**Revenge**, **Bunny**, and **Vendetta**).

---

## 🚀 Quick Install

Copy the raw plugin URL below and paste it directly into your Discord mod plugin browser:

```
https://raw.githubusercontent.com/LucidFR-67/lucid-message-logger/main/
```

---

## ✨ Features

- 🗑️ **Deleted Messages Inline:** Keep deleted messages visible in the chat with a clear `[ DELETED ]` badge and dynamic relative timestamp (`<t:UNIX:R>`).
- 🖼️ **Preserve Media & Attachments:** Deleted images, files, and stickers remain visible and loaded from local cache.
- ✏️ **Edit History:** Retains previous versions of edited messages with timestamps without corrupting formatting or codeblocks.
- 🔄 **Preserve Edited-Out Images:** If an image is removed during an edit, it is automatically merged and kept visible.
- ⚡ **Zero Lag:** No heavy `JSON.parse` / `JSON.stringify` bridges on scrolling frames. Execution time is under 0.1ms.
- 🛡️ **Crash-Proof:** Ephemeral slash commands, bot dismissals, and empty payloads are cleanly filtered to prevent Android UI exceptions.
- ⚙️ **In-App Settings UI:** Toggle features, filter bots, ignore self messages, and clear memory cache with one tap.

---

## 🛠️ Configuration Options

Available inside Discord **Settings ➔ Plugins ➔ Lucid Message Logger**:
- **Log Deleted Messages:** Enable/disable inline deleted message logging.
- **Log Edited Messages:** Enable/disable edit history tracking.
- **Preserve Deleted Images & Media:** Keep attachments when deleted or edited out.
- **Ignore Bots:** Prevent bot message clutter.
- **Ignore My Own Messages:** Do not log your own edits/deletes.
- **Clear Active Memory Cache:** One-tap RAM cleanup.

---

## 👤 Author
- **Lucid** (GitHub: [@LucidFR-67](https://github.com/LucidFR-67))
