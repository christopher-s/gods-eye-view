import { resolveVoiceModelChoice } from '../../../src/voice/voiceProviders.js';
import { realtimeInstructions } from '../openai/instructions.js';
import { enforceOptInRateLimit, geminiRateLimiter } from '../rate-limit.js';
import {
  GEMINI_AUTH_TOKENS_ENDPOINT,
  GEMINI_LIVE_MODEL_3_DEFAULT,
  GEMINI_LIVE_MODEL_DEFAULT,
  GEMINI_NEW_SESSION_WINDOW_MS,
  GEMINI_TOKEN_LIFETIME_MS,
} from './constants.js';
import { geminiFunctionDeclarations } from './tools.js';

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function requestedChoice(req) {
  try {
    return new URL(req.url || '', 'http://localhost').searchParams.get('model');
  } catch {
    return null;
  }
}

function effectiveRequestOrigin(req) {
  const forwardedProtocol = String(
    req.headers?.['x-forwarded-proto'] || '',
  ).trim();
  const protocol = req.socket?.encrypted
    ? 'https:'
    : forwardedProtocol === 'http' || forwardedProtocol === 'https'
      ? `${forwardedProtocol}:`
      : forwardedProtocol
        ? null
        : 'http:';
  const host = String(req.headers?.host || '').trim();
  if (!protocol || !host || /[\s/?#@]/.test(host)) return null;
  try {
    const parsed = new URL(`${protocol}//${host}`);
    return parsed.host === host.toLowerCase() ? parsed.origin : null;
  } catch {
    return null;
  }
}

function allowsRequestOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === null || origin === '') return true;
  const effectiveOrigin = effectiveRequestOrigin(req);
  if (!effectiveOrigin) return false;
  try {
    const parsed = new URL(String(origin));
    return (
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.origin === effectiveOrigin
    );
  } catch {
    return false;
  }
}

function resolvedGeminiModel(value) {
  const selection = resolveVoiceModelChoice('gemini', value);
  return {
    choice: selection.choice,
    model:
      selection.choice === 'gemini-3'
        ? process.env.GEMINI_LIVE_MODEL_3 || GEMINI_LIVE_MODEL_3_DEFAULT
        : process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODEL_DEFAULT,
  };
}

function createGeminiLiveTokenHandler({
  annotationGuidance,
  fetchImpl = globalThis.fetch,
} = {}) {
  const limiter = geminiRateLimiter();
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    if (!allowsRequestOrigin(req)) {
      json(res, 403, { error: 'Cross-origin requests are refused' });
      return;
    }
    if (!enforceOptInRateLimit(limiter, req, res)) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      json(res, 503, { error: 'Gemini Live is not configured' });
      return;
    }

    const { choice, model } = resolvedGeminiModel(requestedChoice(req));
    const now = Date.now();
    const payload = {
      uses: 1,
      expireTime: new Date(now + GEMINI_TOKEN_LIFETIME_MS).toISOString(),
      newSessionExpireTime: new Date(
        now + GEMINI_NEW_SESSION_WINDOW_MS,
      ).toISOString(),
      liveConnectConstraints: {
        model: `models/${model}`,
        config: {
          responseModalities: ['AUDIO'],
          systemInstruction: {
            parts: [{ text: realtimeInstructions(annotationGuidance) }],
          },
          tools: [
            { functionDeclarations: geminiFunctionDeclarations() },
          ],
        },
      },
    };

    try {
      const response = await fetchImpl(GEMINI_AUTH_TOKENS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        json(res, 502, { error: 'Failed to create Gemini Live token' });
        return;
      }
      const upstream = await response.json();
      if (typeof upstream?.name !== 'string' || !upstream.name) {
        json(res, 502, { error: 'Failed to create Gemini Live token' });
        return;
      }
      json(res, 200, {
        token: upstream.name,
        model,
        choice,
        provider: 'gemini',
      });
    } catch {
      json(res, 502, { error: 'Failed to create Gemini Live token' });
    }
  };
}

export { createGeminiLiveTokenHandler };
