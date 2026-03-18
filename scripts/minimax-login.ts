import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loginWithMiniMax, ANTHROPIC_URL, type MiniMaxRegion } from '../src/minimax-oauth.js';

const ri = process.argv.indexOf('--region');
const region: MiniMaxRegion = ri > -1
  ? (process.argv[ri + 1] as MiniMaxRegion) : 'global';

console.log('MiniMax OAuth Login (region: ' + region + ')');

const token = await loginWithMiniMax({
  region,
  openUrl: (url) => {
    try {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execSync(cmd + ' ' + url, { stdio: 'ignore' });
    } catch {}
  },
  onDeviceCode: (code, url) => {
    console.log('1. Open in your browser: ' + url);
    console.log('2. Enter code if prompted: ' + code);
    console.log('Polling for approval...');
  },
});

const envPath = path.join(process.cwd(), '.env');
const baseUrl = token.resourceUrl || ANTHROPIC_URL[region];
function upsertEnv(s:string,k:string,v:string):string{
  const re=new RegExp('^'+k+'=.*$','m');
  return re.test(s)?s.replace(re,k+'='+v):s+'\n'+k+'='+v;
}
let env='';try{env=fs.readFileSync(envPath,'utf8');}catch{}
env=upsertEnv(env,'MINIMAX_OAUTH_ACCESS',token.access);
env=upsertEnv(env,'MINIMAX_OAUTH_REFRESH',token.refresh);
env=upsertEnv(env,'MINIMAX_OAUTH_EXPIRES',String(token.expires));
env=upsertEnv(env,'MINIMAX_BASE_URL',baseUrl);
fs.writeFileSync(envPath,env.trimStart());
console.log('Tokens saved. Base URL: '+baseUrl);
console.log('Expires: '+new Date(token.expires).toISOString());
