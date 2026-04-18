// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// v2 ships with no channels baked in. Channel skills (e.g. /add-slack-v2,
// /add-discord-v2, /add-whatsapp-v2) copy the channel module from the
// `channels` branch and append a self-registration import below.
import './telegram.js';
import './discord.js';
