/**
 * SceneForge AI (MVP+)
 * --------------------
 * This version keeps the original MVP behavior, then adds:
 *  - seeded deterministic generation
 *  - multiple themed layout variations
 *  - Scene directory context menu actions for image edit, preset IO, and voting
 *  - per-document flags so regeneration only removes SceneForge content
 *
 * There is still NO real AI call here. Layouts are template-driven.
 */

const MODULE_ID = "sceneforge-ai";
const GRID_SIZE_PX = 100;
const DEFAULT_SCENE_BACKGROUND_COLOR = "#000000";
const FLAG_GENERATION_KEY = "generationData";
const FLAG_GENERATED_KEY = "generated";
const FLAG_IMAGE_GENERATION_KEY = "imageGeneration";
const FLAG_IMAGE_DUMP_ENTRY_ID = "imageDumpEntryId";
const DEBUG = false;
const GLOBAL_IMAGE_LIBRARY_ONLY = true;
const TILE_FALLBACK_MODE = "skip-missing";
// Temporary product-focus switch: disable all spawned tile/prop/pack assets.
const ENABLE_ASSET_SPAWNING = false;
// Test isolation switch: disable all SceneForge journals and notes.
const ENABLE_JOURNALS_AND_NOTES = false;
// Product decision: do not generate procedural walls/lights over AI maps.
const ENABLE_SCENE_WALLS_AND_LIGHTS = false;

/**
 * Lightweight debug logger so noisy logs can stay disabled by default.
 * Set DEBUG = true while developing/troubleshooting.
 */
function debugLog(...args) {
  if (!DEBUG) return;
  console.log(`${MODULE_ID} |`, ...args);
}

function debugPayload(label, payload) {
  if (!DEBUG) return;
  console.log(`${MODULE_ID} | ${label} payload:`, payload);
}

function logImagePipelineError(stage, details = {}, error = null) {
  const payload = { ...details };
  if (error) {
    payload.error = error?.stack ?? error?.message ?? String(error);
  }
  console.error(`${MODULE_ID} | ${stage}`, payload);
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:");
}

function isBflDeliveryUrl(value) {
  return typeof value === "string" && /^https?:\/\/delivery\.[^.]+\.bfl\.ai\//i.test(value);
}

function buildDataUrlFromBase64(base64Value, mimeType = "image/png") {
  const normalized = String(base64Value ?? "").trim();
  if (!normalized) return "";
  return `data:${String(mimeType || "image/png").trim()};base64,${normalized}`;
}

async function resolveBflRemoteImageForPersistence(remoteUrl) {
  const backendBaseUrl = getSubscriptionBackendUrl();
  const authFetch = getAuthApi()?.authenticatedFetch ?? fetch;
  if (!backendBaseUrl || !getSubscriptionAuthToken()) return null;

  const candidates = [
    { path: "/api/maps/image/proxy", method: "POST", body: { imageUrl: remoteUrl } },
    { path: "/api/maps/image/proxy", method: "POST", body: { remoteUrl } },
    { path: "/api/maps/image/fetch", method: "POST", body: { imageUrl: remoteUrl } },
    { path: "/api/maps/image/fetch", method: "POST", body: { remoteUrl } }
  ];

  for (const candidate of candidates) {
    const endpoint = `${backendBaseUrl}${candidate.path}`;
    try {
      const response = await authFetch(endpoint, {
        method: candidate.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(candidate.body)
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({}));
      const localPath = String(payload?.localPath ?? payload?.path ?? payload?.imagePath ?? "").trim();
      if (localPath && !isHttpUrl(localPath) && !isDataUrl(localPath)) return localPath;
      const returnedDataUrl = String(payload?.dataUrl ?? payload?.imageDataUrl ?? "").trim();
      if (returnedDataUrl && isDataUrl(returnedDataUrl)) return returnedDataUrl;
      const base64Value = String(payload?.base64 ?? payload?.imageBase64 ?? "").trim();
      if (base64Value) {
        const mimeType = String(payload?.mimeType ?? payload?.contentType ?? "image/png").trim();
        return buildDataUrlFromBase64(base64Value, mimeType);
      }
    } catch (_error) {
      // Try the next candidate endpoint.
    }
  }
  return null;
}

function normalizePathForComparison(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (isDataUrl(raw)) return raw;

  let normalized = raw;
  try {
    const parsed = new URL(raw, window.location.origin);
    normalized = `${parsed.pathname}${parsed.search}`;
  } catch (_error) {
    normalized = raw;
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch (_error) {
    // Keep non-decoded value if malformed encoding is present.
  }

  normalized = normalized
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\//, "")
    .replace(/[?#].*$/, "")
    .trim();

  return normalized;
}

function pathsLikelyMatch(leftPath, rightPath) {
  const left = normalizePathForComparison(leftPath);
  const right = normalizePathForComparison(rightPath);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function getFilePickerImpl() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker ?? null;
}

function getRenderTemplateFn() {
  return foundry?.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
}

async function ensureDataDirectory(path) {
  const FilePickerImpl = getFilePickerImpl();
  if (!path || typeof FilePickerImpl?.createDirectory !== "function") return;
  const parts = String(path).split("/").filter((part) => part.length > 0);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePickerImpl.createDirectory("data", current);
    } catch (_error) {
      // Ignore if directory already exists or cannot be created.
    }
  }
}

function inferImageExtension(inputPath, mimeType = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("png")) return "png";

  const path = String(inputPath ?? "");
  const match = path.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
  if (match) return match[1].toLowerCase();
  return "png";
}

function parseImageSizeString(sizeValue) {
  const raw = String(sizeValue ?? "").trim();
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl ?? "").match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) throw new Error("Invalid data URL.");
  const mimeType = match[1] || "image/png";
  const isBase64 = Boolean(match[2]);
  const dataSegment = match[3] || "";
  if (isBase64) {
    const binary = atob(dataSegment);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(dataSegment)], { type: mimeType });
}

async function persistSceneBackgroundPath(imagePath, options = {}) {
  if (typeof imagePath !== "string" || imagePath.trim().length === 0) return imagePath;
  const trimmedPath = imagePath.trim();
  const FilePickerImpl = getFilePickerImpl();

  // Already local/relative module path; no persistence needed.
  if (!isHttpUrl(trimmedPath) && !isDataUrl(trimmedPath)) return trimmedPath;
  // BFL delivery URLs intentionally do not allow direct browser CORS fetches.
  // Try backend proxy/relay endpoints first so we can still persist locally.
  let resolvedInputPath = trimmedPath;
  if (isBflDeliveryUrl(trimmedPath)) {
    const proxiedPath = await resolveBflRemoteImageForPersistence(trimmedPath);
    if (proxiedPath) {
      if (!isHttpUrl(proxiedPath) && !isDataUrl(proxiedPath)) return proxiedPath;
      resolvedInputPath = proxiedPath;
    } else {
      logImagePipelineError("bfl remote image cannot be persisted locally", {
        imagePath: trimmedPath,
        note: "Backend image relay endpoint is missing. Expected /api/maps/image/proxy or /api/maps/image/fetch."
      });
      return null;
    }
  }
  if (typeof FilePickerImpl?.upload !== "function" || typeof File !== "function") return trimmedPath;

  const { seed = "map", provider = "ai" } = options;
  const targetDir = `${MODULE_ID}/generated-maps`;
  await ensureDataDirectory(targetDir);

  try {
    let blob;
    if (isDataUrl(resolvedInputPath)) {
      blob = dataUrlToBlob(resolvedInputPath);
    } else {
      const response = await fetch(resolvedInputPath, { method: "GET", cache: "no-store" });
      if (!response.ok) throw new Error(`Background fetch failed (${response.status}).`);
      blob = await response.blob();
    }

    const extension = inferImageExtension(resolvedInputPath, blob.type);
    const safeProvider = String(provider ?? "ai").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const safeSeed = String(seed ?? "map").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const filename = `map-${safeProvider}-${safeSeed}-${Date.now()}.${extension}`;
    const file = new File([blob], filename, { type: blob.type || "image/png" });
    const uploadResult = await FilePickerImpl.upload("data", targetDir, file, {}, { notify: false });
    const uploadedPath = uploadResult?.path ?? uploadResult?.files?.[0] ?? null;
    if (uploadedPath) return uploadedPath;
  } catch (error) {
    debugLog("Background persistence skipped; using original path", error?.message ?? error);
  }

  return trimmedPath;
}

// Defensive constant fallbacks to avoid runtime failures across minor API differences.
const WALL_NORMAL = CONST.EDGE_SENSE_TYPES?.NORMAL ?? CONST.WALL_SENSE_TYPES?.NORMAL ?? 1;
const WALL_DOOR_NONE = CONST.WALL_DOOR_TYPES?.NONE ?? 0;
const WALL_DOOR_CLOSED = CONST.WALL_DOOR_STATES?.CLOSED ?? 0;
const ASSET_PATH_AVAILABILITY_CACHE = new Map();

function getSceneBackgroundSrc(scene) {
  const objectData = scene?.toObject ? scene.toObject() : null;
  const levelBackgroundSrc =
    scene?.levels?.contents?.[0]?.textures?.background?.src
    ?? scene?.levels?.contents?.[0]?.background?.src
    ?? scene?.collections?.levels?.contents?.[0]?.textures?.background?.src
    ?? scene?.collections?.levels?.contents?.[0]?.background?.src
    ?? objectData?.levels?.[0]?.textures?.background?.src
    ?? objectData?.levels?.[0]?.background?.src
    ?? null;
  if (levelBackgroundSrc) return levelBackgroundSrc;
  return (
    scene?._source?.background?.src
    ?? objectData?.background?.src
    ?? null
  );
}

function getPrimarySceneLevel(scene) {
  const fromLevelsCollection = scene?.levels?.contents?.[0] ?? null;
  if (fromLevelsCollection) return fromLevelsCollection;
  const fromEmbeddedCollection = scene?.collections?.levels?.contents?.[0] ?? null;
  return fromEmbeddedCollection;
}

async function applyBackgroundToScene(scene, backgroundSrc) {
  if (!scene || !backgroundSrc) {
    return {
      applied: false,
      finalBackgroundSrc: null
    };
  }

  // Attempt 1: v14+ level background paths.
  await scene.update({
    "levels.0.textures.background.src": backgroundSrc,
    "levels.0.background.src": backgroundSrc
  });
  let finalBackgroundSrc = getSceneBackgroundSrc(scene);
  if (pathsLikelyMatch(finalBackgroundSrc, backgroundSrc)) {
    return {
      applied: true,
      finalBackgroundSrc
    };
  }

  // Attempt 2: explicit level document update.
  const primaryLevel = getPrimarySceneLevel(scene);
  if (primaryLevel?.update) {
    await primaryLevel.update({
      "textures.background.src": backgroundSrc,
      "background.src": backgroundSrc
    });
    finalBackgroundSrc = getSceneBackgroundSrc(scene);
    if (pathsLikelyMatch(finalBackgroundSrc, backgroundSrc)) {
      return {
        applied: true,
        finalBackgroundSrc
      };
    }
  }

  // Attempt 3: legacy scene-level background path (v12/v13 compatibility).
  await scene.update({
    background: {
      src: backgroundSrc
    }
  });
  finalBackgroundSrc = getSceneBackgroundSrc(scene);
  if (pathsLikelyMatch(finalBackgroundSrc, backgroundSrc)) {
    return {
      applied: true,
      finalBackgroundSrc
    };
  }

  // Attempt 4: dotted path update for versions storing flattened keys.
  await scene.update({
    "background.src": backgroundSrc,
    "levels.0.background.src": backgroundSrc,
    "levels.0.textures.background.src": backgroundSrc
  });
  finalBackgroundSrc = getSceneBackgroundSrc(scene);
  if (pathsLikelyMatch(finalBackgroundSrc, backgroundSrc)) {
    return {
      applied: true,
      finalBackgroundSrc
    };
  }

  return {
    applied: false,
    finalBackgroundSrc
  };
}

function getSceneBackgroundPath(scene) {
  const src = String(getSceneBackgroundSrc(scene) ?? "").trim();
  return src || null;
}

async function loadImageAsBlobOrFile(backgroundPath, options = {}) {
  const src = String(backgroundPath ?? "").trim();
  if (!src) throw new Error("Background image path is empty.");

  const { filenamePrefix = "sceneforge-edit-reference" } = options;
  let blob;
  if (isDataUrl(src)) {
    blob = dataUrlToBlob(src);
  } else {
    const response = await fetch(src, { method: "GET", cache: "no-store" });
    if (!response.ok) throw new Error(`Failed loading reference image (${response.status}).`);
    blob = await response.blob();
  }

  const extension = inferImageExtension(src, blob.type);
  const filename = `${filenamePrefix}-${Date.now()}.${extension}`;
  const file = (typeof File === "function")
    ? new File([blob], filename, { type: blob.type || "image/png" })
    : blob;

  return {
    blob,
    file,
    filename,
    mimeType: blob.type || "image/png"
  };
}

async function persistEditedSceneBackground(imageData, options = {}) {
  return persistSceneBackgroundPath(imageData, {
    seed: options.seed ?? "edit",
    provider: options.provider ?? "edit"
  });
}

