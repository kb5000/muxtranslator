// Service worker entry point for MV3 (Chrome).
// importScripts loads the same modules that MV2 listed under background.scripts.
importScripts(
  'lib/utils.js',
  'lib/settings.js',
  'lib/cache.js',
  'lib/providers.js',
  'background.js'
);
