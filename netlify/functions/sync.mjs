// Netlify Function (API v2, ESM): /.netlify/functions/sync
// Device sync backed by Netlify Blobs. The v2 format + a static import give
// reliable automatic Blobs configuration (no env vars, no dashboard setup).
//
//   POST  { code?, data, updatedAt? }  -> stores data; returns { code, updatedAt }
//   GET   ?code=SPK-XXXX-XXXX          -> returns { data, updatedAt } or 404
//
// A "sync code" identifies each backup; anyone holding it can read/write it, so
// codes are long enough to be unguessable (~1 trillion combinations).

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'speakmaster-sync';
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB cap

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1
function pick(n) { let s = ''; for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return s; }
function genCode() { return `SPK-${pick(4)}-${pick(4)}`; }
function validCode(c) { return typeof c === 'string' && /^SPK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c); }
function json(status, obj) { return new Response(JSON.stringify(obj), { status, headers: CORS }); }

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (e) {
    return json(500, { error: 'Could not open sync store.', detail: String((e && e.message) || e).slice(0, 300) });
  }

  try {
    const url = new URL(req.url);

    // ---------- RESTORE ----------
    if (req.method === 'GET') {
      const code = (url.searchParams.get('code') || '').toUpperCase().trim();
      if (!validCode(code)) return json(400, { error: 'That sync code is not valid — it should look like SPK-XXXX-XXXX.' });
      const rec = await store.get(code, { type: 'json' });
      if (!rec) return json(404, { error: 'No backup found for that code.' });
      return json(200, rec);
    }

    // ---------- BACK UP ----------
    if (req.method === 'POST') {
      const bodyText = await req.text();
      if (bodyText.length > MAX_BYTES) return json(413, { error: 'Backup is too large to sync.' });
      let payload;
      try { payload = JSON.parse(bodyText || '{}'); }
      catch { return json(400, { error: 'Invalid request body.' }); }

      if (!payload.data || typeof payload.data !== 'object') return json(400, { error: 'Missing progress data.' });

      let code = (payload.code || '').toUpperCase().trim();
      if (code && !validCode(code)) return json(400, { error: 'That sync code is not valid.' });
      if (!code) {
        for (let i = 0; i < 4; i++) {
          const c = genCode();
          const exists = await store.get(c, { type: 'json' });
          if (!exists) { code = c; break; }
        }
        if (!code) code = genCode();
      }

      const updatedAt = new Date().toISOString();
      await store.setJSON(code, { data: payload.data, updatedAt });
      return json(200, { code, updatedAt });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    return json(500, { error: 'Sync server error.', detail: String((err && err.message) || err).slice(0, 300) });
  }
};
