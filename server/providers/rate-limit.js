import { clientKey, makeOptInRateLimiter } from './common/rate-limit.js';

function enforceOptInRateLimit(limiter, req, res) {
  if (!limiter || limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

function geminiRateLimiter() {
  return makeOptInRateLimiter(process.env.GEV_RATELIMIT_GEMINI_PER_MIN || '10');
}

export { enforceOptInRateLimit, geminiRateLimiter };
