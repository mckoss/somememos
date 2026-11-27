// Headers every response the server renders carries (hooks.server.ts),
// unless the response set its own: the blog and the API do. The app's
// content security policy comes from SvelteKit (vite.config.ts). Static
// files (the built app, icons) are served before the hook runs.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
});

/** `response` with every `SECURITY_HEADERS` entry it does not already have. */
export function withSecurityHeaders(response: Response): Response {
  const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  try {
    for (const [name, value] of missing) response.headers.set(name, value);
    return response;
  } catch {
    // Immutable headers (a response passed through from fetch): copy them.
    const headers = new Headers(response.headers);
    for (const [name, value] of missing) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