async function getImagePixelDimensions(imagePath) {
  const src = String(imagePath ?? "").trim();
  if (!src || typeof Image !== "function") return null;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const width = Number(image.naturalWidth || image.width || 0);
      const height = Number(image.naturalHeight || image.height || 0);
      if (width > 0 && height > 0) resolve({ width, height });
      else resolve(null);
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * Scene sizes are expressed in grid cells.
 * Foundry stores scene dimensions in pixels.
 */
const SCENE_SIZES = {
  small: 30,
  medium: 50,
  large: 70,
  xlarge: 90
};

const SCENE_GRID_PIXEL_SIZES = {
  small: 120,
  medium: 80,
  large: 60,
  xlarge: 40
};

const MAP_COVERAGE_METERS = {
  small: 50,
  medium: 250,
  large: 800,
  xlarge: 1609
};

const IMAGE_ORIENTATION_SPECS = {
  landscape: { key: "landscape", size: "1536x1024", promptLine: "LANDSCAPE ORIENTATION" },
  square: { key: "square", size: "1024x1024", promptLine: "SQUARE ORIENTATION" },
  portrait: { key: "portrait", size: "1024x1536", promptLine: "PORTRAIT ORIENTATION" }
};

const IMAGE_SIZE_BY_SCALE_AND_ORIENTATION = {
  small: {
    landscape: "1536x1024",
    square: "1280x1280",
    portrait: "1024x1536"
  },
  medium: {
    landscape: "2048x1280",
    square: "1536x1536",
    portrait: "1280x2048"
  },
  large: {
    landscape: "2304x1536",
    square: "1792x1792",
    portrait: "1536x2304"
  },
  xlarge: {
    landscape: "2560x1536",
    square: "1984x1984",
    portrait: "1536x2560"
  }
};

/**
 * Theme labels are reused for UI strings and note summaries.
 */
const THEME_LABELS = {
  "ai-map": "AI Map",
  tavern: "Tavern",
  cave: "Cave",
  "forest-ruins": "Forest Ruins",
  dungeon: "Dungeon"
};

const LIGHTING_MOOD_LABELS = {
  bright: "Bright",
  dim: "Dim",
  dark: "Dark",
  night: "Night",
  magical: "Magical"
};

const FEATURE_KEYS = [
  "bossRoom",
  "sideRooms",
  "storageRoom",
  "altar",
  "pillars",
  "hiddenRoom",
  "treasure",
  "water",
  "traps",
  "campfire",
  "bar",
  "cells"
];

const AI_PLANNER_BIOMES = [
  "jungle",
  "forest",
  "desert",
  "snow",
  "swamp",
  "cave",
  "underground",
  "coastal",
  "mountain",
  "volcanic"
];

const AI_PLANNER_THEMES = [
  "ruins",
  "temple",
  "dungeon",
  "tavern",
  "castle",
  "crypt",
  "village",
  "camp",
  "fortress",
  "sewer"
];

const AI_PLANNER_TERRAIN_FEATURES = [
  "river",
  "bridge",
  "waterfall",
  "lava",
  "cliffs",
  "road",
  "pond",
  "lake",
  "trees",
  "pillars",
  "altar",
  "treasure",
  "hidden room",
  "side rooms",
  "boss room",
  "puzzle room",
  "prison cells",
  "market stalls",
  "docks"
];

const AI_PLANNER_LIGHTING_MOODS = ["bright", "dim", "dark", "magical", "torchlit"];

/**
 * Settings keys for optional premium-style asset packs.
 * Base assets are always included and do not need a setting.
 */
const SETTING_PREMIUM_TAVERN_PACK = "enablePremiumTavernPack";
const SETTING_DARK_DUNGEON_PACK = "enableDarkDungeonPack";
const SETTING_RUNE_RUINS_PACK = "enableRuneRuinsPack";
const SETTING_AI_IMAGE_PROVIDER = "aiImageProvider";
const SETTING_OPENAI_API_KEY = "openAiApiKey";
const SETTING_BFL_API_KEY = "bflApiKey";
const SETTING_OPENAI_MONTHLY_LIMIT = "openAiMonthlyGenerationLimit";
const SETTING_CONFIRM_PAID_GENERATION = "confirmBeforePaidGeneration";
const SETTING_OPENAI_USAGE_TRACKING = "openAiUsageTracking";
const SETTING_SUBSCRIPTION_BACKEND_URL = "subscriptionBackendUrl";
const SETTING_AUTH_API_BASE_URL = "gambitsAuthApiBaseUrl";
const SETTING_SUBSCRIPTION_ACCOUNT_STATE = "subscriptionAccountState";
const SETTING_IMAGE_DUMP_LIBRARY = "imageDumpLibrary";
const SETTING_GLOBAL_LIBRARY_ONLY_MODE = "globalLibraryOnlyMode";
const DEFAULT_BACKEND_URL = "https://sceneforge-backend.onrender.com";
const DEFAULT_AUTH_API_BASE_URL = "https://gambitsforge.online";
const NOTIFICATION_THROTTLE_MS = 5000;
const NOTIFICATION_LAST_AT = new Map();

function notifyThrottled(type, message, options = {}) {
  const normalizedOptions = options && typeof options === "object" ? options : {};
  const shouldNotify = normalizedOptions.notify !== false;
  if (!shouldNotify) return;
  const key = String(
    normalizedOptions.key
    ?? normalizedOptions.throttleKey
    ?? `${type}:${String(message ?? "").trim()}`
  );
  const now = Date.now();
  const last = Number(NOTIFICATION_LAST_AT.get(key) ?? 0);
  if (now - last < NOTIFICATION_THROTTLE_MS) return;
  NOTIFICATION_LAST_AT.set(key, now);
  const notify = ui.notifications?.[type];
  if (typeof notify === "function") notify(message);
}

/**
 * Base registry ships with the core module.
 * Future premium packs can be merged in additively via getActiveAssetRegistry().
 */
const baseRegistry = {
  tavern: [
    { id: "table", src: "/assets/tavern/table.png", width: 180, height: 120, layer: "prop", rarity: "common", count: [3, 6], placement: "room" },
    { id: "chair", src: "/assets/tavern/chair.png", width: 70, height: 70, layer: "prop", rarity: "common", count: [6, 12], placement: "room" },
    { id: "bar-counter", src: "/assets/tavern/bar-counter.png", width: 320, height: 110, layer: "prop", rarity: "common", count: [1, 1], placement: "wall-near" },
    { id: "fireplace", src: "/assets/tavern/fireplace.png", width: 170, height: 120, layer: "prop", rarity: "common", count: [1, 1], placement: "wall-near" },
    { id: "rug", src: "/assets/tavern/rug.png", width: 240, height: 160, layer: "floor", rarity: "common", count: [1, 2], placement: "room" },
    { id: "barrel", src: "/assets/tavern/barrel.png", width: 85, height: 85, layer: "prop", rarity: "common", count: [4, 8], placement: "room" },
    { id: "bed-upstairs", src: "/assets/tavern/bed.png", width: 190, height: 120, layer: "prop", rarity: "common", count: [2, 4], placement: "upstairs" }
  ],
  cave: [
    { id: "rock", src: "/assets/cave/rock.png", width: 140, height: 120, layer: "floor", rarity: "common", count: [8, 16], placement: "random" },
    { id: "stalagmite", src: "/assets/cave/stalagmite.png", width: 110, height: 130, layer: "prop", rarity: "common", count: [6, 12], placement: "random" },
    { id: "mushroom", src: "/assets/cave/mushroom.png", width: 80, height: 70, layer: "prop", rarity: "common", count: [4, 9], placement: "random" },
    { id: "bones", src: "/assets/cave/bones.png", width: 100, height: 70, layer: "prop", rarity: "common", count: [3, 7], placement: "random" },
    { id: "water-pool", src: "/assets/cave/water-pool.png", width: 220, height: 170, layer: "floor", rarity: "common", count: [1, 3], placement: "room" },
    { id: "crystal", src: "/assets/cave/crystal.png", width: 120, height: 140, layer: "prop", rarity: "rare", count: [1, 2], placement: "room" }
  ],
  forestRuins: [
    { id: "broken-pillar", src: "/assets/forest-ruins/broken-pillar.png", width: 100, height: 120, layer: "prop", rarity: "common", count: [5, 10], placement: "room" },
    { id: "statue", src: "/assets/forest-ruins/statue.png", width: 130, height: 190, layer: "prop", rarity: "rare", count: [1, 2], placement: "room" },
    { id: "vines", src: "/assets/forest-ruins/vines.png", width: 180, height: 140, layer: "floor", rarity: "common", count: [3, 7], placement: "wall-near" },
    { id: "rubble", src: "/assets/forest-ruins/rubble.png", width: 120, height: 90, layer: "floor", rarity: "common", count: [8, 14], placement: "random" },
    { id: "altar", src: "/assets/forest-ruins/altar.png", width: 260, height: 160, layer: "prop", rarity: "common", count: [1, 1], placement: "center" },
    { id: "tree", src: "/assets/forest-ruins/tree.png", width: 180, height: 240, layer: "prop", rarity: "common", count: [3, 6], placement: "wall-near" },
    { id: "stone-debris", src: "/assets/forest-ruins/stone-debris.png", width: 100, height: 80, layer: "floor", rarity: "common", count: [8, 14], placement: "random" }
  ],
  dungeon: [
    { id: "crate", src: "/assets/dungeon/crate.png", width: 100, height: 100, layer: "prop", rarity: "common", count: [4, 8], placement: "room" },
    { id: "prison-cell", src: "/assets/dungeon/prison-cell.png", width: 220, height: 200, layer: "prop", rarity: "common", count: [1, 3], placement: "wall-near" },
    { id: "chains", src: "/assets/dungeon/chains.png", width: 70, height: 140, layer: "prop", rarity: "common", count: [3, 8], placement: "wall-near" },
    { id: "torture-table", src: "/assets/dungeon/torture-table.png", width: 240, height: 130, layer: "prop", rarity: "rare", count: [1, 1], placement: "room" },
    { id: "bookshelf", src: "/assets/dungeon/bookshelf.png", width: 170, height: 80, layer: "prop", rarity: "common", count: [2, 5], placement: "wall-near" },
    { id: "broken-wall", src: "/assets/dungeon/broken-wall.png", width: 180, height: 120, layer: "floor", rarity: "common", count: [3, 6], placement: "random" },
    { id: "torch-prop", src: "/assets/dungeon/torch.png", width: 50, height: 90, layer: "prop", rarity: "common", count: [4, 8], placement: "wall-near" }
  ]
};

/**
 * Optional add-on: Premium Tavern Pack placeholders.
 * These paths are examples for future subscriber art bundles.
 */
const premiumTavernRegistry = {
  tavern: [
    { id: "premium-round-table", src: "/assets/premium/tavern/round-table.png", width: 210, height: 150, layer: "prop", rarity: "common", count: [2, 4], placement: "room" },
    { id: "premium-lantern-chandelier", src: "/assets/premium/tavern/chandelier.png", width: 130, height: 130, layer: "prop", rarity: "rare", count: [1, 1], placement: "center" },
    { id: "premium-wall-keg-rack", src: "/assets/premium/tavern/keg-rack.png", width: 240, height: 110, layer: "prop", rarity: "common", count: [1, 2], placement: "wall-near" }
  ]
};

/**
 * Optional add-on: Dark Dungeon Pack placeholders.
 */
const darkDungeonRegistry = {
  dungeon: [
    { id: "dark-blood-altar", src: "/assets/premium/dark-dungeon/blood-altar.png", width: 260, height: 170, layer: "prop", rarity: "rare", count: [1, 1], placement: "center" },
    { id: "dark-iron-maiden", src: "/assets/premium/dark-dungeon/iron-maiden.png", width: 120, height: 210, layer: "prop", rarity: "rare", count: [1, 2], placement: "wall-near" },
    { id: "dark-torture-rack", src: "/assets/premium/dark-dungeon/torture-rack.png", width: 240, height: 140, layer: "prop", rarity: "common", count: [1, 2], placement: "room" }
  ]
};

/**
 * Optional add-on: Rune Ruins Pack placeholders.
 */
const runeRuinsRegistry = {
  forestRuins: [
    { id: "rune-obelisk", src: "/assets/premium/rune-ruins/rune-obelisk.png", width: 160, height: 240, layer: "prop", rarity: "rare", count: [1, 2], placement: "room" },
    { id: "rune-circle", src: "/assets/premium/rune-ruins/rune-circle.png", width: 280, height: 280, layer: "floor", rarity: "common", count: [1, 1], placement: "center" },
    { id: "rune-shard-cluster", src: "/assets/premium/rune-ruins/rune-shards.png", width: 150, height: 110, layer: "floor", rarity: "common", count: [3, 6], placement: "random" }
  ]
};

Hooks.once("init", () => {
  debugLog("Initializing module");
  registerAssetPackSettings();
  getAuthApi()?.SessionStore?.registerSettings?.();
});

/**
 * Cleanup for legacy SceneForge journal artifacts from older versions.
 * These are no longer used in AI-image-only mode and can trigger startup
 * validation issues in newer Foundry versions if old page payloads linger.
 */
async function cleanupLegacyGeneratedJournals() {
  if (!game.user?.isGM) return;
  const journals = Array.from(game.journal?.contents ?? []);
  const generatedIds = journals
    .filter((doc) => doc?.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true)
    .map((doc) => doc.id)
    .filter((id) => typeof id === "string" && id.length > 0);

  if (generatedIds.length === 0) return;

  try {
    await JournalEntry.deleteDocuments(generatedIds);
    debugLog(`Removed ${generatedIds.length} legacy SceneForge journal entries.`);
    ui.notifications.info(`SceneForge AI: Removed ${generatedIds.length} legacy SceneForge journal entries.`);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to cleanup legacy journals`, error);
  }
}

Hooks.once("ready", () => {
  void cleanupLegacyGeneratedJournals();
  void enforceProductionSettingsDefaults();
  void getAuthApi()?.SessionStore?.clearCorruptedSession?.();
  void getAuthApi()?.EntitlementService?.restoreSessionOnStartup?.({ notify: false });
  void syncSubscriptionStatus({ notify: false });
  registerAuthDiagnosticsCommand();
});

function getAuthApi() {
  return globalThis.SceneForgeAuth ?? {};
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const randomPart = Math.random().toString(16).slice(2);
  return `sf-${Date.now()}-${randomPart}`;
}

function redactIdempotencyKey(idempotencyKey) {
  const transactionApi = getGenerationTransactionApi();
  if (transactionApi?.redactSupportKey) return transactionApi.redactSupportKey(idempotencyKey);
  const value = String(idempotencyKey ?? "").trim();
  if (!value) return "(missing)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function mapAuthErrorCodeToMessage(errorCode, fallbackMessage) {
  const code = String(errorCode ?? "").toUpperCase();
  if (code === "AUTH_REQUIRED") return "Authentication required. Please sign in again.";
  if (code === "SESSION_EXPIRED") return "Session expired. Please sign in again.";
  if (code === "EMAIL_NOT_VERIFIED") return "Email not verified. Please verify your account.";
  if (code === "SUBSCRIPTION_INACTIVE") return "Subscription inactive. Please update your plan.";
  if (code === "ENTITLEMENT_DENIED") return "Entitlement denied for SceneForge AI.";
  if (code === "USAGE_EXHAUSTED") return "No generations remaining for this billing period.";
  if (code === "RATE_LIMITED") return "Too many requests. Please retry shortly.";
  if (code === "BACKEND_UNAVAILABLE") return "Backend unavailable. Please retry shortly.";
  return fallbackMessage || "Request failed.";
}

function getGenerationTransactionApi() {
  return getAuthApi()?.GenerationTransaction ?? null;
}

async function callEntitlementMutationWithAuthRetry(operation, idempotencyKey, generationId = "") {
  const auth = getAuthApi();
  const client = auth?.AuthClient;
  const store = auth?.SessionStore;
  const token = getSubscriptionAuthToken();
  if (!token || !client || !store) {
    return { ok: false, status: 401, errorCode: "AUTH_REQUIRED", message: "Missing authentication session." };
  }
  const mutationGenerationId = normalizeMutationGenerationId(generationId);
  let result = await client?.[operation]?.(token, idempotencyKey, mutationGenerationId);
  if (!result?.ok && Number(result?.status ?? 0) === 401 && auth?._refreshWithLock) {
    const refreshed = await auth._refreshWithLock(auth, store, client);
    if (refreshed?.ok) {
      const retryToken = getSubscriptionAuthToken();
      if (retryToken) {
        result = await client?.[operation]?.(retryToken, idempotencyKey, mutationGenerationId);
      }
    }
  }
  return result ?? { ok: false, status: 0, errorCode: "BACKEND_UNAVAILABLE", message: "Mutation endpoint unavailable." };
}

function normalizeMutationGenerationId(generationId) {
  return getGenerationTransactionApi()?.normalizeGenerationId?.(generationId)
    ?? String(generationId ?? "").trim();
}

function extractReservationIdentifier(payload) {
  return getGenerationTransactionApi()?.extractReservationIdentifier?.(payload)
    ?? "";
}

async function completeGenerationReservation(idempotencyKey, generationId) {
  const mutationGenerationId = normalizeMutationGenerationId(generationId);
  if (!mutationGenerationId) {
    return {
      ok: false,
      status: 400,
      errorCode: "MISSING_GENERATION_ID",
      message: "Missing generationId for completion."
    };
  }
  return callEntitlementMutationWithAuthRetry("complete", idempotencyKey, mutationGenerationId);
}

async function refundGenerationReservation(idempotencyKey, generationId) {
  const mutationGenerationId = normalizeMutationGenerationId(generationId);
  if (!mutationGenerationId) {
    return {
      ok: false,
      status: 400,
      errorCode: "MISSING_GENERATION_ID",
      message: "Missing generationId for refund."
    };
  }
  return callEntitlementMutationWithAuthRetry("refund", idempotencyKey, mutationGenerationId);
}

async function attemptRefundWithContract({
  idempotencyKey,
  generationId = "",
  reservationIdentifier = "",
  reservationPayload = null,
  context = "generation_failure"
} = {}) {
  const decision = getGenerationTransactionApi()?.buildRefundContractDecision?.({
    idempotencyKey,
    generationId,
    reservationIdentifier,
    reservationPayload
  }) ?? {
    shouldRefund: Boolean(normalizeMutationGenerationId(generationId || reservationIdentifier)),
    refundGenerationId: normalizeMutationGenerationId(generationId || reservationIdentifier),
    supportKey: redactIdempotencyKey(idempotencyKey),
    userMessage: ""
  };

  if (!decision.shouldRefund) {
    const supportMessage = decision.userMessage
      || `SceneForge AI: Unable to refund generation automatically. Contact support with request key ${decision.supportKey}.`;
    ui.notifications.error(supportMessage);
    logImagePipelineError("refund skipped missing generation identifier", {
      context,
      supportKey: decision.supportKey
    });
    return { ok: false, skipped: true, errorCode: "MISSING_GENERATION_ID", supportKey: decision.supportKey };
  }

  const refundResult = await refundGenerationReservation(idempotencyKey, decision.refundGenerationId);
  if (!refundResult.ok) {
    ui.notifications.error(`SceneForge AI: Refund failed. Contact support with request key ${decision.supportKey}.`);
  }
  return refundResult;
}

function scheduleCompletionRetry(idempotencyKey, generationId, attempt = 1) {
  const retryApi = getGenerationTransactionApi();
  const retryContext = retryApi?.createCompletionRetryContext
    ? retryApi.createCompletionRetryContext(idempotencyKey, generationId, attempt)
    : {
      idempotencyKey: normalizeMutationGenerationId(idempotencyKey),
      generationId: normalizeMutationGenerationId(generationId),
      attempt: Number(attempt ?? 1)
    };
  const mutationGenerationId = retryContext.generationId;
  const mutationIdempotencyKey = retryContext.idempotencyKey;
  if (!mutationGenerationId || !mutationIdempotencyKey) return;
  const maxAttempts = 3;
  if (retryContext.attempt > maxAttempts) return;
  const waitMs = retryContext.attempt === 1 ? 2500 : 8000;
  window.setTimeout(async () => {
    const retry = await completeGenerationReservation(mutationIdempotencyKey, mutationGenerationId);
    if (retry.ok) {
      debugLog("Completion retry succeeded", {
        idempotencyKey: redactIdempotencyKey(mutationIdempotencyKey),
        generationId: redactIdempotencyKey(mutationGenerationId),
        attempt: retryContext.attempt
      });
      return;
    }
    logImagePipelineError("generation completion retry failed", {
      idempotencyKey: redactIdempotencyKey(mutationIdempotencyKey),
      generationId: redactIdempotencyKey(mutationGenerationId),
      attempt: retryContext.attempt,
      status: retry.status ?? 0,
      errorCode: retry.errorCode ?? ""
    });
    const next = retryApi?.nextCompletionRetryContext
      ? retryApi.nextCompletionRetryContext(retryContext)
      : { ...retryContext, attempt: retryContext.attempt + 1 };
    scheduleCompletionRetry(next.idempotencyKey, next.generationId, next.attempt);
  }, waitMs);
}

function registerAuthDiagnosticsCommand() {
  if (!DEBUG) return;
  globalThis.sceneforgeAuthDiagnostics = () => {
    const diagnostics = getAuthApi()?.EntitlementService?.getDiagnostics?.() ?? {};
    console.info(`${MODULE_ID} | Auth diagnostics`, diagnostics);
    return diagnostics;
  };
}

async function enforceProductionSettingsDefaults() {
  // Only a GM can persist world-scoped defaults.
  if (!game.user?.isGM) return;
  try {
    // Force BFL cloud mode via backend regardless of legacy local-provider values.
    await game.settings.set(MODULE_ID, SETTING_AI_IMAGE_PROVIDER, "black-forest-labs");

    const backendUrl = String(game.settings.get(MODULE_ID, SETTING_SUBSCRIPTION_BACKEND_URL) ?? "").trim();
    if (!backendUrl) {
      await game.settings.set(MODULE_ID, SETTING_SUBSCRIPTION_BACKEND_URL, DEFAULT_BACKEND_URL);
    }
    const authApiUrl = String(game.settings.get(MODULE_ID, SETTING_AUTH_API_BASE_URL) ?? "").trim();
    if (!authApiUrl) {
      await game.settings.set(MODULE_ID, SETTING_AUTH_API_BASE_URL, DEFAULT_AUTH_API_BASE_URL);
    }

    // Prevent stale direct-provider credentials from creating ambiguity.
    if (String(game.settings.get(MODULE_ID, SETTING_OPENAI_API_KEY) ?? "").trim()) {
      await game.settings.set(MODULE_ID, SETTING_OPENAI_API_KEY, "");
    }
    if (String(game.settings.get(MODULE_ID, SETTING_BFL_API_KEY) ?? "").trim()) {
      await game.settings.set(MODULE_ID, SETTING_BFL_API_KEY, "");
    }
  } catch (error) {
    debugLog("Could not enforce production settings defaults", error?.message ?? error);
  }
}

/**
 * Registers user-facing module settings for optional asset packs.
 * Location in Foundry: Game Settings -> Configure Settings -> Module Settings.
 */
function registerAssetPackSettings() {
  game.settings.register(MODULE_ID, SETTING_PREMIUM_TAVERN_PACK, {
    name: "Premium Tavern Pack",
    hint: "Enable additive tavern assets from /assets/premium/tavern/...",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTING_DARK_DUNGEON_PACK, {
    name: "Dark Dungeon Pack",
    hint: "Enable additive dungeon assets from /assets/premium/dark-dungeon/...",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTING_RUNE_RUINS_PACK, {
    name: "Rune Ruins Pack",
    hint: "Enable additive forest ruins assets from /assets/premium/rune-ruins/...",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTING_AI_IMAGE_PROVIDER, {
    name: "AI Image Provider",
    hint: "SceneForge Cloud provider (BFL via backend).",
    scope: "world",
    config: false,
    type: String,
    choices: {
      "black-forest-labs": "Black Forest Labs (via Subscription Backend)"
    },
    default: "black-forest-labs"
  });

  game.settings.register(MODULE_ID, SETTING_GLOBAL_LIBRARY_ONLY_MODE, {
    name: "Global Library Only Mode",
    hint: "SceneForge AI uses global library mode for production.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_SUBSCRIPTION_BACKEND_URL, {
    name: "Subscription Backend URL",
    hint: "Generation API base URL for /api/maps/generate.",
    scope: "world",
    config: false,
    type: String,
    default: DEFAULT_BACKEND_URL,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_AUTH_API_BASE_URL, {
    name: "Gambits Auth API Base URL",
    hint: "Auth + entitlement API base URL for Gambits Forge account and quota routes.",
    scope: "world",
    config: false,
    type: String,
    default: DEFAULT_AUTH_API_BASE_URL,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_SUBSCRIPTION_ACCOUNT_STATE, {
    name: "Subscription Account State",
    scope: "client",
    config: false,
    type: Object,
    default: {
      linked: false,
      active: false,
      tier: "none",
      isOwner: false,
      unlimitedGenerations: false,
      accountName: "",
      accountEmail: "",
      accountId: "",
      monthKey: "",
      usageCount: 0,
      usageLimit: 0,
      resetAt: null,
      lastSyncAt: null
    },
    restricted: false
  });

  game.settings.register(MODULE_ID, SETTING_OPENAI_API_KEY, {
    name: "OpenAI API Key",
    hint: "Used when AI Image Provider is OpenAI.",
    scope: "world",
    config: false,
    type: String,
    default: "",
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_BFL_API_KEY, {
    name: "BFL API Key",
    hint: "Used when AI Image Provider is Black Forest Labs (FLUX).",
    scope: "world",
    config: false,
    type: String,
    default: "",
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_OPENAI_MONTHLY_LIMIT, {
    name: "OpenAI Monthly Generation Limit",
    hint: "Legacy hidden setting.",
    scope: "world",
    config: false,
    type: Number,
    default: 20,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_CONFIRM_PAID_GENERATION, {
    name: "Confirm Before Paid Generation",
    hint: "Legacy hidden setting.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    restricted: true
  });

  // Hidden bookkeeping setting for monthly usage tracking.
  game.settings.register(MODULE_ID, SETTING_OPENAI_USAGE_TRACKING, {
    name: "OpenAI Usage Tracking",
    scope: "world",
    config: false,
    type: Object,
    default: {
      monthKey: "",
      count: 0
    },
    restricted: true
  });

  // Hidden image dump metadata used for prompt-matched reuse and voting.
  game.settings.register(MODULE_ID, SETTING_IMAGE_DUMP_LIBRARY, {
    name: "Image Dump Library",
    scope: "world",
    config: false,
    type: Object,
    default: {
      version: 1,
      entries: []
    },
    restricted: true
  });
}

/**
 * Merge base registry + enabled pack registries into one active registry.
 *
 * Beginner note:
 * To add a new future subscriber pack:
 *  1) create a new <packName>Registry object with theme arrays
 *  2) register a module setting toggle
 *  3) include the registry in this function when toggle is enabled
 */
function getActiveAssetRegistry(forcedEnabledPackIds = null) {
  const merged = cloneRegistryWithPackMeta(baseRegistry, "base");

  if (isAssetPackEnabled("premium-tavern", forcedEnabledPackIds)) {
    mergeRegistryInto(merged, cloneRegistryWithPackMeta(premiumTavernRegistry, "premium-tavern"));
  }
  if (isAssetPackEnabled("dark-dungeon", forcedEnabledPackIds)) {
    mergeRegistryInto(merged, cloneRegistryWithPackMeta(darkDungeonRegistry, "dark-dungeon"));
  }
  if (isAssetPackEnabled("rune-ruins", forcedEnabledPackIds)) {
    mergeRegistryInto(merged, cloneRegistryWithPackMeta(runeRuinsRegistry, "rune-ruins"));
  }

  return merged;
}

/**
 * Supports either explicit pack IDs (preset import) or world settings toggles.
 */
function isAssetPackEnabled(packId, forcedEnabledPackIds) {
  if (Array.isArray(forcedEnabledPackIds)) {
    return forcedEnabledPackIds.includes(packId);
  }

  if (packId === "premium-tavern") return game.settings.get(MODULE_ID, SETTING_PREMIUM_TAVERN_PACK);
  if (packId === "dark-dungeon") return game.settings.get(MODULE_ID, SETTING_DARK_DUNGEON_PACK);
  if (packId === "rune-ruins") return game.settings.get(MODULE_ID, SETTING_RUNE_RUINS_PACK);
  return false;
}

/**
 * Returns active non-base pack IDs, useful for debugging and scene flags.
 */
function getEnabledAssetPackIds() {
  const packIds = [];
  if (game.settings.get(MODULE_ID, SETTING_PREMIUM_TAVERN_PACK)) packIds.push("premium-tavern");
  if (game.settings.get(MODULE_ID, SETTING_DARK_DUNGEON_PACK)) packIds.push("dark-dungeon");
  if (game.settings.get(MODULE_ID, SETTING_RUNE_RUINS_PACK)) packIds.push("rune-ruins");
  return packIds;
}

function getAiImageProvider() {
  const provider = String(game.settings.get(MODULE_ID, SETTING_AI_IMAGE_PROVIDER) ?? "subscription").trim().toLowerCase();
  // Customer mode always routes image generation through subscription backend.
  if (provider === "black-forest-labs" || provider === "subscription") return "subscription";
  return "subscription";
}

function getOpenAiApiKey() {
  return String(game.settings.get(MODULE_ID, SETTING_OPENAI_API_KEY) ?? "").trim();
}

function getBflApiKey() {
  return String(game.settings.get(MODULE_ID, SETTING_BFL_API_KEY) ?? "").trim();
}

function getSubscriptionBackendUrl() {
  return String(game.settings.get(MODULE_ID, SETTING_SUBSCRIPTION_BACKEND_URL) ?? "").trim().replace(/\/+$/, "");
}

function getSubscriptionAuthToken() {
  const accessToken = String(getAuthApi()?.SessionStore?.getAccessToken?.() ?? "").trim();
  if (accessToken) return accessToken;
  return "";
}

function getSubscriptionAccountState() {
  const fallback = {
    linked: false,
    active: false,
    tier: "none",
    isOwner: false,
    unlimitedGenerations: false,
    accountName: "",
    accountEmail: "",
    accountId: "",
    monthKey: "",
    usageCount: 0,
    usageLimit: 0,
    resetAt: null,
    lastSyncAt: null
  };
  const value = game.settings.get(MODULE_ID, SETTING_SUBSCRIPTION_ACCOUNT_STATE);
  if (!value || typeof value !== "object") return fallback;
  return { ...fallback, ...value };
}

async function setSubscriptionAccountState(patch = {}) {
  const nextState = {
    ...getSubscriptionAccountState(),
    ...(patch && typeof patch === "object" ? patch : {}),
    lastSyncAt: new Date().toISOString()
  };
  await game.settings.set(MODULE_ID, SETTING_SUBSCRIPTION_ACCOUNT_STATE, nextState);
  return nextState;
}

function getOpenAiMonthlyLimit() {
  return Math.max(0, Number(game.settings.get(MODULE_ID, SETTING_OPENAI_MONTHLY_LIMIT) ?? 0));
}

function getMapCoverageMeters(mapScaleKey) {
  return Number(MAP_COVERAGE_METERS[mapScaleKey] ?? MAP_COVERAGE_METERS.medium);
}

function getSceneGridPixelSize(sceneSizeKey) {
  return Number(SCENE_GRID_PIXEL_SIZES[sceneSizeKey] ?? SCENE_GRID_PIXEL_SIZES.medium);
}

function getImageOrientationSpec(imageOrientationKey) {
  return IMAGE_ORIENTATION_SPECS[imageOrientationKey] ?? IMAGE_ORIENTATION_SPECS.landscape;
}

function getRequestedImageSize(sceneSizeKey, imageOrientationKey) {
  const scaleKey = SCENE_SIZES[sceneSizeKey] ? sceneSizeKey : "medium";
  const orientationKey = IMAGE_ORIENTATION_SPECS[imageOrientationKey] ? imageOrientationKey : "landscape";
  return (
    IMAGE_SIZE_BY_SCALE_AND_ORIENTATION?.[scaleKey]?.[orientationKey]
    ?? IMAGE_ORIENTATION_SPECS[orientationKey]?.size
    ?? "1536x1024"
  );
}

async function openGambitsForgeLoginWindow() {
  return Boolean(await getAuthApi()?.LoginWindow?.open?.());
}

async function syncSubscriptionStatus(options = {}) {
  const normalizedOptions = options && typeof options === "object" ? options : {};
  const opts = { notify: true, ...normalizedOptions };
  const entitlementService = getAuthApi()?.EntitlementService;
  if (!entitlementService?.syncEntitlement) {
    return { ok: false, reason: "auth-unavailable" };
  }
  const result = await entitlementService.syncEntitlement({ notify: opts.notify });
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? "entitlement-failed", payload: result.payload ?? null };
  }
  const entitlement = result.entitlement ?? {};
  const normalized = {
    linked: true,
    active: entitlement.active !== false,
    tier: String(entitlement.tier ?? entitlement.plan ?? "none"),
    isOwner: false,
    unlimitedGenerations: false,
    accountName: String(entitlement?.user?.name ?? entitlement?.user?.displayName ?? ""),
    accountEmail: String(entitlement?.user?.email ?? ""),
    accountId: String(entitlement?.user?.id ?? ""),
    monthKey: getCurrentUsageMonthKey(),
    usageCount: Number(entitlement.usageCount ?? 0),
    usageLimit: Number(entitlement.usageLimit ?? 0),
    resetAt: entitlement.renewalDate || null
  };
  const state = await setSubscriptionAccountState(normalized);
  if (opts.notify) {
    const remaining = Math.max(0, state.usageLimit - state.usageCount);
    const remainingLabel = state.unlimitedGenerations ? "Unlimited" : String(remaining);
    ui.notifications.info(`SceneForge AI: Account synced. Plan: ${state.tier}. Remaining this month: ${remainingLabel}.`);
  }
  return { ok: true, state, payload: result.payload ?? null };
}

function formatLinkedAccountLabel(state) {
  const name = String(state?.accountName ?? "").trim();
  const email = String(state?.accountEmail ?? "").trim();
  const accountId = String(state?.accountId ?? "").trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  if (accountId) return `Account user ${accountId}`;
  return "Unknown account";
}

function maskSensitiveValue(value, edgeChars = 2) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (normalized.length <= edgeChars * 2) return "*".repeat(normalized.length);
  return `${normalized.slice(0, edgeChars)}***${normalized.slice(-edgeChars)}`;
}

function formatDisplayDate(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return normalized;
  return new Date(timestamp).toLocaleString();
}

function isGlobalLibraryOnlyModeEnabled() {
  if (getAiImageProvider() !== "subscription") return false;
  const configured = game.settings.get(MODULE_ID, SETTING_GLOBAL_LIBRARY_ONLY_MODE);
  if (typeof configured === "boolean") return configured;
  return true;
}

function isPaidGenerationConfirmationEnabled() {
  return game.settings.get(MODULE_ID, SETTING_CONFIRM_PAID_GENERATION) === true;
}

function getCurrentUsageMonthKey() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
}

function normalizePromptForReuse(prompt) {
  return String(prompt ?? "").trim();
}

function canUseGlobalImageDumpLibrary() {
  if (!isGlobalLibraryOnlyModeEnabled()) return false;
  if (getAiImageProvider() !== "subscription") return false;
  return Boolean(getSubscriptionBackendUrl() && getSubscriptionAuthToken());
}

async function callGlobalImageDumpApi(path, { method = "POST", body = null } = {}) {
  const backendBaseUrl = getSubscriptionBackendUrl();
  debugLog("SceneForge backendBaseUrl:", backendBaseUrl);
  if (!backendBaseUrl || !getSubscriptionAuthToken()) return { ok: false, status: 0, payload: null };
  const authFetch = getAuthApi()?.authenticatedFetch ?? fetch;

  const endpoint = `${backendBaseUrl}${path}`;
  try {
    const response = await authFetch(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : null
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    logImagePipelineError("global image dump api exception", { endpoint, method }, error);
    return { ok: false, status: 0, payload: null };
  }
}

function buildSceneNameFromPrompt(prompt, options = {}) {
  const { prefix = "SceneForge", fallback = "Map" } = options;
  const words = String(prompt ?? "")
    .trim()
    .replace(/[^a-z0-9\s-]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 5);
  const label = words.length > 0 ? words.join(" ") : fallback;
  const title = label.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${prefix} - ${title}`;
}

function getImageDumpLibrary() {
  const raw = game.settings.get(MODULE_ID, SETTING_IMAGE_DUMP_LIBRARY);
  if (!raw || typeof raw !== "object") {
    return { version: 1, entries: [] };
  }
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return { version: 1, entries };
}

async function setImageDumpLibrary(library) {
  await game.settings.set(MODULE_ID, SETTING_IMAGE_DUMP_LIBRARY, {
    version: 1,
    entries: Array.isArray(library?.entries) ? library.entries : []
  });
}

function getPlanCategoryKey(plan) {
  const biome = String(plan?.biome ?? "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const theme = String(plan?.theme ?? "general").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${biome}/${theme}`;
}

function scoreImageDumpEntry(entry) {
  return Number(entry?.likes ?? 0) - Number(entry?.dislikes ?? 0);
}

async function findReusableImageEntryForPrompt(prompt) {
  const promptExact = normalizePromptForReuse(prompt);
  if (!promptExact) return null;

  if (!canUseGlobalImageDumpLibrary()) {
    throw new Error("Global image library is required. Configure Subscription provider, backend URL, and auth token.");
  }

  const response = await callGlobalImageDumpApi("/api/maps/reuse/exact", {
    method: "POST",
    body: {
      promptExact,
      requirePositiveVote: true
    }
  });
  if (Number(response.status) === 404) {
    // 404 means no reusable image exists for this exact prompt.
    return null;
  }
  if (!response.ok) {
    throw new Error(`Global reuse lookup failed (${response.status || "network"}).`);
  }
  const match = response.payload?.entry ?? response.payload?.match ?? null;
  if (!match?.imagePath) return null;
  return {
    id: match.id ?? null,
    promptExact,
    imagePath: String(match.imagePath),
    provider: "subscription",
    source: "global"
  };
}

async function upsertImageDumpEntry(entry) {
  const library = getImageDumpLibrary();
  const entries = [...library.entries];
  const id = entry?.id || foundry.utils.randomID();
  const normalizedEntry = {
    id,
    promptExact: normalizePromptForReuse(entry?.promptExact ?? ""),
    imagePath: String(entry?.imagePath ?? "").trim(),
    categoryKey: String(entry?.categoryKey ?? "unknown/general"),
    provider: String(entry?.provider ?? "unknown"),
    seed: String(entry?.seed ?? ""),
    sceneId: entry?.sceneId ?? null,
    compiledPrompt: String(entry?.compiledPrompt ?? ""),
    likes: Number(entry?.likes ?? 0),
    dislikes: Number(entry?.dislikes ?? 0),
    votes: entry?.votes && typeof entry.votes === "object" ? entry.votes : {},
    createdAt: Number(entry?.createdAt ?? Date.now()),
    updatedAt: Number(entry?.updatedAt ?? Date.now()),
    lastUsedAt: Number(entry?.lastUsedAt ?? Date.now()),
    usageCount: Number(entry?.usageCount ?? 0)
  };

  const existingIndex = entries.findIndex((item) => item?.id === id);
  if (existingIndex >= 0) entries[existingIndex] = normalizedEntry;
  else entries.push(normalizedEntry);

  await setImageDumpLibrary({ version: 1, entries });
  return normalizedEntry;
}

async function recordGeneratedImageDumpEntry({ generationData, imageGenerationMetadata, imagePath, scene }) {
  const promptExact = normalizePromptForReuse(generationData?.prompt ?? "");
  if (!promptExact || !imagePath || !scene) return null;

  if (!canUseGlobalImageDumpLibrary()) {
    logImagePipelineError("global image upsert skipped (global library unavailable)", {
      promptExact,
      sceneId: scene?.id ?? null
    });
    return null;
  }

  const response = await callGlobalImageDumpApi("/api/maps/library/upsert", {
    method: "POST",
    body: {
      promptExact,
      imagePath,
      categoryKey: getPlanCategoryKey(generationData?.aiPlan ?? null),
      provider: imageGenerationMetadata?.provider ?? "unknown",
      seed: generationData?.seed ?? "",
      sceneId: scene.id,
      compiledPrompt: generationData?.compiledImagePrompt ?? ""
    }
  });
  const globalEntryId = response.payload?.entry?.id ?? response.payload?.id ?? null;
  if (!response.ok || !globalEntryId) {
    logImagePipelineError("global image upsert failed", {
      promptExact,
      sceneId: scene?.id ?? null,
      status: response.status || "network"
    });
    return null;
  }
  await scene.setFlag(MODULE_ID, FLAG_IMAGE_DUMP_ENTRY_ID, globalEntryId);
  return { id: globalEntryId, promptExact, imagePath };
}

async function markImageDumpEntryUsed(entryId, scene) {
  if (!entryId) return;
  if (!canUseGlobalImageDumpLibrary()) {
    logImagePipelineError("global usage mark skipped (global library unavailable)", { entryId });
    return;
  }
  const response = await callGlobalImageDumpApi("/api/maps/library/mark-used", {
    method: "POST",
    body: {
      entryId,
      sceneId: scene?.id ?? null
    }
  });
  if (!response.ok) {
    logImagePipelineError("global usage update failed", {
      entryId,
      status: response.status || "network"
    });
    return;
  }
  if (scene) {
    await scene.setFlag(MODULE_ID, FLAG_IMAGE_DUMP_ENTRY_ID, entryId);
  }
}

async function voteOnSceneMap(scene, voteValue) {
  const entryId = scene?.getFlag(MODULE_ID, FLAG_IMAGE_DUMP_ENTRY_ID);
  if (!entryId) {
    ui.notifications.warn("SceneForge AI: No image dump entry found for this scene.");
    return;
  }
  const userId = game.user?.id;
  if (!userId) return;

  if (!canUseGlobalImageDumpLibrary()) {
    ui.notifications.error("SceneForge AI: Global vote service is required.");
    return;
  }

  const response = await callGlobalImageDumpApi("/api/maps/library/vote", {
    method: "POST",
    body: {
      entryId,
      vote: Number(voteValue)
    }
  });
  if (response.ok) {
    ui.notifications.info(`SceneForge AI: Vote saved globally (${Number(voteValue) === 1 ? "Liked" : "Disliked"}).`);
    return;
  }

  ui.notifications.error(`SceneForge AI: Global vote failed (${response.status || "network"}).`);
}

async function promptForGeneratedSceneVote(scene) {
  if (!scene) return;
  const entryId = scene.getFlag(MODULE_ID, FLAG_IMAGE_DUMP_ENTRY_ID);
  if (!entryId) return;
  if (!canUseGlobalImageDumpLibrary()) return;
  await new Promise((resolve) => {
    const dialog = new Dialog({
      title: "SceneForge AI: Keep this map for reuse?",
      content: "<p>Do you like this generated map?</p>",
      buttons: {
        yes: {
          icon: '<i class="fas fa-thumbs-up"></i>',
          label: "Yes, keep for reuse",
          callback: async () => {
            await voteOnSceneMap(scene, 1);
            resolve();
          }
        },
        no: {
          icon: '<i class="fas fa-thumbs-down"></i>',
          label: "No, do not reuse",
          callback: async () => {
            await voteOnSceneMap(scene, -1);
            resolve();
          }
        }
      },
      default: "yes",
      close: () => resolve()
    });
    dialog.render(true);
  });
}

function getCategoryReferenceSummary(plan) {
  if (canUseGlobalImageDumpLibrary()) {
    return "Global reference library enabled.";
  }
  const categoryKey = getPlanCategoryKey(plan);
  const library = getImageDumpLibrary();
  const categoryEntries = library.entries.filter((entry) =>
    entry?.categoryKey === categoryKey
    && Number(entry?.likes ?? 0) >= Number(entry?.dislikes ?? 0)
  );
  if (categoryEntries.length === 0) {
    return "No prior rated category references yet.";
  }
  const highlyRated = categoryEntries.filter((entry) => Number(entry.likes ?? 0) > Number(entry.dislikes ?? 0));
  return `Rated references available for ${categoryKey}: ${categoryEntries.length} (highly rated: ${highlyRated.length}).`;
}

/**
 * Sanitize document payloads using Foundry's document class cleaner when available.
 * This helps strip unknown fields before creation in newer core versions.
 */
function sanitizeDocumentPayload(documentName, payload) {
  const cls = getDocumentClass(documentName);
  if (!cls || typeof cls.cleanData !== "function") {
    return payload;
  }

  const sanitizeOne = (entry) => {
    const clone = foundry.utils.deepClone(entry);
    cls.cleanData(clone, { partial: false });
    return clone;
  };

  return Array.isArray(payload) ? payload.map(sanitizeOne) : sanitizeOne(payload);
}

/**
 * Safe wrappers around document creation to avoid runtime crashes and expose
 * exact failing payloads in DEBUG mode.
 */
async function safeSceneCreate(payload, contextLabel = "Scene.create") {
  try {
    debugPayload(contextLabel, payload);
    const sanitized = sanitizeDocumentPayload("Scene", payload);
    return await Scene.create(sanitized);
  } catch (error) {
    console.error(`${MODULE_ID} | ${contextLabel} failed`, error);
    debugPayload(contextLabel, payload);
    ui.notifications.error("SceneForge AI: Scene creation failed due to invalid document data.");
    return null;
  }
}

async function safeJournalEntryCreate(payload, contextLabel = "JournalEntry.create") {
  if (!ENABLE_JOURNALS_AND_NOTES) {
    debugLog(`${contextLabel} skipped (journals disabled).`);
    return null;
  }
  try {
    debugPayload(contextLabel, payload);
    const sanitized = sanitizeDocumentPayload("JournalEntry", payload);
    return await JournalEntry.create(sanitized);
  } catch (error) {
    console.error(`${MODULE_ID} | ${contextLabel} failed`, error);
    debugPayload(contextLabel, payload);
    ui.notifications.error("SceneForge AI: Journal creation failed due to invalid document data.");
    return null;
  }
}

async function safeEmbeddedCreate(scene, documentName, payloadArray, contextLabel) {
  if (!ENABLE_JOURNALS_AND_NOTES && documentName === "Note") {
    debugLog(`${contextLabel} skipped (notes disabled).`);
    return [];
  }
  try {
    debugPayload(contextLabel, payloadArray);
    const sanitized = sanitizeDocumentPayload(documentName, payloadArray);
    return await scene.createEmbeddedDocuments(documentName, sanitized);
  } catch (error) {
    console.error(`${MODULE_ID} | ${contextLabel} failed`, error);
    debugPayload(contextLabel, payloadArray);
    ui.notifications.error(`SceneForge AI: ${documentName} creation failed due to invalid document data.`);
    return [];
  }
}

async function getOpenAiUsageState() {
  const raw = game.settings.get(MODULE_ID, SETTING_OPENAI_USAGE_TRACKING) ?? {};
  const currentMonth = getCurrentUsageMonthKey();
  if (raw.monthKey !== currentMonth) {
    const resetState = { monthKey: currentMonth, count: 0 };
    await game.settings.set(MODULE_ID, SETTING_OPENAI_USAGE_TRACKING, resetState);
    return resetState;
  }
  return {
    monthKey: currentMonth,
    count: Number(raw.count) || 0
  };
}

async function incrementOpenAiUsageCount() {
  const usage = await getOpenAiUsageState();
  const next = {
    monthKey: usage.monthKey,
    count: usage.count + 1
  };
  await game.settings.set(MODULE_ID, SETTING_OPENAI_USAGE_TRACKING, next);
  return next;
}

/**
 * Requirement helper:
 * Compare preset.required packs against currently enabled packs.
 */
function getMissingPresetPacks(preset) {
  const requiredPacks = Array.isArray(preset?.enabledAssetPacks)
    ? preset.enabledAssetPacks.filter((v) => typeof v === "string")
    : [];
  const enabledNow = getEnabledAssetPackIds();
  return requiredPacks.filter((packId) => !enabledNow.includes(packId));
}

/**
 * Clone registry and decorate each asset with pack metadata.
 */
function cloneRegistryWithPackMeta(registry, packId) {
  const clone = {};
  for (const [themeKey, assets] of Object.entries(registry)) {
    clone[themeKey] = assets.map((asset) => ({
      ...asset,
      packId,
      theme: normalizeRegistryThemeToSceneTheme(themeKey)
    }));
  }
  return clone;
}

/**
 * In-place additive merge: append pack assets to existing theme arrays.
 */
function mergeRegistryInto(targetRegistry, sourceRegistry) {
  for (const [themeKey, assets] of Object.entries(sourceRegistry)) {
    if (!targetRegistry[themeKey]) targetRegistry[themeKey] = [];
    targetRegistry[themeKey].push(...assets);
  }
}

/**
 * Normalize Foundry render hook HTML argument to a native HTMLElement.
 * v12 often passes jQuery; v13 can pass native elements.
 */
function getHtmlElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

/**
 * Add the "Generate Map" button to the Scene Directory footer.
 */
Hooks.on("renderSceneDirectory", (app, html) => {
  if (!game.user?.isGM) return;

  const rootElement = getHtmlElement(html);
  if (!rootElement) {
    debugLog("renderSceneDirectory received unsupported html payload", html);
    return;
  }

  if (rootElement.querySelector(".sceneforge-generate-btn")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sceneforge-generate-btn";
  button.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate Map';
  button.addEventListener("click", async () => {
    await openGeneratorDialog();
  });

  const footer = rootElement.querySelector(".directory-footer");
  if (footer) footer.appendChild(button);
  else rootElement.appendChild(button);
});

/**
 * Add a right-click context menu item to each scene in Scene Directory.
 */
function registerSceneDirectoryEntryContextOptions(entryOptions) {
  if (!Array.isArray(entryOptions)) return;
  if (entryOptions.some((option) => option?.name === "Edit Image (SceneForge AI)")) return;

  entryOptions.push({
    name: "Edit Image (SceneForge AI)",
    icon: '<i class="fas fa-image"></i>',
    condition: () => game.user?.isGM === true,
    callback: async (li) => {
      const scene = getSceneFromDirectoryLi(li);
      if (!scene) {
        ui.notifications.error("SceneForge AI: Could not resolve selected scene.");
        return;
      }
      await openSceneImageEditDialog(scene);
    }
  });

  entryOptions.push({
    name: "SceneForge: Export Preset",
    icon: '<i class="fas fa-file-export"></i>',
    condition: (li) => {
      if (!game.user?.isGM) return false;
      const scene = getSceneFromDirectoryLi(li);
      return Boolean(scene?.getFlag(MODULE_ID, FLAG_GENERATION_KEY));
    },
    callback: async (li) => {
      const scene = getSceneFromDirectoryLi(li);
      if (!scene) return;
      await exportScenePreset(scene);
    }
  });

  entryOptions.push({
    name: "SceneForge: Import Preset",
    icon: '<i class="fas fa-file-import"></i>',
    condition: () => game.user?.isGM === true,
    callback: async () => {
      await promptImportPresetFile();
    }
  });

  entryOptions.push({
    name: "SceneForge: Rate Map",
    icon: '<i class="fas fa-thumbs-up"></i>',
    condition: (li) => {
      const scene = getSceneFromDirectoryLi(li);
      return Boolean(scene?.getFlag(MODULE_ID, FLAG_GENERATION_KEY));
    },
    callback: async (li) => {
      const scene = getSceneFromDirectoryLi(li);
      if (!scene) return;
      const dialog = new Dialog({
        title: "SceneForge: Rate Generated Map",
        content: "<p>How do you rate this generated map for future reuse?</p>",
        buttons: {
          like: {
            icon: '<i class="fas fa-thumbs-up"></i>',
            label: "Like",
            callback: async () => voteOnSceneMap(scene, 1)
          },
          dislike: {
            icon: '<i class="fas fa-thumbs-down"></i>',
            label: "Dislike",
            callback: async () => voteOnSceneMap(scene, -1)
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel"
          }
        },
        default: "cancel"
      });
      dialog.render(true);
    }
  });
}

Hooks.on("getSceneDirectoryEntryContext", (...args) => {
  const entryOptions = args.find((arg) => Array.isArray(arg));
  registerSceneDirectoryEntryContextOptions(entryOptions);
});

// v13+ compatibility fallback for generic document directory context hook.
Hooks.on("getDocumentDirectoryEntryContext", (...args) => {
  const entryOptions = args.find((arg) => Array.isArray(arg));
  const directoryLike = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
  const documentName =
    directoryLike?.documentName
    ?? directoryLike?.constructor?.documentName
    ?? directoryLike?.collection?.documentName
    ?? null;
  if (documentName && documentName !== "Scene") return;
  registerSceneDirectoryEntryContextOptions(entryOptions);
});

// v13+ ApplicationV2 document context hook for scenes.
Hooks.on("getSceneContextOptions", (...args) => {
  const entryOptions = args.find((arg) => Array.isArray(arg));
  registerSceneDirectoryEntryContextOptions(entryOptions);
});

// Generic document hook in case specific scene hook is unavailable.
Hooks.on("getDocumentContextOptions", (...args) => {
  const applicationLike = args.find((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
  const entryOptions = args.find((arg) => Array.isArray(arg));
  const documentName =
    applicationLike?.documentName
    ?? applicationLike?.collection?.documentName
    ?? applicationLike?.constructor?.documentName
    ?? null;
  if (documentName && documentName !== "Scene") return;
  registerSceneDirectoryEntryContextOptions(entryOptions);
});

Hooks.on("renderSettingsConfig", (_app, html) => {
  const rootElement = getHtmlElement(html);
  if (!rootElement) return;
  if (rootElement.querySelector(".sceneforge-auth-actions")) return;

  const anchorInput = rootElement.querySelector(`input[name="${MODULE_ID}.${SETTING_RUNE_RUINS_PACK}"]`);
  const anchorGroup = anchorInput?.closest(".form-group");
  if (!anchorGroup) return;

  const state = getSubscriptionAccountState();
  const authState = getAuthApi()?.EntitlementService?.getState?.() ?? "Not Signed In";
  const authStateMessage = getAuthApi()?.EntitlementService?.stateMessage?.(authState) ?? authState;
  const accountName = String(state.accountName || "Not Signed In");
  const planLine = `Plan: ${String(state.tier || "None")}`;
  const remaining = Math.max(0, Number(state.usageLimit || 0) - Number(state.usageCount || 0));
  const generationLine = Number(state.usageLimit || 0) > 0
    ? `Generations Remaining: ${remaining} / ${Number(state.usageLimit || 0)}`
    : "Generations Remaining: Unknown";
  const renewalLine = `Renewal Date: ${formatDisplayDate(state.resetAt) || "Not provided"}`;
  const stateLine = `State: ${authState}`;
  const stateMessageLine = `Message: ${authStateMessage}`;

  const actions = document.createElement("div");
  actions.className = "form-group sceneforge-auth-actions";
  actions.innerHTML = `
    <label>Gambits Forge Authentication</label>
    <div class="form-fields">
      <button type="button" class="sceneforge-login"><i class="fas fa-right-to-bracket"></i> Sign In</button>
      <button type="button" class="sceneforge-sync-auth"><i class="fas fa-rotate"></i> Sync Subscription</button>
      <button type="button" class="sceneforge-logout"><i class="fas fa-right-from-bracket"></i> Logout</button>
      <button type="button" class="sceneforge-forgot-password"><i class="fas fa-key"></i> Forgot Password</button>
      <button type="button" class="sceneforge-create-account"><i class="fas fa-user-plus"></i> Create Account</button>
    </div>
    <div class="notes sceneforge-auth-status" style="margin-top:6px; line-height:1.4;">
      <div><strong>Logged in as: ${foundry.utils.escapeHTML(accountName)}</strong></div>
      <div>${foundry.utils.escapeHTML(planLine)}</div>
      <div>${foundry.utils.escapeHTML(generationLine)}</div>
      <div>${foundry.utils.escapeHTML(renewalLine)}</div>
      <div>${foundry.utils.escapeHTML(stateLine)}</div>
      <div>${foundry.utils.escapeHTML(stateMessageLine)}</div>
    </div>
  `;
  anchorGroup.after(actions);

  const loginButton = actions.querySelector(".sceneforge-login");
  const syncButton = actions.querySelector(".sceneforge-sync-auth");
  const logoutButton = actions.querySelector(".sceneforge-logout");
  const forgotButton = actions.querySelector(".sceneforge-forgot-password");
  const createButton = actions.querySelector(".sceneforge-create-account");

  loginButton?.addEventListener("click", async () => {
    const loggedIn = await openGambitsForgeLoginWindow();
    if (loggedIn) await syncSubscriptionStatus({ notify: true });
  });
  syncButton?.addEventListener("click", async () => {
    await syncSubscriptionStatus({ notify: true });
  });
  logoutButton?.addEventListener("click", async () => {
    await getAuthApi()?.LoginWindow?.logout?.();
  });
  forgotButton?.addEventListener("click", () => {
    window.open("https://gambitsforge.online", "_blank", "noopener,noreferrer");
  });
  createButton?.addEventListener("click", () => {
    window.open("https://gambitsforge.online", "_blank", "noopener,noreferrer");
  });
});

/**
 * Resolve a Scene document from a Scene Directory <li>.
 * The dataset key can vary by Foundry version, so we check multiple keys.
 */
function getSceneFromDirectoryLi(li) {
  const element =
    (li instanceof HTMLElement ? li : null)
    ?? (li?.[0] instanceof HTMLElement ? li[0] : null)
    ?? null;
  const nearestWithDataset = element?.closest?.("[data-document-id], [data-entry-id], [data-scene-id], [data-uuid], li");

  const readDataValue = (key) => {
    const datasetKey = key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const fromElement = element?.dataset?.[datasetKey];
    if (fromElement) return fromElement;
    const fromNearest = nearestWithDataset?.dataset?.[datasetKey];
    if (fromNearest) return fromNearest;
    if (element?.getAttribute || nearestWithDataset?.getAttribute) {
      const attrValue =
        element?.getAttribute?.(`data-${key}`)
        ?? nearestWithDataset?.getAttribute?.(`data-${key}`)
        ?? null;
      if (attrValue) return attrValue;
    }
    if (typeof li?.data === "function") {
      const value = li.data(datasetKey) ?? li.data(key);
      if (value) return value;
    }
    return null;
  };

  const sceneId =
    readDataValue("document-id")
    ?? readDataValue("documentId")
    ?? readDataValue("entry-id")
    ?? readDataValue("entryId")
    ?? readDataValue("scene-id")
    ?? readDataValue("sceneId")
    ?? readDataValue("id")
    ?? li?.id
    ?? li?.documentId
    ?? li?.dataset?.documentId
    ?? li?.dataset?.entryId
    ?? li?.dataset?.sceneId
    ?? null;

  if (sceneId && game.scenes?.has(sceneId)) {
    return game.scenes.get(sceneId) ?? null;
  }

  const sceneUuid =
    readDataValue("uuid")
    ?? readDataValue("document-uuid")
    ?? readDataValue("documentUuid")
    ?? li?.dataset?.uuid
    ?? li?.dataset?.documentUuid
    ?? li?.uuid
    ?? null;
  if (sceneUuid && typeof fromUuidSync === "function") {
    const doc = fromUuidSync(sceneUuid);
    if (doc?.documentName === "Scene") return doc;
  }

  return null;
}

/**
 * Open the generator dialog from our template.
 */
async function openGeneratorDialog(initialState = null) {
  const renderTemplateCompat = getRenderTemplateFn();
  if (typeof renderTemplateCompat !== "function") {
    ui.notifications.error("SceneForge AI: Template renderer unavailable in this Foundry version.");
    return;
  }
  const content = await renderTemplateCompat(`modules/${MODULE_ID}/templates/generator-dialog.html`);

  const dialog = new Dialog({
    title: "SceneForge AI - Generate Map",
    content,
    buttons: {
      generate: {
        icon: '<i class="fas fa-wand-magic-sparkles"></i>',
        label: "Generate Map",
        callback: async (dialogHtml) => {
          await handleGenerate(dialogHtml);
        }
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "generate",
    render: (dialogHtml) => {
      wireAutoDetectUi(dialogHtml, initialState);
    }
  });

  dialog.render(true);
}

/**
 * Wire the simplified prompt-only generator dialog.
 */
function wireAutoDetectUi(dialogHtml, initialState = null) {
  const form = dialogHtml.find(".sceneforge-form");

  // Restore previous values if the dialog is reopened.
  applyGeneratorFormState(form, initialState);
}

/**
 * Apply previously entered generator form values into the dialog inputs.
 */
function applyGeneratorFormState(form, state) {
  if (!state || typeof state !== "object") return;
  if (typeof state.prompt === "string") form.find('[name="prompt"]').val(state.prompt);
  if (typeof state.seed === "string") form.find('[name="seed"]').val(state.seed);
  if (typeof state.mapScale === "string") form.find('[name="mapScale"]').val(state.mapScale);
  if (typeof state.imageOrientation === "string") form.find('[name="imageOrientation"]').val(state.imageOrientation);
}

/**
 * Parse prompt, store detected payload, render preview, and optionally
 * apply detected settings to manual controls if toggle is enabled.
 */
function refreshDetectionPreview(dialogHtml) {
  const form = dialogHtml.find(".sceneforge-form");
  const prompt = String(form.find('[name="prompt"]').val() ?? "").trim();
  if (!prompt) return null;

  const detected = parsePromptForSceneSettings(prompt);
  form.data("sceneforgeDetected", detected);

  if (form.find('[name="useDetectedSettings"]').is(":checked")) {
    applyDetectedSettingsToControls(form, detected);
  }

  if (dialogHtml.find(".sceneforge-detected-results").length > 0) {
    renderDetectedResults(dialogHtml, detected);
  }
  return detected;
}

/**
 * Synchronize manual dropdowns to currently detected values.
 */
function applyDetectedSettingsToControls(form, detected) {
  form.find('[name="theme"]').val(detected.theme);
  form.find('[name="sceneSize"]').val(detected.suggestedSize);
  form.find('[name="lightingMood"]').val(detected.lightingMood);
}

/**
 * Handle first-time generation from dialog values.
 */
async function handleGenerate(dialogHtml) {
  const form = dialogHtml.find(".sceneforge-form");
  const generationConfig = buildGenerationConfigFromForm(form);
  if (!generationConfig) return;

  await createMockAiSceneFromGenerationData(generationConfig.generationData, generationConfig.seedWasAutoGenerated);
}

/**
 * Build normalized generation config from generator dialog inputs.
 */
function buildGenerationConfigFromForm(form) {
  const generationMode = "ai-image-only";
  const prompt = String(form.find('[name="prompt"]').val() ?? "").trim();
  const sceneSizeKey = String(form.find('[name="mapScale"]').val() ?? "medium").trim().toLowerCase();
  const imageOrientation = String(form.find('[name="imageOrientation"]').val() ?? "landscape").trim().toLowerCase();
  const orientationSpec = getImageOrientationSpec(imageOrientation);
  const requestedImageSize = getRequestedImageSize(sceneSizeKey, imageOrientation);
  const theme = "ai-map";
  const lightingMood = "dim";
  const useDetectedSettings = false;
  const seedInput = String(form.find('[name="seed"]').val() ?? "").trim();
  const seed = seedInput || randomSeedString();

  if (!prompt) {
    ui.notifications.warn("SceneForge AI: Please enter a prompt before generating.");
    return null;
  }

  const mapCoverageMeters = getMapCoverageMeters(sceneSizeKey);
  const compiledImagePrompt = compileInkarnatePrompt(prompt, {
    imageOrientation,
    sceneSizeKey,
    mapCoverageMeters
  });

  const generationData = {
    generationMode,
    prompt,
    sceneSizeKey,
    imageOrientation,
    imageSize: requestedImageSize,
    mapCoverageMeters,
    theme,
    lightingMood,
    detected: null,
    useDetectedSettings,
    effectiveDetected: null,
    aiPlan: null,
    layoutGraph: null,
    compiledImagePrompt,
    imageGeneration: {
      provider: getAiImageProvider(),
      compiledPrompt: compiledImagePrompt ?? "",
      imageStatus: "not-requested",
      imagePath: null,
      costEstimate: null,
      imageSize: requestedImageSize,
      imageOrientation
    },
    enabledAssetPacks: [],
    generationLayers: ["background-image"],
    seed,
    moduleVersion: "0.21.0"
  };

  // Store the raw form values so Back/Edit can restore exactly what user entered.
  const formState = {
    prompt,
    seed,
    mapScale: sceneSizeKey,
    imageOrientation
  };

  return {
    generationData,
    formState,
    seedWasAutoGenerated: !seedInput
  };
}

/**
 * Requirement helper:
 * Estimate object counts and summarize final generation state before creation.
 */
function buildGenerationPreviewData(config) {
  const generationData = config.generationData;
  const gridCells = SCENE_SIZES[generationData.sceneSizeKey] ?? SCENE_SIZES.medium;
  const gridPixelSize = getSceneGridPixelSize(generationData.sceneSizeKey);
  const widthPx = gridCells * gridPixelSize;
  const heightPx = gridCells * gridPixelSize;

  const rng = createSeededRng(`${generationData.seed}|${generationData.theme}|${generationData.sceneSizeKey}|${generationData.prompt}`);
  const walls = ENABLE_SCENE_WALLS_AND_LIGHTS
    ? buildThemeWalls(generationData.theme, widthPx, heightPx, rng, generationData.seed, generationData.effectiveDetected)
    : [];
  const tiles = ENABLE_ASSET_SPAWNING
    ? buildThemeTiles(
      generationData.theme,
      widthPx,
      heightPx,
      walls,
      rng,
      generationData.seed,
      generationData.effectiveDetected,
      generationData.enabledAssetPacks
    )
    : { floorTiles: [], propTiles: [] };
  const lights = ENABLE_SCENE_WALLS_AND_LIGHTS
    ? buildThemeLights(
      generationData.theme,
      widthPx,
      heightPx,
      rng,
      generationData.seed,
      generationData.lightingMood,
      generationData.effectiveDetected
    )
    : [];

  const appliedFeatures = FEATURE_KEYS
    .filter((key) => generationData.effectiveDetected?.features?.[key])
    .map((key) => formatFeatureLabel(key, generationData.effectiveDetected.features));

  const estimatedNotes = 1 + (generationData.effectiveDetected?.features?.treasure ? 1 : 0);
  const estimatedFloorTiles = ENABLE_ASSET_SPAWNING ? tiles.floorTiles.length : 0;
  const estimatedPropTiles = ENABLE_ASSET_SPAWNING ? tiles.propTiles.length : 0;
  const packContribution = ENABLE_ASSET_SPAWNING
    ? estimateAssetPackContribution(tiles)
    : {
      base: 0,
      "premium-tavern": 0,
      "dark-dungeon": 0,
      "rune-ruins": 0
    };
  const featureImpact = estimateFeatureImpact(generationData);
  debugLog("Preview estimates", {
    theme: generationData.theme,
    size: generationData.sceneSizeKey,
    walls: walls.length,
    lights: lights.length,
    floorTiles: estimatedFloorTiles,
    propTiles: estimatedPropTiles
  });

  return {
    generationMode: generationData.generationMode ?? "ai-image-only",
    finalTheme: generationData.theme,
    finalSize: generationData.sceneSizeKey,
    finalSeed: generationData.seed,
    imageOrientation: generationData.imageOrientation ?? "landscape",
    imageSize: generationData.imageSize ?? "1536x1024",
    mapCoverageMeters: generationData.mapCoverageMeters ?? getMapCoverageMeters(generationData.sceneSizeKey),
    lightingMood: generationData.lightingMood,
    appliedFeatures,
    enabledAssetPacks: generationData.enabledAssetPacks,
    aiPlan: generationData.aiPlan,
    layoutGraph: generationData.layoutGraph,
    compiledImagePrompt: generationData.compiledImagePrompt,
    aiImageProvider: generationData.imageGeneration?.provider ?? "none",
    aiReadableSummary: null,
    estimated: {
      walls: walls.length,
      ambientLights: lights.length,
      floorTiles: estimatedFloorTiles,
      propTiles: estimatedPropTiles,
      notes: estimatedNotes
    },
    packContribution,
    featureImpact
  };
}

/**
 * Estimate how many preview tiles come from each asset pack source.
 */
function estimateAssetPackContribution(tiles) {
  const contribution = {
    base: 0,
    "premium-tavern": 0,
    "dark-dungeon": 0,
    "rune-ruins": 0
  };

  const allTiles = [...tiles.floorTiles, ...tiles.propTiles];
  for (const tile of allTiles) {
    const packId = tile.flags?.[MODULE_ID]?.packId ?? "base";
    if (!Object.prototype.hasOwnProperty.call(contribution, packId)) {
      contribution[packId] = 0;
    }
    contribution[packId] += 1;
  }

  return contribution;
}

/**
 * Describe likely generation effects caused by detected features and lighting.
 * These are preview hints only and do not create any scene documents.
 */
function estimateFeatureImpact(generationData) {
  const impacts = [];
  const features = generationData.effectiveDetected?.features ?? {};
  const lightingMood = generationData.lightingMood;

  if (features.pillars) impacts.push("pillars detected: +pillar props");
  if (features.treasure) impacts.push("treasure detected: +treasure note");
  if (features.hiddenRoom) impacts.push("hidden room detected: +secret room layout");
  if (lightingMood === "night" || lightingMood === "dark") {
    impacts.push(`${lightingMood} detected: reduced light radius`);
  }

  return impacts;
}

/**
 * Shows SceneForge Preview Mode and routes user choice.
 */
async function openGenerationPreviewDialog(config, previewData) {
  const featuresHtml = previewData.appliedFeatures.length > 0
    ? previewData.appliedFeatures.map((feature) => `<li>${foundry.utils.escapeHTML(feature)}</li>`).join("")
    : "<li>None</li>";

  const packsHtml = previewData.enabledAssetPacks.length > 0
    ? previewData.enabledAssetPacks.map((packId) => `<li>${foundry.utils.escapeHTML(packId)}</li>`).join("")
    : "<li>base</li>";

  const featureImpactHtml = previewData.featureImpact.length > 0
    ? previewData.featureImpact.map((line) => `<li>${foundry.utils.escapeHTML(line)}</li>`).join("")
    : "<li>No special feature impacts detected.</li>";
  const aiSummaryHtml = previewData.aiReadableSummary
    ? previewData.aiReadableSummary.map((line) => `<li>${foundry.utils.escapeHTML(line)}</li>`).join("")
    : "";
  const aiPlanJsonHtml = previewData.aiPlan
    ? foundry.utils.escapeHTML(JSON.stringify(previewData.aiPlan, null, 2))
    : "";
  const layoutGraphJsonHtml = previewData.layoutGraph
    ? foundry.utils.escapeHTML(JSON.stringify(previewData.layoutGraph, null, 2))
    : "";
  const compiledPromptHtml = previewData.compiledImagePrompt
    ? foundry.utils.escapeHTML(previewData.compiledImagePrompt)
    : "";
  const aiPlannerSection = `
  <hr/>
  <p><strong>AI Planner Summary</strong></p>
  <ul>${aiSummaryHtml}</ul>
  <p><strong>Structured JSON Plan</strong></p>
  <pre>${aiPlanJsonHtml}</pre>
  <p><strong>Layout Graph JSON</strong></p>
  <pre>${layoutGraphJsonHtml}</pre>
  <p><strong>Compiled Image Prompt Preview</strong></p>
  <pre>${compiledPromptHtml}</pre>
  <p><strong>AI Image Provider:</strong> ${foundry.utils.escapeHTML(previewData.aiImageProvider)}</p>
    `;

  const content = `
<div class="sceneforge-preview">
  <p><strong>Generation Mode:</strong> AI Planner Mode</p>
  <p><strong>Final Theme:</strong> ${foundry.utils.escapeHTML(formatThemeLabel(previewData.finalTheme))}</p>
  <p><strong>Final Size:</strong> ${foundry.utils.escapeHTML(formatSceneSizeLabel(previewData.finalSize))}</p>
  <p><strong>Final Seed:</strong> ${foundry.utils.escapeHTML(previewData.finalSeed)}</p>
  <p><strong>Lighting Mood:</strong> ${foundry.utils.escapeHTML(LIGHTING_MOOD_LABELS[previewData.lightingMood] ?? "Dim")}</p>
  <p><strong>Detected Features Being Applied:</strong></p>
  <ul>${featuresHtml}</ul>
  <p><strong>Enabled Asset Packs:</strong></p>
  <ul>${packsHtml}</ul>
  ${aiPlannerSection}
  <hr/>
  <p><strong>Estimated Objects</strong></p>
  <p>Walls: ${previewData.estimated.walls} | Ambient Lights: ${previewData.estimated.ambientLights} | Tiles: ${previewData.estimated.floorTiles + previewData.estimated.propTiles} | Notes: ${previewData.estimated.notes}</p>
  <details>
    <summary><strong>Advanced Breakdown</strong></summary>
    <p><strong>Estimated Counts by Category</strong></p>
    <ul>
      <li>walls: ${previewData.estimated.walls}</li>
      <li>ambient lights: ${previewData.estimated.ambientLights}</li>
      <li>floor tiles: ${previewData.estimated.floorTiles}</li>
      <li>prop tiles: ${previewData.estimated.propTiles}</li>
      <li>notes: ${previewData.estimated.notes}</li>
    </ul>
    <p><strong>Asset Pack Contribution Estimate</strong></p>
    <ul>
      <li>base assets: ${previewData.packContribution.base ?? 0}</li>
      <li>premium tavern pack: ${previewData.packContribution["premium-tavern"] ?? 0}</li>
      <li>dark dungeon pack: ${previewData.packContribution["dark-dungeon"] ?? 0}</li>
      <li>rune ruins pack: ${previewData.packContribution["rune-ruins"] ?? 0}</li>
    </ul>
    <p><strong>Feature Impact</strong></p>
    <ul>${featureImpactHtml}</ul>
  </details>
</div>
  `;

  const userChoice = await new Promise((resolve) => {
    const buttons = {
      confirm: {
        icon: '<i class="fas fa-check"></i>',
        label: "Confirm Generate",
        callback: () => resolve("confirm")
      },
      back: {
        icon: '<i class="fas fa-arrow-left"></i>',
        label: "Back / Edit",
        callback: () => resolve("back")
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel",
        callback: () => resolve("cancel")
      }
    };

    const dialog = new Dialog({
      title: "SceneForge Preview Mode",
      content,
      buttons,
      default: "confirm",
      close: () => resolve("cancel")
    });
    dialog.render(true);
  });

  if (userChoice === "back") {
    await openGeneratorDialog(config.formState);
    return;
  }
  if (userChoice !== "confirm") return;

  debugLog("AI Planner Confirm clicked");
  await createMockAiSceneFromGenerationData(config.generationData, config.seedWasAutoGenerated);
}

/**
 * Shared scene creation path used after preview confirmation.
 */
async function createSceneFromGenerationData(generationData, seedWasAutoGenerated = false, options = {}) {
  const { backgroundPath = null, imageGenerationMetadata = null, sceneNamePrefix = "SceneForge" } = options;
  const isAiImageMode = generationData?.generationMode === "ai-image-only" || generationData?.generationMode === "ai-planner";
  const activeProvider = imageGenerationMetadata?.provider ?? getAiImageProvider();
  if (isAiImageMode) {
    const imageStatus = imageGenerationMetadata?.imageStatus ?? null;
    const imagePath = imageGenerationMetadata?.imagePath ?? backgroundPath ?? null;
    const hasValidAiImage = (
      (activeProvider === "openai" && imageStatus === "complete")
      || (activeProvider === "mock" && imageStatus === "mock-generated")
      || (activeProvider === "subscription" && imageStatus === "complete")
      || (activeProvider === "cache" && imageStatus === "reused")
    ) && Boolean(imagePath);

    if (!hasValidAiImage) {
      logImagePipelineError("createSceneFromGenerationData precondition failed", {
        provider: activeProvider,
        imageStatus,
        imagePath
      });
      ui.notifications.error("SceneForge AI: AI image generation must complete before scene creation.");
      if (activeProvider === "openai") {
        debugLog("OpenAI generation failed, aborting scene creation");
      }
      return;
    }
  }

  const gridCells = SCENE_SIZES[generationData.sceneSizeKey] ?? SCENE_SIZES.medium;
  const gridPixelSize = getSceneGridPixelSize(generationData.sceneSizeKey);
  const widthPx = gridCells * gridPixelSize;
  const heightPx = gridCells * gridPixelSize;
  const mapCoverageMeters = Number(generationData.mapCoverageMeters ?? getMapCoverageMeters(generationData.sceneSizeKey));
  const metersPerGrid = Math.max(0.1, mapCoverageMeters / Math.max(1, gridCells));
  const sceneName = buildSceneNameFromPrompt(generationData?.prompt ?? "", {
    prefix: sceneNamePrefix,
    fallback: "Map"
  });

  let createdScene = null;
  try {
    let resolvedGenerationData = imageGenerationMetadata
      ? { ...generationData, imageGeneration: imageGenerationMetadata }
      : generationData;

    const scenePayload = {
      name: sceneName,
      width: widthPx,
      height: heightPx,
      padding: 0.1,
      grid: {
        type: CONST.GRID_TYPES.SQUARE,
        size: gridPixelSize,
        distance: metersPerGrid,
        units: "m"
      },
      backgroundColor: DEFAULT_SCENE_BACKGROUND_COLOR,
      navigation: true,
      flags: {
        [MODULE_ID]: {
          [FLAG_GENERATION_KEY]: resolvedGenerationData
        }
      }
    };
    const scene = await safeSceneCreate(scenePayload, "createSceneFromGenerationData.Scene.create");
    createdScene = scene;

    if (!scene) throw new Error("Scene creation returned no scene document.");

    let backgroundVerified = false;
    let persistedBackgroundPath = null;
    if (backgroundPath) {
      debugLog("Scene background imagePath received", backgroundPath);
      persistedBackgroundPath = await persistSceneBackgroundPath(backgroundPath, {
        seed: resolvedGenerationData.seed,
        provider: imageGenerationMetadata?.provider ?? "ai"
      });
      debugLog("Scene background path resolved", persistedBackgroundPath);
      debugLog("Scene background before update", getSceneBackgroundSrc(scene));

      if (imageGenerationMetadata && persistedBackgroundPath && imageGenerationMetadata.imagePath !== persistedBackgroundPath) {
        const updatedImageGenerationMetadata = {
          ...imageGenerationMetadata,
          imagePath: persistedBackgroundPath
        };
        resolvedGenerationData = {
          ...resolvedGenerationData,
          imageGeneration: updatedImageGenerationMetadata
        };
      }

      if ((activeProvider === "openai" || activeProvider === "subscription" || activeProvider === "cache") && !persistedBackgroundPath) {
        logImagePipelineError("background persistence failed", {
          provider: activeProvider,
          imagePath: backgroundPath,
          persistedBackgroundPath,
          sceneId: scene.id,
          sceneName: scene.name
        });
        await scene.delete();
        ui.notifications.error("SceneForge AI: Could not save generated image locally. Scene was not created.");
        return;
      }

      // Reduce blur by matching scene pixel dimensions to the generated image.
      // The old fixed 50x50 grid at 100px (5000x5000) stretched 1024px maps heavily.
      const imageDimensions = await getImagePixelDimensions(persistedBackgroundPath);
      const fallbackSize = parseImageSizeString(resolvedGenerationData.imageSize);
      const resolvedImageWidth = Number(imageDimensions?.width ?? fallbackSize?.width ?? 0);
      const resolvedImageHeight = Number(imageDimensions?.height ?? fallbackSize?.height ?? 0);
      if (resolvedImageWidth > 0 && resolvedImageHeight > 0) {
        const resolvedGridPixelSize = getSceneGridPixelSize(resolvedGenerationData.sceneSizeKey);
        const mapCoverageMeters = Number(resolvedGenerationData.mapCoverageMeters ?? getMapCoverageMeters(resolvedGenerationData.sceneSizeKey));
        const gridSquaresAcross = Math.max(1, resolvedImageWidth / resolvedGridPixelSize);
        const metersPerGrid = Math.max(0.1, mapCoverageMeters / gridSquaresAcross);
        await scene.update({
          width: resolvedImageWidth,
          height: resolvedImageHeight,
          grid: {
            type: CONST.GRID_TYPES.SQUARE,
            size: resolvedGridPixelSize,
            distance: metersPerGrid,
            units: "m"
          },
          backgroundColor: DEFAULT_SCENE_BACKGROUND_COLOR
        });
      }

      const backgroundApplyResult = await applyBackgroundToScene(scene, persistedBackgroundPath);
      const updatedBackgroundSrc = backgroundApplyResult.finalBackgroundSrc;
      debugLog("Scene background after update", updatedBackgroundSrc);
      backgroundVerified = Boolean(persistedBackgroundPath) && backgroundApplyResult.applied;

      if (!backgroundVerified && (activeProvider === "openai" || activeProvider === "subscription" || activeProvider === "cache")) {
        logImagePipelineError("background verification failed", {
          provider: activeProvider,
          imagePath: backgroundPath,
          persistedBackgroundPath,
          updatedBackgroundSrc,
          sceneId: scene.id,
          sceneName: scene.name
        });
        await scene.delete();
        ui.notifications.error("SceneForge AI: Map image failed to apply. Scene was not created.");
        return;
      }

      if (backgroundVerified) {
        debugLog("SceneForge AI: Map image verified as scene background.");
        ui.notifications.info("SceneForge AI: Map image applied as scene background.");
      }
    }

    if (resolvedGenerationData.imageGeneration) {
      await scene.setFlag(MODULE_ID, FLAG_IMAGE_GENERATION_KEY, resolvedGenerationData.imageGeneration);
    }

    if (persistedBackgroundPath) {
      if (resolvedGenerationData.imageGeneration?.provider === "cache" && resolvedGenerationData.imageGeneration?.cacheEntryId) {
        await markImageDumpEntryUsed(resolvedGenerationData.imageGeneration.cacheEntryId, scene);
      } else if (resolvedGenerationData.imageGeneration?.provider !== "none") {
        await recordGeneratedImageDumpEntry({
          generationData: resolvedGenerationData,
          imageGenerationMetadata: resolvedGenerationData.imageGeneration,
          imagePath: persistedBackgroundPath,
          scene
        });
      }
    }

    if (seedWasAutoGenerated) {
      ui.notifications.info(`SceneForge AI: Seed auto-generated as "${resolvedGenerationData.seed}".`);
    }
    const shouldShowCreatedSuccess = !backgroundPath || backgroundVerified;
    if (shouldShowCreatedSuccess) {
      ui.notifications.info(`SceneForge AI: Created "${scene.name}" successfully.`);
    }
    try {
      await scene.activate();
    } catch (_activateError) {
      // Non-fatal: scene already exists even if activation fails.
    }
    await promptForGeneratedSceneVote(scene);
  } catch (error) {
    if ((activeProvider === "openai" || activeProvider === "subscription" || activeProvider === "cache") && createdScene) {
      logImagePipelineError("scene creation failed after OpenAI image generation", {
        provider: activeProvider,
        sceneId: createdScene?.id ?? null,
        sceneName: createdScene?.name ?? null
      }, error);
      try {
        await createdScene.delete();
      } catch (_deleteError) {
        // Ignore cleanup errors; original failure is reported below.
      }
      ui.notifications.error("SceneForge AI: Map image failed to apply. Scene was not created.");
      return;
    }
    console.error(`${MODULE_ID} | Scene generation failed`, error);
    ui.notifications.error("SceneForge AI: Failed to generate scene. Check browser console for details.");
  }
}

/**
 * Main image-generation path using configured provider architecture.
 */
async function createMockAiSceneFromGenerationData(generationData, seedWasAutoGenerated = false) {
  if (isGlobalLibraryOnlyModeEnabled()) {
    const provider = getAiImageProvider();
    if (provider !== "subscription") {
      ui.notifications.error("SceneForge AI: Global library mode requires AI provider set to Subscription Backend.");
      return;
    }
    if (!canUseGlobalImageDumpLibrary()) {
      ui.notifications.error("SceneForge AI: Global library mode requires backend URL and subscription auth token.");
      return;
    }
  }

  let reusableEntry = null;
  try {
    reusableEntry = await findReusableImageEntryForPrompt(generationData?.prompt ?? "");
  } catch (error) {
    logImagePipelineError("global reuse lookup failed", { prompt: generationData?.prompt ?? "" }, error);
    ui.notifications.warn("SceneForge AI: Global cache lookup failed. Proceeding with new image generation.");
    reusableEntry = null;
  }
  if (reusableEntry) {
    console.info(`${MODULE_ID} | Reusing cached image from dump library`, {
      entryId: reusableEntry.id,
      prompt: reusableEntry.promptExact,
      imagePath: reusableEntry.imagePath
    });
    ui.notifications.info("SceneForge AI: Reused a previously generated map for this exact prompt.");
    const imageGenerationMetadata = {
      provider: "cache",
      compiledPrompt: generationData.compiledImagePrompt ?? "",
      imageStatus: "reused",
      imagePath: reusableEntry.imagePath,
      costEstimate: {
        preview: "$0.00 cached",
        final: "$0.00 cached"
      },
      cacheEntryId: reusableEntry.id
    };
    await createSceneFromGenerationData(generationData, seedWasAutoGenerated, {
      backgroundPath: reusableEntry.imagePath,
      imageGenerationMetadata,
      sceneNamePrefix: "SceneForge Cached"
    });
    return;
  }

  const provider = getAiImageProvider();
  if (provider === "none") {
    logImagePipelineError("no AI provider selected", { provider });
    ui.notifications.error("SceneForge AI: No AI image provider selected.");
    return;
  }
  if (provider === "openai" && !getOpenAiApiKey()) {
    logImagePipelineError("OpenAI API key missing", { provider });
    ui.notifications.error("SceneForge AI: OpenAI API key required before AI map generation.");
    return;
  }
  if (provider === "bfl" && !getBflApiKey()) {
    logImagePipelineError("BFL API key missing", { provider });
    ui.notifications.error("SceneForge AI: BFL API key required before AI map generation.");
    return;
  }
  if (provider === "openai") {
    debugLog("OpenAI generation path called");
  }

  const compiledPrompt = generationData.compiledImagePrompt ?? "";
  const imageResult = await generateAiMapImage(compiledPrompt, {
    mode: "preview",
    seed: generationData.seed,
    sourcePrompt: generationData.prompt ?? "",
    imageSize: generationData.imageSize ?? getRequestedImageSize(generationData.sceneSizeKey, generationData.imageOrientation),
    imageOrientation: generationData.imageOrientation ?? "landscape"
  });
  debugLog("AI imageResult", imageResult);

  if (imageResult?.imageStatus === "failed") {
    const errorMessage = imageResult.errorMessage ?? "Image generation failed.";
    logImagePipelineError("image generation failed", {
      provider: imageResult?.provider ?? provider,
      imageStatus: imageResult?.imageStatus ?? null,
      errorMessage,
      seed: generationData.seed
    });
    ui.notifications.error(`SceneForge AI: ${errorMessage}`);
    if (imageResult?.provider === "openai") {
      debugLog("OpenAI generation failed, aborting scene creation");
    }
    return;
  }

  const validImageForScene = (
    (imageResult?.provider === "openai" && imageResult?.imageStatus === "complete")
    || (imageResult?.provider === "mock" && imageResult?.imageStatus === "mock-generated")
    || (imageResult?.provider === "subscription" && imageResult?.imageStatus === "complete")
    || (imageResult?.provider === "cache" && imageResult?.imageStatus === "reused")
  ) && Boolean(imageResult?.imagePath);

  if (!validImageForScene) {
    logImagePipelineError("invalid image result for scene creation", {
      provider: imageResult?.provider ?? provider,
      imageStatus: imageResult?.imageStatus ?? null,
      imagePath: imageResult?.imagePath ?? null,
      seed: generationData.seed
    });
    ui.notifications.error("SceneForge AI: Image generation did not return a valid map image.");
    if (imageResult?.provider === "openai") {
      debugLog("OpenAI generation failed, aborting scene creation");
    }
    return;
  }

  const imageGenerationMetadata = {
    provider: imageResult.provider,
    compiledPrompt,
    imageStatus: imageResult.imageStatus,
    imagePath: imageResult.imagePath,
    costEstimate: imageResult.costEstimate,
    generationMetadata: imageResult.generationMetadata ?? null
  };

  if (imageResult?.provider === "subscription" && imageResult?.generationMetadata) {
    debugLog("Subscription generation metadata returned to module", imageResult.generationMetadata);
  }

  await createSceneFromGenerationData(generationData, seedWasAutoGenerated, {
    backgroundPath: imageResult.imagePath ?? null,
    imageGenerationMetadata,
    sceneNamePrefix: imageResult.provider === "mock" ? "SceneForge Mock Test Scene" : "SceneForge"
  });
}

function buildSceneImageEditPrompt(userInstructions, preserveOptions, strength) {
  const selectedPreserve = [];
  if (preserveOptions?.artStyle) selectedPreserve.push("Art style");
  if (preserveOptions?.lighting) selectedPreserve.push("Lighting");
  if (preserveOptions?.terrain) selectedPreserve.push("Terrain");
  if (preserveOptions?.structures) selectedPreserve.push("Structures");
  const preserveLine = selectedPreserve.length > 0 ? selectedPreserve.join(", ") : "None selected";

  return [
    "You are editing an existing top-down fantasy battle map. Make only the requested changes. Preserve the original camera angle, art style, lighting, terrain, composition, and map usability unless the user specifically asks otherwise.",
    "",
    `USER EDIT:\n${String(userInstructions ?? "").trim()}`,
    "",
    `PRESERVE:\n${preserveLine}`,
    "",
    `CHANGE STRENGTH:\nApply approximately ${Math.max(0, Math.min(100, Number(strength) || 0))}% change. Lower strength means minimal edits and maximum consistency.`,
    "",
    "HARD CONSTRAINTS:",
    "- Keep TRUE TOP DOWN battle map perspective.",
    "- Keep 90 degree orthographic camera.",
    "- Keep gridless VTT map format.",
    "- No characters.",
    "- No text.",
    "- No labels.",
    "- No UI elements.",
    "- No isometric angle.",
    "- No cinematic perspective.",
    "- Return only the edited map image."
  ].join("\n");
}

async function editOpenAiMapImage(referenceImagePath, editPrompt, options = {}) {
  const provider = "openai";
  const costEstimate = {
    preview: "$0.00 mock",
    final: "$0.08 placeholder"
  };
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "OpenAI API key required before AI image editing."
    };
  }

  try {
    const referenceImage = await loadImageAsBlobOrFile(referenceImagePath, {
      filenamePrefix: "sceneforge-edit-reference"
    });
    const endpoint = "https://api.openai.com/v1/images/edits";
    debugLog("OpenAI endpoint called:", endpoint);
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("prompt", String(editPrompt ?? ""));
    form.append("size", "1024x1024");
    if (referenceImage.file instanceof Blob) {
      form.append("image", referenceImage.file, referenceImage.filename);
    } else {
      form.append("image", referenceImage.file);
    }
    if (DEBUG) {
      debugLog("OpenAI image edit request metadata", {
        endpoint,
        method: "POST",
        hasReferenceImage: true
      });
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
    if (!response.ok) {
      logImagePipelineError("OpenAI image edit request failed", {
        provider,
        endpoint,
        status: response.status
      });
      throw new Error(`OpenAI image edit request failed (${response.status}).`);
    }

    debugLog("OpenAI response headers", [...response.headers.entries()]);
    debugLog("OpenAI success response", await response.clone().text());

    const payload = await response.json();
    const first = payload?.data?.[0] ?? null;
    const imagePath = first?.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : (first?.url ?? null);
    if (!imagePath) {
      throw new Error("OpenAI image edit response did not include an image payload.");
    }
    return {
      provider,
      imageStatus: "complete",
      imagePath,
      costEstimate
    };
  } catch (error) {
    logImagePipelineError("OpenAI image edit exception", { provider }, error);
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `OpenAI image edit failed: ${error?.message ?? "unknown error"}`
    };
  }
}

async function editAiMapImage(referenceImagePath, editPrompt, options = {}) {
  const provider = getAiImageProvider();
  if (provider === "none") {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      errorMessage: "No AI image provider selected."
    };
  }
  if (provider === "mock") {
    return {
      provider,
      imageStatus: "mock-edited",
      imagePath: buildMockMapBackgroundDataUri({ seed: `edit-${Date.now()}` }),
      costEstimate: {
        preview: "$0.00 mock",
        final: "$0.00 mock"
      }
    };
  }
  if (provider === "openai") {
    return editOpenAiMapImage(referenceImagePath, editPrompt, options);
  }
  return {
    provider,
    imageStatus: "failed",
    imagePath: null,
    errorMessage: "SceneForge AI: Image editing currently supports OpenAI (or Mock test mode) only."
  };
}

async function handleSceneImageEdit(scene, editConfig) {
  const originalBackgroundPath = getSceneBackgroundPath(scene);
  if (!originalBackgroundPath) {
    ui.notifications.error("SceneForge AI: Image edit failed. Original map was not changed.");
    return;
  }
  if (getAiImageProvider() === "none") {
    ui.notifications.error("SceneForge AI: No AI image provider selected.");
    return;
  }
  const editPrompt = buildSceneImageEditPrompt(
    editConfig.instructions,
    editConfig.preserveOptions,
    editConfig.strength
  );
  const result = await editAiMapImage(originalBackgroundPath, editPrompt, {
    strength: editConfig.strength,
    preserveOptions: editConfig.preserveOptions
  });
  if (!result?.imagePath || (result.imageStatus !== "complete" && result.imageStatus !== "mock-edited")) {
    ui.notifications.error("SceneForge AI: Image edit failed. Original map was not changed.");
    return;
  }

  try {
    const persistedPath = await persistEditedSceneBackground(result.imagePath, {
      seed: scene?.id ?? "scene-edit",
      provider: result.provider ?? "edit"
    });
    if (!persistedPath) throw new Error("No persisted edited image path returned.");
    const applyResult = await applyBackgroundToScene(scene, persistedPath);
    const finalBackgroundSrc = String(applyResult?.finalBackgroundSrc ?? "").trim();
    const recheckedBackgroundSrc = getSceneBackgroundPath(scene);
    const isVerified =
      pathsLikelyMatch(finalBackgroundSrc, persistedPath)
      || pathsLikelyMatch(recheckedBackgroundSrc, persistedPath);
    if (!applyResult?.applied || !isVerified) {
      await applyBackgroundToScene(scene, originalBackgroundPath);
      throw new Error("Scene background verification failed after edit.");
    }
    ui.notifications.info("SceneForge AI: Edited map applied successfully.");
  } catch (error) {
    logImagePipelineError("scene image edit apply failed", {
      sceneId: scene?.id ?? null,
      sceneName: scene?.name ?? null
    }, error);
    ui.notifications.error("SceneForge AI: Image edit failed. Original map was not changed.");
  }
}

async function openSceneImageEditDialog(scene) {
  const currentBackgroundPath = getSceneBackgroundPath(scene);
  if (!currentBackgroundPath) {
    ui.notifications.error("SceneForge AI: Image edit failed. Original map was not changed.");
    return;
  }
  const content = `
<form class="sceneforge-edit-form">
  <div class="form-group">
    <label>Current Map</label>
    <div style="margin-top:6px;">
      <img src="${foundry.utils.escapeHTML(currentBackgroundPath)}" alt="Current scene map" style="max-width:100%; max-height:220px; border-radius:6px; object-fit:contain;" />
    </div>
  </div>
  <div class="form-group">
    <label for="sf-edit-instructions">Edit Instructions</label>
    <textarea id="sf-edit-instructions" name="instructions" rows="5" placeholder="Example: Move the ship away from the pathway and dock it along the right side. Keep the beach, road, dock, and ocean unchanged." required></textarea>
  </div>
  <fieldset class="form-group">
    <legend>Preserve</legend>
    <label><input type="checkbox" name="preserveArtStyle" checked /> Art style</label><br/>
    <label><input type="checkbox" name="preserveLighting" checked /> Lighting</label><br/>
    <label><input type="checkbox" name="preserveTerrain" checked /> Terrain</label><br/>
    <label><input type="checkbox" name="preserveStructures" checked /> Structures</label>
  </fieldset>
  <div class="form-group">
    <label for="sf-edit-strength">Change Strength: <span class="sf-edit-strength-value">30</span>%</label>
    <input id="sf-edit-strength" type="range" name="strength" min="0" max="100" value="30" />
  </div>
</form>
  `;

  const dialog = new Dialog({
    title: "SceneForge AI - Edit Image",
    content,
    buttons: {
      generate: {
        icon: '<i class="fas fa-wand-magic-sparkles"></i>',
        label: "Generate Edited Image",
        callback: async (dialogHtml) => {
          const form = dialogHtml.find(".sceneforge-edit-form");
          const instructions = String(form.find('[name="instructions"]').val() ?? "").trim();
          if (!instructions) {
            ui.notifications.warn("SceneForge AI: Please enter edit instructions.");
            return;
          }
          await handleSceneImageEdit(scene, {
            instructions,
            preserveOptions: {
              artStyle: form.find('[name="preserveArtStyle"]').is(":checked"),
              lighting: form.find('[name="preserveLighting"]').is(":checked"),
              terrain: form.find('[name="preserveTerrain"]').is(":checked"),
              structures: form.find('[name="preserveStructures"]').is(":checked")
            },
            strength: Number(form.find('[name="strength"]').val() ?? 30)
          });
        }
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel"
      }
    },
    default: "generate",
    render: (dialogHtml) => {
      const slider = dialogHtml.find('[name="strength"]');
      const strengthValue = dialogHtml.find(".sf-edit-strength-value");
      slider.on("input change", () => {
        strengthValue.text(String(slider.val() ?? 30));
      });
    }
  });
  dialog.render(true);
}

/**
 * Provider architecture router.
 * Real generation is currently enabled only for the OpenAI provider path.
 */
async function generateAiMapImage(compiledPrompt, options = {}) {
  // Production hard-lock: all generation goes through subscription backend,
  // where BFL keys are server-side only.
  const provider = "subscription";
  console.info(`${MODULE_ID} | AI image provider selected: ${provider}`);
  return generateSubscriptionMapImage(compiledPrompt, options);
}

async function generateSubscriptionMapImage(compiledPrompt, options = {}) {
  const stringifyBackendField = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return "";
    }
  };

  const provider = "subscription";
  const costEstimate = { preview: "included with subscription", final: "included with subscription" };
  const backendBaseUrl = getSubscriptionBackendUrl();
  const authFetch = getAuthApi()?.authenticatedFetch ?? fetch;
  debugLog("SceneForge backendBaseUrl:", backendBaseUrl);
  const token = getSubscriptionAuthToken();

  if (!backendBaseUrl) {
    logImagePipelineError("subscription backend url missing", { provider });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "Subscription backend URL is not configured."
    };
  }

  if (!token) {
    logImagePipelineError("subscription auth token missing", { provider });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "Please sign in to Gambits Forge first."
    };
  }

  const entitlementCheck = await getAuthApi()?.EntitlementService?.ensureCanGenerate?.({ notify: true });
  if (entitlementCheck && entitlementCheck.ok === false) {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "Authentication or subscription check failed."
    };
  }

  const idempotencyKey = createIdempotencyKey();
  const reserve = await callEntitlementMutationWithAuthRetry("consume", idempotencyKey);
  if (!reserve?.ok) {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: mapAuthErrorCodeToMessage(reserve?.errorCode, reserve?.message || "Could not reserve generation usage.")
    };
  }
  const reservationIdentifier = extractReservationIdentifier(reserve?.payload);
  if (!reservationIdentifier) {
    logImagePipelineError("consume response missing reservation identifier", {
      idempotencyKey: redactIdempotencyKey(idempotencyKey),
      payloadKeys: Object.keys(reserve?.payload ?? {})
    });
  }

  const subscriptionSync = await syncSubscriptionStatus({ notify: false });
  const subscriptionState = subscriptionSync?.state ?? getSubscriptionAccountState();
  if (subscriptionSync.ok && subscriptionState.active === false) {
    await attemptRefundWithContract({
      idempotencyKey,
      reservationIdentifier,
      reservationPayload: reserve?.payload,
      context: "subscription_inactive_pre_generation"
    });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "Subscription is inactive. Please sign in again."
    };
  }
  if (
    subscriptionSync.ok
    && !subscriptionState.unlimitedGenerations
    && subscriptionState.usageLimit > 0
    && subscriptionState.usageCount >= subscriptionState.usageLimit
  ) {
    await attemptRefundWithContract({
      idempotencyKey,
      reservationIdentifier,
      reservationPayload: reserve?.payload,
      context: "usage_limit_pre_generation"
    });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `Monthly generation limit reached (${subscriptionState.usageCount}/${subscriptionState.usageLimit}). Resets at the next billing month.`
    };
  }
  const endpoint = `${backendBaseUrl}/api/maps/generate`;
  console.info(`${MODULE_ID} | Subscription backend endpoint: ${endpoint}`);
  const normalizedPrompt = String(compiledPrompt ?? "").trim();
  const parsedImageSize = parseImageSizeString(options.imageSize ?? "1536x1024");
  const requestPayload = {
    compiledPrompt: normalizedPrompt,
    // Compatibility aliases for backend variants that expect generic keys.
    prompt: normalizedPrompt,
    input: normalizedPrompt,
    seed: options.seed ?? null,
    plan: options.plan ?? null,
    layoutGraph: options.layoutGraph ?? null,
    sourcePrompt: options.sourcePrompt ?? "",
    imageSize: options.imageSize ?? "1536x1024",
    imageOrientation: options.imageOrientation ?? "landscape",
    width: parsedImageSize?.width ?? null,
    height: parsedImageSize?.height ?? null
  };
  debugLog("Subscription generation request", { endpoint, requestPayload });

  try {
    const response = await authFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify(requestPayload)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failedGenerationId = String(payload?.generationId ?? payload?.id ?? payload?.result?.generationId ?? "").trim();
      await attemptRefundWithContract({
        idempotencyKey,
        generationId: failedGenerationId,
        reservationIdentifier,
        reservationPayload: reserve?.payload,
        context: "generate_http_failure"
      });
      const backendMessage = stringifyBackendField(payload?.error ?? payload?.message);
      const backendDetail = stringifyBackendField(
        payload?.detail
        ?? payload?.reason
        ?? payload?.backendMessage
        ?? payload?.providerError
        ?? payload?.upstreamError
        ?? payload?.errors
        ?? payload?.error_description
      );
      const nestedErrorDetail = stringifyBackendField(payload?.error?.detail ?? payload?.error?.message ?? payload?.error?.reason);
      const backendCombinedMessage = [backendMessage, backendDetail]
        .concat(nestedErrorDetail ? [nestedErrorDetail] : [])
        .map((part) => String(part ?? "").trim())
        .filter((part, index, arr) => part && arr.indexOf(part) === index)
        .join(" - ");
      const quotaErrorCode = String(payload?.errorCode ?? payload?.code ?? payload?.error ?? "").toLowerCase();
      if (quotaErrorCode === "quota_exceeded") {
        const monthKey = String(payload?.monthKey ?? payload?.usage?.monthKey ?? subscriptionState?.monthKey ?? "").trim();
        const usageLimit = Number(payload?.usageLimit ?? payload?.usage?.limit ?? subscriptionState?.usageLimit ?? 0);
        const usageCount = Number(payload?.usageCount ?? payload?.usage?.used ?? subscriptionState?.usageCount ?? usageLimit);
        const monthLabel = monthKey || "this month";
        return {
          provider,
          imageStatus: "failed",
          imagePath: null,
          costEstimate,
          errorMessage: `Monthly quota exceeded for ${monthLabel}: ${usageCount}/${usageLimit}.`
        };
      }
      if (response.status === 401 || response.status === 403) {
        logImagePipelineError("subscription backend unauthorized", {
          provider,
          status: response.status,
          backendMessage: backendCombinedMessage || backendMessage
        });
        return {
          provider,
          imageStatus: "failed",
          imagePath: null,
          costEstimate,
          errorMessage: "Subscription access denied. Please sign in again."
        };
      }
      logImagePipelineError("subscription backend request failed", {
        provider,
        status: response.status,
        backendMessage: backendCombinedMessage || backendMessage,
        payload
      });
      return {
        provider,
        imageStatus: "failed",
        imagePath: null,
        costEstimate,
        errorMessage: backendCombinedMessage || `Subscription backend request failed (${response.status}).`
      };
    }

    const generationMetadata = extractSubscriptionGenerationMetadata(payload, endpoint);
    debugLog("Subscription downstream endpoint called:", generationMetadata.endpoint);
    debugLog("Subscription generation metadata", generationMetadata);
    debugLog("Subscription generation cost fields", {
      estimatedCost: generationMetadata.estimatedCost,
      rawCostFields: generationMetadata.rawCostFields
    });

    const imagePath = payload?.imagePath ?? payload?.image_url ?? payload?.url ?? null;
    if (!imagePath) {
      await attemptRefundWithContract({
        idempotencyKey,
        generationId: generationMetadata?.generationId,
        reservationIdentifier,
        reservationPayload: reserve?.payload,
        context: "missing_image_path_after_generate"
      });
      logImagePipelineError("subscription backend returned no image path", {
        provider,
        payloadKeys: Object.keys(payload ?? {})
      });
      return {
        provider,
        imageStatus: "failed",
        imagePath: null,
        costEstimate,
        errorMessage: "Subscription backend returned no map image."
      };
    }

    const completionGenerationId = normalizeMutationGenerationId(generationMetadata?.generationId);
    const completion = await completeGenerationReservation(idempotencyKey, completionGenerationId);
    if (!completion.ok) {
      logImagePipelineError("generation completion failed after successful map generation", {
        idempotencyKey: redactIdempotencyKey(idempotencyKey),
        generationId: redactIdempotencyKey(completionGenerationId),
        status: completion.status ?? 0,
        errorCode: completion.errorCode ?? ""
      });
      if (completion.errorCode !== "MISSING_GENERATION_ID") {
        scheduleCompletionRetry(idempotencyKey, completionGenerationId, 1);
      }
    }
    await syncSubscriptionStatus({ notify: false });

    return {
      provider,
      imageStatus: "complete",
      imagePath: String(imagePath),
      costEstimate,
      generationMetadata
    };
  } catch (error) {
    const refundResult = await attemptRefundWithContract({
      idempotencyKey,
      reservationIdentifier,
      reservationPayload: reserve?.payload,
      context: "generate_exception"
    });
    if (!refundResult.ok && !refundResult.skipped) {
      logImagePipelineError("generation refund failed after exception", {
        idempotencyKey: redactIdempotencyKey(idempotencyKey),
        generationId: redactIdempotencyKey(refundResult?.payload?.generationId ?? reservationIdentifier),
        status: refundResult.status ?? 0,
        errorCode: refundResult.errorCode ?? ""
      });
    }
    logImagePipelineError("subscription backend exception", { provider, endpoint }, error);
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `Subscription backend request failed: ${error?.message ?? "unknown error"}`
    };
  }
}

