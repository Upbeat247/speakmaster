// Netlify Function: /.netlify/functions/sync
// Turnkey device-sync backend backed by Netlify Blobs. No accounts — a random
// "sync code" identifies each backup. Anyone holding the code can read/write it,
// so codes are long enough to be unguessable (32^8 ≈ 1 trillion combos).
//
//   POST  { code?, data, updatedAt? }  -> stores data; returns { code, updatedAt }
//                                          (generates a code when none is supplied)
//   GET   ?code=SPK-XXXX-XXXX          -> returns { data, updatedAt } or 404
//
// Netlify provisions Blobs automatically for the site; no extra config needed.

const STORE_NAME = 'speakmaster-sync';
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB cap on a single backup payload

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Crockford-ish alphabet without ambiguous characters (no O/0/I/1).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pick(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
function genCode() { return `SPK-${pick(4)}-${pick(4)}`; }
function validCode(code) {
  return typeof code === 'string' && /^SPK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // @netlify/blobs is ESM-only; load it dynamically from this CommonJS function.
  let getStore;
  try {
    ({ getStore } = await import('@netlify/blobs'));
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Sync storage unavailable on this deploy.', detail: String(e && e.message || e).slice(0, 200) }) };
  }

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not open sync store.', detail: String(e && e.message || e).slice(0, 200) }) };
  }

  try {
    // ---------- RESTORE (GET) ----------
    if (event.httpMethod === 'GET') {
      const code = ((event.queryStringParameters && event.queryStringParameters.code) || '').toUpperCase().trim();
      if (!validCode(code)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'That sync code is not valid. It should look like SPK-XXXX-XXXX.' }) };
      }
      const rec = await store.get(code, { type: 'json' });
      if (!rec) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No backup found for that code.' }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify(rec) };
    }

    // ---------- BACK UP (POST) ----------
    if (event.httpMethod === 'POST') {
      if ((event.body || '').length > MAX_BYTES) {
        return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Backup is too large to sync.' }) };
      }
      let payload;
      try { payload = JSON.parse(event.body || '{}'); }
      catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body.' }) }; }

      if (!payload.data || typeof payload.data !== 'object') {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing progress data.' }) };
      }

      let code = (payload.code || '').toUpperCase().trim();
      if (code && !validCode(code)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'That sync code is not valid.' }) };
      }
      if (!code) {
        // Generate a fresh code, retrying on the (astronomically rare) collision.
        for (let i = 0; i < 4; i++) {
          const c = genCode();
          const exists = await store.get(c, { type: 'json' });
          if (!exists) { code = c; break; }
        }
        if (!code) code = genCode();
      }

      const updatedAt = new Date().toISOString();
      await store.setJSON(code, { data: payload.data, updatedAt });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ code, updatedAt }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Sync server error.', detail: String(err && err.message || err).slice(0, 300) }) };
  }
};
