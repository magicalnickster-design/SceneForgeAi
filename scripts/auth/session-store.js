(() => {
  const MODULE_ID = "sceneforge-ai";
  const SETTING_AUTH_SESSION = "gambitsAuthSession";

  function registerSettings() {
    if (!globalThis.game?.settings) return;
    const existing = game.settings.settings?.get?.(`${MODULE_ID}.${SETTING_AUTH_SESSION}`);
    if (existing) return;
    game.settings.register(MODULE_ID, SETTING_AUTH_SESSION, {
      name: "Gambits Auth Session",
      scope: "client",
      config: false,
      type: Object,
      default: {},
      restricted: false
    });
  }

  function getSession() {
    // Foundry client settings are persistent but not encrypted secure storage.
    // Keep only minimal session tokens and non-sensitive account metadata.
    const fallback = {
      accessToken: "",
      refreshToken: "",
      tokenType: "Bearer",
      expiresAt: "",
      rememberMe: false,
      user: null,
      entitlement: null
    };
    const raw = game.settings?.get?.(MODULE_ID, SETTING_AUTH_SESSION);
    if (!raw || typeof raw !== "object") return fallback;
    const merged = { ...fallback, ...raw };
    if (typeof merged !== "object" || Array.isArray(merged)) return fallback;
    return merged;
  }

  async function setSession(nextSession = {}) {
    const session = {
      ...getSession(),
      ...(nextSession && typeof nextSession === "object" ? nextSession : {})
    };
    await game.settings.set(MODULE_ID, SETTING_AUTH_SESSION, session);
    return session;
  }

  async function clearSession() {
    await game.settings.set(MODULE_ID, SETTING_AUTH_SESSION, {});
  }

  async function clearCorruptedSession() {
    const raw = game.settings?.get?.(MODULE_ID, SETTING_AUTH_SESSION);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return false;
    await clearSession();
    return true;
  }

  function getAccessToken() {
    return String(getSession().accessToken ?? "").trim();
  }

  function getRefreshToken() {
    return String(getSession().refreshToken ?? "").trim();
  }

  function isAccessTokenExpired(bufferSeconds = 30) {
    const expiresAt = String(getSession().expiresAt ?? "").trim();
    if (!expiresAt) return false;
    const timestamp = Date.parse(expiresAt);
    if (!Number.isFinite(timestamp)) return false;
    return timestamp <= (Date.now() + (bufferSeconds * 1000));
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.SessionStore = {
    registerSettings,
    getSession,
    setSession,
    clearSession,
    clearCorruptedSession,
    getAccessToken,
    getRefreshToken,
    isAccessTokenExpired
  };
})();
