// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';
import './signal.js';
import './telegram.js';
import './whatsapp.js';
import './slack.js';
import './discord.js';
import './line.js';
import './email.js';
import './imessage.js';
