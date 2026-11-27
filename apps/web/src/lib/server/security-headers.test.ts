import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, withSecurityHeaders } from './security-headers.ts';

describe('withSecurityHeaders', () => {
  it('adds the headers a response lacks', () => {
    const response = withSecurityHeaders(new Response('<p>hi</p>'));
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('keeps headers the response set itself', () => {
    const response = withSecurityHeaders(
      new Response('x', { headers: { 'referrer-policy': 'no-referrer' } }),
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('copies a response whose headers cannot change', async () => {
    const immutable = Response.redirect('https://example.com/elsewhere', 302);
    const response = withSecurityHeaders(immutable);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/elsewhere');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
