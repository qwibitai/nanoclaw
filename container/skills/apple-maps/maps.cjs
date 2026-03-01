#!/usr/bin/env node
/**
 * Apple Maps CLI — high-level commands for the agent.
 *
 * Usage:
 *   node maps.cjs directions "Origin Address" "Destination Address" [--mode walking|transit]
 *   node maps.cjs eta "Origin" "Dest1" "Dest2" ... [--mode walking|transit]
 *   node maps.cjs search "query" [--near "lat,lng" | --near "City, State"]
 *   node maps.cjs geocode "address or place name"
 *
 * Handles token management, geocoding, and Apple Maps link generation automatically.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_DIR = '/home/node/.apple-maps';
const CACHE_FILE = '/tmp/apple-maps-token.json';
const TOKEN_TTL = 25 * 60 * 1000;
const API_BASE = 'https://maps-api.apple.com/v1';

// ── Token management (from token.cjs) ───────────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function readConfig() {
  const configPath = path.join(CONFIG_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing ' + configPath + ' — create it with {"teamId":"...","keyId":"..."}');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config.teamId || !config.keyId) {
    throw new Error('config.json must contain "teamId" and "keyId"');
  }
  const keyFiles = fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.p8'));
  if (keyFiles.length === 0) throw new Error('No .p8 key file found in ' + CONFIG_DIR);
  const privateKey = fs.readFileSync(path.join(CONFIG_DIR, keyFiles[0]), 'utf-8');
  return { teamId: config.teamId, keyId: config.keyId, privateKey };
}

function generateAuthToken(teamId, keyId, privateKey) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: teamId, iat: now, exp: now + 1800, sub: 'maps' };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = crypto.createPrivateKey(privateKey);
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  return `${signingInput}.${base64url(sign.sign({ key, dsaEncoding: 'ieee-p1363' }))}`;
}

async function getAccessToken() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (Date.now() - cached.timestamp < TOKEN_TTL) return cached.accessToken;
    } catch { /* regenerate */ }
  }
  const { teamId, keyId, privateKey } = readConfig();
  const authToken = generateAuthToken(teamId, keyId, privateKey);
  const resp = await apiRequest('/token', {}, authToken);
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ accessToken: resp.accessToken, timestamp: Date.now() }));
  return resp.accessToken;
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

function apiRequest(endpoint, params, tokenOverride) {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${API_BASE}${endpoint}${qs ? '?' + qs : ''}`;

  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${tokenOverride || token}` } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API ${endpoint} failed (${res.statusCode}): ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${endpoint}: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

let token; // set after auth

// ── Geocoding ───────────────────────────────────────────────────────────────

const COORD_RE = /^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$/;

