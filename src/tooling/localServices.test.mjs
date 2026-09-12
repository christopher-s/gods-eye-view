import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { overpassProxy } from 'gods-eye-view/server/providers/overpass';
import { militaryInstallationsProxy } from 'gods-eye-view/server/providers/military-installations';
import {
  regionalBriefProxy,
  weatherEffectsProxy,
} from 'gods-eye-view/server/providers/regional';
import { openAiRealtimeProxy } from 'gods-eye-view/server/providers/openai';
import {
  createGeminiLiveTokenHandler,
  geminiLiveProxy,
} from '../../server/providers/gemini.js';
import { geminiFunctionDeclarations } from '../../server/providers/gemini/tools.js';
import { keySetupEndpoint } from 'gods-eye-view/server/standalone/key-setup';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
    restart: async () => {},
  });
  return routes;
}
function request(
  handler,
  {
    method = 'GET',
    url = '/',
    body = '',
    origin = 'http://localhost:4173',
    headers: requestHeaders = {},
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method,
      url,
      headers: {
        host: 'localhost:4173',
        ...(origin === undefined ? {} : { origin }),
        'content-type': 'application/json',
        ...requestHeaders,
      },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(status, values) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(values)) this.setHeader(k, v);
      },
      end(body = '') {
        resolve({
          status: this.statusCode,
          headers,
          body: String(body),
          json: () => JSON.parse(String(body)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}
function root(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-services-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('standalone service guards run in development and preview without upstream acquisition', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('invalid requests must not fetch');
  });
  for (const preview of [false, true]) {
    for (const [factory, route] of [
      [overpassProxy, '/api/overpass'],
      [militaryInstallationsProxy, '/api/military-installations'],
      [regionalBriefProxy, '/api/regional-brief'],
      [weatherEffectsProxy, '/api/weather-effects'],
    ]) {
      const routes = install(factory(), preview);
      assert.equal(
        (await request(routes.get(route), { method: 'DELETE' })).status,
        405,
      );
      assert.equal(
        (
          await request(routes.get(route), {
            method: route === '/api/overpass' ? 'POST' : 'GET',
          })
        ).status,
        400,
      );
    }
  }
});

test('weather-only requests share upstream work and retain fresh and stale responses', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).hostname, 'api.open-meteo.com');
    if (calls > 1) throw Error('offline');
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      current: {
        time: '2026-09-12T12:00',
        temperature_2m: 20,
        weather_code: 0,
        wind_speed_10m: 10,
      },
    });
  });
  const handler = install(weatherEffectsProxy()).get('/api/weather-effects');
  const query = { url: '/?latitude=34.61&longitude=-112.43' };
  const pair = await Promise.all([
    request(handler, query),
    request(handler, query),
  ]);
  assert.deepEqual(pair.map((r) => r.headers['x-weather-effects']).sort(), [
    'INFLIGHT',
    'MISS',
  ]);
  assert.equal(calls, 1);
  assert.equal(
    (await request(handler, query)).headers['x-weather-effects'],
    'HIT',
  );
  now += 6 * 60_000;
  assert.equal(
    (await request(handler, query)).headers['x-weather-effects'],
    'STALE',
  );
});

test('Realtime handler preserves tools and default instructions, isolates supplied annotation guidance, and keeps the upstream key server-side', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-upstream-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', undefined);
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(
      options.headers.Authorization,
      'Bearer fixture-upstream-secret',
    );
    sent.push(JSON.parse(options.body));
    return Response.json({ value: 'fixture-ephemeral' });
  });
  for (const [options, guidance] of [
    [{}, undefined],
    [
      { annotationGuidance: 'Fixture annotation instruction.' },
      'Fixture annotation instruction.',
    ],
    [{}, undefined],
  ]) {
    const response = await request(
      install(openAiRealtimeProxy(options)).get('/api/realtime/token'),
      { url: '/?tier=unknown' },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-gev-voice-tier'], 'standard');
    assert.equal(response.headers['x-gev-voice-tier-fallback'], '1');
    assert.equal(response.body.includes('fixture-upstream-secret'), false);
    assert.equal(
      sent.at(-1).session.instructions,
      realtimeInstructions(guidance),
    );
    assert.deepEqual(sent.at(-1).session.tools, GEV_REALTIME_TOOLS);
  }
  assert.notEqual(sent[0].session.instructions, sent[1].session.instructions);
  assert.equal(sent[0].session.instructions, sent[2].session.instructions);
});

test('Gemini plugin registers the token route for development and preview', () => {
  for (const preview of [false, true]) {
    const routes = install(geminiLiveProxy(), preview);
    assert.equal(typeof routes.get('/api/gemini-live/token'), 'function');
  }
});

