(() => {
  const MODULE_ID = "sceneforge-ai";
  const DEFAULT_AUTH_BASE_URL = "https://gambitsforge.online";

  function getAuthBaseUrl() {
    try {
      const configured = String(game.settings?.get?.(MODULE_ID, "gambitsAuthBaseUrl") ?? "").trim();
      return (configured || DEFAULT_AUTH_BASE_URL).replace(/\/+$/, "");
    } catch (_error) {
      return DEFAULT_AUTH_BASE_URL;
    }
  }

  function parseResponsePayload(text) {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  function normalizeSessionPayload(payload = {}) {
    const user = payload?.user ?? payload?.profile ?? payload?.account ?? {};
    const subscription = payload?.subscription ?? payload?.plan ?? payload?.billing ?? {};
    const usage = payload?.usage ?? {};
    const modules = payload?.modules ?? payload?.entitlements ?? [];
    const moduleEntry = Array.isArray(modules)
      ? modules.find((entry) => String(entry?.moduleId ?? entry?.id ?? "").toLowerCase() === MODULE_ID)
      : null;
    const moduleAllowed = moduleEntry
      ? (moduleEntry.allowed !== false && moduleEntry.active !== false)
      : Boolean(
        payload?.entitlement?.allowed
        ?? payload?.sceneforgeAllowed
        ?? payload?.allowed
        ?? false
      );
    const usageLimit = Number(
      usage?.limit
      ?? usage?.monthlyLimit
      ?? payload?.monthlyGenerationLimit
      ?? payload?.usageLimit
      ?? 0
    );
    const usageUsed = Number(
      usage?.used
      ?? usage?.count
      ?? payload?.monthlyGenerationUsed
      ?? payload?.usageCount
      ?? 0
    );
    return {
      authenticated: true,
      user: {
        id: String(user?.id ?? user?._id ?? payload?.userId ?? ""),
        email: String(user?.email ?? payload?.email ?? ""),
        displayName: String(user?.displayName ?? user?.name ?? payload?.name ?? "")
      },
      subscription: {
        active: Boolean(subscription?.active ?? payload?.active ?? false),
        plan: String(subscription?.plan ?? subscription?.name ?? payload?.tier ?? payload?.plan ?? ""),
        status: String(subscription?.status ?? payload?.status ?? ""),
        currentPeriodEnd: subscription?.currentPeriodEnd ?? payload?.currentPeriodEnd ?? payload?.expiresAt ?? null
      },
      entitlement: {
        allowed: Boolean(moduleAllowed),
        moduleId: MODULE_ID
      },
      usage: {
        remaining: Math.max(0, usageLimit - usageUsed),
        limit: Number.isFinite(usageLimit) ? Math.max(0, usageLimit) : 0
      },
      accessToken: String(payload?.accessToken ?? payload?.token ?? ""),
      refreshToken: String(payload?.refreshToken ?? ""),
      expiresAt: String(payload?.expiresAt ?? payload?.accessTokenExpiresAt ?? "")
    };
  }

  async function jsonRequest(path, { method = "GET", body = null, accessToken = "", credentials = "include" } = {}) {
    const baseUrl = getAuthBaseUrl();
    if (!baseUrl) return { ok: false, status: 0, payload: null, message: "Backend URL is not configured." };
    const endpoint = `${baseUrl}${path}`;
    try {
      const headers = { Accept: "application/json" };
      if (body !== null) headers["Content-Type"] = "application/json";
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const response = await fetch(endpoint, {
        method,
        headers,
        credentials,
        body: body !== null ? JSON.stringify(body) : null
      });
      const rawText = await response.text();
      const payload = parseResponsePayload(rawText);
      const message = String(payload?.message ?? payload?.error ?? payload?.detail ?? "").trim();
      const errorCode = String(payload?.errorCode ?? payload?.code ?? payload?.error ?? "").trim().toLowerCase();
      return { ok: response.ok, status: response.status, payload, message, errorCode, endpoint };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        payload: null,
        message: String(error?.message ?? "network error"),
        errorCode: "network_error",
        endpoint
      };
    }
  }

  async function signIn({ email, password, rememberMe }) {
    const result = await jsonRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: String(email ?? "").trim(),
        password: String(password ?? "")
      }
    });
    if (!result.ok) return result;
    const snapshot = await fetchAccountSnapshot(result.payload?.accessToken ?? result.payload?.token ?? "");
    if (!snapshot.ok) return snapshot;
    snapshot.payload = { ...(result.payload ?? {}), ...(snapshot.payload ?? {}) };
    snapshot.normalized = normalizeSessionPayload(snapshot.payload);
    snapshot.normalized.rememberMe = Boolean(rememberMe);
    return snapshot;
  }

  async function refreshSession(refreshToken = "") {
    const body = refreshToken ? { refreshToken: String(refreshToken ?? "") } : {};
    const result = await jsonRequest("/api/auth/refresh", {
      method: "POST",
      body
    });
    if (!result.ok) return result;
    const snapshot = await fetchAccountSnapshot(result.payload?.accessToken ?? result.payload?.token ?? "");
    if (!snapshot.ok) return snapshot;
    snapshot.payload = { ...(result.payload ?? {}), ...(snapshot.payload ?? {}) };
    snapshot.normalized = normalizeSessionPayload(snapshot.payload);
    return snapshot;
  }

  async function fetchCurrentUser(accessToken = "") {
    return jsonRequest("/api/auth/me", { method: "GET", accessToken });
  }

  async function fetchSubscription(accessToken = "") {
    return jsonRequest("/api/subscription", { method: "GET", accessToken });
  }

  async function fetchUsage(accessToken = "") {
    return jsonRequest("/api/usage", { method: "GET", accessToken });
  }

  async function fetchEntitlement(accessToken = "", moduleId = MODULE_ID) {
    const single = await jsonRequest(`/api/modules/${moduleId}`, { method: "GET", accessToken });
    if (single.ok) return single;
    const list = await jsonRequest("/api/modules", { method: "GET", accessToken });
    return list;
  }

  async function fetchAccountSnapshot(accessToken = "") {
    const [me, subscription, usage, entitlement] = await Promise.all([
      fetchCurrentUser(accessToken),
      fetchSubscription(accessToken),
      fetchUsage(accessToken),
      fetchEntitlement(accessToken, MODULE_ID)
    ]);
    const responses = [me, subscription, usage, entitlement];
    const firstFailure = responses.find((entry) => !entry.ok);
    if (firstFailure) return firstFailure;
    const payload = {
      user: me.payload ?? {},
      subscription: subscription.payload ?? {},
      usage: usage.payload ?? {},
      entitlements: entitlement.payload?.modules ?? entitlement.payload ?? []
    };
    return {
      ok: true,
      status: 200,
      payload,
      message: "",
      errorCode: "",
      endpoint: "aggregate",
      normalized: normalizeSessionPayload(payload)
    };
  }

  async function logout() {
    return jsonRequest("/api/auth/logout", {
      method: "POST",
      body: {}
    });
  }

  function stateFromError(result) {
    const code = String(result?.errorCode ?? "").toLowerCase();
    const message = String(result?.message ?? "").toLowerCase();
    const status = Number(result?.status ?? 0);
    if (status === 0) return "backend_offline";
    if (status === 401) return "session_expired";
    if (status === 403 && (code.includes("unverified") || message.includes("verify"))) return "email_unverified";
    if (status === 403 && (code.includes("inactive") || message.includes("inactive") || message.includes("subscription"))) return "subscription_inactive";
    if (status === 403) return "entitlement_denied";
    if (status === 429) return "usage_exhausted";
    return "backend_offline";
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.AuthClient = {
    getAuthBaseUrl,
    jsonRequest,
    normalizeSessionPayload,
    fetchCurrentUser,
    fetchSubscription,
    fetchUsage,
    fetchAccountSnapshot,
    signIn,
    refreshSession,
    fetchEntitlement,
    logout,
    stateFromError
  };
})();
