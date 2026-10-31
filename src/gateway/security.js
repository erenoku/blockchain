/**
 * HTTP hardening for the public gateway: security headers, a JSON-only rule
 * for state-changing API calls (blocks cross-site form posts), and a small
 * in-memory rate limiter.
 */

// The page can ask BSV Desktop (localhost:3321) to sign payments and renders
// untrusted AI output, so scripts and connections are locked down.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self' http://localhost:3321 http://127.0.0.1:3321",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** State-changing API calls must be JSON: a cross-site <form> can't send that. */
function requireJsonBody(req, res, next) {
  const changes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (changes && req.headers['content-type'] && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}

/**
 * Fixed-window limiter. `key(req)` picks the bucket (user or IP).
 * In-memory: fine for one gateway process; use a shared store when scaling out.
 */
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: 'Çok fazla istek. Biraz bekleyip tekrar deneyin.' });
    }
    next();
  };
}

module.exports = { securityHeaders, requireJsonBody, rateLimit, CSP };
