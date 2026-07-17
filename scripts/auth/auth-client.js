(() => {
  const MODULE_ID = "sceneforge-ai";
  const SETTING_AUTH_API_BASE_URL = "gambitsAuthApiBaseUrl";
  const DEFAULT_AUTH_API_BASE_URL = "https://gambitsforge.online";

  function getAuthBaseUrl() {
    try {
      const configured = String(game.settings?.get?.(MODULE_ID, SETTING_AUTH_API_BASE_URL) ?? "").trim();
      return (configured || DEFAULT_AUTH_API_BASE_URL).replace(/\/+$/, "");
    } catch (_error) {
      return DEFAULT_AUTH_API_BASE_URL;
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

  function normalizeSessionPayload(authPayload = {}, entitlementPayload = {}) {
    const usage = entitlementPayload?.usage ?? {};
    const usageLimit = Number(usage?.limit ?? 0);
    const usageUsed = Number(usage?.used ?? 0);
    const usageRemaining = Number(usage?.remaining ?? Math.max(0, usageLimit - usageUsed));
    return {
      authenticated: true,
      user: {
        id: String(authPayload?.user?.id ?? ""),
        email: String(authPayload?.user?.email ?? ""),
        displayName: String(authPayload?.user?.email ?? "")
      },
      subscription: {
        active: String(entitlementPayload?.subscriptionStatus ?? "").toLowerCase() === "active",
        plan: String(entitlementPayload?.plan ?? ""),
        status: String(entitlementPayload?.subscriptionStatus ?? ""),
        currentPeriodEnd: usage?.resetsAt ?? null
      },
      entitlement: {
        allowed: Boolean(entitlementPayload?.allowed === true),
        moduleId: MODULE_ID
      },
      usage: {
        remaining: Number.isFinite(usageRemaining) ? Math.max(0, usageRemaining) : 0,
        limit: Number.isFinite(usageLimit) ? Math.max(0, usageLimit) : 0
      },
      accessToken: String(authPayload?.accessToken ?? ""),
      refreshToken: String(authPayload?.refreshToken ?? ""),
      expiresAt: String(authPayload?.expiresAt ?? "")
    };
  }

  async function jsonRequest(path, { method = "GET", body = null, accessToken = "", extraHeaders = {} } = {}) {
    const baseUrl = getAuthBaseUrl();
    if (!baseUrl) {
      return {
        ok: false,
        status: 0,
        payload: null,
        message: "Backend URL is not configured.",
        errorCode: "BACKEND_UNAVAILABLE",
        endpoint: ""
      };
    }
    const endpoint = `${baseUrl}${path}`;
    try {
      const headers = {
        Accept: "application/json",
        ...extraHeaders
      };
      if (body !== null) headers["Content-Type"] = "application/json";
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

      const response = await fetch(endpoint, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : null
      });
      const rawText = await response.text();
      const payload = parseResponsePayload(rawText);
      const errorCode = String(payload?.errorCode ?? payload?.code ?? payload?.error ?? "").trim() || "";
      const message = String(payload?.message ?? payload?.error ?? payload?.detail ?? "").trim();
      return { ok: response.ok, status: response.status, payload, message, errorCode, endpoint };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        payload: null,
        message: String(error?.message ?? "network error"),
        errorCode: "BACKEND_UNAVAILABLE",
        endpoint
      };
    }
  }

  async function login({ email, password, rememberMe }) {
    const authResult = await jsonRequest("/api/auth/login", {
      method: "POST",
      body: {
        email: String(email ?? "").trim(),
        password: String(password ?? "")
      }
    });
    if (!authResult.ok) return authResult;

    const entitlementResult = await getEntitlement(String(authResult.payload?.accessToken ?? ""));
    if (!entitlementResult.ok) return entitlementResult;

    authResult.normalized = normalizeSessionPayload(authResult.payload ?? {}, entitlementResult.payload ?? {});
    authResult.normalized.rememberMe = Boolean(rememberMe);
    return authResult;
  }

  async function refresh(refreshToken) {
    const refreshResult = await jsonRequest("/api/auth/refresh", {
      method: "POST",
      body: {
        refreshToken: String(refreshToken ?? "")
      }
    });
    if (!refreshResult.ok) return refreshResult;

    const entitlementResult = await getEntitlement(String(refreshResult.payload?.accessToken ?? ""));
    if (!entitlementResult.ok) return entitlementResult;

    refreshResult.normalized = normalizeSessionPayload(refreshResult.payload ?? {}, entitlementResult.payload ?? {});
    return refreshResult;
  }

  async function logout(refreshToken) {
    return jsonRequest("/api/auth/logout", {
      method: "POST",
      body: {
        refreshToken: String(refreshToken ?? "")
      }
    });
  }

  async function getEntitlement(accessToken) {
    return jsonRequest("/api/entitlements/sceneforge-ai", {
      method: "GET",
      accessToken
    });
  }

  async function consume(accessToken, idempotencyKey) {
    return jsonRequest("/api/entitlements/sceneforge-ai/consume", {
      method: "POST",
      accessToken,
      body: {},
      extraHeaders: {
        "Idempotency-Key": String(idempotencyKey ?? "")
      }
    });
  }

  function normalizeGenerationId(generationId) {
    return String(generationId ?? "").trim();
  }

  async function complete(accessToken, idempotencyKey, generationId) {
    const normalizedGenerationId = normalizeGenerationId(generationId);
    if (!normalizedGenerationId) {
      return {
        ok: false,
        status: 400,
        payload: null,
        message: "generationId is required for completion.",
        errorCode: "MISSING_GENERATION_ID",
        endpoint: ""
      };
    }
    return jsonRequest("/api/entitlements/sceneforge-ai/complete", {
      method: "POST",
      accessToken,
      body: {
        generationId: normalizedGenerationId
      },
      extraHeaders: {
        "Idempotency-Key": String(idempotencyKey ?? "")
      }
    });
  }

  async function refund(accessToken, idempotencyKey, generationId) {
    const normalizedGenerationId = normalizeGenerationId(generationId);
    if (!normalizedGenerationId) {
      return {
        ok: false,
        status: 400,
        payload: null,
        message: "generationId is required for refund.",
        errorCode: "MISSING_GENERATION_ID",
        endpoint: ""
      };
    }
    return jsonRequest("/api/entitlements/sceneforge-ai/refund", {
      method: "POST",
      accessToken,
      body: {
        generationId: normalizedGenerationId
      },
      extraHeaders: {
        "Idempotency-Key": String(idempotencyKey ?? "")
      }
    });
  }

  function stateFromError(result) {
    const code = String(result?.errorCode ?? "").toUpperCase();
    if (code === "AUTH_REQUIRED") return "signed_out";
    if (code === "SESSION_EXPIRED") return "session_expired";
    if (code === "EMAIL_NOT_VERIFIED") return "email_unverified";
    if (code === "SUBSCRIPTION_INACTIVE") return "subscription_inactive";
    if (code === "ENTITLEMENT_DENIED") return "entitlement_denied";
    if (code === "USAGE_EXHAUSTED") return "usage_exhausted";
    if (code === "RATE_LIMITED") return "backend_offline";
    if (code === "BACKEND_UNAVAILABLE") return "backend_offline";
    return "backend_offline";
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.AuthClient = {
    getAuthBaseUrl,
    jsonRequest,
    normalizeSessionPayload,
    login,
    refresh,
    logout,
    getEntitlement,
    consume,
    complete,
    refund,
    stateFromError
  };
})();
