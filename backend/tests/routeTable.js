const routes = require('../routes/index');

// Walks an Express router tree and yields { method, path, permission }.
//
// Express 5 keeps a mount path only inside each layer's matcher closure, so the
// prefix is recovered by asking the matcher itself: the mount candidates come
// from the `router.use('/x', …)` calls in routes/index.js, and the matching one
// is the layer's prefix. No hand-maintained mount table.
const MOUNT_CANDIDATES = [...require('fs')
  .readFileSync(require.resolve('../routes/index'), 'utf8')
  .matchAll(/router\.use\('(\/[^']*)'/g)]
  .map((match) => match[1]);

const collectRoutes = (router, prefix = '') => {
  const found = [];

  const layerPath = (layer) => {
    if (layer.route) return layer.route.path;
    const matcher = layer.matchers?.[0];
    if (!matcher) return '';
    const mount = MOUNT_CANDIDATES.find((candidate) => matcher(candidate));
    return mount || '';
  };

  for (const layer of router.stack || []) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
      const handlers = layer.route.stack.map((s) => s.handle);
      const permission = handlers.map((h) => h.permission).find(Boolean) || null;

      for (const method of Object.keys(layer.route.methods)) {
        found.push({ method: method.toUpperCase(), path, permission, handlers });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      found.push(...collectRoutes(layer.handle, `${prefix}${layerPath(layer)}`.replace(/\/$/, '')));
    }
  }

  return found;
};

module.exports = { collectRoutes, allRoutes: collectRoutes(routes) };
