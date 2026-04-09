// Minimal Google Sheets v4 client for in-container scripts.
//
// Token is minted from ADC at runtime. All functions accept an optional
// `token` parameter so tests can inject a fake; the lower-level `request`
// helper accepts an optional `fetchFn` for the same reason.
//
// Used by group scripts (compute-tiers, score-guess, etc) to keep
// auth + URL construction out of the per-script code.

import fs from 'fs';

const ADC_PATH = '/home/node/.config/gcloud/application_default_credentials.json';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function getAccessToken({ fetchFn = fetch, adcPath = ADC_PATH } = {}) {
  const creds = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
  const resp = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Token mint failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function request(method, url, body, token, fetchFn) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetchFn(url, init);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sheets ${method} ${url}: ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function readRange(sheetId, range, { token, fetchFn = fetch } = {}) {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}`;
  const data = await request('GET', url, undefined, token, fetchFn);
  return data.values || [];
}

export async function appendRows(sheetId, range, values, { token, fetchFn = fetch } = {}) {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  return request('POST', url, { values }, token, fetchFn);
}

export async function updateRange(sheetId, range, values, { token, fetchFn = fetch } = {}) {
  const url = `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  return request('PUT', url, { values }, token, fetchFn);
}
