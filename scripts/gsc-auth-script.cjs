/**
 * ONE-TIME GSC AUTH SCRIPT
 * Run: node gsc-auth.js
 * After success, copy the printed tokens into your .env
 */

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const dotenv = require('dotenv');
// NOTE: `open` v11 is ESM-only, so `require('open')` throws ERR_REQUIRE_ESM and would
// crash this script on launch. We load it lazily via dynamic import and fall back to
// just printing the URL — auto-opening the browser is only a convenience.

dotenv.config();

// Paste your OAuth2 credentials from Google Cloud Console here
const CLIENT_ID = process.env.GSC_CLIENT_ID ||'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.GSC_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = process.env.GSC_REDIRECT_URI || 'http://localhost:3000/callback';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// One refresh token can cover multiple Google APIs as long as the OAuth consent includes scopes.
// Add scopes here BEFORE generating the refresh token.
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly', // GSC
  'https://www.googleapis.com/auth/analytics.readonly', // GA4 Data API (read)
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces refresh_token to be returned
  scope: SCOPES,
});

console.log('\n🔐 Starting one-time GSC auth...');
console.log('Opening browser for Google login...\n');

// Spin up a temporary local server to catch the callback
const server = http.createServer(async (req, res) => {
  const qs = new url.URL(req.url, REDIRECT_URI).searchParams;
  const code = qs.get('code');

  if (!code) {
    res.end('No code found. Try again.');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.end('✅ Auth successful! You can close this tab and check your terminal.');
    server.close();

    console.log('\n✅ SUCCESS — Add these to your .env:\n');
    console.log(`GSC_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GSC_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GSC_REDIRECT_URI=${REDIRECT_URI}`);
    console.log(`GSC_ACCESS_TOKEN=${tokens.access_token}`);
    console.log(`GSC_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GSC_TOKEN_EXPIRY=${tokens.expiry_date}`);
    console.log('\n⚠️  Copy GSC_REFRESH_TOKEN especially — it only appears once.\n');

  } catch (err) {
    console.error('Error getting tokens:', err);
    res.end('Auth failed. Check terminal.');
    server.close();
  }
});

server.listen(3000, () => {
  console.log('👉 If a browser does not open, paste this URL manually:\n');
  console.log(authUrl + '\n');
  // Best-effort auto-open (open v11 is ESM-only, so use dynamic import).
  import('open')
    .then((mod) => (mod.default || mod)(authUrl))
    .catch(() => { /* URL already printed above */ });
});