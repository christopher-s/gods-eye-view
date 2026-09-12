import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PROVIDERS,
  modelsForProvider,
  readStoredVoiceSelection,
  resolveVoiceModelChoice,
  resolveVoiceProvider,
  writeStoredVoiceSelection,
} from './voiceProviders.js';

function fakeStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    dump: () => Object.fromEntries(values),
  };
}

test('registry exposes the approved providers, labels, defaults, and exact model ids', () => {
  assert.deepEqual(Object.keys(VOICE_PROVIDERS), ['gemini', 'openai']);
  assert.equal(VOICE_PROVIDERS.gemini.label, 'Gemini Live');
  assert.equal(VOICE_PROVIDERS.openai.label, 'OpenAI Realtime');

  assert.deepEqual(modelsForProvider('gemini'), [
    {
      provider: 'gemini',
      choice: 'gemini-2.5',
      label: 'Gemini 2.5 Flash Native Audio Dialog',
      modelId: 'gemini-2.5-flash-native-audio-preview-12-2025',
    },
    {
      provider: 'gemini',
      choice: 'gemini-3',
      label: 'Gemini 3 Flash Live',
      modelId: 'gemini-3.1-flash-live-preview',
    },
  ]);
  assert.deepEqual(modelsForProvider('openai'), [
    { provider: 'openai', choice: 'standard', label: 'Standard', modelId: 'gpt-realtime-2' },
    { provider: 'openai', choice: 'mini', label: 'Mini', modelId: 'gpt-realtime-2.1-mini' },
  ]);
  assert.ok(Object.isFrozen(VOICE_PROVIDERS));
  assert.ok(modelsForProvider('gemini').every(Object.isFrozen));
});

test('new and hostile provider values resolve to Gemini Live', () => {
  for (const value of [undefined, null, '', 'constructor', '__proto__', 'openai-ish']) {
    assert.equal(resolveVoiceProvider(value).provider, 'gemini');
  }
  assert.equal(resolveVoiceProvider(' OPENAI ').provider, 'openai');
});

test('model choices fall back within their resolved provider and reject arbitrary model ids', () => {
  assert.equal(resolveVoiceModelChoice('gemini').choice, 'gemini-2.5');
  assert.equal(resolveVoiceModelChoice('gemini', 'gemini-3').modelId, 'gemini-3.1-flash-live-preview');
  assert.equal(resolveVoiceModelChoice('gemini', 'gpt-realtime-2').choice, 'gemini-2.5');
  assert.equal(resolveVoiceModelChoice('openai', 'mini').modelId, 'gpt-realtime-2.1-mini');
  assert.equal(resolveVoiceModelChoice('openai', '__proto__').choice, 'standard');
  assert.equal(resolveVoiceModelChoice('hostile', 'mini').choice, 'gemini-2.5');
});

test('selection persists provider and independent per-provider choices', () => {
  const storage = fakeStorage({ 'gev.voice.model.gemini': 'gemini-3' });
  assert.deepEqual(writeStoredVoiceSelection({ provider: 'openai', choice: 'mini' }, storage), {
    provider: 'openai', choice: 'mini', label: 'Mini', modelId: 'gpt-realtime-2.1-mini',
  });
  assert.deepEqual(writeStoredVoiceSelection({ provider: 'gemini', choice: 'gemini-3' }, storage), {
    provider: 'gemini', choice: 'gemini-3', label: 'Gemini 3 Flash Live', modelId: 'gemini-3.1-flash-live-preview',
  });
  assert.deepEqual(writeStoredVoiceSelection({ provider: 'openai' }, storage), {
    provider: 'openai', choice: 'mini', label: 'Mini', modelId: 'gpt-realtime-2.1-mini',
  });
  assert.deepEqual(storage.dump(), {
    'gev.voice.provider': 'openai',
    'gev.voice.model.gemini': 'gemini-3',
    'gev.voice.model.openai': 'mini',
  });
  assert.deepEqual(writeStoredVoiceSelection({ provider: 'gemini' }, storage), {
    provider: 'gemini', choice: 'gemini-3', label: 'Gemini 3 Flash Live', modelId: 'gemini-3.1-flash-live-preview',
  });
  assert.deepEqual(readStoredVoiceSelection(storage), {
    provider: 'gemini', choice: 'gemini-3', label: 'Gemini 3 Flash Live', modelId: 'gemini-3.1-flash-live-preview',
  });
});

test('corrupt storage resolves safely and writes never throw', () => {
  const corrupt = fakeStorage({
    'gev.voice.provider': '__proto__',
    'gev.voice.model.gemini': 'gemini-3.1-flash-live-preview',
  });
  assert.deepEqual(readStoredVoiceSelection(corrupt), {
    provider: 'gemini', choice: 'gemini-2.5', label: 'Gemini 2.5 Flash Native Audio Dialog',
    modelId: 'gemini-2.5-flash-native-audio-preview-12-2025',
  });
  const hostile = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  assert.equal(readStoredVoiceSelection(hostile).choice, 'gemini-2.5');
  assert.equal(writeStoredVoiceSelection({ provider: 'openai', choice: 'mini' }, hostile).choice, 'mini');
});
