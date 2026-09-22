import { handleAPI } from './api.mjs';

// Deployment adapter: bind a D1 database as DB and the game assets as ASSETS.
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleAPI(request, env.DB);
    return env.ASSETS.fetch(request);
  },
};
