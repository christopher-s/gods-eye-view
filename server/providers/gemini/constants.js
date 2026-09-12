import { VOICE_PROVIDERS } from '../../../src/voice/voiceProviders.js';

const GEMINI_AUTH_TOKENS_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const GEMINI_LIVE_WEBSOCKET_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const GEMINI_LIVE_MODEL_DEFAULT =
  VOICE_PROVIDERS.gemini.models['gemini-2.5'].modelId;
const GEMINI_LIVE_MODEL_3_DEFAULT =
  VOICE_PROVIDERS.gemini.models['gemini-3'].modelId;
const GEMINI_TOKEN_LIFETIME_MS = 30 * 60_000;
const GEMINI_NEW_SESSION_WINDOW_MS = 60_000;

export {
  GEMINI_AUTH_TOKENS_ENDPOINT,
  GEMINI_LIVE_MODEL_3_DEFAULT,
  GEMINI_LIVE_MODEL_DEFAULT,
  GEMINI_LIVE_WEBSOCKET_ENDPOINT,
  GEMINI_NEW_SESSION_WINDOW_MS,
  GEMINI_TOKEN_LIFETIME_MS,
};