function extractSubscriptionGenerationMetadata(payload, backendEndpoint) {
  const normalizedPayload = payload && typeof payload === "object" ? payload : {};
  const provider = String(
    normalizedPayload?.provider
    ?? normalizedPayload?.generation?.provider
    ?? "subscription-backend"
  );
  const model = String(
    normalizedPayload?.model
    ?? normalizedPayload?.generation?.model
    ?? "unknown"
  );
  const endpoint = String(
    normalizedPayload?.endpoint
    ?? normalizedPayload?.providerEndpoint
    ?? normalizedPayload?.generation?.endpoint
    ?? backendEndpoint
  );
  const generationId = String(
    normalizedPayload?.generationId
    ?? normalizedPayload?.id
    ?? normalizedPayload?.generation?.id
    ?? ""
  );

  const imageCountCandidate = Number(
    normalizedPayload?.imageCount
    ?? normalizedPayload?.images?.length
    ?? normalizedPayload?.data?.length
    ?? 1
  );
  const imageCount = Number.isFinite(imageCountCandidate) && imageCountCandidate > 0
    ? imageCountCandidate
    : 1;

  const estimatedCost = normalizedPayload?.estimatedCost
    ?? normalizedPayload?.cost
    ?? normalizedPayload?.pricing?.estimatedCost
    ?? null;

  return {
    provider,
    model,
    endpoint,
    estimatedCost,
    generationId,
    imageCount,
    rawCostFields: {
      cost: normalizedPayload?.cost ?? null,
      estimatedCost: normalizedPayload?.estimatedCost ?? null,
      usage: normalizedPayload?.usage ?? null,
      pricing: normalizedPayload?.pricing ?? null
    }
  };
}

