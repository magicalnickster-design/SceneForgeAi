(() => {
  let refreshInFlight = null;

  async function refreshWithLock(auth, sessionStore, authClient) {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const refreshToken = sessionStore.getRefreshToken();
      if (!refreshToken) {
        await sessionStore.clearSession();
        return { ok: false, reason: "missing_refresh_token" };
      }
      const refreshResult = await authClient.refreshSession(refreshToken);
      if (!refreshResult.ok) {
        await sessionStore.clearSession();
        return { ok: false, reason: refreshResult.errorCode || "refresh_failed", status: refreshResult.status };
      }
      const payload = refreshResult.payload ?? {};
      await sessionStore.setSession({
        accessToken: String(payload?.accessToken ?? payload?.token ?? ""),
        refreshToken: String(payload?.refreshToken ?? refreshToken),
        tokenType: "Bearer",
        expiresAt: String(payload?.expiresAt ?? payload?.accessTokenExpiresAt ?? ""),
        user: payload?.user ?? sessionStore.getSession().user ?? null
      });
      return { ok: true };
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  async function authenticatedFetch(input, init = {}, options = {}) {
    const auth = globalThis.SceneForgeAuth ?? {};
    const sessionStore = auth.SessionStore;
    const authClient = auth.AuthClient;
    if (!sessionStore || !authClient) {
      return fetch(input, init);
    }

    const opts = { retryOnUnauthorized: true, promptLoginOnFailure: true, ...options };
    let session = sessionStore.getSession();
    if (sessionStore.isAccessTokenExpired?.() && sessionStore.getRefreshToken()) {
      await refreshWithLock(auth, sessionStore, authClient);
      session = sessionStore.getSession();
    }
    const accessToken = String(session.accessToken ?? "").trim();
    const headers = new Headers(init?.headers ?? {});
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

    const firstResponse = await fetch(input, { ...init, headers });
    if (!(opts.retryOnUnauthorized && firstResponse.status === 401)) {
      return firstResponse;
    }

    const refreshResult = await refreshWithLock(auth, sessionStore, authClient);
    if (!refreshResult.ok) {
      if (opts.promptLoginOnFailure) auth.LoginWindow?.open?.();
      return firstResponse;
    }

    const retriedHeaders = new Headers(init?.headers ?? {});
    const retriedToken = sessionStore.getAccessToken();
    if (retriedToken) retriedHeaders.set("Authorization", `Bearer ${retriedToken}`);
    const retriedResponse = await fetch(input, { ...init, headers: retriedHeaders });
    if (retriedResponse.status === 401 && opts.promptLoginOnFailure) {
      await sessionStore.clearSession();
      auth.LoginWindow?.open?.();
    }
    return retriedResponse;
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.authenticatedFetch = authenticatedFetch;
  globalThis.SceneForgeAuth._refreshWithLock = refreshWithLock;
})();
