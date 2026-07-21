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

test("consume succeeds, generate fails pre-generationId, refund uses reservation identifier", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/consume")) return createOkResponse({ reservationId: "reserve-77" });
    if (url.endsWith("/refund")) return createOkResponse({ refunded: true });
    return createOkResponse({ ok: true });
  });

  const idempotencyKey = "idem-contract-1";
  const consumeResult = await authClient.consume("access-token", idempotencyKey);
  assert.equal(consumeResult.ok, true);

  // Simulate /api/maps/generate failure before returning generationId.
  const refundDecision = transactionApi.buildRefundContractDecision({
    idempotencyKey,
    generationId: "",
    reservationPayload: consumeResult.payload
  });
  assert.equal(refundDecision.shouldRefund, true);
  assert.equal(refundDecision.refundGenerationId, "reserve-77");

  const refundResult = await authClient.refund("access-token", idempotencyKey, refundDecision.refundGenerationId);
  assert.equal(refundResult.ok, true);

  const consumeCalls = calls.filter((entry) => String(entry.url).endsWith("/consume"));
  const refundCalls = calls.filter((entry) => String(entry.url).endsWith("/refund"));
  assert.equal(consumeCalls.length, 1, "no second consume call should occur");
  assert.equal(refundCalls.length, 1, "refund should happen exactly once");

  const refundCall = refundCalls[0];
  assert.equal(refundCall.init?.headers?.["Idempotency-Key"], idempotencyKey, "same idempotency key preserved");
  const refundBody = JSON.parse(refundCall.init?.body ?? "{}");
  assert.deepEqual(refundBody, { generationId: "reserve-77" });
  assert.ok(Object.keys(refundBody).length > 0, "refund body must not be empty");
});

test("missing generation and reservation identifiers skips refund and provides support key", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    return createOkResponse({ ok: true });
  });

  const decision = transactionApi.buildRefundContractDecision({
    idempotencyKey: "idem-support-9999",
    generationId: "",
    reservationIdentifier: "",
    reservationPayload: {}
  });

  assert.equal(decision.shouldRefund, false);
  assert.equal(decision.refundGenerationId, "");
  assert.equal(decision.supportKey, "idem***9999");
  assert.match(decision.userMessage, /Contact support with request key idem\*\*\*9999/);
  if (decision.shouldRefund) {
    await authClient.refund("access-token", "idem-support-9999", decision.refundGenerationId);
  }
  assert.equal(calls.filter((entry) => String(entry.url).endsWith("/refund")).length, 0);
});

test("same idempotency key and identifier are used from consume through complete", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/consume")) return createOkResponse({ reservationId: "reserve-900" });
    if (url.endsWith("/complete")) return createOkResponse({ completed: true });
    return createOkResponse({});
  });

  const idempotencyKey = "idem-e2e-900";
  const consumeResult = await authClient.consume("access-token", idempotencyKey);
  const identifier = transactionApi.extractReservationIdentifier(consumeResult.payload);
  await authClient.complete("access-token", idempotencyKey, identifier);

  const consumeCalls = calls.filter((entry) => String(entry.url).endsWith("/consume"));
  const completeCalls = calls.filter((entry) => String(entry.url).endsWith("/complete"));
  assert.equal(consumeCalls.length, 1);
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].init?.headers?.["Idempotency-Key"], idempotencyKey);
  assert.deepEqual(JSON.parse(completeCalls[0].init?.body ?? "{}"), { generationId: "reserve-900" });
});

test("refund uses same idempotency key and identifier as consume", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/consume")) return createOkResponse({ reservationId: "reserve-refund-1" });
    if (url.endsWith("/refund")) return createOkResponse({ refunded: true });
    return createOkResponse({});
  });

  const idempotencyKey = "idem-refund-1";
  const consumeResult = await authClient.consume("access-token", idempotencyKey);
  const identifier = transactionApi.extractReservationIdentifier(consumeResult.payload);
  await authClient.refund("access-token", idempotencyKey, identifier);

  const refundCalls = calls.filter((entry) => String(entry.url).endsWith("/refund"));
  assert.equal(refundCalls.length, 1);
  assert.equal(refundCalls[0].init?.headers?.["Idempotency-Key"], idempotencyKey);
  assert.deepEqual(JSON.parse(refundCalls[0].init?.body ?? "{}"), { generationId: "reserve-refund-1" });
});

