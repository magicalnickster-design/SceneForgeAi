const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const transactionApi = require("../scripts/auth/generation-transaction.js");

function loadAuthClientWithFetch(fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "auth", "auth-client.js"), "utf8");
  const context = {
    console,
    fetch: fetchImpl,
    game: {
      settings: {
        get: (_moduleId, key) => {
          if (key === "gambitsAuthApiBaseUrl") return "https://gambitsforge.online";
          return "";
        }
      }
    },
    SceneForgeAuth: {},
    globalThis: null
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SceneForgeAuth.AuthClient;
}

function createOkResponse(payload = {}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}

test("successful complete sends generationId body and idempotency key", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    return createOkResponse({ ok: true });
  });

  const result = await authClient.complete("access-token", "idem-123", "gen-abc");

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gambitsforge.online/api/entitlements/sceneforge-ai/complete");
  assert.equal(calls[0].init?.headers?.Authorization, "Bearer access-token");
  assert.equal(calls[0].init?.headers?.["Idempotency-Key"], "idem-123");
  assert.deepEqual(JSON.parse(calls[0].init?.body ?? "{}"), { generationId: "gen-abc" });
});

test("refund sends required identifier and idempotency key", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    return createOkResponse({ ok: true });
  });

  const fallbackIdentifier = transactionApi.resolveRefundIdentifier({
    generationId: "",
    reservationPayload: { reservationId: "reserve-42" }
  });
  const result = await authClient.refund("access-token", "idem-xyz", fallbackIdentifier);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gambitsforge.online/api/entitlements/sceneforge-ai/refund");
  assert.equal(calls[0].init?.headers?.["Idempotency-Key"], "idem-xyz");
  assert.deepEqual(JSON.parse(calls[0].init?.body ?? "{}"), { generationId: "reserve-42" });
});

test("missing generationId is rejected safely without network call", async () => {
  let callCount = 0;
  const authClient = loadAuthClientWithFetch(async () => {
    callCount += 1;
    return createOkResponse({ ok: true });
  });

  const completeResult = await authClient.complete("access-token", "idem-1", "");
  const refundResult = await authClient.refund("access-token", "idem-1", "");

  assert.equal(completeResult.ok, false);
  assert.equal(completeResult.errorCode, "MISSING_GENERATION_ID");
  assert.equal(refundResult.ok, false);
  assert.equal(refundResult.errorCode, "MISSING_GENERATION_ID");
  assert.equal(callCount, 0);
});

test("completion retry context preserves generationId and idempotency key", () => {
  const initial = transactionApi.createCompletionRetryContext("idem-keep", "gen-keep", 1);
  const next = transactionApi.nextCompletionRetryContext(initial);

  assert.equal(next.idempotencyKey, "idem-keep");
  assert.equal(next.generationId, "gen-keep");
  assert.equal(next.attempt, 2);
});
