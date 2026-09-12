import { GEV_REALTIME_TOOLS } from '../openai/tools.js';

function geminiFunctionDeclarations(tools = GEV_REALTIME_TOOLS) {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

export { geminiFunctionDeclarations };
