import { resolveVoiceModel } from './voiceCost.js';

const freezeModel = (provider, choice, label, modelId) => Object.freeze({
  provider,
  choice,
  label,
  modelId,
});

const geminiModels = Object.freeze({
  'gemini-2.5': freezeModel(
    'gemini',
    'gemini-2.5',
    'Gemini 2.5 Flash Native Audio Dialog',
    'gemini-2.5-flash-native-audio-preview-12-2025'
  ),
  'gemini-3': freezeModel(
    'gemini',
    'gemini-3',
    'Gemini 3 Flash Live',
    'gemini-3.1-flash-live-preview'
  ),
});

const openAiModels = Object.freeze({
  standard: freezeModel('openai', 'standard', 'Standard', resolveVoiceModel('standard').id),
  mini: freezeModel('openai', 'mini', 'Mini', resolveVoiceModel('mini').id),
});

export const VOICE_PROVIDERS = Object.freeze({
  gemini: Object.freeze({
    provider: 'gemini',
    label: 'Gemini Live',
    defaultChoice: 'gemini-2.5',
    models: geminiModels,
  }),
  openai: Object.freeze({
    provider: 'openai',
    label: 'OpenAI Realtime',
    defaultChoice: 'standard',
    models: openAiModels,
  }),
});

const DEFAULT_PROVIDER = 'gemini';
const PROVIDER_STORAGE_KEY = 'gev.voice.provider';
const modelStorageKey = (provider) => `gev.voice.model.${provider}`;

function storageHandle(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function resolveVoiceProvider(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(VOICE_PROVIDERS, key)
    ? VOICE_PROVIDERS[key]
    : VOICE_PROVIDERS[DEFAULT_PROVIDER];
}

export function resolveVoiceModelChoice(provider, value) {
  const resolvedProvider = resolveVoiceProvider(provider);
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(resolvedProvider.models, key)
    ? resolvedProvider.models[key]
    : resolvedProvider.models[resolvedProvider.defaultChoice];
}

export function modelsForProvider(provider) {
  return Object.freeze(Object.values(resolveVoiceProvider(provider).models));
}

export function readStoredVoiceSelection(storage) {
  try {
    const handle = storageHandle(storage);
    const provider = resolveVoiceProvider(handle?.getItem(PROVIDER_STORAGE_KEY)).provider;
    return resolveVoiceModelChoice(provider, handle?.getItem(modelStorageKey(provider)));
  } catch {
    return resolveVoiceModelChoice(DEFAULT_PROVIDER);
  }
}

export function writeStoredVoiceSelection(selection, storage) {
  const provider = resolveVoiceProvider(selection?.provider).provider;
  let choice = selection?.choice;
  const handle = storageHandle(storage);
  if (choice === undefined) {
    try {
      choice = handle?.getItem(modelStorageKey(provider));
    } catch {
      choice = undefined;
    }
  }
  const resolved = resolveVoiceModelChoice(provider, choice);
  try {
    handle?.setItem(PROVIDER_STORAGE_KEY, provider);
    handle?.setItem(modelStorageKey(provider), resolved.choice);
  } catch {
    // Persistence is best effort in locked-down browsers.
  }
  return resolved;
}
