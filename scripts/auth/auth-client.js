(() => {
  const MODULE_ID = "sceneforge-ai";

  function getBackendBaseUrl() {
    try {
      return String(game.settings?.get?.(MODULE_ID, "subscriptionBackendUrl") ?? "").trim().replace(/\/+$/, "");
    } catch (_error) {
      return "";
    }
  }

  async function jsonRequest(path, { method = "GET", body = null, accessToken = "" } = {}) {
    const baseUrl = getBackendBaseUrl();
    if (!baseUrl) return { ok: false, status: 0, payload: null, message: "Backend URL is not configured." };
    const endpoint = `${baseUrl}${path}`;
    try {
      const headers = { Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const response = await fetch(endpoint, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
      });
      const payload = await response.json().catch(() => ({}));
      const message = String(payload?.message ?? payload?.error ?? payload?.detail ?? "").trim();
      return { ok: response.ok, status: response.status, payload, message, endpoint };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        payload: null,
        message: String(error?.message ?? "network error"),
        endpoint
      };
    }
  }

  async function signIn({ email, password, rememberMe }) {
    return jsonRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: String(email ?? "").trim(),
        password: String(password ?? ""),
        rememberMe: Boolean(rememberMe),
        source: MODULE_ID
      }
    });
  }

  async function refreshSession(refreshToken) {
    return jsonRequest("/api/auth/refresh", {
      method: "POST",
      body: {
        refreshToken: String(refreshToken ?? "").trim(),
        source: MODULE_ID
      }
    });
  }

  async function fetchEntitlement(accessToken) {
    return jsonRequest("/api/subscription/status", {
      method: "GET",
      accessToken
    });
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.AuthClient = {
    getBackendBaseUrl,
    jsonRequest,
    signIn,
    refreshSession,
    fetchEntitlement
  };
})();
