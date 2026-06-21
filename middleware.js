// middleware.js — Vercel Edge Middleware: branded login gate for the whole site.
//
// WHY: the dashboard embeds real provider names + CEU/license compliance status.
// That is sensitive employment data and must not be publicly reachable or indexed.
//
// HOW: every request is checked at the edge (before any static file is served).
// Without a valid session cookie the visitor gets a branded login page. Posting
// the correct password sets an HttpOnly session cookie; the password itself is
// never stored in the cookie (the cookie holds a SHA-256 token derived from it).
// A client-side-only password form would be fake security — the HTML data would
// still be downloadable — so the check lives here, in the edge runtime.
//
// SETUP (one time, in the Vercel dashboard for this project):
//   Settings → Environment Variables → add
//     SITE_PASSWORD = <your shared password>     (e.g. Fountain2026!)
//   Then redeploy. The password lives ONLY in Vercel, never in this repo.
//
// This does not touch the scraper or the reminder emails (those read local files
// and send via SMTP).

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};

const COOKIE = 'ceu_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
// Public assets the login page itself needs — served without auth (no data here).
const PUBLIC_PATHS = new Set(['/fountain-logo-mark.png', '/fountain-logo.png', '/favicon.svg', '/favicon.ico', '/robots.txt']);

async function sessionToken(password) {
  const data = new TextEncoder().encode('ceu-tracker:v1:' + password);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const c = part.trim();
    if (c.startsWith(name + '=')) return c.slice(name.length + 1);
  }
  return null;
}

export default async function middleware(request) {
  const PASSWORD = process.env.SITE_PASSWORD;
  const url = new URL(request.url);

  // Fail closed: if no password is configured, do NOT serve the data.
  if (!PASSWORD) {
    return new Response(
      'Password protection is not configured. Set the SITE_PASSWORD environment ' +
        'variable in the Vercel project settings, then redeploy.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const expected = await sessionToken(PASSWORD);

  // Let the login page's own assets through.
  if (PUBLIC_PATHS.has(url.pathname)) return;

  // Handle the login form submission.
  if (url.pathname === '/__auth' && request.method === 'POST') {
    const form = await request.formData();
    const submitted = (form.get('password') || '').toString();
    if (submitted === PASSWORD) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
        },
      });
    }
    return loginResponse({ error: true });
  }

  // Already authenticated?
  if (getCookie(request, COOKIE) === expected) return;

  // Otherwise, show the branded login page.
  return loginResponse({ error: false });
}

function loginResponse({ error }) {
  return new Response(loginPage({ error }), {
    status: error ? 401 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function loginPage({ error }) {
  const errorBanner = error
    ? '<p class="error" role="alert">Incorrect password. Please try again.</p>'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>CEU Tracker — Sign in</title>
  <link rel="icon" href="/favicon.svg" />
  <style>
    :root { --navy:#1e293b; --navy2:#334155; --accent:#2563eb; --border:#e2e8f0; --muted:#64748b; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: linear-gradient(135deg, var(--navy) 0%, var(--navy2) 100%);
      padding: 24px; color: var(--navy);
    }
    .card {
      width: 100%; max-width: 380px; background: #fff; border-radius: 16px;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.35); padding: 40px 32px; text-align: center;
    }
    .logo { height: 48px; width: auto; margin: 0 auto 20px; display: block; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { font-size: 13px; color: var(--muted); margin: 0 0 28px; }
    form { display: flex; flex-direction: column; gap: 14px; text-align: left; }
    label { font-size: 12px; font-weight: 600; color: var(--navy); }
    input[type="password"] {
      width: 100%; padding: 12px 14px; font-size: 15px; border: 1px solid var(--border);
      border-radius: 10px; outline: none; transition: border-color .15s, box-shadow .15s;
    }
    input[type="password"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    button {
      margin-top: 4px; padding: 12px 14px; font-size: 15px; font-weight: 600; color: #fff;
      background: var(--accent); border: none; border-radius: 10px; cursor: pointer; transition: background .15s;
    }
    button:hover { background: #1d4ed8; }
    .error { background:#fef2f2; color:#991b1b; font-size:13px; border:1px solid #fecaca; border-radius:10px; padding:10px 12px; margin:0 0 4px; }
    .foot { margin-top: 24px; font-size: 11px; color: #94a3b8; }
  </style>
</head>
<body>
  <main class="card">
    <img class="logo" src="/fountain-logo-mark.png" alt="Fountain" onerror="this.style.display='none'" />
    <h1>CEU Tracker</h1>
    <p class="sub">This dashboard is restricted. Please sign in to continue.</p>
    <form method="POST" action="/__auth" autocomplete="off">
      ${errorBanner}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autofocus aria-label="Password" />
      <button type="submit">Sign in</button>
    </form>
    <p class="foot">Fountain Vitality — Authorized access only</p>
  </main>
</body>
</html>`;
}
