// GEV phone shell: network-only, with a fixed reconnect page on network failure.
// Never persist responses, requests, credentials, CoT, locations or mission data.
// API requests and non-app navigations never enter this handler.
const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1929"><title>GEV TAK · Offline</title>
<style>body{background:#0a0a0f;color:#e8eaed;font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:24px}h1{font-size:24px}a{display:inline-block;padding:12px 20px;border:1px solid #64c4ff;border-radius:8px;color:#64c4ff}p{color:#b9c9db}</style></head>
<body><h1>GEV TAK · Offline</h1><p>Reconnect to your approved private network, then reopen the app.</p><p>This installation does not store offline tactical data or maps. Positions and messages from the previous page session are not restored.</p><a href="/">Try again</a></body></html>`;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.search ||
    !['/', '/index.html'].includes(url.pathname)
  )
    return;
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
          },
        }),
    ),
  );
});
