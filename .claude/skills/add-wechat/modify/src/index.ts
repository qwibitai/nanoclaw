import { WeixinChannel } from './channels/weixin.js';
import { WEIXIN_ENABLED } from './config.js';

// In main() function, after QQBot initialization:
  if (WEIXIN_ENABLED) {
    const weixin = new WeixinChannel(channelOpts);
    channels.push(weixin);
    try {
      await weixin.connect();
    } catch (err) {
      logger.warn({ err }, 'WeChat channel failed to connect, continuing without it');
    }
  }