function parseImageSizeToBflDimensions(imageSize) {
  const raw = String(imageSize ?? "").trim();
  const match = raw.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return { width: 1024, height: 1024 };
  const width = Math.max(256, Number(match[1] ?? 1024));
  const height = Math.max(256, Number(match[2] ?? 1024));
  return { width, height };
}

async function generateBflMapImage(compiledPrompt, options = {}) {
  const provider = "bfl";
  const costEstimate = {
    preview: "$0.00 mock",
    final: "BFL variable"
  };
  const apiKey = getBflApiKey();
  if (!apiKey) {
    logImagePipelineError("BFL API key missing", { provider });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "BFL API key required before AI map generation."
    };
  }

  const submitEndpoint = "https://api.bfl.ai/v1/flux-pro-1.1";
  const { width, height } = parseImageSizeToBflDimensions(options.imageSize ?? "1024x1024");
  const requestPayload = {
    prompt: String(compiledPrompt ?? ""),
    width,
    height
  };

  try {
    debugLog("BFL endpoint called:", submitEndpoint);
    debugLog("BFL request metadata", {
      endpoint: submitEndpoint,
      method: "POST",
      hasApiKey: true,
      width,
      height
    });

    const submitResponse = await fetch(submitEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "x-key": apiKey
      },
      body: JSON.stringify(requestPayload)
    });
    const submitPayload = await submitResponse.json().catch(() => ({}));
    if (!submitResponse.ok) {
      const message = String(submitPayload?.error ?? submitPayload?.message ?? "");
      logImagePipelineError("BFL submit request failed", {
        provider,
        endpoint: submitEndpoint,
        status: submitResponse.status,
        message
      });
      return {
        provider,
        imageStatus: "failed",
        imagePath: null,
        costEstimate,
        errorMessage: message || `BFL generation request failed (${submitResponse.status}).`
      };
    }

    const generationId = String(submitPayload?.id ?? "").trim();
    const pollingUrl = String(
      submitPayload?.polling_url
      ?? (generationId ? `https://api.bfl.ai/v1/get_result?id=${encodeURIComponent(generationId)}` : "")
    ).trim();
    if (!pollingUrl) {
      return {
        provider,
        imageStatus: "failed",
        imagePath: null,
        costEstimate,
        errorMessage: "BFL generation response did not include polling URL."
      };
    }
    debugLog("BFL endpoint called:", pollingUrl);

    const startedAt = Date.now();
    const timeoutMs = 120000;
    while (Date.now() - startedAt < timeoutMs) {
      const pollResponse = await fetch(pollingUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-key": apiKey
        }
      });
      const pollPayload = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok) {
        const message = String(pollPayload?.error ?? pollPayload?.message ?? "");
        return {
          provider,
          imageStatus: "failed",
          imagePath: null,
          costEstimate,
          errorMessage: message || `BFL polling request failed (${pollResponse.status}).`
        };
      }

      const status = String(pollPayload?.status ?? "").trim().toLowerCase();
      if (status === "ready") {
        const imagePath = String(pollPayload?.result?.sample ?? "").trim();
        if (!imagePath) {
          return {
            provider,
            imageStatus: "failed",
            imagePath: null,
            costEstimate,
            errorMessage: "BFL response was Ready but no image URL was returned."
          };
        }
        return {
          provider,
          imageStatus: "complete",
          imagePath,
          costEstimate,
          generationMetadata: {
            provider: "bfl",
            model: "flux-pro-1.1",
            endpoint: submitEndpoint,
            estimatedCost: null,
            generationId,
            imageCount: 1
          }
        };
      }
      if (status === "error" || status === "failed" || status.includes("moderat") || status === "task not found") {
        return {
          provider,
          imageStatus: "failed",
          imagePath: null,
          costEstimate,
          errorMessage: String(pollPayload?.error ?? pollPayload?.message ?? `BFL generation failed with status: ${status}`)
        };
      }

      // BFL async generation requires polling until Ready.
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "BFL generation timed out while waiting for result."
    };
  } catch (error) {
    logImagePipelineError("BFL generation exception", { provider, endpoint: submitEndpoint }, error);
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `BFL generation failed: ${error?.message ?? "unknown error"}`
    };
  }
}

