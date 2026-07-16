(() => {
  const ACCOUNT_URL = "https://gambitsforge.online";

  async function performLogin(formData) {
    const auth = globalThis.SceneForgeAuth ?? {};
    const client = auth.AuthClient;
    const store = auth.SessionStore;
    if (!client || !store) {
      ui.notifications.error("SceneForge AI: Authentication services are unavailable.");
      return false;
    }

    const result = await client.signIn(formData);
    if (!result.ok) {
      const code = String(result?.errorCode ?? "").toLowerCase();
      if (code.includes("verify") || Number(result?.status) === 403) {
        ui.notifications.error("SceneForge AI: Email verification required. Please verify your account.");
      } else {
        ui.notifications.error(`SceneForge AI: ${result.message || "Sign in failed."}`);
      }
      return false;
    }

    const normalized = result.normalized ?? {};
    await store.setSession({
      accessToken: String(normalized?.accessToken ?? ""),
      refreshToken: String(normalized?.refreshToken ?? ""),
      tokenType: "Bearer",
      expiresAt: String(normalized?.expiresAt ?? ""),
      rememberMe: Boolean(formData.rememberMe),
      user: normalized?.user ?? null
    });
    const entitlementResult = await auth.EntitlementService?.syncEntitlement?.({ notify: false });
    if (entitlementResult?.ok) {
      ui.notifications.info("SceneForge AI: Signed in successfully.");
      return true;
    }
    ui.notifications.warn("SceneForge AI: Signed in, but subscription could not be verified.");
    return true;
  }

  function open({ title = "SceneForge AI - Gambits Forge Login" } = {}) {
    const content = `
      <form class="sceneforge-gambits-login">
        <p><strong>Gambits Forge</strong></p>
        <div class="form-group">
          <label>Email</label>
          <input type="email" name="email" autocomplete="username" required />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" name="password" autocomplete="current-password" required />
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" name="rememberMe" />
            Remember Me
          </label>
        </div>
      </form>
    `;

    return new Promise((resolve) => {
      const dialog = new Dialog({
        title,
        content,
        buttons: {
          signin: {
            label: "Sign In",
            callback: (html) => {
              void (async () => {
                const root = html?.[0] ?? html;
                const email = root?.querySelector?.('input[name="email"]')?.value ?? "";
                const password = root?.querySelector?.('input[name="password"]')?.value ?? "";
                const rememberMe = Boolean(root?.querySelector?.('input[name="rememberMe"]')?.checked);
                const ok = await performLogin({ email, password, rememberMe });
                resolve(ok);
              })();
            }
          },
          forgot: {
            label: "Forgot Password",
            callback: () => {
              window.open(ACCOUNT_URL, "_blank", "noopener,noreferrer");
              resolve(false);
            }
          },
          create: {
            label: "Create Account",
            callback: () => {
              window.open(ACCOUNT_URL, "_blank", "noopener,noreferrer");
              resolve(false);
            }
          }
        },
        default: "signin",
        close: () => resolve(false)
      });
      dialog.render(true);
    });
  }

  async function logout() {
    const auth = globalThis.SceneForgeAuth ?? {};
    await auth.AuthClient?.logout?.();
    await auth.SessionStore?.clearSession?.();
    ui.notifications.info("SceneForge AI: Logged out.");
  }

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.LoginWindow = {
    open,
    logout
  };
})();
