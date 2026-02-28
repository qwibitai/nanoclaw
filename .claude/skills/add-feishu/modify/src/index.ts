// MODIFY: src/index.ts
// This shows the changes needed to add Feishu channel support

// === IMPORTS (add at top) ===
import { FeishuChannel } from './channels/feishu.js';
import { readEnvFile } from './env.js';
import { DATA_DIR } from './config.js';
import { deleteRegisteredGroup } from './db.js';

// === MODULE STATE (add) ===
let feishu: FeishuChannel;
const channels: Channel[] = [];

// === ADD UNREGISTER FUNCTION (add before main()) ===
function unregisterGroup(jid: string): void {
  const group = registeredGroups[jid];
  if (!group) {
    logger.warn({ jid }, 'Attempted to unregister non-existent group');
    return;
  }

  deleteRegisteredGroup(jid);
  delete registeredGroups[jid];

  // Clean up groups folder
  try {
    const groupDir = resolveGroupFolderPath(group.folder);
    if (fs.existsSync(groupDir)) {
      fs.rmSync(groupDir, { recursive: true, force: true });
      logger.info({ folder: group.folder }, 'Group folder deleted');
    }
  } catch (err) {
    logger.warn({ err, folder: group.folder }, 'Failed to delete group folder');
  }

  // Clean up data/sessions folder
  try {
    const sessionsDir = path.join(DATA_DIR, 'sessions', group.folder);
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      logger.info({ folder: group.folder }, 'Sessions folder deleted');
    }
  } catch (err) {
    logger.warn({ err, folder: group.folder }, 'Failed to delete sessions folder');
  }

  // Clean up data/ipc folder
  try {
    const ipcDir = path.join(DATA_DIR, 'ipc', group.folder);
    if (fs.existsSync(ipcDir)) {
      fs.rmSync(ipcDir, { recursive: true, force: true });
      logger.info({ folder: group.folder }, 'IPC folder deleted');
    }
  } catch (err) {
    logger.warn({ err, folder: group.folder }, 'Failed to delete IPC folder');
  }

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group unregistered');
}

// === MODIFY processGroupMessages() ===
// Remove trigger requirement by changing:
//   if (!isMainGroup && group.requiresTrigger !== false) {
// To:
//   if (false && !isMainGroup && group.requiresTrigger !== false) {

// === MODIFY startMessageLoop() ===
// Change:
//   const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
// To:
//   const needsTrigger = false;

// === MODIFY channelOpts (add) ===
const channelOpts = {
  onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
  onChatMetadata: (chatJid, timestamp, name, channel, isGroup) =>
    storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
  registeredGroups: () => registeredGroups,
  registerGroup,
  unregisterGroup,
};

// === MODIFY main() (add Feishu initialization) ===
// After WhatsApp initialization, add:
const feishuEnv = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
if (feishuEnv.FEISHU_APP_ID && feishuEnv.FEISHU_APP_SECRET) {
  feishu = new FeishuChannel(channelOpts);
  channels.push(feishu);
  await feishu.connect();
} else {
  logger.info('Feishu credentials not found, skipping Feishu channel');
}
