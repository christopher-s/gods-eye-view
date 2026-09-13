import { GEV_REALTIME_TOOLS } from '../openai/tools.js';

// Gemini function-declaration parameters accept an OpenAPI 3.0 subset of
// JSON Schema, not full JSON Schema: unknown keywords are hard errors on
// the live WebSocket (empirically WS 1007 'Unknown name
// "additionalProperties" at setup.tools[0].function_declarations[0]').
// Allowlist the documented Schema fields — recursively through
// properties/items/anyOf — and drop everything else so the canonical
// OpenAI definitions can keep using full JSON Schema upstream.
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
]);

// OpenAPI (and therefore Gemini) only defines these format values; any
// other format string is dropped rather than risking upstream rejection.
const SUPPORTED_FORMATS = new Set([
  'enum',
  'date-time',
  'int32',
  'int64',
  'float',
  'double',
]);

function sanitizeSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema);
  }
  if (schema === null || typeof schema !== 'object') {
    return schema;
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'format' && !SUPPORTED_FORMATS.has(value)) {
      continue;
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const properties = {};
      for (const [name, property] of Object.entries(value)) {
        properties[name] = sanitizeSchema(property);
      }
      sanitized.properties = properties;
      continue;
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      sanitized.anyOf = value.map(sanitizeSchema);
      continue;
    }
    if (key === 'items') {
      sanitized.items = sanitizeSchema(value);
      continue;
    }
    // sanitizeSchema copies arrays (enum/required/propertyOrdering) and
    // passes scalars through, so no original reference is ever shared.
    sanitized[key] = sanitizeSchema(value);
  }
  return sanitized;
}

function geminiFunctionDeclarations(tools = GEV_REALTIME_TOOLS) {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    // Deep-copy + sanitize: never alias the OpenAI originals.
    parameters: sanitizeSchema(parameters),
  }));
}

export { geminiFunctionDeclarations };