/**
 * Real OpenAI image generation path with hard safety controls.
 */
async function generateOpenAiMapImage(compiledPrompt, options = {}) {
  const provider = "openai";
  const costEstimate = {
    preview: "$0.00 mock",
    final: "$0.08 placeholder"
  };

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    logImagePipelineError("OpenAI API key missing", { provider });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "OpenAI API key required before AI map generation."
    };
  }

  const monthlyLimit = getOpenAiMonthlyLimit();
  const usage = await getOpenAiUsageState();
  if (usage.count >= monthlyLimit) {
    logImagePipelineError("OpenAI monthly limit reached", {
      provider,
      usageCount: usage.count,
      monthlyLimit
    });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `Monthly generation limit reached (${usage.count}/${monthlyLimit}).`
    };
  }

  const confirmed = await promptPaidGenerationConfirmation(compiledPrompt, {
    estimatedCost: costEstimate.final,
    usageCount: usage.count,
    usageLimit: monthlyLimit,
    requireConfirmation: isPaidGenerationConfirmationEnabled()
  });
  if (!confirmed) {
    logImagePipelineError("OpenAI paid generation cancelled", { provider });
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "Paid generation cancelled."
    };
  }

  try {
    const endpoint = "https://api.openai.com/v1/images/generations";
    debugLog("OpenAI endpoint called:", endpoint);
    console.info(`${MODULE_ID} | OpenAI endpoint: ${endpoint} (model: gpt-image-1)`);
    const requestPayload = {
      model: "gpt-image-1",
      prompt: compiledPrompt,
      size: String(options.imageSize ?? "1536x1024")
    };
    debugLog("OpenAI request payload validated");
    debugLog("OpenAI request metadata", {
      endpoint,
      method: "POST",
      authorization: "Bearer <redacted>"
    });
    debugLog("OpenAI request payload", requestPayload);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      logImagePipelineError("OpenAI images request failed", {
        provider,
        endpoint,
        status: response.status
      });
      throw new Error(`OpenAI image request failed (${response.status}).`);
    }

    debugLog("OpenAI response headers", [...response.headers.entries()]);
    debugLog("OpenAI success response", await response.clone().text());

    const payload = await response.json();
    const first = payload?.data?.[0] ?? null;
    const imagePath = first?.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : (first?.url ?? null);
    debugLog("OpenAI imagePath received", imagePath);

    if (!imagePath) {
      logImagePipelineError("OpenAI response missing image payload", {
        provider,
        endpoint,
        payloadKeys: Object.keys(payload ?? {})
      });
      throw new Error("OpenAI response did not include an image payload.");
    }

    await incrementOpenAiUsageCount();

    return {
      provider,
      imageStatus: "complete",
      imagePath,
      costEstimate
    };
  } catch (error) {
    logImagePipelineError("OpenAI generation exception", { provider }, error);
    debugLog("OpenAI generation failed", error?.message ?? error);
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `OpenAI generation failed: ${error?.message ?? "unknown error"}`
    };
  }
}

