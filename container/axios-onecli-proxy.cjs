'use strict';

// OneCLI's gateway is CONNECT-only. axios's built-in HTTPS_PROXY support sends
// absolute-form HTTP that the gateway rejects with 400. Patch axios.defaults
// to use https-proxy-agent (correct CONNECT tunneling) instead.

(() => {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxyUrl) return;

  let HttpsProxyAgent;
  try {
    ({ HttpsProxyAgent } = require(`${__dirname}/node_modules/https-proxy-agent`));
  } catch (err) {
    console.error('[axios-onecli-proxy] https-proxy-agent not vendored — patch skipped:', err.message);
    return;
  }
  const agent = new HttpsProxyAgent(proxyUrl);

  const Module = require('module');
  const origRequire = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    const m = origRequire.apply(this, arguments);
    if (id === 'axios' && m && !m.__nanoclaw_proxy_patched && m.defaults) {
      m.defaults.httpsAgent = agent;
      m.defaults.proxy = false;
      m.__nanoclaw_proxy_patched = true;
    }
    return m;
  };
})();
