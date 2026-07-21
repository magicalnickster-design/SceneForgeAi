(() => {
  const IMAGE_INPUT_FIELDS = [
    "image",
    "inputImage",
    "input_image",
    "imageUrl",
    "image_url",
    "referenceImage",
    "base64Image",
    "editSource",
    "previousImage"
  ];

  function normalizeGenerationId(value) {
    return String(value ?? "").trim();
  }

  function isFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed);
  }

  function normalizeStringField(value) {
    const normalized = String(value ?? "").trim();
    return normalized || "";
  }

  function extractReservationIdentifier(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    return normalizeGenerationId(
      source?.generationId
      ?? source?.reservationGenerationId
      ?? source?.reservationId
      ?? source?.reservation?.generationId
      ?? source?.reservation?.id
      ?? source?.id
      ?? ""
    );
  }

  function resolveRefundIdentifier({ generationId = "", reservationPayload = null, reservationIdentifier = "" } = {}) {
    const normalizedGenerationId = normalizeGenerationId(generationId);
    if (normalizedGenerationId) return normalizedGenerationId;
    const normalizedReservationIdentifier = normalizeGenerationId(reservationIdentifier);
    if (normalizedReservationIdentifier) return normalizedReservationIdentifier;
    return extractReservationIdentifier(reservationPayload);
  }

  function createCompletionRetryContext(idempotencyKey, generationId, attempt = 1) {
    return {
      idempotencyKey: normalizeGenerationId(idempotencyKey),
      generationId: normalizeGenerationId(generationId),
      attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 1
    };
  }

  function redactSupportKey(value) {
    const normalized = normalizeGenerationId(value);
    if (!normalized) return "(missing)";
    if (normalized.length <= 8) return "***";
    return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
  }

  function buildRefundContractDecision({
    idempotencyKey = "",
    generationId = "",
    reservationIdentifier = "",
    reservationPayload = null
  } = {}) {
    const normalizedReservationIdentifier = normalizeGenerationId(reservationIdentifier);
    const payloadReservationIdentifier = extractReservationIdentifier(reservationPayload);
    const normalizedGenerationId = normalizeGenerationId(generationId);
    const refundGenerationId = resolveRefundIdentifier({
      generationId: normalizedReservationIdentifier || payloadReservationIdentifier || normalizedGenerationId,
      reservationIdentifier: normalizedReservationIdentifier || payloadReservationIdentifier,
      reservationPayload
    });
    const supportKey = redactSupportKey(idempotencyKey);
    if (!refundGenerationId) {
      return {
        shouldRefund: false,
        refundGenerationId: "",
        supportKey,
        userMessage: `SceneForge AI: Unable to refund generation automatically. Contact support with request key ${supportKey}.`
      };
    }
    return {
      shouldRefund: true,
      refundGenerationId,
      supportKey,
      userMessage: ""
    };
  }

  function stripImageInputFields(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
    const clone = {};
    for (const [key, value] of Object.entries(payload)) {
      if (IMAGE_INPUT_FIELDS.includes(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      clone[key] = value;
    }
    return clone;
  }

  function buildTextToImagePayload({
    prompt,
    size,
    orientation,
    width,
    height,
    seed
  } = {}) {
    const payload = {
      prompt: normalizeStringField(prompt),
      size: normalizeStringField(size),
      orientation: normalizeStringField(orientation)
    };
    if (isFiniteNumber(width)) payload.width = Number(width);
    if (isFiniteNumber(height)) payload.height = Number(height);
    if (seed !== undefined && seed !== null) {
      const normalizedSeed = normalizeStringField(seed);
      if (normalizedSeed) payload.seed = normalizedSeed;
    }
    return stripImageInputFields(payload);
  }

  function detectImageInputFields(payload = {}) {
    if (!payload || typeof payload !== "object") return [];
    return IMAGE_INPUT_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(payload, field));
  }

  function buildGeneratePayloadSummary(payload = {}, { idempotencyKey = "" } = {}) {
    const imageInputFields = detectImageInputFields(payload);
    return {
      fieldNames: Object.keys(payload).sort(),
      promptLength: String(payload?.prompt ?? "").length,
      width: Number(payload?.width ?? 0),
      height: Number(payload?.height ?? 0),
      orientation: String(payload?.orientation ?? ""),
      hasImageInputField: imageInputFields.length > 0,
      imageInputFields,
      idempotencyKey: redactSupportKey(idempotencyKey)
    };
  }

  function isGenerationRequestNotFoundError(result = {}) {
    const status = Number(result?.status ?? 0);
    if (status !== 404) return false;
    const message = String(result?.message ?? result?.payload?.message ?? result?.payload?.error ?? "").toLowerCase();
    return message.includes("generation request not found");
  }

  function buildCompletionRetryPlan({ result = {}, attempt = 0, idempotencyKey = "", generationId = "" } = {}) {
    const diagnostic = {
      idempotencyKey: redactSupportKey(idempotencyKey),
      generationId: redactSupportKey(generationId),
      endpoint: String(result?.endpoint ?? ""),
      status: Number(result?.status ?? 0),
      errorCode: String(result?.errorCode ?? "")
    };
    const isNotFound = isGenerationRequestNotFoundError(result);
    if (!isNotFound) {
      return {
        shouldRetry: false,
        stop: true,
        reason: "non_retryable",
        diagnostic,
        userMessage: `SceneForge AI: Could not finalize usage tracking. Contact support with request key ${diagnostic.idempotencyKey}.`
      };
    }
    if (Number(attempt) < 1) {
      return {
        shouldRetry: true,
        stop: false,
        reason: "diagnostic_retry",
        nextAttempt: Number(attempt) + 1,
        diagnostic,
        userMessage: ""
      };
    }
    return {
      shouldRetry: false,
      stop: true,
      reason: "generation_request_not_found",
      diagnostic,
      userMessage: `SceneForge AI: Generation request correlation failed. Contact support with request key ${diagnostic.idempotencyKey}.`
    };
  }

  function nextCompletionRetryContext(context = {}) {
    const current = createCompletionRetryContext(
      context?.idempotencyKey ?? "",
      context?.generationId ?? "",
      context?.attempt ?? 1
    );
    return {
      ...current,
      attempt: current.attempt + 1
    };
  }

  const api = {
    normalizeGenerationId,
    extractReservationIdentifier,
    resolveRefundIdentifier,
    redactSupportKey,
    buildRefundContractDecision,
    buildTextToImagePayload,
    buildGeneratePayloadSummary,
    stripImageInputFields,
    detectImageInputFields,
    isGenerationRequestNotFoundError,
    buildCompletionRetryPlan,
    createCompletionRetryContext,
    nextCompletionRetryContext
  };

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.GenerationTransaction = api;

  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
