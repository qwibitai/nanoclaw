// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.
// API channel is first so it gets ownsJid() priority for pending requests.

// api (direct message)
import './api.js';

// discord

// gmail

// irc
import './irc.js';

// slack
import './slack.js';

// telegram
import './telegram.js';

// whatsapp
