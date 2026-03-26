import { AgentLite } from '../src/sdk.js';
import { TelegramChannel } from '../src/channels/telegram.js';

const agent_lite = new AgentLite();

await agent_lite.start();

await agent_lite.registerChannel(new TelegramChannel('8661866633:AAFcPI-aKxvLk5PF96ozzT4JuDEFw51WN3k'));

agent_lite.registerGroup('tg:7123844036', {
  name: 'Main',
  isMain: true,
});
