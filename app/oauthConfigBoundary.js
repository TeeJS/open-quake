'use strict';

function configForRenderer(config) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  const oauth = clone.settings && clone.settings.oauth;
  if (!oauth || typeof oauth !== 'object') return clone;
  oauth.tokens = {};
  const providers = oauth.providers && typeof oauth.providers === 'object' ? oauth.providers : {};
  Object.entries(providers).forEach(([provider, settings]) => {
    if (!settings || typeof settings !== 'object') return;
    delete settings.clientSecret;
    if (provider === 'microsoft') delete settings.clientId;
  });
  return clone;
}

module.exports = { configForRenderer };