/**
 * Paid generation confirmation dialog shown before OpenAI API request.
 */
function promptPaidGenerationConfirmation(compiledPrompt, options = {}) {
  const {
    usageCount = 0,
    usageLimit = 0,
    requireConfirmation = true
  } = options;

  if (!requireConfirmation) return Promise.resolve(true);

  return new Promise((resolve) => {
    const dialog = new Dialog({
      title: "Confirm Paid AI Generation",
      content: `
<p><strong>Monthly Usage:</strong> ${usageCount}/${usageLimit}</p>
<p><strong>Compiled Prompt:</strong></p>
<pre>${foundry.utils.escapeHTML(compiledPrompt)}</pre>
      `,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-check"></i>',
          label: "Confirm Paid Generation",
          callback: () => resolve(true)
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => resolve(false)
        }
      },
      default: "cancel",
      close: () => resolve(false)
    });
    dialog.render(true);
  });
}

/**
 * Build a simple SVG data URI as local placeholder background.
 */
function buildMockMapBackgroundDataUri(options = {}) {
  const size = 1024;
  const seed = String(options.seed ?? "mock");
  const colorA = "#2f3e46";
  const colorB = "#1f2a30";
  const colorC = "#4f6d7a";
  const label = `SceneForge Mock ${seed}`.replace(/&/g, "&amp;");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${colorA}" />
      <stop offset="100%" stop-color="${colorB}" />
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M64 0 L0 0 0 64" fill="none" stroke="${colorC}" stroke-opacity="0.2" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)" />
  <rect width="${size}" height="${size}" fill="url(#grid)" />
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 5}" fill="${colorC}" fill-opacity="0.2" />
  <text x="${size / 2}" y="${size - 40}" text-anchor="middle" font-size="26" fill="#d9e4ea" fill-opacity="0.85">${label}</text>
</svg>
  `.trim();

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Render detected values in the dialog so users can review before generating.
 */
function renderDetectedResults(dialogHtml, detected) {
  const form = dialogHtml.find(".sceneforge-form");
  const content = dialogHtml.find(".sceneforge-detected-content");
  const matchedKeywords = detected.matchedKeywords ?? { theme: [], lighting: [], features: [] };
  const enabledFeatures = FEATURE_KEYS.filter((key) => detected.features[key]);
  const featureListHtml = enabledFeatures.length > 0
    ? enabledFeatures.map((key) => `<li>${foundry.utils.escapeHTML(formatFeatureLabel(key, detected.features))}</li>`).join("")
    : "<li>No specific feature keywords detected.</li>";

  const highlightedPrompt = buildPromptHighlightHtml(String(form.find('[name="prompt"]').val() ?? ""), matchedKeywords);
  const themeDebug = formatMatchedKeywordList(matchedKeywords.theme);
  const lightingDebug = formatMatchedKeywordList(matchedKeywords.lighting);
  const featureDebug = formatMatchedKeywordList(matchedKeywords.features);

  content.html(`
    <p><strong>Theme:</strong> ${foundry.utils.escapeHTML(formatThemeLabel(detected.theme))}</p>
    <p><strong>Lighting Mood:</strong> ${foundry.utils.escapeHTML(LIGHTING_MOOD_LABELS[detected.lightingMood] ?? "Dim")}</p>
    <p><strong>Suggested Size:</strong> ${foundry.utils.escapeHTML(formatSceneSizeLabel(detected.suggestedSize))}</p>
    <p><strong>Detected Features:</strong></p>
    <ul>${featureListHtml}</ul>
    <p><strong>Keyword Highlights:</strong></p>
    <div class="sceneforge-highlight-preview">${highlightedPrompt}</div>
    <div class="sceneforge-debug-lines">
      <p><strong>Theme:</strong> ${foundry.utils.escapeHTML(themeDebug)}</p>
      <p><strong>Lighting:</strong> ${foundry.utils.escapeHTML(lightingDebug)}</p>
      <p><strong>Features:</strong> ${foundry.utils.escapeHTML(featureDebug)}</p>
    </div>
  `);
}

/**
 * Build a detection payload with features disabled.
 * Used when "Use Detected Settings" is OFF.
 */
function buildDisabledDetectedPayload(detected) {
  const disabledFeatures = {
    sideRoomsCount: detected?.features?.sideRoomsCount ?? 2
  };
  for (const key of FEATURE_KEYS) {
    disabledFeatures[key] = false;
  }

  return {
    ...detected,
    features: disabledFeatures
  };
}

/**
 * Format a comma-separated keyword list for debug lines.
 */
function formatMatchedKeywordList(keywords) {
  if (!keywords || keywords.length === 0) return "none";
  return keywords.join(", ");
}

/**
 * Remove duplicate keyword strings while preserving original order.
 */
function dedupeKeywords(keywords) {
  const seen = new Set();
  const result = [];
  for (const keyword of keywords) {
    const normalized = String(keyword ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(keyword);
  }
  return result;
}

/**
 * Highlight matched keyword text in the original prompt preview.
 * Uses separate classes for theme / lighting / feature categories.
 */
function buildPromptHighlightHtml(prompt, matchedKeywords) {
  if (!prompt) return '<span class="notes">No prompt entered.</span>';

  const ranges = [
    ...buildKeywordRanges(prompt, matchedKeywords?.theme ?? [], "sceneforge-hl-theme"),
    ...buildKeywordRanges(prompt, matchedKeywords?.lighting ?? [], "sceneforge-hl-lighting"),
    ...buildKeywordRanges(prompt, matchedKeywords?.features ?? [], "sceneforge-hl-feature")
  ];

  // Sort ranges and drop overlaps to keep resulting HTML predictable.
  ranges.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const nonOverlapping = [];
  let cursor = -1;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    nonOverlapping.push(range);
    cursor = range.end;
  }

  if (nonOverlapping.length === 0) {
    return foundry.utils.escapeHTML(prompt);
  }

  let result = "";
  let index = 0;
  for (const range of nonOverlapping) {
    result += foundry.utils.escapeHTML(prompt.slice(index, range.start));
    const matchedText = foundry.utils.escapeHTML(prompt.slice(range.start, range.end));
    result += `<span class="${range.className}">${matchedText}</span>`;
    index = range.end;
  }
  result += foundry.utils.escapeHTML(prompt.slice(index));
  return result;
}

/**
 * Find all case-insensitive ranges for each keyword inside prompt text.
 */
function buildKeywordRanges(prompt, keywords, className) {
  const textLower = prompt.toLowerCase();
  const ranges = [];

  for (const rawKeyword of keywords) {
    const keyword = String(rawKeyword ?? "").trim().toLowerCase();
    if (!keyword) continue;

    let searchIndex = 0;
    while (searchIndex < textLower.length) {
      const start = textLower.indexOf(keyword, searchIndex);
      if (start === -1) break;
      const end = start + keyword.length;
      ranges.push({ start, end, className });
      searchIndex = end;
    }
  }

  return ranges;
}

/**
 * Regenerate a scene from previously saved scene flags.
 */
async function regenerateSceneFromFlags(scene) {
  const generationData = scene.getFlag(MODULE_ID, FLAG_GENERATION_KEY);
  if (!generationData) {
    ui.notifications.warn("SceneForge AI: This scene has no saved generation data.");
    return;
  }

  try {
    await generateSceneLayout(scene, generationData, { isRegeneration: true });
    ui.notifications.info(`SceneForge AI: Cleared SceneForge-generated overlays for "${scene.name}".`);
  } catch (error) {
    console.error(`${MODULE_ID} | Scene regeneration failed`, error);
    ui.notifications.error("SceneForge AI: Failed to regenerate layout. Check browser console.");
  }
}

/**
 * Export a generated SceneForge scene as a reusable JSON preset file.
 */
async function exportScenePreset(scene) {
  const generationData = scene.getFlag(MODULE_ID, FLAG_GENERATION_KEY);
  if (!generationData) {
    ui.notifications.warn("SceneForge AI: This scene has no SceneForge generation data to export.");
    return;
  }

  const preset = buildScenePresetPayload(scene, generationData);
  const filename = `sceneforge-preset-${slugifyFilename(scene.name)}.json`;
  downloadJsonFile(preset, filename);
  ui.notifications.info(`SceneForge AI: Exported preset "${filename}".`);
}

/**
 * Ask user for a preset JSON file, validate it, and generate a new scene from it.
 */
async function promptImportPresetFile() {
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";

  fileInput.addEventListener("change", async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) return;

      const text = await file.text();
      let rawPreset;
      try {
        rawPreset = JSON.parse(text);
      } catch (_error) {
        ui.notifications.error("SceneForge AI: Invalid preset JSON. Could not parse file.");
        return;
      }

      const validation = validateImportedPreset(rawPreset);
      if (!validation.ok) {
        ui.notifications.error(`SceneForge AI: Invalid preset - ${validation.error}`);
        return;
      }

      const missingPacks = getMissingPresetPacks(validation.generationData);
      debugLog("Preset import pack check", {
        required: validation.generationData.enabledAssetPacks,
        missing: missingPacks
      });
      let importWithMissingPacks = false;
      if (missingPacks.length > 0) {
        const shouldImport = await promptMissingPacksWarningDialog(missingPacks);
        if (!shouldImport) return;
        importWithMissingPacks = true;

        // Fallback behavior: use only packs currently enabled in this world.
        validation.generationData.enabledAssetPacks = validation.generationData.enabledAssetPacks
          .filter((packId) => !missingPacks.includes(packId));
      }

      await importPresetAsNewScene(validation.generationData, validation.sourceVersion, {
        missingPacks: importWithMissingPacks ? missingPacks : []
      });
      ui.notifications.info("SceneForge AI: Preset imported successfully.");
    } catch (error) {
      console.error(`${MODULE_ID} | Preset import failed`, error);
      ui.notifications.error("SceneForge AI: Failed to import preset. See console for details.");
    }
  });

  fileInput.click();
}

/**
 * If a preset needs packs that are not enabled, ask whether to continue.
 */
function promptMissingPacksWarningDialog(missingPacks) {
  return new Promise((resolve) => {
    const listHtml = missingPacks.map((id) => `<li>${foundry.utils.escapeHTML(id)}</li>`).join("");
    const dialog = new Dialog({
      title: "SceneForge Preset Warning",
      content: `
