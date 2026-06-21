// middleware.js — Vercel Edge Middleware: HTTP Basic Auth gate for the whole site.
//
// WHY: the dashboard embeds real provider names + CEU/license compliance status.
// That is sensitive employment data and must not be publicly reachable or indexed.
//
// SETUP (one time, in the Vercel dashboard for this project):
//   Settings → Environment Variables → add
//     SITE_PASSWORD = <your shared password>     (e.g. Fountain2026!)
//     SITE_USER     = <optional, defaults to "fountain">
//   Then redeploy. The password is NEVER committed — it lives only in Vercel.
//
// Visitors get a one-time browser Basic Auth prompt. This does not touch the
// scraper or the reminder emails (those read local files and send via SMTP).

export const config = {
  // Run on every request except Vercel's internal/static asset paths.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export default function middleware(request) {
  const EXPECTED_USER = process.env.SITE_USER || 'fountain';
  const EXPECTED_PASS = process.env.SITE_PASSWORD;

  // Fail closed: if no password is configured, do NOT serve the data.
  if (!EXPECTED_PASS) {
    return new Response(
      'Password protection is not configured. Set the SITE_PASSWORD environment ' +
        'variable in the Vercel project settings, then redeploy.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    );
  }

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const decoded = atob(header.slice(6)); // "user:pass"
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === EXPECTED_USER && pass === EXPECTED_PASS) {
      return; // authorized — let the request through to the static site
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="CEU Tracker", charset="UTF-8"',
      'Content-Type': 'text/plain',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
