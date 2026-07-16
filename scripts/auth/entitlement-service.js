(() => {
  const AUTH_STATES = Object.freeze({
    LOADING: "loading",
    SIGNED_OUT: "signed_out",
    EMAIL_UNVERIFIED: "email_unverified",
    SUBSCRIPTION_INACTIVE: "subscription_inactive",
    ENTITLEMENT_DENIED: "entitlement_denied",
    USAGE_EXHAUSTED: "usage_exhausted",
    BACKEND_OFFLINE: "backend_offline",
    SESSION_EXPIRED: "session_expired",
    AUTHENTICATED: "authenticated"
  });

  let currentState = AUTH_STATES.SIGNED_OUT;
  let currentEntitlement = null;
  let lastApiError = "";

  function setState(nextState) {
    currentState = nextState;
  }

  function getState() {
    return currentState;
  }

  function normalizeEntitlement(normalized = {}) {
    const usageLimit = Number(normalized?.usage?.limit ?? 0);
    const remaining = Number(normalized?.usage?.remaining ?? 0);
    return {
      linked: Boolean(normalized?.authenticated ?? false),
      active: Boolean(normalized?.subscription?.active ?? false),
      tier: String(normalized?.subscription?.plan ?? "none"),
      plan: String(normalized?.subscription?.plan ?? "none"),
      usageLimit: Number.isFinite(usageLimit) ? Math.max(0, usageLimit) : 0,
      usageCount: Math.max(0, (Number.isFinite(usageLimit) ? usageLimit : 0) - Math.max(0, remaining)),
      remainingGenerations: remaining,
      renewalDate: String(normalized?.subscription?.currentPeriodEnd ?? ""),
      user: normalized?.user ?? null,
      accountId: String(normalized?.user?.id ?? ""),
      payload: normalized
    };
  }

  function stateMessage(state) {
    switch (state) {
      case AUTH_STATES.SIGNED_OUT:
        return "Please sign in to Gambits Forge.";
      case AUTH_STATES.EMAIL_UNVERIFIED:
        return "Email is not verified. Please verify your email.";
      case AUTH_STATES.SUBSCRIPTION_INACTIVE:
        return "Subscription is inactive.";
      case AUTH_STATES.ENTITLEMENT_DENIED:
        return "Your account is not entitled to SceneForge AI.";
      case AUTH_STATES.USAGE_EXHAUSTED:
        return "Generation limit reached for this billing period.";
      case AUTH_STATES.BACKEND_OFFLINE:
        return "Authentication backend is offline.";
      case AUTH_STATES.SESSION_EXPIRED:
        return "Session expired. Please sign in again.";
      case AUTH_STATES.AUTHENTICATED:
        return "Authenticated.";
      default:
        return "Authentication in progress.";
    }
  }

  async function syncEntitlement({ notify = false } = {}) {
    const auth = globalThis.SceneForgeAuth ?? {};
    const store = auth.SessionStore;
    const client = auth.AuthClient;
    if (!store || !client) {
      setState(AUTH_STATES.BACKEND_OFFLINE);
      lastApiError = "auth_unavailable";
      return { ok: false, reason: "auth-unavailable" };
    }

    const session = store.getSession();
    const accessToken = String(session.accessToken ?? "").trim();
    const refreshToken = String(session.refreshToken ?? "").trim();
    if (!accessToken && !refreshToken) {
      setState(AUTH_STATES.SIGNED_OUT);
      lastApiError = "";
      return { ok: false, reason: "signed-out" };
    }

    setState(AUTH_STATES.LOADING);
    let snapshot = await client.getEntitlement(accessToken);
    if (!snapshot.ok && Number(snapshot.status) === 401 && refreshToken) {
      const refreshResult = await auth._refreshWithLock?.(auth, store, client);
      if (refreshResult?.ok) {
        const refreshedToken = store.getAccessToken();
        snapshot = await client.getEntitlement(refreshedToken);
      }
    }
    if (!snapshot.ok) {
      const nextState = client.stateFromError?.(snapshot) ?? AUTH_STATES.BACKEND_OFFLINE;
      setState(nextState);
      lastApiError = snapshot?.message ?? snapshot?.errorCode ?? "";
      if (notify) ui.notifications.error(`SceneForge AI: ${snapshot?.message || stateMessage(nextState)}`);
      return { ok: false, reason: nextState, status: snapshot.status, payload: snapshot.payload };
    }

    const normalized = client.normalizeSessionPayload?.(store.getSession(), snapshot.payload ?? {}) ?? {};
    currentEntitlement = normalizeEntitlement(normalized);
    lastApiError = "";

    if (!currentEntitlement.active) {
      setState(AUTH_STATES.SUBSCRIPTION_INACTIVE);
      if (notify) ui.notifications.error("SceneForge AI: Subscription is inactive.");
      return { ok: false, reason: AUTH_STATES.SUBSCRIPTION_INACTIVE, payload: snapshot.payload, entitlement: currentEntitlement };
    }
    if (!normalized?.entitlement?.allowed) {
      setState(AUTH_STATES.ENTITLEMENT_DENIED);
      if (notify) ui.notifications.error("SceneForge AI: Entitlement denied for SceneForge AI.");
      return { ok: false, reason: AUTH_STATES.ENTITLEMENT_DENIED, payload: snapshot.payload, entitlement: currentEntitlement };
    }
    if (currentEntitlement.usageLimit > 0 && currentEntitlement.remainingGenerations <= 0) {
      setState(AUTH_STATES.USAGE_EXHAUSTED);
      if (notify) ui.notifications.error("SceneForge AI: No generations remaining.");
      return { ok: false, reason: AUTH_STATES.USAGE_EXHAUSTED, payload: snapshot.payload, entitlement: currentEntitlement };
    }

    setState(AUTH_STATES.AUTHENTICATED);
    return { ok: true, entitlement: currentEntitlement, payload: snapshot.payload };
  }

  async function restoreSessionOnStartup({ notify = false } = {}) {
    const result = await syncEntitlement({ notify });
    return result.ok;
  }

  async function ensureCanGenerate({ notify = true } = {}) {
    const result = await syncEntitlement({ notify: false });
    if (!result.ok) {
      if (notify) {
        ui.notifications.error(`SceneForge AI: ${stateMessage(getState())}`);
      }
      return { ok: false, reason: result.reason };
    }

    const entitlement = result.entitlement;
    if (!entitlement.active) {
      if (notify) ui.notifications.error(`SceneForge AI: ${stateMessage(AUTH_STATES.SUBSCRIPTION_INACTIVE)}`);
      return { ok: false, reason: "inactive" };
    }
    if (entitlement.usageLimit > 0 && entitlement.usageCount >= entitlement.usageLimit) {
      setState(AUTH_STATES.USAGE_EXHAUSTED);
      if (notify) ui.notifications.error(`SceneForge AI: ${stateMessage(AUTH_STATES.USAGE_EXHAUSTED)}`);
      return { ok: false, reason: "limit-reached", entitlement };
    }
    return { ok: true, entitlement };
  }

  function getEntitlementSnapshot() {
    return currentEntitlement;
  }

  function getDiagnostics() {
    const auth = globalThis.SceneForgeAuth ?? {};
    const session = auth.SessionStore?.getSession?.() ?? {};
    const client = auth.AuthClient;
    return {
      apiBaseUrl: client?.getAuthBaseUrl?.() ?? "",
      authState: currentState,
      userEmail: String(currentEntitlement?.user?.email ?? session?.user?.email ?? ""),
      subscriptionStatus: String(currentEntitlement?.active ? "active" : "inactive"),
      plan: String(currentEntitlement?.plan ?? ""),
      entitlementAllowed: Boolean(currentEntitlement?.linked && currentEntitlement?.active),
      usageRemaining: Number(currentEntitlement?.remainingGenerations ?? 0),
      usageLimit: Number(currentEntitlement?.usageLimit ?? 0),
      accessTokenExpiresAt: String(session?.expiresAt ?? ""),
      hasRefreshToken: Boolean(String(session?.refreshToken ?? "").trim()),
      lastApiError
    };
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.EntitlementService = {
    AUTH_STATES,
    stateMessage,
    getState,
    getEntitlementSnapshot,
    getDiagnostics,
    syncEntitlement,
    restoreSessionOnStartup,
    ensureCanGenerate
  };
})();