test('Gemini declarations retain only the supported function fields', () => {
  assert.deepEqual(
    geminiFunctionDeclarations([
      {
        type: 'function',
        name: 'fixture_tool',
        description: 'Fixture description',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
    ]),
    [
      {
        name: 'fixture_tool',
        description: 'Fixture description',
        parameters: { type: 'object', properties: {} },
      },
    ],
  );
});

test('Gemini token handler is POST-only and requires a server key', async (t) => {
  env(t, 'GEMINI_API_KEY', undefined);
  const handler = createGeminiLiveTokenHandler();
  assert.equal((await request(handler)).status, 405);
  const missing = await request(handler, { method: 'POST' });
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.json(), { error: 'Gemini Live is not configured' });
});

test('Gemini token handler allowlists choices, applies env overrides, and mints constrained audio tokens', async (t) => {
  env(t, 'GEMINI_API_KEY', 'fixture-permanent-gemini-key');
  env(t, 'GEMINI_LIVE_MODEL', 'fixture-gemini-25-model');
  env(t, 'GEMINI_LIVE_MODEL_3', 'fixture-gemini-3-model');
  env(t, 'GEV_RATELIMIT_GEMINI_PER_MIN', '10');
  const calls = [];
  const handler = createGeminiLiveTokenHandler({
    annotationGuidance: 'Fixture annotation instruction.',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, payload: JSON.parse(options.body) });
      return Response.json({
        name: 'authTokens/fixture-ephemeral-token',
        extra: 'private',
      });
    },
  });
  for (const [query, choice, model] of [
    ['gemini-3', 'gemini-3', 'fixture-gemini-3-model'],
    ['hostile/model', 'gemini-2.5', 'fixture-gemini-25-model'],
  ]) {
    const response = await request(handler, {
      method: 'POST',
      url: `/?model=${encodeURIComponent(query)}`,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), {
      token: 'authTokens/fixture-ephemeral-token',
      model,
      choice,
      provider: 'gemini',
    });
    assert.equal(response.body.includes('fixture-permanent-gemini-key'), false);
    assert.equal(
      JSON.stringify(response.headers).includes('fixture-permanent-gemini-key'),
      false,
    );
    const call = calls.at(-1);
    assert.equal(
      call.url,
      'https://generativelanguage.googleapis.com/v1beta/auth_tokens',
    );
    assert.equal(
      call.options.headers['x-goog-api-key'],
      'fixture-permanent-gemini-key',
    );
    assert.equal(call.payload.uses, 1);
    assert.equal(call.payload.liveConnectConstraints.model, `models/${model}`);
    assert.deepEqual(
      call.payload.liveConnectConstraints.config.responseModalities,
      ['AUDIO'],
    );
    assert.equal(
      call.payload.liveConnectConstraints.config.systemInstruction.parts[0]
        .text,
      realtimeInstructions('Fixture annotation instruction.'),
    );
    assert.deepEqual(
      call.payload.liveConnectConstraints.config.tools[0].functionDeclarations,
      geminiFunctionDeclarations(GEV_REALTIME_TOOLS),
    );
    const expiry = Date.parse(call.payload.expireTime);
    const sessionExpiry = Date.parse(call.payload.newSessionExpireTime);
    assert.ok(expiry > Date.now() && expiry <= Date.now() + 31 * 60_000);
    assert.ok(
      sessionExpiry > Date.now() && sessionExpiry <= Date.now() + 2 * 60_000,
    );
  }
});