test("duplicate complete retry does not create a new reservation", async () => {
  const calls = [];
  const authClient = loadAuthClientWithFetch(async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/consume")) return createOkResponse({ reservationId: "reserve-retry-5" });
    if (url.endsWith("/complete")) return createOkResponse({ completed: true });
    return createOkResponse({});
  });

  const idempotencyKey = "idem-retry-5";
  const consumeResult = await authClient.consume("access-token", idempotencyKey);
  const identifier = transactionApi.extractReservationIdentifier(consumeResult.payload);
  await authClient.complete("access-token", idempotencyKey, identifier);
  await authClient.complete("access-token", idempotencyKey, identifier);

  assert.equal(calls.filter((entry) => String(entry.url).endsWith("/consume")).length, 1);
  assert.equal(calls.filter((entry) => String(entry.url).endsWith("/complete")).length, 2);
});

test("normal text-to-image payload contains no image-input fields", () => {
  const payload = transactionApi.buildTextToImagePayload({
    prompt: "A castle map",
    size: "1536x1024",
    orientation: "landscape",
    width: 1536,
    height: 1024,
    image: "should-not-pass",
    inputImage: "should-not-pass",
    image_url: "should-not-pass"
  });
  assert.deepEqual(Object.keys(payload).sort(), ["height", "orientation", "prompt", "size", "width"]);
  assert.equal(transactionApi.detectImageInputFields(payload).length, 0);
  assert.equal(transactionApi.buildGeneratePayloadSummary(payload, { idempotencyKey: "idem-foo-1234" }).hasImageInputField, false);
});

test("empty image/input fields are omitted from payload", () => {
  const payload = transactionApi.buildTextToImagePayload({
    prompt: "A dungeon",
    size: "1024x1024",
    orientation: "square",
    width: 1024,
    height: 1024,
    seed: "",
    referenceImage: "",
    previousImage: null
  });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "seed"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "referenceImage"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "previousImage"), false);
});

test("stale edit state fields are stripped from new generation payload", () => {
  const stripped = transactionApi.stripImageInputFields({
    prompt: "A swamp",
    size: "1536x1024",
    orientation: "portrait",
    width: 1024,
    height: 1536,
    editSource: "stale-edit-reference",
    previousImage: "stale-image",
    input_image: "stale-base64"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "editSource"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "previousImage"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "input_image"), false);
});

test("orientation retry payload has no image input fields", () => {
  const retryPayload = transactionApi.buildTextToImagePayload({
    prompt: "Top-down harbor map",
    size: "1024x1536",
    orientation: "portrait",
    width: 1024,
    height: 1536,
    imageUrl: "stale-from-previous-attempt"
  });
  const summary = transactionApi.buildGeneratePayloadSummary(retryPayload, { idempotencyKey: "idem-orient-7777" });
  assert.equal(summary.orientation, "portrait");
  assert.equal(summary.hasImageInputField, false);
  assert.deepEqual(summary.imageInputFields, []);
});

test("completion 404 not found allows one retry then stops with diagnostics", () => {
  const failure = {
    status: 404,
    endpoint: "https://gambitsforge.online/api/entitlements/sceneforge-ai/complete",
    errorCode: "NOT_FOUND",
    message: "Generation request not found"
  };
  const firstAttempt = transactionApi.buildCompletionRetryPlan({
    result: failure,
    attempt: 0,
    idempotencyKey: "idem-notfound-1234",
    generationId: "reserve-notfound-1234"
  });
  assert.equal(firstAttempt.shouldRetry, true);
  assert.equal(firstAttempt.nextAttempt, 1);

  const secondAttempt = transactionApi.buildCompletionRetryPlan({
    result: failure,
    attempt: 1,
    idempotencyKey: "idem-notfound-1234",
    generationId: "reserve-notfound-1234"
  });
  assert.equal(secondAttempt.shouldRetry, false);
  assert.equal(secondAttempt.stop, true);
  assert.equal(secondAttempt.reason, "generation_request_not_found");
  assert.match(secondAttempt.userMessage, /Contact support with request key idem\*\*\*1234/);
  assert.equal(secondAttempt.diagnostic.status, 404);
});
