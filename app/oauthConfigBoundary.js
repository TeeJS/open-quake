'use strict';

function configForRenderer(config) {
  const clone = JSON.parse(JSON.stringify(config || {}));
  const oauth = clone.settings && clone.settings.oauth;
  if (!oauth || typeof oauth !== 'object') return clone;
  oauth.tokens = {};
  const providers = oauth.providers && typeof oauth.providers === 'object' ? oauth.providers : {};
  Object.values(providers).forEach(settings => {
    if (settings && typeof settings === 'object') delete settings.clientSecret;
  });
  return clone;
}

module.exports = { configForRenderer };
