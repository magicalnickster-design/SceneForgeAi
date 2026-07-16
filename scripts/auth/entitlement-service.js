(() => {
  const AUTH_STATES = Object.freeze({
    NOT_SIGNED_IN: "Not Signed In",
    SESSION_EXPIRED: "Session Expired",
    SUBSCRIPTION_INACTIVE: "Subscription Inactive",
    BACKEND_OFFLINE: "Backend Offline",
    LOADING: "Loading",
    AUTHENTICATED: "Authenticated"
  });

  let currentState = AUTH_STATES.NOT_SIGNED_IN;
  let currentEntitlement = null;

  function setState(nextState) {
    currentState = nextState;
  }

  function getState() {
    return currentState;
  }

  function normalizeEntitlement(payload = {}) {
    const tier = String(payload?.tier ?? payload?.plan ?? payload?.subscription?.tier ?? "none");
    const usageLimit = Number(payload?.usageLimit ?? payload?.monthlyGenerationLimit ?? payload?.usage?.limit ?? 0);
    const usageCount = Number(payload?.usageCount ?? payload?.monthlyGenerationUsed ?? payload?.usage?.used ?? 0);
    const remaining = Math.max(0, usageLimit - usageCount);
    const active = payload?.active === true || String(payload?.subscription?.active ?? payload?.active ?? "").toLowerCase() === "true";
    return {
      linked: Boolean(payload?.linked ?? true),
      active,
      tier,
      plan: tier,
      usageLimit: Number.isFinite(usageLimit) ? Math.max(0, usageLimit) : 0,
      usageCount: Number.isFinite(usageCount) ? Math.max(0, usageCount) : 0,
      remainingGenerations: remaining,
      renewalDate: String(payload?.resetAt ?? payload?.expiresAt ?? payload?.subscription?.expiresAt ?? ""),
      user: payload?.user ?? null,
      discordUserId: String(payload?.discordUserId ?? payload?.user?.id ?? ""),
      payload
    };
  }

  async function syncEntitlement({ notify = false } = {}) {
    const auth = globalThis.SceneForgeAuth ?? {};
    const store = auth.SessionStore;
    const client = auth.AuthClient;
    if (!store || !client) {
      setState(AUTH_STATES.BACKEND_OFFLINE);
      return { ok: false, reason: "auth-unavailable" };
    }

    const accessToken = store.getAccessToken();
    if (!accessToken) {
      setState(AUTH_STATES.NOT_SIGNED_IN);
      return { ok: false, reason: "not-signed-in" };
    }

    setState(AUTH_STATES.LOADING);
    const baseUrl = client.getBackendBaseUrl();
    if (!baseUrl) {
      setState(AUTH_STATES.BACKEND_OFFLINE);
      return { ok: false, reason: "missing-backend-url" };
    }
    const endpoint = `${baseUrl}/api/subscription/status`;
    const response = await auth.authenticatedFetch?.(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" }
    }, {
      retryOnUnauthorized: true,
      promptLoginOnFailure: false
    });
    const payload = await response?.json?.().catch?.(() => ({}));
    if (!response?.ok) {
      if (response?.status === 401) {
        setState(AUTH_STATES.SESSION_EXPIRED);
      } else if (!response || response?.status === 0) {
        setState(AUTH_STATES.BACKEND_OFFLINE);
      } else if (response?.status === 403) {
        setState(AUTH_STATES.SUBSCRIPTION_INACTIVE);
      } else {
        setState(AUTH_STATES.BACKEND_OFFLINE);
      }
      const failureMessage = String(payload?.message ?? payload?.error ?? payload?.detail ?? "Could not verify subscription.");
      if (notify) ui.notifications.error(`SceneForge AI: ${failureMessage}`);
      return { ok: false, reason: "entitlement-failed", status: response?.status ?? 0, payload };
    }

    currentEntitlement = normalizeEntitlement(payload ?? {});
    if (!currentEntitlement.active) {
      setState(AUTH_STATES.SUBSCRIPTION_INACTIVE);
      if (notify) ui.notifications.error("SceneForge AI: Subscription is inactive.");
      return { ok: false, reason: "subscription-inactive", payload, entitlement: currentEntitlement };
    }

    setState(AUTH_STATES.AUTHENTICATED);
    return { ok: true, entitlement: currentEntitlement, payload };
  }

  async function restoreSessionOnStartup({ notify = false } = {}) {
    const result = await syncEntitlement({ notify });
    return result.ok;
  }

  async function ensureCanGenerate({ notify = true } = {}) {
    const result = await syncEntitlement({ notify: false });
    if (!result.ok) {
      if (notify) {
        const message = getState() === AUTH_STATES.NOT_SIGNED_IN
          ? "Please sign in to Gambits Forge first."
          : getState() === AUTH_STATES.SESSION_EXPIRED
            ? "Session expired. Please sign in again."
            : getState() === AUTH_STATES.BACKEND_OFFLINE
              ? "Gambits Forge backend is offline."
              : "Subscription check failed.";
        ui.notifications.error(`SceneForge AI: ${message}`);
      }
      return { ok: false, reason: result.reason };
    }

    const entitlement = result.entitlement;
    if (!entitlement.active) {
      if (notify) ui.notifications.error("SceneForge AI: Subscription inactive.");
      return { ok: false, reason: "inactive" };
    }
    if (entitlement.usageLimit > 0 && entitlement.usageCount >= entitlement.usageLimit) {
      if (notify) ui.notifications.error(`SceneForge AI: Monthly generation limit reached (${entitlement.usageCount}/${entitlement.usageLimit}).`);
      return { ok: false, reason: "limit-reached", entitlement };
    }
    return { ok: true, entitlement };
  }

  function getEntitlementSnapshot() {
    return currentEntitlement;
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.EntitlementService = {
    AUTH_STATES,
    getState,
    getEntitlementSnapshot,
    syncEntitlement,
    restoreSessionOnStartup,
    ensureCanGenerate
  };
})();
