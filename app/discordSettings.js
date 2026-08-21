'use strict';

const DEFAULT_DISCORD_SETTINGS = Object.freeze({
  enabled: true,
  applicationIdOverride: '',
  defaultView: 'voice',
  autoReconnect: true,
  showUnavailable: true,
  richPresence: false,
});

const VIEWS = new Set(['voice', 'chat', 'activity']);

function cleanId(value, maxLength) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, maxLength) : '';
}

function normalizeDiscordSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacyClientId = source.clientId == null ? source.applicationId : source.clientId;
  const applicationIdOverride = source.applicationIdOverride == null ? legacyClientId : source.applicationIdOverride;
  const defaultView = VIEWS.has(source.defaultView) ? source.defaultView : DEFAULT_DISCORD_SETTINGS.defaultView;
  return {
    enabled: source.enabled !== false,
    applicationIdOverride: cleanId(applicationIdOverride, 128),
    defaultView,
    autoReconnect: source.autoReconnect !== false,
    showUnavailable: source.showUnavailable !== false,
    richPresence: source.richPresence === true,
  };
}

// Public application identifier for the open-quake Discord Developer Portal app.
// This is deliberately not a secret; OAuth tokens remain in the encrypted store.
const DEFAULT_DISCORD_APPLICATION_ID = '1539959318974169088';

function discordApplicationId(settings) {
  const normalized = normalizeDiscordSettings(settings);
  return normalized.applicationIdOverride || DEFAULT_DISCORD_APPLICATION_ID;
}

module.exports = { DEFAULT_DISCORD_APPLICATION_ID, DEFAULT_DISCORD_SETTINGS, discordApplicationId, normalizeDiscordSettings };