<p>This preset was built with packs you do not currently have enabled.</p>
<p><strong>Missing Packs:</strong></p>
<ul>${listHtml}</ul>
<p>You can import anyway and SceneForge will use fallback base assets for missing premium content.</p>
      `,
      buttons: {
        importAnyway: {
          icon: '<i class="fas fa-check"></i>',
          label: "Import Anyway",
          callback: () => resolve(true)
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => resolve(false)
        }
      },
      default: "cancel",
      close: () => resolve(false)
    });
    dialog.render(true);
  });
}

/**
 * Build a portable preset payload that can be shared or published.
 */
function buildScenePresetPayload(scene, generationData) {
  return {
    presetType: "SceneForgePreset",
    presetSchemaVersion: "1.0.0",
    version: generationData.moduleVersion ?? "0.21.0",
    exportedAt: new Date().toISOString(),
    sceneName: scene.name,
    generationMode: generationData.generationMode ?? "ai-image-only",
    prompt: generationData.prompt,
    theme: generationData.theme,
    size: generationData.sceneSizeKey,
    sceneSizeKey: generationData.sceneSizeKey,
    seed: generationData.seed,
    lightingMood: generationData.lightingMood ?? "dim",
    aiPlan: generationData.aiPlan ?? null,
    layoutGraph: generationData.layoutGraph ?? null,
    compiledImagePrompt: generationData.compiledImagePrompt ?? null,
    imageGeneration: generationData.imageGeneration ?? null,
    detected: generationData.detected ?? null,
    detectedFeatures: generationData.detected?.features ?? null,
    useDetectedSettings: generationData.useDetectedSettings !== false,
    enabledAssetPacks: Array.isArray(generationData.enabledAssetPacks) ? generationData.enabledAssetPacks : [],
    generationLayers: generationData.generationLayers ?? ["walls", "floor-assets", "props", "lighting", "notes"],
    generationMetadata: collectGeneratedDocumentMetadata(scene),
    generationData
  };
}

/**
 * Capture generated wall/tile/light/note metadata for export debugging and sharing.
 */
function collectGeneratedDocumentMetadata(scene) {
  const mapGeneratedDocs = (collection, mapper) => collection
    .filter((doc) => doc.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true)
    .map(mapper);

  return {
    walls: mapGeneratedDocs(scene.walls, (doc) => ({
      c: doc.c,
      flags: doc.flags?.[MODULE_ID] ?? {}
    })),
    tiles: mapGeneratedDocs(scene.tiles, (doc) => ({
      x: doc.x,
      y: doc.y,
      width: doc.width,
      height: doc.height,
      src: doc.texture?.src ?? "",
      flags: doc.flags?.[MODULE_ID] ?? {}
    })),
    lights: mapGeneratedDocs(scene.lights, (doc) => ({
      x: doc.x,
      y: doc.y,
      config: {
        bright: doc.config?.bright,
        dim: doc.config?.dim,
        color: doc.config?.color,
        animation: doc.config?.animation?.type ?? "none"
      },
      flags: doc.flags?.[MODULE_ID] ?? {}
    })),
    notes: mapGeneratedDocs(scene.notes, (doc) => ({
      x: doc.x,
      y: doc.y,
      text: doc.text ?? "",
      flags: doc.flags?.[MODULE_ID] ?? {}
    }))
  };
}

/**
 * Validate imported JSON and normalize it into generationData shape.
 */
function validateImportedPreset(rawPreset) {
  if (!rawPreset || typeof rawPreset !== "object") {
    return { ok: false, error: "Preset must be a JSON object." };
  }

  const sourceVersion = String(rawPreset.version ?? rawPreset.generationData?.moduleVersion ?? "unknown");
  const generationMode = String(rawPreset.generationMode ?? rawPreset.generationData?.generationMode ?? "ai-image-only");
  const prompt = String(rawPreset.prompt ?? rawPreset.generationData?.prompt ?? "").trim();
  const theme = "ai-map";
  const sceneSizeKey = "medium";
  const seed = String(rawPreset.seed ?? rawPreset.generationData?.seed ?? "").trim();
  const lightingMood = "dim";

  if (!prompt) return { ok: false, error: "Missing prompt." };
  if (!seed) return { ok: false, error: "Missing seed." };
  const compiledImagePrompt = rawPreset.compiledImagePrompt
    ?? rawPreset.generationData?.compiledImagePrompt
    ?? compileInkarnatePrompt(prompt);
  const detected = null;
  const aiPlan = null;
  const layoutGraph = null;
  const imageGeneration = rawPreset.imageGeneration
    ?? rawPreset.generationData?.imageGeneration
    ?? {
      provider: getAiImageProvider(),
      compiledPrompt: compiledImagePrompt ?? "",
      imageStatus: "not-requested",
      imagePath: null,
      costEstimate: null
    };

  const useDetectedSettings = false;
  const enabledAssetPacks = [];
  const effectiveDetected = null;

  const generationData = {
    generationMode,
    prompt,
    sceneSizeKey,
    theme,
    lightingMood,
    detected,
    useDetectedSettings: useDetectedSettings !== false,
    effectiveDetected,
    aiPlan,
    layoutGraph,
    compiledImagePrompt,
    imageGeneration,
    enabledAssetPacks: Array.isArray(enabledAssetPacks) ? enabledAssetPacks.filter((v) => typeof v === "string") : [],
    generationLayers: ["background-image"],
    seed,
    moduleVersion: "0.21.0"
  };

  return {
    ok: true,
    sourceVersion,
    generationData
  };
}

/**
 * Create a new scene from normalized preset data and generate full layout.
 */
async function importPresetAsNewScene(generationData, sourceVersion = "unknown", options = {}) {
  const { missingPacks = [] } = options;
  const gridCells = SCENE_SIZES[generationData.sceneSizeKey] ?? SCENE_SIZES.medium;
  const gridPixelSize = getSceneGridPixelSize(generationData.sceneSizeKey);
  const widthPx = gridCells * gridPixelSize;
  const heightPx = gridCells * gridPixelSize;
  const mapCoverageMeters = Number(generationData.mapCoverageMeters ?? getMapCoverageMeters(generationData.sceneSizeKey));
  const metersPerGrid = Math.max(0.1, mapCoverageMeters / Math.max(1, gridCells));
  const sceneName = `SceneForge Preset - ${formatThemeLabel(generationData.theme)} - ${generationData.seed}`;

  const scenePayload = {
    name: sceneName,
    width: widthPx,
    height: heightPx,
    padding: 0.1,
    grid: {
      type: CONST.GRID_TYPES.SQUARE,
      size: gridPixelSize,
      distance: metersPerGrid,
      units: "m"
    },
    backgroundColor: DEFAULT_SCENE_BACKGROUND_COLOR,
    navigation: true,
    flags: {
      [MODULE_ID]: {
        [FLAG_GENERATION_KEY]: {
          ...generationData,
          importedFromPresetVersion: sourceVersion,
          missingPresetPacks: missingPacks
        }
      }
    }
  };
  const scene = await safeSceneCreate(scenePayload, "importPresetAsNewScene.Scene.create");

  if (!scene) {
    throw new Error("Failed to create scene during preset import.");
  }

  await generateSceneLayout(scene, generationData);

  if (missingPacks.length > 0) {
    ui.notifications.warn(`SceneForge AI: Imported preset references missing packs (${missingPacks.join(", ")}).`);
  }
}

/**
 * If import proceeds without required packs, drop a warning journal note in scene.
 */
async function createMissingPackWarningJournalNote(scene, missingPacks) {
  if (!ENABLE_JOURNALS_AND_NOTES) return;

  const content = `
<h2>SceneForge Import Warning</h2>
<p>This preset was built with asset packs not currently enabled:</p>
<ul>${missingPacks.map((id) => `<li>${foundry.utils.escapeHTML(id)}</li>`).join("")}</ul>
<p>SceneForge imported anyway and used base/fallback assets where premium assets were missing.</p>
  `.trim();

  const journalPayload = {
    name: `SceneForge Warning - ${scene.name}`,
    pages: [
      {
        name: "Missing Asset Packs",
        type: "text",
        text: {
          format: 1,
          content
        }
      }
    ],
    flags: {
      [MODULE_ID]: {
        [FLAG_GENERATED_KEY]: true,
        sceneId: scene.id,
        warningType: "missing-packs"
      }
    }
  };
  const journal = await safeJournalEntryCreate(journalPayload, "createMissingPackWarningJournalNote.JournalEntry.create");

  const firstPage = journal?.pages?.contents?.[0];
  if (!firstPage) return;

  await safeEmbeddedCreate(scene, "Note", [
    {
      x: Math.floor(scene.width * 0.2),
      y: Math.floor(scene.height * 0.2),
      entryId: journal.id,
      pageId: firstPage.id,
      iconSize: 40,
      text: "SceneForge Missing Packs Warning",
      flags: {
        [MODULE_ID]: {
          [FLAG_GENERATED_KEY]: true,
          kind: "note",
          noteType: "missing-packs-warning"
        }
      }
    }
  ], "createMissingPackWarningJournalNote.Note.createEmbeddedDocuments");
}

/**
 * Download helper that supports Foundry's saveDataToFile utility.
 */
function downloadJsonFile(data, filename) {
  const jsonText = JSON.stringify(data, null, 2);
  if (typeof saveDataToFile === "function") {
    saveDataToFile(jsonText, "application/json", filename);
    return;
  }

  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Convert scene names into safe filenames.
 */
function slugifyFilename(name) {
  return String(name ?? "scene")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "scene";
}

/**
 * Legacy regeneration entrypoint.
 * In image-only mode, it only normalizes scene grid metadata and clears
 * any previously generated SceneForge overlays (walls/lights/tiles/notes/journals).
 */
async function generateSceneLayout(scene, generationData, options = {}) {
  void options;

  const prompt = String(generationData.prompt ?? "").trim();
  const sceneSizeKey = "medium";
  const theme = "ai-map";
  const lightingMood = "dim";
  const seed = String(generationData.seed ?? randomSeedString());
  const detected = null;
  const useDetectedSettings = false;
  const effectiveDetected = null;

  const gridCells = SCENE_SIZES[sceneSizeKey] ?? SCENE_SIZES.medium;
  const gridPixelSize = getSceneGridPixelSize(sceneSizeKey);
  const widthPx = gridCells * gridPixelSize;
  const heightPx = gridCells * gridPixelSize;
  const mapCoverageMeters = getMapCoverageMeters(sceneSizeKey);
  const metersPerGrid = Math.max(0.1, mapCoverageMeters / Math.max(1, gridCells));

  // Keep scene settings aligned with saved generation options every regeneration.
  await scene.update({
    width: widthPx,
    height: heightPx,
    grid: {
      type: CONST.GRID_TYPES.SQUARE,
      size: gridPixelSize,
      distance: metersPerGrid,
      units: "m"
    },
    backgroundColor: DEFAULT_SCENE_BACKGROUND_COLOR
  });

  await clearGeneratedContent(scene);
  const generationLayers = ["background-image"];

  await scene.setFlag(MODULE_ID, FLAG_GENERATION_KEY, {
    generationMode: generationData.generationMode ?? "ai-image-only",
    prompt,
    sceneSizeKey,
    theme,
    lightingMood,
    detected,
    useDetectedSettings,
    effectiveDetected,
    aiPlan: generationData.aiPlan ?? null,
    layoutGraph: generationData.layoutGraph ?? null,
    compiledImagePrompt: generationData.compiledImagePrompt ?? null,
    imageGeneration: generationData.imageGeneration ?? {
      provider: getAiImageProvider(),
      compiledPrompt: generationData.compiledImagePrompt ?? "",
      imageStatus: "not-requested",
      imagePath: null,
      costEstimate: null
    },
    enabledAssetPacks: [],
    generationLayers,
    seed,
    moduleVersion: "0.21.0",
    lastGeneratedAt: Date.now()
  });

  if (generationData.imageGeneration) {
    await scene.setFlag(MODULE_ID, FLAG_IMAGE_GENERATION_KEY, generationData.imageGeneration);
  }
}

/**
 * Remove only SceneForge-owned generated documents from this scene:
 *  - walls
 *  - ambient lights
 *  - notes
 * Also remove SceneForge journals linked to this scene to avoid orphan notes.
 */
async function clearGeneratedContent(scene) {
  const wallIds = scene.walls
    .filter((doc) => doc.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true)
    .map((doc) => doc.id);
  if (wallIds.length > 0) {
    await scene.deleteEmbeddedDocuments("Wall", wallIds);
  }

  const lightIds = scene.lights
    .filter((doc) => doc.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true)
    .map((doc) => doc.id);
  if (lightIds.length > 0) {
    await scene.deleteEmbeddedDocuments("AmbientLight", lightIds);
  }

  const tileIds = scene.tiles
    .filter((doc) => doc.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true)
    .map((doc) => doc.id);
  if (tileIds.length > 0) {
    await scene.deleteEmbeddedDocuments("Tile", tileIds);
  }

  const noteIds = scene.notes
    .filter((doc) => doc.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true)
    .map((doc) => doc.id);
  if (noteIds.length > 0) {
    await scene.deleteEmbeddedDocuments("Note", noteIds);
  }

  const generatedJournalIds = game.journal
    .filter((doc) => doc.getFlag(MODULE_ID, FLAG_GENERATED_KEY) === true && doc.getFlag(MODULE_ID, "sceneId") === scene.id)
    .map((doc) => doc.id);
  if (generatedJournalIds.length > 0) {
    await JournalEntry.deleteDocuments(generatedJournalIds);
  }
}

/**
 * Build themed walls with deterministic variation.
 * Each theme has multiple variant patterns selected by seeded RNG.
 */
function buildThemeWalls(theme, widthPx, heightPx, rng, seed, detected) {
  const walls = [];
  const features = detected?.features ?? {};

  const wallDefaults = {
    move: WALL_NORMAL,
    sight: WALL_NORMAL,
    sound: WALL_NORMAL,
    door: WALL_DOOR_NONE,
    ds: WALL_DOOR_CLOSED
  };

  const baseFlags = {
    [MODULE_ID]: {
      [FLAG_GENERATED_KEY]: true,
      kind: "wall",
      seed
    }
  };

  const pushWall = (x1, y1, x2, y2) => {
    walls.push({
      c: [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)],
      ...wallDefaults,
      flags: baseFlags
    });
  };

  const cx = Math.floor(widthPx / 2);
  const cy = Math.floor(heightPx / 2);
  const margin = Math.floor(GRID_SIZE_PX * 1.5);

  // Standard outer boundary walls.
  pushWall(0, 0, widthPx, 0);
  pushWall(widthPx, 0, widthPx, heightPx);
  pushWall(widthPx, heightPx, 0, heightPx);
  pushWall(0, heightPx, 0, 0);

  /**
   * Helper: create small "pillar" squares from 4 wall segments.
   */
  const addPillarSquare = (x, y, size) => {
    pushWall(x - size, y - size, x + size, y - size);
    pushWall(x + size, y - size, x + size, y + size);
    pushWall(x + size, y + size, x - size, y + size);
    pushWall(x - size, y + size, x - size, y - size);
  };

  /**
   * Helper: adds a rectangular room quickly.
   */
  const addRoomRectangle = (left, top, right, bottom) => {
    pushWall(left, top, right, top);
    pushWall(right, top, right, bottom);
    pushWall(right, bottom, left, bottom);
    pushWall(left, bottom, left, top);
  };

  if (theme === "tavern") {
    // Requirement coverage: rooms, bar area, storage room, fireplace area.
    const variant = randomInt(rng, 0, 2);
    const left = margin + randomInt(rng, 0, 120);
    const right = widthPx - margin - randomInt(rng, 0, 120);
    const top = margin + randomInt(rng, 0, 100);
    const bottom = heightPx - margin - randomInt(rng, 0, 100);

    // Main hall boundary inside the outer walls.
    addRoomRectangle(left, top, right, bottom);

    // Bar area as a U-shape.
    const barY = top + (variant === 0 ? 260 : 340);
    pushWall(left + 220, barY, left + 780, barY);
    pushWall(left + 220, barY, left + 220, barY + 220);
    pushWall(left + 780, barY, left + 780, barY + 220);

    // Storage room back corner.
    const storageW = 360 + variant * 60;
    const storageH = 320;
    pushWall(right - storageW, top + 40, right - 20, top + 40);
    pushWall(right - 20, top + 40, right - 20, top + storageH);
    pushWall(right - 20, top + storageH, right - storageW, top + storageH);

    // Fireplace area as a boxed alcove.
    const fireX = variant === 2 ? left + 260 : right - 260;
    pushWall(fireX - 130, bottom - 220, fireX + 130, bottom - 220);
    pushWall(fireX - 130, bottom - 220, fireX - 130, bottom - 80);
    pushWall(fireX + 130, bottom - 220, fireX + 130, bottom - 80);
  } else if (theme === "cave") {
    // Requirement coverage: irregular chambers, tunnels, dead ends.
    const chamberCount = randomInt(rng, 3, 4);
    const chamberCenters = [];

    for (let i = 0; i < chamberCount; i += 1) {
      const x = randomInt(rng, margin + 300, widthPx - margin - 300);
      const y = randomInt(rng, margin + 250, heightPx - margin - 250);
      const radius = randomInt(rng, 180, 280);
      chamberCenters.push({ x, y, radius });

      // Approximate "organic" chamber by an uneven polygon ring.
      const points = [];
      const vertices = randomInt(rng, 6, 8);
      for (let v = 0; v < vertices; v += 1) {
        const angle = (Math.PI * 2 * v) / vertices;
        const jitter = randomInt(rng, -60, 60);
        const r = radius + jitter;
        points.push({
          x: x + Math.cos(angle) * r,
          y: y + Math.sin(angle) * r
        });
      }
      for (let v = 0; v < points.length; v += 1) {
        const next = (v + 1) % points.length;
        pushWall(points[v].x, points[v].y, points[next].x, points[next].y);
      }
    }

    // Connect chambers with rough tunnels.
    for (let i = 0; i < chamberCenters.length - 1; i += 1) {
      const a = chamberCenters[i];
      const b = chamberCenters[i + 1];
      const midX = (a.x + b.x) / 2 + randomInt(rng, -120, 120);
      const midY = (a.y + b.y) / 2 + randomInt(rng, -120, 120);
      pushWall(a.x, a.y, midX, midY);
      pushWall(midX, midY, b.x, b.y);
    }

    // Add one or two dead-end tunnel branches.
    const deadEnds = randomInt(rng, 1, 2);
    for (let i = 0; i < deadEnds; i += 1) {
      const start = chamberCenters[randomInt(rng, 0, chamberCenters.length - 1)];
      const endX = start.x + randomInt(rng, -300, 300);
      const endY = start.y + randomInt(rng, -300, 300);
      pushWall(start.x, start.y, endX, endY);
    }
  } else if (theme === "forest-ruins") {
    // Requirement coverage: broken outer walls, pillars, altar/boss area.
    const left = cx - 900;
    const right = cx + 900;
    const top = cy - 650;
    const bottom = cy + 650;

    // Broken outer walls: segments with intentional gaps.
    const gap = 220 + randomInt(rng, -50, 50);
    pushWall(left, top, cx - gap, top);
    pushWall(cx + gap, top, right, top);
    pushWall(right, top, right, cy - gap);
    pushWall(right, cy + gap, right, bottom);
    pushWall(right, bottom, cx + gap, bottom);
    pushWall(cx - gap, bottom, left, bottom);
    pushWall(left, bottom, left, cy + gap);
    pushWall(left, cy - gap, left, top);

    // Altar/boss platform area near the north side.
    const altarTop = top + 180;
    pushWall(cx - 260, altarTop, cx + 260, altarTop);
    pushWall(cx - 260, altarTop, cx - 260, altarTop + 180);
    pushWall(cx + 260, altarTop, cx + 260, altarTop + 180);
    pushWall(cx - 260, altarTop + 180, cx + 260, altarTop + 180);

    // Pillars in a rough grid with minor jitter.
    for (let row = 0; row < 2; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        const px = cx - 540 + col * 360 + randomInt(rng, -28, 28);
        const py = cy - 180 + row * 360 + randomInt(rng, -28, 28);
        addPillarSquare(px, py, 28);
      }
    }
  } else {
    // Dungeon requirement coverage: corridors, cells, central chamber, side rooms.
    const variant = randomInt(rng, 0, 2);
    const chamberHalfW = 420 + randomInt(rng, -80, 80);
    const chamberHalfH = 320 + randomInt(rng, -60, 60);

    // Central chamber.
    pushWall(cx - chamberHalfW, cy - chamberHalfH, cx + chamberHalfW, cy - chamberHalfH);
    pushWall(cx + chamberHalfW, cy - chamberHalfH, cx + chamberHalfW, cy + chamberHalfH);
    pushWall(cx + chamberHalfW, cy + chamberHalfH, cx - chamberHalfW, cy + chamberHalfH);
    pushWall(cx - chamberHalfW, cy + chamberHalfH, cx - chamberHalfW, cy - chamberHalfH);

    // Main corridors branching north/south.
    pushWall(cx, margin, cx, cy - chamberHalfH);
    pushWall(cx, cy + chamberHalfH, cx, heightPx - margin);

    // Cells along one side (vertical separators).
    const cellBaseX = variant === 0 ? cx - chamberHalfW - 320 : cx + chamberHalfW + 320;
    const cellTop = cy - 420;
    const cellBottom = cy + 420;
    pushWall(cellBaseX - 180, cellTop, cellBaseX + 180, cellTop);
    pushWall(cellBaseX + 180, cellTop, cellBaseX + 180, cellBottom);
    pushWall(cellBaseX + 180, cellBottom, cellBaseX - 180, cellBottom);
    pushWall(cellBaseX - 180, cellBottom, cellBaseX - 180, cellTop);
    pushWall(cellBaseX - 60, cellTop, cellBaseX - 60, cellBottom);
    pushWall(cellBaseX + 60, cellTop, cellBaseX + 60, cellBottom);

    // Side rooms connected to central area.
    const roomOffsetY = 520;
    pushWall(cx - 760, cy - roomOffsetY - 220, cx - 360, cy - roomOffsetY - 220);
    pushWall(cx - 360, cy - roomOffsetY - 220, cx - 360, cy - roomOffsetY + 180);
    pushWall(cx - 360, cy - roomOffsetY + 180, cx - 760, cy - roomOffsetY + 180);
    pushWall(cx - 760, cy - roomOffsetY + 180, cx - 760, cy - roomOffsetY - 220);

    pushWall(cx + 360, cy + roomOffsetY - 180, cx + 760, cy + roomOffsetY - 180);
    pushWall(cx + 760, cy + roomOffsetY - 180, cx + 760, cy + roomOffsetY + 220);
    pushWall(cx + 760, cy + roomOffsetY + 220, cx + 360, cy + roomOffsetY + 220);
    pushWall(cx + 360, cy + roomOffsetY + 220, cx + 360, cy + roomOffsetY - 180);
  }

  // Feature influence: add pillars in any theme if prompt asks for pillars.
  if (features.pillars) {
    const pillarCount = randomInt(rng, 3, 5);
    for (let i = 0; i < pillarCount; i += 1) {
      const px = randomInt(rng, margin + 240, widthPx - margin - 240);
      const py = randomInt(rng, margin + 220, heightPx - margin - 220);
      addPillarSquare(px, py, 24);
    }
  }

  // Feature influence: extra side rooms when prompt asks for side rooms.
  if (features.sideRooms) {
    const sideRoomCount = Math.max(2, Number(features.sideRoomsCount ?? 2));
    for (let i = 0; i < sideRoomCount; i += 1) {
      const isLeft = i % 2 === 0;
      const offsetY = -300 + i * 260;
      const roomLeft = isLeft ? margin + 40 : widthPx - margin - 380;
      const roomRight = roomLeft + 340;
      const roomTop = cy + offsetY;
      const roomBottom = roomTop + 220;
      addRoomRectangle(roomLeft, roomTop, roomRight, roomBottom);
      // Small corridor connector toward center.
      const connectX1 = isLeft ? roomRight : roomLeft;
      const connectX2 = isLeft ? cx - 180 : cx + 180;
      const connectY = roomTop + 110;
      pushWall(connectX1, connectY, connectX2, connectY);
    }
  }

  // Feature influence: hidden room layout (small off-center chamber).
  if (features.hiddenRoom) {
    const hiddenLeft = widthPx - margin - 360;
    const hiddenTop = margin + 120;
    addRoomRectangle(hiddenLeft, hiddenTop, hiddenLeft + 260, hiddenTop + 220);
    // "False wall" segment nearby to suggest a secret access.
    pushWall(hiddenLeft - 140, hiddenTop + 110, hiddenLeft - 30, hiddenTop + 110);
  }

  return walls;
}

/**
 * Build floor + prop tiles using modular registry rules.
 * This is intentionally data-driven so future premium packs can swap sources.
 */
function buildThemeTiles(theme, widthPx, heightPx, walls, rng, seed, detected, enabledPackIds = null) {
  const registryThemeKey = normalizeThemeToRegistryKey(theme);
  const activeRegistry = getActiveAssetRegistry(enabledPackIds);
  const assetEntries = activeRegistry[registryThemeKey] ?? [];
  const contexts = buildPlacementContexts(registryThemeKey, widthPx, heightPx);
  const occupied = [];
  const floorTiles = [];
  const propTiles = [];

  for (const asset of assetEntries) {
    // Rarity controls uniqueness: rare assets only appear occasionally.
    if (!shouldSpawnAsset(asset, rng, detected)) continue;

    const countMin = asset.count?.[0] ?? 1;
    const countMax = asset.count?.[1] ?? countMin;
    const targetCount = randomInt(rng, countMin, countMax);

    let createdForAsset = 0;
    const maxAttempts = Math.max(8, targetCount * 10);
    for (let attempt = 0; attempt < maxAttempts && createdForAsset < targetCount; attempt += 1) {
      const candidate = getPlacementCandidate(asset, contexts, widthPx, heightPx, rng, detected);
      if (!candidate) continue;

      const rect = {
        x: candidate.x,
        y: candidate.y,
        w: asset.width,
        h: asset.height
      };

      // Collision rule 1: no asset overlap with already placed assets.
      if (!isRectPlacementValid(rect, occupied, 12)) continue;

      // Collision rule 2: avoid wall overlap unless this is explicitly a wall-near item.
      const allowNearWalls = asset.placement === "wall-near";
      if (!allowNearWalls && rectOverlapsWalls(rect, walls, 8)) continue;

      occupied.push(rect);
      const tileData = buildTileDataFromAsset(asset, candidate.x, candidate.y, rng, seed);
      if (asset.layer === "floor") floorTiles.push(tileData);
      else propTiles.push(tileData);
      createdForAsset += 1;
    }
  }

  return { floorTiles, propTiles };
}

/**
 * Converts a requested theme key into the asset registry key naming style.
 */
function normalizeThemeToRegistryKey(theme) {
  if (theme === "forest-ruins") return "forestRuins";
  return theme;
}

/**
 * Convert registry key back to scene-facing theme key for metadata flags.
 */
function normalizeRegistryThemeToSceneTheme(registryThemeKey) {
  if (registryThemeKey === "forestRuins") return "forest-ruins";
  return registryThemeKey;
}

/**
 * Spawn chance rules by rarity plus feature hints.
 */
function shouldSpawnAsset(asset, rng, detected) {
  if (asset.rarity === "rare") {
    // Requirement: rare assets are about 10% chance.
    return rng() <= 0.1;
  }

  // Common assets are likely, but not guaranteed, to keep output varied.
  let baseChance = 0.82;

  // Feature-aware boosts for relevant assets.
  if (asset.id.includes("altar") && detected?.features?.altar) baseChance = 1;
  if (asset.id.includes("broken-pillar") && detected?.features?.pillars) baseChance = 1;
  if (asset.id.includes("prison-cell") && detected?.features?.cells) baseChance = 1;
  if (asset.id.includes("bar-counter") && detected?.features?.bar) baseChance = 1;
  if (asset.id.includes("water-pool") && detected?.features?.water) baseChance = 1;

  return rng() <= baseChance;
}

/**
 * Prepare high-level placement zones for each theme.
 * These zones are used so beds go in room-like spaces, altars center, etc.
 */
function buildPlacementContexts(themeKey, widthPx, heightPx) {
  const margin = 220;
  const cx = Math.floor(widthPx / 2);
  const cy = Math.floor(heightPx / 2);
  const defaultRoom = {
    x1: margin,
    y1: margin,
    x2: widthPx - margin,
    y2: heightPx - margin
  };

  const base = {
    center: { x: cx, y: cy },
    rooms: [defaultRoom],
    upstairs: [
      {
        x1: margin + 80,
        y1: margin,
        x2: widthPx - margin - 80,
        y2: cy - 140
      }
    ],
    wallBands: {
      top: { x1: margin, y1: 80, x2: widthPx - margin, y2: 220 },
      bottom: { x1: margin, y1: heightPx - 220, x2: widthPx - margin, y2: heightPx - 80 },
      left: { x1: 80, y1: margin, x2: 220, y2: heightPx - margin },
      right: { x1: widthPx - 220, y1: margin, x2: widthPx - 80, y2: heightPx - margin }
    }
  };

  if (themeKey === "tavern") {
    base.rooms = [
      { x1: margin + 40, y1: margin + 60, x2: widthPx - margin - 40, y2: heightPx - margin - 80 }
    ];
  } else if (themeKey === "cave") {
    base.rooms = [
      { x1: margin, y1: margin, x2: cx + 120, y2: cy + 80 },
      { x1: cx - 180, y1: cy - 130, x2: widthPx - margin, y2: heightPx - margin }
    ];
  } else if (themeKey === "forestRuins") {
    base.rooms = [
      { x1: cx - 820, y1: cy - 580, x2: cx + 820, y2: cy + 580 }
    ];
  } else if (themeKey === "dungeon") {
    base.rooms = [
      { x1: cx - 480, y1: cy - 360, x2: cx + 480, y2: cy + 360 },
      { x1: margin + 60, y1: cy - 520, x2: margin + 520, y2: cy - 180 },
      { x1: widthPx - margin - 520, y1: cy + 180, x2: widthPx - margin - 60, y2: cy + 520 }
    ];
  }

  return base;
}

/**
 * Decide candidate tile coordinates for one asset using placement hints.
 */
function getPlacementCandidate(asset, contexts, widthPx, heightPx, rng, detected) {
  const w = asset.width;
  const h = asset.height;
  const placement = asset.placement ?? "random";

  // Center placement supports important landmarks like altar/boss area.
  if (placement === "center") {
    return {
      x: Math.round(contexts.center.x - w / 2),
      y: Math.round(contexts.center.y - h / 2)
    };
  }

  if (placement === "upstairs" && contexts.upstairs.length > 0) {
    const zone = contexts.upstairs[randomInt(rng, 0, contexts.upstairs.length - 1)];
    return randomPositionInZone(zone, w, h, rng);
  }

  if (placement === "room" && contexts.rooms.length > 0) {
    // If prompt asks side rooms, bias some assets into non-primary room zones.
    const prefersSideRoom = detected?.features?.sideRooms && contexts.rooms.length > 1;
    const roomIndex = prefersSideRoom
      ? randomInt(rng, 0, contexts.rooms.length - 1)
      : 0;
    const zone = contexts.rooms[Math.min(roomIndex, contexts.rooms.length - 1)];
    return randomPositionInZone(zone, w, h, rng);
  }

  if (placement === "wall-near") {
    return positionNearWallBand(contexts.wallBands, w, h, rng);
  }

  // Default random placement avoids outer map edge margins.
  const margin = 120;
  return {
    x: randomInt(rng, margin, Math.max(margin, widthPx - margin - w)),
    y: randomInt(rng, margin, Math.max(margin, heightPx - margin - h))
  };
}

/**
 * Random position in a rectangular zone with asset-size clamping.
 */
function randomPositionInZone(zone, width, height, rng) {
  const minX = Math.round(zone.x1);
  const maxX = Math.round(Math.max(zone.x1, zone.x2 - width));
  const minY = Math.round(zone.y1);
  const maxY = Math.round(Math.max(zone.y1, zone.y2 - height));
  return {
    x: randomInt(rng, minX, maxX),
    y: randomInt(rng, minY, maxY)
  };
}

/**
 * Chooses a position near one of the wall-adjacent bands.
 * Great for torches, shelves, chains, etc.
 */
function positionNearWallBand(wallBands, width, height, rng) {
  const sides = ["top", "bottom", "left", "right"];
  const side = sides[randomInt(rng, 0, sides.length - 1)];
  return randomPositionInZone(wallBands[side], width, height, rng);
}

/**
 * Convert asset definition into Foundry v12 tile data.
 */
function buildTileDataFromAsset(asset, x, y, rng, seed) {
  const rotationByPlacement = asset.placement === "random" ? randomInt(rng, 0, 3) * 90 : 0;

  return {
    x,
    y,
    width: asset.width,
    height: asset.height,
    rotation: rotationByPlacement,
    texture: {
      src: asset.src,
      scaleX: 1,
      scaleY: 1
    },
    flags: {
      [MODULE_ID]: {
        [FLAG_GENERATED_KEY]: true,
        kind: "tile",
        layer: asset.layer,
        packId: asset.packId ?? "base",
        assetId: asset.id,
        rarity: asset.rarity ?? "common",
        theme: asset.theme ?? "unknown",
        assetPath: asset.src,
        seed
      }
    }
  };
}

/**
 * True when a candidate rectangle is collision-free against prior placements.
 */
function isRectPlacementValid(candidate, occupied, padding = 0) {
  return !occupied.some((other) => rectsOverlap(candidate, other, padding));
}

/**
 * Axis-aligned rectangle intersection test with optional spacing padding.
 */
function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.w + padding <= b.x
    || b.x + b.w + padding <= a.x
    || a.y + a.h + padding <= b.y
    || b.y + b.h + padding <= a.y
  );
}

/**
 * Checks whether a tile rectangle intersects any generated wall segment bbox.
 */
function rectOverlapsWalls(rect, walls, wallPadding = 0) {
  for (const wall of walls) {
    const c = wall?.c;
    if (!Array.isArray(c) || c.length !== 4) continue;

    const wx1 = Math.min(c[0], c[2]) - wallPadding;
    const wx2 = Math.max(c[0], c[2]) + wallPadding;
    const wy1 = Math.min(c[1], c[3]) - wallPadding;
    const wy2 = Math.max(c[1], c[3]) + wallPadding;
    const wallRect = { x: wx1, y: wy1, w: wx2 - wx1, h: wy2 - wy1 };

    if (rectsOverlap(rect, wallRect, 0)) return true;
  }

  return false;
}

/**
 * Built-in fallback mode for missing placeholder assets.
 * Currently we skip missing-image tiles so scenes stay clean.
 */
async function applyTileFallbackModeToTiles(tiles) {
  if (TILE_FALLBACK_MODE !== "skip-missing") {
    return tiles;
  }

  return filterTilesWithAvailableAssets(tiles);
}

/**
 * Applies fallback handling to layered tile output from buildThemeTiles.
 * Keeps layer merge logic separate from source validation.
 */
async function applyTileFallbackModeToTileLayers(tileLayers) {
  if (!tileLayers || typeof tileLayers !== "object") return [];
  const floorTiles = Array.isArray(tileLayers.floorTiles) ? tileLayers.floorTiles : [];
  const propTiles = Array.isArray(tileLayers.propTiles) ? tileLayers.propTiles : [];
  const mergedTiles = [...floorTiles, ...propTiles];
  return applyTileFallbackModeToTiles(mergedTiles);
}

/**
 * Keep only tiles whose texture source can be fetched by the client.
 * Missing paths are skipped to avoid Foundry warning triangle icons.
 */
async function filterTilesWithAvailableAssets(tiles) {
  const kept = [];
  for (const tile of tiles) {
    const src = tile?.texture?.src;
    const exists = await isAssetPathAvailable(src);
    if (!exists) {
      debugLog("Skipping missing asset:", src);
      continue;
    }
    kept.push(tile);
  }
  return kept;
}

/**
 * Resolve and cache asset path availability.
 */
async function isAssetPathAvailable(src) {
  if (!src || typeof src !== "string") return false;
  if (src.startsWith("data:")) return true;
  if (ASSET_PATH_AVAILABILITY_CACHE.has(src)) {
    return ASSET_PATH_AVAILABILITY_CACHE.get(src);
  }

  const exists = await probeAssetPath(src);
  ASSET_PATH_AVAILABILITY_CACHE.set(src, exists);
  return exists;
}

/**
 * Probe a path using lightweight fetch checks.
 */
async function probeAssetPath(src) {
  try {
    const headResponse = await fetch(src, { method: "HEAD", cache: "no-store" });
    if (headResponse.ok) return true;
  } catch (_error) {
    // Ignore and fallback to GET probe below.
  }

  try {
    const getResponse = await fetch(src, { method: "GET", cache: "no-store" });
    return getResponse.ok;
  } catch (_error) {
    return false;
  }
}

/**
 * Build themed ambient lights with deterministic variation.
 */
function buildThemeLights(theme, widthPx, heightPx, rng, seed, lightingMood, detected) {
  const lights = [];
  const cx = Math.floor(widthPx / 2);
  const cy = Math.floor(heightPx / 2);
  const features = detected?.features ?? {};

  const baseFlags = {
    [MODULE_ID]: {
      [FLAG_GENERATED_KEY]: true,
      kind: "light",
      seed
    }
  };

  const pushLight = (x, y, overrides = {}) => {
    const defaultConfig = {
      alpha: 0.5,
      angle: 360,
      bright: 6,
      color: "#ffcc88",
      coloration: 1,
      dim: 18,
      attenuation: 0.5,
      luminosity: 0.5,
      saturation: 0,
      contrast: 0,
      shadows: 0.2,
      animation: {
        type: "torch",
        speed: 3,
        intensity: 3,
        reverse: false
      },
      darkness: {
        min: 0,
        max: 1
      }
    };

    const mergedConfig = foundry.utils.mergeObject(defaultConfig, overrides.config ?? {}, { inplace: false });
    const mergedLight = foundry.utils.mergeObject(
      {
        x: Math.round(x),
        y: Math.round(y),
        rotation: 0,
        walls: true,
        vision: false,
        config: mergedConfig,
        flags: baseFlags
      },
      overrides,
      { inplace: false }
    );

    // Ensure config remains the merged copy.
    mergedLight.config = mergedConfig;
    lights.push(mergedLight);
  };

  const lightCountByTheme = {
    tavern: randomInt(rng, 4, 6),
    cave: randomInt(rng, 3, 5),
    "forest-ruins": randomInt(rng, 4, 6),
    dungeon: randomInt(rng, 5, 7)
  };
  const lightCount = lightCountByTheme[theme] ?? 5;

  // Lighting mood influence:
  // - dark/night => lower bright & dim ranges
  // - bright => stronger overall lighting
  // - magical => arcane colors + pulse animation
  const moodRanges = {
    bright: { brightMin: 7, brightMax: 10, dimMin: 20, dimMax: 30, alpha: 0.55 },
    dim: { brightMin: 4, brightMax: 7, dimMin: 14, dimMax: 22, alpha: 0.5 },
    dark: { brightMin: 2, brightMax: 4, dimMin: 8, dimMax: 14, alpha: 0.42 },
    night: { brightMin: 1, brightMax: 3, dimMin: 7, dimMax: 12, alpha: 0.38 },
    magical: { brightMin: 5, brightMax: 8, dimMin: 18, dimMax: 28, alpha: 0.58 }
  };
  const moodConfig = moodRanges[lightingMood] ?? moodRanges.dim;

  for (let i = 0; i < lightCount; i += 1) {
    const spreadX = randomInt(rng, -700, 700);
    const spreadY = randomInt(rng, -500, 500);
    const colorByTheme = {
      tavern: "#ffd27a",
      cave: "#ffb347",
      "forest-ruins": "#ffc46b",
      dungeon: "#f4c27a"
    };

    const magicalColor = ["#66ccff", "#8a7dff", "#5af0c8"][randomInt(rng, 0, 2)];
    const selectedColor = lightingMood === "magical" ? magicalColor : (colorByTheme[theme] ?? "#ffcc88");

    pushLight(cx + spreadX, cy + spreadY, {
      config: {
        alpha: moodConfig.alpha,
        bright: randomInt(rng, moodConfig.brightMin, moodConfig.brightMax),
        dim: randomInt(rng, moodConfig.dimMin, moodConfig.dimMax),
        color: selectedColor,
        animation: lightingMood === "magical"
          ? { type: "pulse", speed: 2, intensity: 4, reverse: false }
          : { type: "torch", speed: 3, intensity: 3, reverse: false }
      }
    });
  }

  // Feature influence: campfire request adds one warm central light.
  if (features.campfire) {
    pushLight(cx + randomInt(rng, -120, 120), cy + randomInt(rng, -120, 120), {
      config: {
        bright: 5,
        dim: 16,
        color: "#ff7b3a",
        animation: { type: "torch", speed: 4, intensity: 5, reverse: false }
      }
    });
  }

  return lights;
}

function formatThemeLabel(theme) {
  return THEME_LABELS[theme] ?? "AI Map";
}

/**
 * Build beginner-friendly note text showing the exact saved generation data.
 */
function buildPromptSummary(prompt, sceneSizeKey, theme, seed, lightingMood, detected, isRegeneration, useDetectedSettings) {
  const sceneSizeLabel = {
    small: "Small (~50m)",
    medium: "Medium (~250m)",
    large: "Large (~800m)",
    xlarge: "Extra Large (~1 mile)"
  }[sceneSizeKey] ?? "Medium (~250m)";
  const featureSummary = FEATURE_KEYS
    .filter((key) => detected?.features?.[key])
    .map((key) => formatFeatureLabel(key, detected?.features ?? {}));

  return `
