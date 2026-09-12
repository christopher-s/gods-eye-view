import { createGeminiLiveTokenHandler } from './gemini/live.js';

function geminiLiveProxy({ annotationGuidance, fetchImpl } = {}) {
  function install(middlewares) {
    middlewares.use(
      '/api/gemini-live/token',
      createGeminiLiveTokenHandler({ annotationGuidance, fetchImpl }),
    );
  }

  return {
    name: 'gemini-live-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { createGeminiLiveTokenHandler, geminiLiveProxy };
