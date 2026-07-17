(() => {
  function normalizeGenerationId(value) {
    return String(value ?? "").trim();
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
    createCompletionRetryContext,
    nextCompletionRetryContext
  };

  globalThis.SceneForgeAuth = globalThis.SceneForgeAuth ?? {};
  globalThis.SceneForgeAuth.GenerationTransaction = api;

  if (typeof module !== "undefined" && module?.exports) {
    module.exports = api;
  }
})();
