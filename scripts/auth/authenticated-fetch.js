(() => {
  async function authenticatedFetch(input, init = {}, options = {}) {
    const auth = globalThis.SceneForgeAuth ?? {};
    const sessionStore = auth.SessionStore;
    const authClient = auth.AuthClient;
    if (!sessionStore || !authClient) {
      return fetch(input, init);
    }

    const opts = { retryOnUnauthorized: true, promptLoginOnFailure: true, ...options };
    const session = sessionStore.getSession();
    const accessToken = String(session.accessToken ?? "").trim();
    const headers = new Headers(init?.headers ?? {});
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

    const firstResponse = await fetch(input, { ...init, headers });
    if (!(opts.retryOnUnauthorized && firstResponse.status === 401)) {
      return firstResponse;
    }

    const refreshToken = sessionStore.getRefreshToken();
    if (!refreshToken) {
      await sessionStore.clearSession();
      if (opts.promptLoginOnFailure) auth.LoginWindow?.open?.();
      return firstResponse;
    }

    const refreshResult = await authClient.refreshSession(refreshToken);
    if (!refreshResult.ok) {
      await sessionStore.clearSession();
      if (opts.promptLoginOnFailure) auth.LoginWindow?.open?.();
      return firstResponse;
    }

    const payload = refreshResult.payload ?? {};
    await sessionStore.setSession({
      accessToken: String(payload?.accessToken ?? payload?.token ?? ""),
      refreshToken: String(payload?.refreshToken ?? refreshToken),
      tokenType: "Bearer",
      expiresAt: String(payload?.expiresAt ?? payload?.accessTokenExpiresAt ?? ""),
      user: payload?.user ?? session.user ?? null
    });

    const retriedHeaders = new Headers(init?.headers ?? {});
    const retriedToken = sessionStore.getAccessToken();
    if (retriedToken) retriedHeaders.set("Authorization", `Bearer ${retriedToken}`);
    return fetch(input, { ...init, headers: retriedHeaders });
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.authenticatedFetch = authenticatedFetch;
})();