<h2>SceneForge AI Prompt Summary</h2>
<p><strong>Prompt:</strong> ${foundry.utils.escapeHTML(prompt)}</p>
<p><strong>Theme:</strong> ${formatThemeLabel(theme)}</p>
<p><strong>Scene Size:</strong> ${sceneSizeLabel}</p>
<p><strong>Lighting Mood:</strong> ${foundry.utils.escapeHTML(LIGHTING_MOOD_LABELS[lightingMood] ?? "Dim")}</p>
<p><strong>Detected Features:</strong> ${foundry.utils.escapeHTML(featureSummary.join(", ") || "None")}</p>
<p><strong>Use Detected Settings:</strong> ${useDetectedSettings ? "Enabled" : "Disabled"}</p>
<p><strong>Seed:</strong> ${foundry.utils.escapeHTML(seed)}</p>
<p><strong>Generation Mode:</strong> ${isRegeneration ? "Regenerated from scene flags" : "Initial generation"}</p>
<p>This layout is deterministic and local-only. No external AI API calls are used.</p>
  `.trim();
}

/**
 * Build the final image prompt by appending universal quality constraints.
 */
function formatMapScalePromptInstruction(sceneSizeKey, mapCoverageMeters) {
  const meters = Number.isFinite(Number(mapCoverageMeters)) ? Math.max(1, Math.round(Number(mapCoverageMeters))) : 250;
  const miles = meters / 1609.344;
  const milesLabel = miles >= 0.1
    ? `${miles.toFixed(2)} miles`
    : `${Math.round(miles * 5280)} feet`;
  const scaleGuidance = {
    small: "SMALL SCALE BATTLE MAP COMPOSITION",
    medium: "LOCAL AREA MAP COMPOSITION WITH MULTIPLE POINTS OF INTEREST",
    large: "LARGE DISTRICT SCALE COMPOSITION WITH BROAD SPATIAL COVERAGE",
    xlarge: "REGIONAL SCALE COMPOSITION SHOWING A WIDE AREA ACROSS THE MAP"
  }[sceneSizeKey] ?? "LOCAL AREA MAP COMPOSITION WITH MULTIPLE POINTS OF INTEREST";

  return [
    `MAP SCALE TARGET: APPROXIMATELY ${meters} METERS WIDE (${milesLabel})`,
    scaleGuidance,
    "FRAME THE ENTIRE MAP AS A WIDE-AREA OVERVIEW, NOT A CLOSE-UP ENCOUNTER SHOT"
  ];
}

function compileInkarnatePrompt(prompt, options = {}) {
  const sourcePrompt = String(prompt ?? "").trim();
  const orientationSpec = getImageOrientationSpec(options.imageOrientation);
  const scaleLines = formatMapScalePromptInstruction(options.sceneSizeKey, options.mapCoverageMeters);
  const lines = [
    sourcePrompt,
    "TRUE TOP DOWN BATTLE MAP",
    "90 DEGREE ORTHOGRAPHIC CAMERA",
    "BIRDS-EYE PLANIMETRIC VIEW FROM DIRECTLY OVERHEAD",
    "EVERY BUILDING MUST READ AS A FLOORPLAN OR ROOF PLAN SHAPE ONLY",
    "ALL WALLS AND BUILDINGS MUST BE TOP-DOWN PLAN VIEW ONLY",
    "SHOW ONLY ROOFS OR WALL TOP CAPS, NEVER SIDE FACES",
    "NO VISIBLE WALL SIDES, NO BUILDING FACADES",
    "NO ELEVATION VIEW, NO HORIZON, NO ANGLED ARCHITECTURE",
    "ALL DOORS, WINDOWS, AND WALLS MUST BE DRAWN AS TOP-DOWN SYMBOLS, NOT SIDE VIEWS",
    "IF A STRUCTURE APPEARS, FORCE IT INTO FLAT TOP-DOWN ROOF OR FLOOR FOOTPRINT",
    orientationSpec.promptLine,
    ...scaleLines,
    "GRIDLESS",
    "HAND PAINTED INKARNATE STYLE",
    "CRISP LINEWORK",
    "SHARP CLEAN EDGES",
    "HIGH DETAIL TEXTURES",
    "HIGH CONTRAST COLOR SEPARATION",
    "VIBRANT READABLE COLORS",
    "D&D VTT MAP",
    "NO CHARACTERS",
    "NO TEXT",
    "NO LABELS",
    "NO ISOMETRIC",
    "NO PERSPECTIVE CAMERA",
    "NO THREE-QUARTER VIEW",
    "NO OBLIQUE CAMERA ANGLE"
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

function buildAiCompositionNotes({ text, rooms, terrainFeatures, biome, lightingMood }) {
  const notes = [];
  if (terrainFeatures.includes("river")) notes.push("river runs through center");
  if (rooms.some((room) => room.type === "boss_room")) notes.push("boss room in northern section");
  if (rooms.some((room) => room.type === "side_room")) notes.push("side rooms east and west");
  if (terrainFeatures.includes("bridge")) notes.push("bridge connects key traversal points");
  if (terrainFeatures.includes("hidden room")) notes.push("hidden chamber tucked off main route");
  if (notes.length === 0) {
    notes.push(`${biome} composition with ${lightingMood} mood and readable encounter flow`);
  }
  if (text.includes("center")) notes.push("center area should host a major focal set piece");
  return dedupeKeywords(notes);
}

function detectDirectionalPosition(text, subject, fallback = "center") {
  const index = text.indexOf(subject);
  if (index === -1) return fallback;
  const windowStart = Math.max(0, index - 40);
  const windowEnd = Math.min(text.length, index + subject.length + 40);
  const segment = text.slice(windowStart, windowEnd);
  if (segment.includes("north")) return "north";
  if (segment.includes("south")) return "south";
  if (segment.includes("east")) return "east";
  if (segment.includes("west")) return "west";
  if (segment.includes("center")) return "center";
  return fallback;
}

/**
 * Parse a natural-language prompt using local keyword rules only.
 * No external API calls are made.
 */
function parsePromptForSceneSettings(prompt) {
  void prompt;
  const features = {
    sideRoomsCount: 0
  };
  for (const key of FEATURE_KEYS) {
    features[key] = false;
  }
  return {
    theme: "ai-map",
    lightingMood: "dim",
    features,
    suggestedSize: "medium",
    featureCount: 0,
    matchedKeywords: {
      theme: [],
      lighting: [],
      features: []
    }
  };
}

/**
 * Convert scene size key to display text.
 */
function formatSceneSizeLabel(sceneSizeKey) {
  const labels = {
    small: "Small (~50m)",
    medium: "Medium (~250m)",
    large: "Large (~800m)",
    xlarge: "Extra Large (~1 mile)"
  };
  return labels[sceneSizeKey] ?? labels.medium;
}

/**
 * Turn feature keys into user-facing labels.
 */
function formatFeatureLabel(featureKey, features = {}) {
  const labels = {
    bossRoom: "Boss Room",
    sideRooms: `Side Rooms${features.sideRoomsCount ? ` (${features.sideRoomsCount})` : ""}`,
    storageRoom: "Storage Room",
    altar: "Altar",
    pillars: "Pillars",
    hiddenRoom: "Hidden Room",
    treasure: "Treasure",
    water: "Water",
    traps: "Traps",
    campfire: "Campfire",
    bar: "Bar",
    cells: "Cells"
  };
  return labels[featureKey] ?? featureKey;
}

/**
 * Detect a rough count for keyworded items, e.g. "two side rooms".
 */
function detectCountFromPrompt(text, phrases, fallback) {
  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6
  };

  for (const phrase of phrases) {
    const phraseRegex = phrase.replace(/\s+/g, "\\s+");
    const numericRegex = new RegExp(`(\\d+)\\s+${phraseRegex}`);
    const numericMatch = text.match(numericRegex);
    if (numericMatch) {
      return Math.max(1, Number(numericMatch[1]));
    }

    for (const [word, value] of Object.entries(numberWords)) {
      const wordRegex = new RegExp(`${word}\\s+${phraseRegex}`);
      if (wordRegex.test(text)) return value;
    }
  }

  return fallback;
}

/**
 * Returns an integer within [min, max] (inclusive), using seeded RNG.
 */
function randomInt(rng, min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(rng() * (high - low + 1)) + low;
}

/**
 * Generate a lightweight random seed string when user leaves seed blank.
 */
function randomSeedString() {
  return foundry.utils.randomID(8);
}

/**
 * Seeded pseudo-random number generator (Mulberry32).
 * We first hash a seed string into a 32-bit integer.
 */
function createSeededRng(seedString) {
  let t = hashStringToUint32(seedString);
  return function rng() {
    t += 0x6d2b79f5;
    let v = t;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic string hash -> unsigned 32-bit number.
 * This ensures the same seed text always maps to the same RNG stream.
 */
function hashStringToUint32(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
