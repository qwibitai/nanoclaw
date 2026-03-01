/**
 * WSL2 IPv6 workaround: force Node.js to use IPv4 only for DNS lookups.
 *
 * WSL2 advertises IPv6 addresses but the IPv6 network is unreachable.
 * Node.js Happy Eyeballs tries both IPv4 and IPv6 simultaneously, and the
 * aggregate timeout fires before the IPv4 connection completes.
 * Forcing IPv4-only lookups avoids the race and lets connections succeed.
 *
 * Loaded via: node --require ./dns-ipv4-patch.cjs dist/index.js
 */
const dns = require('dns');
const original = dns.lookup.bind(dns);
dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') { options = { family: options }; }
  options = { ...options, family: 4 };
  return original(hostname, options, callback);
};
