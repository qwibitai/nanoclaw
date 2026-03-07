import {
  WhatsAppProvider,
  WhatsAppProviderOpts,
} from '../providers/whatsapp.js';
import { registerChannel, ChannelOpts } from './registry.js';

export type WhatsAppChannelOpts = WhatsAppProviderOpts;

// Backward-compatible channel alias over the provider implementation.
export class WhatsAppChannel extends WhatsAppProvider {}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