test('Gemini token handler rejects hostile browser origins before rate limiting or upstream work while allowing same-origin and origin-less clients', async (t) => {
  env(t, 'GEMINI_API_KEY', 'fixture-permanent-gemini-key');
  env(t, 'GEV_RATELIMIT_GEMINI_PER_MIN', '1');
  let calls = 0;
  const handler = createGeminiLiveTokenHandler({
    fetchImpl: async () => {
      calls++;
      return Response.json({ name: 'authTokens/fixture-ephemeral-token' });
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const hostile = await request(handler, {
      method: 'POST',
      origin: 'https://attacker.example',
    });
    assert.equal(hostile.status, 403);
    assert.deepEqual(hostile.json(), {
      error: 'Cross-origin requests are refused',
    });
  }
  assert.equal(calls, 0);
  assert.equal((await request(handler, { method: 'POST' })).status, 200);
  assert.equal(calls, 1);

  const originlessHandler = createGeminiLiveTokenHandler({
    fetchImpl: async () =>
      Response.json({ name: 'authTokens/fixture-cli-token' }),
  });
  assert.equal(
    (await request(originlessHandler, { method: 'POST', origin: undefined }))
      .status,
    200,
  );
});

test('Gemini token handler derives its exact same origin from Host and a valid forwarded protocol', async (t) => {
  env(t, 'GEMINI_API_KEY', 'fixture-permanent-gemini-key');
  env(t, 'GEV_RATELIMIT_GEMINI_PER_MIN', '10');
  const handler = createGeminiLiveTokenHandler({
    fetchImpl: async () =>
      Response.json({ name: 'authTokens/fixture-ephemeral-token' }),
  });
  assert.equal(
    (
      await request(handler, {
        method: 'POST',
        origin: 'https://localhost:4173',
        headers: { 'x-forwarded-proto': 'https' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(handler, {
        method: 'POST',
        origin: 'https://localhost:4173',
        headers: { 'x-forwarded-proto': 'https, http' },
      })
    ).status,
    403,
  );
});

test('Gemini rate limiting defaults to 10/minute for missing, zero, negative, and malformed values', async (t) => {
  env(t, 'GEMINI_API_KEY', 'fixture-permanent-gemini-key');
  for (const value of [undefined, '0', '-1', 'garbage']) {
    env(t, 'GEV_RATELIMIT_GEMINI_PER_MIN', value);
    let calls = 0;
    const handler = createGeminiLiveTokenHandler({
      fetchImpl: async () => {
        calls++;
        return Response.json({ name: 'authTokens/fixture-ephemeral-token' });
      },
    });
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal((await request(handler, { method: 'POST' })).status, 200);
    assert.equal((await request(handler, { method: 'POST' })).status, 429);
    assert.equal(calls, 10);
  }
});

test('Gemini token handler sanitizes upstream failures and never leaks the permanent key', async (t) => {
  env(t, 'GEMINI_API_KEY', 'fixture-permanent-gemini-key');
  env(t, 'GEV_RATELIMIT_GEMINI_PER_MIN', '10');
  const handler = createGeminiLiveTokenHandler({
    fetchImpl: async () =>
      new Response('upstream leaked fixture-permanent-gemini-key', {
        status: 403,
      }),
  });
  const response = await request(handler, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.deepEqual(response.json(), {
    error: 'Failed to create Gemini Live token',
  });
  assert.equal(response.body.includes('fixture-permanent-gemini-key'), false);
  assert.equal(
    JSON.stringify(response.headers).includes('fixture-permanent-gemini-key'),
    false,
  );
});

test('Gemini token handler enforces its per-client rate limit', async (t) => {
  env(t, 'GEMINI_API_KEY', 'fixture-permanent-gemini-key');
  env(t, 'GEV_RATELIMIT_GEMINI_PER_MIN', '1');
  let calls = 0;
  const handler = createGeminiLiveTokenHandler({
    fetchImpl: async () => {
      calls++;
      return Response.json({ name: 'authTokens/fixture-ephemeral-token' });
    },
  });
  assert.equal((await request(handler, { method: 'POST' })).status, 200);
  const limited = await request(handler, { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.json(), { error: 'Rate limit exceeded' });
  assert.equal(calls, 1);
});

test('debug logging resolves each supplied application directory independently', async (t) => {
  const first = root(t),
    second = root(t);
  for (const [sourceRoot, marker] of [
    [first, 'first'],
    [second, 'second'],
  ]) {
    const handler = install(openAiRealtimeProxy({ sourceRoot })).get(
      '/api/realtime/debug-log',
    );
    assert.equal(
      (
        await request(handler, {
          method: 'POST',
          body: JSON.stringify({ marker }),
        })
      ).status,
      204,
    );
    const file = path.join(
      sourceRoot,
      '.gev-logs/realtime-conversations.jsonl',
    );
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).marker, marker);
  }
});

test('key setup writes only the supplied application root, retains request guards and stays absent from preview', async (t) => {
  const first = root(t),
    untouched = root(t);
  env(t, 'OPENAI_API_KEY', undefined);
  const plugin = keySetupEndpoint({ sourceRoot: first });
  assert.equal(plugin.apply({}, { command: 'serve', isPreview: true }), false);
  assert.equal(plugin.configurePreviewServer, undefined);
  const routes = install(plugin);
  const handler = routes.get('/api/setup/keys');
  const body = JSON.stringify({
    OPENAI_API_KEY: 'sk-fixture-only-not-a-real-key',
  });
  assert.equal(
    (
      await request(handler, {
        method: 'POST',
        body,
        origin: 'https://example.com',
      })
    ).status,
    403,
  );
  assert.equal(existsSync(path.join(first, '.env')), false);
  const saved = await request(handler, { method: 'POST', body });
  assert.equal(saved.status, 200);
  assert.match(
    readFileSync(path.join(first, '.env'), 'utf8'),
    /OPENAI_API_KEY=sk-fixture-only-not-a-real-key/,
  );
  if (process.platform !== 'win32')
    assert.equal(statSync(path.join(first, '.env')).mode & 0o777, 0o600);
  assert.equal(saved.body.includes('sk-fixture-only-not-a-real-key'), false);
  assert.equal(existsSync(path.join(untouched, '.env')), false);
});