async function toCoords(place) {
  if (COORD_RE.test(place.trim())) {
    const [lat, lng] = place.trim().split(',').map(Number);
    return { lat, lng, label: `${lat},${lng}` };
  }
  const resp = await apiRequest('/geocode', { q: place });
  if (!resp.results || resp.results.length === 0) {
    throw new Error(`Could not geocode "${place}" — no results found`);
  }
  const r = resp.results[0];
  return {
    lat: r.coordinate.latitude,
    lng: r.coordinate.longitude,
    label: r.formattedAddressLines ? r.formattedAddressLines.join(', ') : place,
  };
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

function formatDistance(meters) {
  const miles = meters / 1609.344;
  if (miles < 0.2) return `${Math.round(meters)} m`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

const TRANSPORT_MAP = { walking: 'Walking', transit: 'Transit', driving: 'Automobile' };

function resolveTransport(mode) {
  if (!mode) return 'Automobile';
  return TRANSPORT_MAP[mode.toLowerCase()] || mode;
}

function dirFlag(transportType) {
  if (transportType === 'Walking') return 'w';
  if (transportType === 'Transit') return 'r';
  return 'd';
}

function mapsLink(origin, destination, transportType) {
  const flag = dirFlag(transportType);
  const saddr = origin.label ? encodeURIComponent(origin.label) : `${origin.lat},${origin.lng}`;
  const daddr = destination.label ? encodeURIComponent(destination.label) : `${destination.lat},${destination.lng}`;
  return `https://maps.apple.com/?saddr=${saddr}&daddr=${daddr}&dirflg=${flag}`;
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdDirections(args, mode) {
  if (args.length < 2) {
    throw new Error('Usage: directions "Origin" "Destination" [--mode walking|transit]');
  }
  const [originStr, destStr] = args;
  const transportType = resolveTransport(mode);

  const [origin, dest] = await Promise.all([toCoords(originStr), toCoords(destStr)]);

  const resp = await apiRequest('/directions', {
    origin: `${origin.lat},${origin.lng}`,
    destination: `${dest.lat},${dest.lng}`,
    transportType,
  });

  const link = mapsLink(origin, dest, transportType);
  const routes = (resp.routes || []).map((route) => ({
    distance: formatDistance(route.distanceMeters),
    duration: formatDuration(route.expectedTravelTimeSeconds),
    distanceMeters: route.distanceMeters,
    durationSeconds: route.expectedTravelTimeSeconds,
    transportType: route.transportType || transportType,
    steps: (route.steps || []).map((s) => s.instructions).filter(Boolean),
  }));

  return {
    origin: origin.label,
    destination: dest.label,
    transportType,
    routes,
    mapsLink: link,
  };
}

async function cmdEta(args, mode) {
  if (args.length < 2) {
    throw new Error('Usage: eta "Origin" "Dest1" ["Dest2" ...] [--mode walking|transit]');
  }
  const [originStr, ...destStrs] = args;
  const transportType = resolveTransport(mode);

  const allCoords = await Promise.all([originStr, ...destStrs].map(toCoords));
  const origin = allCoords[0];
  const dests = allCoords.slice(1);

  const destinations = dests.map((d) => `${d.lat},${d.lng}`).join('|');
  const resp = await apiRequest('/etas', {
    origin: `${origin.lat},${origin.lng}`,
    destinations,
    transportType,
  });

  const etas = (resp.etas || []).map((eta, i) => ({
    destination: dests[i]?.label || `Destination ${i + 1}`,
    distance: formatDistance(eta.distanceMeters),
    duration: formatDuration(eta.expectedTravelTimeSeconds),
    distanceMeters: eta.distanceMeters,
    durationSeconds: eta.expectedTravelTimeSeconds,
    mapsLink: mapsLink(origin, dests[i], transportType),
  }));

  return { origin: origin.label, transportType, etas };
}

async function cmdSearch(args, near) {
  if (args.length < 1) {
    throw new Error('Usage: search "query" [--near "lat,lng" or --near "City, State"]');
  }
  const params = { q: args[0], lang: 'en-US' };
  if (near) {
    if (COORD_RE.test(near.trim())) {
      params.searchLocation = near.trim();
    } else {
      const loc = await toCoords(near);
      params.searchLocation = `${loc.lat},${loc.lng}`;
    }
  }
  const resp = await apiRequest('/search', params);
  return {
    query: args[0],
    results: (resp.results || []).map((r) => ({
      name: r.name,
      address: r.formattedAddressLines ? r.formattedAddressLines.join(', ') : null,
      coordinate: r.coordinate,
      mapsLink: r.coordinate
        ? `https://maps.apple.com/?q=${encodeURIComponent(r.name)}&ll=${r.coordinate.latitude},${r.coordinate.longitude}`
        : null,
    })),
  };
}

async function cmdGeocode(args) {
  if (args.length < 1) {
    throw new Error('Usage: geocode "address or place name"');
  }
  const resp = await apiRequest('/geocode', { q: args[0] });
  return {
    query: args[0],
    results: (resp.results || []).map((r) => ({
      address: r.formattedAddressLines ? r.formattedAddressLines.join(', ') : null,
      latitude: r.coordinate.latitude,
      longitude: r.coordinate.longitude,
      country: r.country,
      mapsLink: `https://maps.apple.com/?q=${encodeURIComponent(r.formattedAddressLines ? r.formattedAddressLines.join(', ') : args[0])}&ll=${r.coordinate.latitude},${r.coordinate.longitude}`,
    })),
  };
}

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const command = argv[0];
  const positional = [];
  let mode = null;
  let near = null;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) {
      mode = argv[++i];
    } else if (argv[i] === '--near' && argv[i + 1]) {
      near = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { command, args: positional, mode, near };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(`Apple Maps CLI

Commands:
  directions "Origin" "Destination" [--mode walking|transit]
  eta        "Origin" "Dest1" "Dest2" ... [--mode walking|transit]
  search     "query" [--near "location"]
  geocode    "address or place name"

Default transport mode is driving. Use --mode to override.`);
    process.exit(0);
  }

  const { command, args, mode, near } = parseArgs(argv);

  // Validate args before fetching token so usage errors are immediate
  const validators = {
    directions: (a) => { if (a.length < 2) throw new Error('Usage: directions "Origin" "Destination" [--mode walking|transit]'); },
    eta: (a) => { if (a.length < 2) throw new Error('Usage: eta "Origin" "Dest1" ["Dest2" ...] [--mode walking|transit]'); },
    search: (a) => { if (a.length < 1) throw new Error('Usage: search "query" [--near "lat,lng" or --near "City, State"]'); },
    geocode: (a) => { if (a.length < 1) throw new Error('Usage: geocode "address or place name"'); },
  };

  if (!validators[command]) {
    throw new Error(`Unknown command: ${command}. Use directions, eta, search, or geocode.`);
  }
  validators[command](args);

  token = await getAccessToken();

  let result;
  switch (command) {
    case 'directions':
      result = await cmdDirections(args, mode);
      break;
    case 'eta':
      result = await cmdEta(args, mode);
      break;
    case 'search':
      result = await cmdSearch(args, near);
      break;
    case 'geocode':
      result = await cmdGeocode(args);
      break;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
