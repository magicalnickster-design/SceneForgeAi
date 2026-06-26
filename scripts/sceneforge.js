/**
 * SceneForge AI (MVP+)
 * --------------------
 * This version keeps the original MVP behavior, then adds:
 *  - seeded deterministic generation
 *  - multiple themed layout variations
 *  - "Regenerate Layout" option in Scene Directory context menu
 *  - per-document flags so regeneration only removes SceneForge content
 *
 * There is still NO real AI call here. Layouts are template-driven.
 */

const MODULE_ID = "sceneforge-ai";
const GRID_SIZE_PX = 100;
const FLAG_GENERATION_KEY = "generationData";
const FLAG_GENERATED_KEY = "generated";
const FLAG_IMAGE_GENERATION_KEY = "imageGeneration";
const DEBUG = false;
const TILE_FALLBACK_MODE = "skip-missing";
// Temporary product-focus switch: disable all spawned tile/prop/pack assets.
const ENABLE_ASSET_SPAWNING = false;
// Test isolation switch: disable all SceneForge journals and notes.
const ENABLE_JOURNALS_AND_NOTES = false;

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

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:");
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
  if (typeof FilePickerImpl?.upload !== "function" || typeof File !== "function") return trimmedPath;

  const { seed = "map", provider = "ai" } = options;
  const targetDir = `${MODULE_ID}/generated-maps`;
  await ensureDataDirectory(targetDir);

  try {
    let blob;
    if (isDataUrl(trimmedPath)) {
      blob = dataUrlToBlob(trimmedPath);
    } else {
      const response = await fetch(trimmedPath, { method: "GET", cache: "no-store" });
      if (!response.ok) throw new Error(`Background fetch failed (${response.status}).`);
      blob = await response.blob();
    }

    const extension = inferImageExtension(trimmedPath, blob.type);
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
  if (!scene?.toObject) return null;
  const objectData = scene.toObject();
  return (
    objectData?.background?.src
    ?? objectData?.levels?.[0]?.background?.src
    ?? objectData?.levels?.[0]?.textures?.background?.src
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

  // Attempt 1: legacy scene-level background path (v12/v13 compatibility).
  await scene.update({
    background: {
      src: backgroundSrc
    }
  });
  let finalBackgroundSrc = getSceneBackgroundSrc(scene);
  if (finalBackgroundSrc === backgroundSrc || Boolean(finalBackgroundSrc)) {
    return {
      applied: true,
      finalBackgroundSrc
    };
  }

  // Attempt 2: v14+ level background path.
  const primaryLevel = getPrimarySceneLevel(scene);
  if (primaryLevel?.update) {
    await primaryLevel.update({
      "background.src": backgroundSrc
    });
    finalBackgroundSrc = getSceneBackgroundSrc(scene);
    if (finalBackgroundSrc === backgroundSrc || Boolean(finalBackgroundSrc)) {
      return {
        applied: true,
        finalBackgroundSrc
      };
    }
  }

  return {
    applied: false,
    finalBackgroundSrc
  };
}

/**
 * Scene sizes are expressed in grid cells.
 * Foundry stores scene dimensions in pixels.
 */
const SCENE_SIZES = {
  small: 30,
  medium: 50,
  large: 70
};

/**
 * Theme labels are reused for UI strings and note summaries.
 */
const THEME_LABELS = {
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
const SETTING_OPENAI_MONTHLY_LIMIT = "openAiMonthlyGenerationLimit";
const SETTING_CONFIRM_PAID_GENERATION = "confirmBeforePaidGeneration";
const SETTING_OPENAI_USAGE_TRACKING = "openAiUsageTracking";
const SETTING_SUBSCRIPTION_BACKEND_URL = "subscriptionBackendUrl";
const SETTING_PATREON_CONNECT_URL = "patreonConnectUrl";
const SETTING_PATREON_MANAGE_URL = "patreonManageUrl";
const SETTING_SUBSCRIPTION_AUTH_TOKEN = "subscriptionAuthToken";

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
 * These paths are examples for future Patreon/subscriber art bundles.
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
});

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
    hint: "Select provider target. Subscription backend is recommended for Patreon-based access.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      none: "None",
      mock: "Mock Provider",
      subscription: "Subscription Backend (Patreon)",
      openai: "OpenAI (Legacy direct key)",
      stability: "Stability placeholder"
    },
    default: "subscription"
  });

  game.settings.register(MODULE_ID, SETTING_SUBSCRIPTION_BACKEND_URL, {
    name: "Subscription Backend URL",
    hint: "Your hosted API base URL (example: https://api.sceneforge.ai).",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_PATREON_CONNECT_URL, {
    name: "Patreon Connect URL",
    hint: "URL users open to link Patreon for active subscription access.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_PATREON_MANAGE_URL, {
    name: "Patreon Manage URL",
    hint: "URL users open to manage subscription status.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_SUBSCRIPTION_AUTH_TOKEN, {
    name: "Subscription Session Token",
    hint: "Per-user token issued by your backend after Patreon linking.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    restricted: false
  });

  game.settings.register(MODULE_ID, SETTING_OPENAI_API_KEY, {
    name: "OpenAI API Key",
    hint: "Used only when AI Image Provider is OpenAI placeholder.",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_OPENAI_MONTHLY_LIMIT, {
    name: "OpenAI Monthly Generation Limit",
    hint: "Hard cap on successful paid generations per month.",
    scope: "world",
    config: true,
    type: Number,
    default: 20,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_CONFIRM_PAID_GENERATION, {
    name: "Confirm Before Paid Generation",
    hint: "When enabled, a paid confirmation dialog is required before OpenAI generation.",
    scope: "world",
    config: true,
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
}

/**
 * Merge base registry + enabled pack registries into one active registry.
 *
 * Beginner note:
 * To add a new future Patreon pack:
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
  return String(game.settings.get(MODULE_ID, SETTING_AI_IMAGE_PROVIDER) ?? "none");
}

function getOpenAiApiKey() {
  return String(game.settings.get(MODULE_ID, SETTING_OPENAI_API_KEY) ?? "").trim();
}

function getSubscriptionBackendUrl() {
  return String(game.settings.get(MODULE_ID, SETTING_SUBSCRIPTION_BACKEND_URL) ?? "").trim().replace(/\/+$/, "");
}

function getPatreonConnectUrl() {
  return String(game.settings.get(MODULE_ID, SETTING_PATREON_CONNECT_URL) ?? "").trim();
}

function getPatreonManageUrl() {
  return String(game.settings.get(MODULE_ID, SETTING_PATREON_MANAGE_URL) ?? "").trim();
}

function getSubscriptionAuthToken() {
  return String(game.settings.get(MODULE_ID, SETTING_SUBSCRIPTION_AUTH_TOKEN) ?? "").trim();
}

function getOpenAiMonthlyLimit() {
  return Math.max(0, Number(game.settings.get(MODULE_ID, SETTING_OPENAI_MONTHLY_LIMIT) ?? 0));
}

function isPaidGenerationConfirmationEnabled() {
  return game.settings.get(MODULE_ID, SETTING_CONFIRM_PAID_GENERATION) === true;
}

function getCurrentUsageMonthKey() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}`;
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
 * This is where we expose "Regenerate Layout".
 */
Hooks.on("getSceneDirectoryEntryContext", (html, entryOptions) => {
  entryOptions.push({
    name: "SceneForge: Regenerate Layout",
    icon: '<i class="fas fa-arrows-rotate"></i>',
    condition: (li) => {
      if (!game.user?.isGM) return false;
      const scene = getSceneFromDirectoryLi(li);
      return Boolean(scene?.getFlag(MODULE_ID, FLAG_GENERATION_KEY));
    },
    callback: async (li) => {
      const scene = getSceneFromDirectoryLi(li);
      if (!scene) return;
      await regenerateSceneFromFlags(scene);
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
});

/**
 * Resolve a Scene document from a Scene Directory <li>.
 * The dataset key can vary by Foundry version, so we check multiple keys.
 */
function getSceneFromDirectoryLi(li) {
  const jq = li?.jquery ? li : $(li);
  const sceneId =
    jq?.data?.("documentId")
    ?? jq?.data?.("entryId")
    ?? li?.[0]?.dataset?.documentId
    ?? li?.[0]?.dataset?.entryId
    ?? li?.dataset?.documentId
    ?? li?.dataset?.entryId;

  if (!sceneId) return null;
  return game.scenes.get(sceneId) ?? null;
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
  const generationMode = "ai-planner";
  const prompt = String(form.find('[name="prompt"]').val() ?? "").trim();
  let sceneSizeKey = "medium";
  let theme = "dungeon";
  let lightingMood = "dim";
  const useDetectedSettings = true;
  const seedInput = String(form.find('[name="seed"]').val() ?? "").trim();
  const seed = seedInput || randomSeedString();

  if (!prompt) {
    ui.notifications.warn("SceneForge AI: Please enter a prompt before generating.");
    return null;
  }

  const detected = parsePromptForSceneSettings(prompt);
  const aiPlan = parseAiMapPlan(prompt);
  const layoutGraph = buildLayoutGraphFromPlan(aiPlan, seed);
  const compiledImagePrompt = compileInkarnatePrompt(aiPlan, layoutGraph);
  let effectiveDetected = applyAiPlanFeaturesToDetected(detected, aiPlan);

  // AI planner provides the final map intent; map it onto current generator knobs.
  theme = mapAiPlanThemeToSceneTheme(aiPlan);
  sceneSizeKey = mapAiPlanSizeToSceneSizeKey(aiPlan.mapSize);
  lightingMood = mapAiPlanLightingToSceneLighting(aiPlan.lightingMood);

  const generationData = {
    generationMode,
    prompt,
    sceneSizeKey,
    theme,
    lightingMood,
    detected,
    useDetectedSettings,
    effectiveDetected,
    aiPlan,
    layoutGraph,
    compiledImagePrompt,
    imageGeneration: {
      provider: getAiImageProvider(),
      compiledPrompt: compiledImagePrompt ?? "",
      imageStatus: "not-requested",
      imagePath: null,
      costEstimate: {
        preview: "$0.00 mock",
        final: "$0.08 placeholder"
      }
    },
    enabledAssetPacks: getEnabledAssetPackIds(),
    seed,
    moduleVersion: "0.16.4"
  };

  // Store the raw form values so Back/Edit can restore exactly what user entered.
  const formState = {
    generationMode,
    prompt,
    sceneSizeKey,
    theme,
    lightingMood,
    seed,
    useDetectedSettings
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
  const widthPx = gridCells * GRID_SIZE_PX;
  const heightPx = gridCells * GRID_SIZE_PX;

  const rng = createSeededRng(`${generationData.seed}|${generationData.theme}|${generationData.sceneSizeKey}|${generationData.prompt}`);
  const walls = buildThemeWalls(generationData.theme, widthPx, heightPx, rng, generationData.seed, generationData.effectiveDetected);
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
  const lights = buildThemeLights(
    generationData.theme,
    widthPx,
    heightPx,
    rng,
    generationData.seed,
    generationData.lightingMood,
    generationData.effectiveDetected
  );

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
    generationMode: generationData.generationMode ?? "ai-planner",
    finalTheme: generationData.theme,
    finalSize: generationData.sceneSizeKey,
    finalSeed: generationData.seed,
    lightingMood: generationData.lightingMood,
    appliedFeatures,
    enabledAssetPacks: generationData.enabledAssetPacks,
    aiPlan: generationData.aiPlan,
    layoutGraph: generationData.layoutGraph,
    compiledImagePrompt: generationData.compiledImagePrompt,
    aiImageProvider: generationData.imageGeneration?.provider ?? "none",
    aiReadableSummary: generationData.aiPlan ? buildAiPlanReadableSummary(generationData.aiPlan) : null,
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
  const isAiPlannerMode = generationData?.generationMode === "ai-planner";
  const activeProvider = imageGenerationMetadata?.provider ?? getAiImageProvider();
  if (isAiPlannerMode) {
    const imageStatus = imageGenerationMetadata?.imageStatus ?? null;
    const imagePath = imageGenerationMetadata?.imagePath ?? backgroundPath ?? null;
    const hasValidAiImage = (
      (activeProvider === "openai" && imageStatus === "complete")
      || (activeProvider === "mock" && imageStatus === "mock-generated")
      || (activeProvider === "subscription" && imageStatus === "complete")
    ) && Boolean(imagePath);

    if (!hasValidAiImage) {
      ui.notifications.error("SceneForge AI: AI image generation must complete before scene creation.");
      if (activeProvider === "openai") {
        debugLog("OpenAI generation failed, aborting scene creation");
      }
      return;
    }
  }

  const gridCells = SCENE_SIZES[generationData.sceneSizeKey] ?? SCENE_SIZES.medium;
  const widthPx = gridCells * GRID_SIZE_PX;
  const heightPx = gridCells * GRID_SIZE_PX;
  const sceneName = `${sceneNamePrefix} - ${formatThemeLabel(generationData.theme)} - ${generationData.seed}`;

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
        size: GRID_SIZE_PX,
        distance: 5,
        units: "ft"
      },
      backgroundColor: "#2b2b2b",
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

      if (activeProvider === "openai" && !persistedBackgroundPath) {
        await scene.delete();
        ui.notifications.error("SceneForge AI: Map image failed to apply. Scene was not created.");
        return;
      }

      const backgroundApplyResult = await applyBackgroundToScene(scene, persistedBackgroundPath);
      const updatedBackgroundSrc = backgroundApplyResult.finalBackgroundSrc;
      debugLog("Scene background after update", updatedBackgroundSrc);
      backgroundVerified = Boolean(persistedBackgroundPath) && backgroundApplyResult.applied;

      if (!backgroundVerified && (activeProvider === "openai" || activeProvider === "subscription")) {
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

    await generateSceneLayout(scene, resolvedGenerationData);

    if (seedWasAutoGenerated) {
      ui.notifications.info(`SceneForge AI: Seed auto-generated as "${resolvedGenerationData.seed}".`);
    }
    const shouldShowCreatedSuccess = !backgroundPath || backgroundVerified;
    if (shouldShowCreatedSuccess) {
      ui.notifications.info(`SceneForge AI: Created "${scene.name}" successfully.`);
    }
  } catch (error) {
    if (activeProvider === "openai" && createdScene) {
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
 * Preview button path for AI Planner Mode.
 * Uses configured provider architecture and handles failures safely.
 */
async function createMockAiSceneFromGenerationData(generationData, seedWasAutoGenerated = false) {
  const provider = getAiImageProvider();
  if (provider === "none") {
    ui.notifications.error("SceneForge AI: No AI image provider selected.");
    return;
  }
  if (provider === "openai" && !getOpenAiApiKey()) {
    ui.notifications.error("SceneForge AI: OpenAI API key required before AI map generation.");
    return;
  }
  if (provider === "openai") {
    debugLog("OpenAI generation path called");
  }

  const compiledPrompt = generationData.compiledImagePrompt ?? "";
  const imageResult = await generateAiMapImage(compiledPrompt, {
    mode: "preview",
    seed: generationData.seed,
    plan: generationData.aiPlan ?? null,
    layoutGraph: generationData.layoutGraph ?? null,
    sourcePrompt: generationData.prompt ?? ""
  });
  debugLog("AI imageResult", imageResult);

  if (imageResult?.imageStatus === "failed") {
    const errorMessage = imageResult.errorMessage ?? "Image generation failed.";
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
  ) && Boolean(imageResult?.imagePath);

  if (!validImageForScene) {
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
    costEstimate: imageResult.costEstimate
  };

  await createSceneFromGenerationData(generationData, seedWasAutoGenerated, {
    backgroundPath: imageResult.imagePath ?? null,
    imageGenerationMetadata,
    sceneNamePrefix: imageResult.provider === "mock" ? "SceneForge Mock Test Scene" : "SceneForge"
  });
}

/**
 * Provider architecture router.
 * Real generation is currently enabled only for the OpenAI provider path.
 */
async function generateAiMapImage(compiledPrompt, options = {}) {
  const configuredProvider = getAiImageProvider();
  const provider = configuredProvider;

  if (provider === "none") {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate: {
        preview: "$0.00 mock",
        final: "$0.08 placeholder"
      },
      errorMessage: "No AI image provider selected."
    };
  }

  if (provider === "mock") {
    debugLog("Mock provider compiled prompt", compiledPrompt);
    const imagePath = buildMockMapBackgroundDataUri(options);
    return {
      provider: "mock",
      imageStatus: "mock-generated",
      imagePath,
      costEstimate: {
        preview: "$0.00 mock",
        final: "$0.08 placeholder"
      }
    };
  }

  if (provider === "subscription") {
    return generateSubscriptionMapImage(compiledPrompt, options);
  }

  if (provider === "openai") {
    debugLog("OpenAI generation path called");
    return generateOpenAiMapImage(compiledPrompt, options);
  }

  // Placeholder architecture for not-yet-implemented providers.
  return {
    provider: configuredProvider,
    imageStatus: "not-generated",
    imagePath: null,
    costEstimate: {
      preview: "$0.00 mock",
      final: "$0.08 placeholder"
    }
  };
}

async function generateSubscriptionMapImage(compiledPrompt, options = {}) {
  const provider = "subscription";
  const costEstimate = { preview: "included with subscription", final: "included with subscription" };
  const backendBaseUrl = getSubscriptionBackendUrl();
  const token = getSubscriptionAuthToken();

  if (!backendBaseUrl) {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: "Subscription backend URL is not configured."
    };
  }

  if (!token) {
    const connectUrl = getPatreonConnectUrl();
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: connectUrl
        ? `Subscription token missing. Link Patreon first: ${connectUrl}`
        : "Subscription token missing. Link Patreon first."
    };
  }

  const endpoint = `${backendBaseUrl}/api/maps/generate`;
  const requestPayload = {
    compiledPrompt,
    seed: options.seed ?? null,
    plan: options.plan ?? null,
    layoutGraph: options.layoutGraph ?? null,
    sourcePrompt: options.sourcePrompt ?? ""
  };
  debugLog("Subscription generation request", { endpoint, requestPayload });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(requestPayload)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const backendMessage = String(payload?.error ?? payload?.message ?? "");
      if (response.status === 401 || response.status === 403) {
        const manageUrl = getPatreonManageUrl();
        return {
          provider,
          imageStatus: "failed",
          imagePath: null,
          costEstimate,
          errorMessage: manageUrl
            ? `Subscription access denied. Verify Patreon status: ${manageUrl}`
            : "Subscription access denied. Verify Patreon status."
        };
      }
      return {
        provider,
        imageStatus: "failed",
        imagePath: null,
        costEstimate,
        errorMessage: backendMessage || `Subscription backend request failed (${response.status}).`
      };
    }

    const imagePath = payload?.imagePath ?? payload?.image_url ?? payload?.url ?? null;
    if (!imagePath) {
      return {
        provider,
        imageStatus: "failed",
        imagePath: null,
        costEstimate,
        errorMessage: "Subscription backend returned no map image."
      };
    }

    return {
      provider,
      imageStatus: "complete",
      imagePath: String(imagePath),
      costEstimate
    };
  } catch (error) {
    return {
      provider,
      imageStatus: "failed",
      imagePath: null,
      costEstimate,
      errorMessage: `Subscription backend request failed: ${error?.message ?? "unknown error"}`
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
    const requestPayload = {
      model: "gpt-image-1",
      prompt: compiledPrompt,
      size: "1024x1024"
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
      throw new Error(`OpenAI image request failed (${response.status}).`);
    }

    const payload = await response.json();
    const first = payload?.data?.[0] ?? null;
    const imagePath = first?.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : (first?.url ?? null);
    debugLog("OpenAI imagePath received", imagePath);

    if (!imagePath) {
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
    ui.notifications.info(`SceneForge AI: Regenerated layout for "${scene.name}".`);
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
    version: generationData.moduleVersion ?? "0.16.4",
    exportedAt: new Date().toISOString(),
    sceneName: scene.name,
    generationMode: generationData.generationMode ?? "ai-planner",
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
  const generationMode = String(rawPreset.generationMode ?? rawPreset.generationData?.generationMode ?? "ai-planner");
  const prompt = String(rawPreset.prompt ?? rawPreset.generationData?.prompt ?? "").trim();
  const theme = String(rawPreset.theme ?? rawPreset.generationData?.theme ?? "").trim();
  const sceneSizeKey = String(rawPreset.size ?? rawPreset.sceneSizeKey ?? rawPreset.generationData?.sceneSizeKey ?? "").trim();
  const seed = String(rawPreset.seed ?? rawPreset.generationData?.seed ?? "").trim();
  const lightingMood = String(rawPreset.lightingMood ?? rawPreset.generationData?.lightingMood ?? "dim");

  if (!prompt) return { ok: false, error: "Missing prompt." };
  if (!Object.prototype.hasOwnProperty.call(THEME_LABELS, theme)) {
    return { ok: false, error: `Invalid theme "${theme}".` };
  }
  if (!Object.prototype.hasOwnProperty.call(SCENE_SIZES, sceneSizeKey)) {
    return { ok: false, error: `Invalid size "${sceneSizeKey}".` };
  }
  if (!seed) return { ok: false, error: "Missing seed." };
  if (!Object.prototype.hasOwnProperty.call(LIGHTING_MOOD_LABELS, lightingMood)) {
    return { ok: false, error: `Invalid lighting mood "${lightingMood}".` };
  }

  const detected = rawPreset.detected
    ?? rawPreset.generationData?.detected
    ?? parsePromptForSceneSettings(prompt);
  const aiPlan = rawPreset.aiPlan
    ?? rawPreset.generationData?.aiPlan
    ?? (generationMode === "ai-planner" ? parseAiMapPlan(prompt) : null);
  const layoutGraph = rawPreset.layoutGraph
    ?? rawPreset.generationData?.layoutGraph
    ?? (aiPlan ? buildLayoutGraphFromPlan(aiPlan, seed) : null);
  const compiledImagePrompt = rawPreset.compiledImagePrompt
    ?? rawPreset.generationData?.compiledImagePrompt
    ?? (aiPlan ? compileInkarnatePrompt(aiPlan, layoutGraph) : null);
  const imageGeneration = rawPreset.imageGeneration
    ?? rawPreset.generationData?.imageGeneration
    ?? {
      provider: getAiImageProvider(),
      compiledPrompt: compiledImagePrompt ?? "",
      imageStatus: "not-requested",
      imagePath: null,
      costEstimate: {
        preview: "$0.00 mock",
        final: "$0.08 placeholder"
      }
    };

  const useDetectedSettings = rawPreset.useDetectedSettings ?? rawPreset.generationData?.useDetectedSettings;
  const enabledAssetPacks = rawPreset.enabledAssetPacks ?? rawPreset.generationData?.enabledAssetPacks;
  const baseDetected = (useDetectedSettings !== false) ? detected : buildDisabledDetectedPayload(detected);
  const effectiveDetected = generationMode === "ai-planner"
    ? applyAiPlanFeaturesToDetected(baseDetected, aiPlan ?? parseAiMapPlan(prompt))
    : baseDetected;

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
    generationLayers: Array.isArray(rawPreset.generationLayers)
      ? rawPreset.generationLayers
      : ["walls", "floor-assets", "props", "lighting", "notes"],
    seed,
    moduleVersion: "0.16.4"
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
  const widthPx = gridCells * GRID_SIZE_PX;
  const heightPx = gridCells * GRID_SIZE_PX;
  const sceneName = `SceneForge Preset - ${formatThemeLabel(generationData.theme)} - ${generationData.seed}`;

  const scenePayload = {
    name: sceneName,
    width: widthPx,
    height: heightPx,
    padding: 0.1,
    grid: {
      type: CONST.GRID_TYPES.SQUARE,
      size: GRID_SIZE_PX,
      distance: 5,
      units: "ft"
    },
    backgroundColor: "#2b2b2b",
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
    await createMissingPackWarningJournalNote(scene, missingPacks);
  }
}

/**
 * If import proceeds without required packs, drop a warning journal note in scene.
 */
async function createMissingPackWarningJournalNote(scene, missingPacks) {
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
 * Core generation pipeline used by both first-time generation and regeneration.
 * Steps:
 *   1) Normalize data and update scene dimensions/grid
 *   2) Clear SceneForge-generated content only
 *   3) Build deterministic walls/lights from seed + options
 *   4) Create summary journal and an in-scene note
 *   5) Re-save generation data to scene flags
 */
async function generateSceneLayout(scene, generationData, options = {}) {
  const { isRegeneration = false } = options;

  const prompt = String(generationData.prompt ?? "").trim();
  const sceneSizeKey = String(generationData.sceneSizeKey ?? "medium");
  const theme = String(generationData.theme ?? "dungeon");
  const lightingMood = String(generationData.lightingMood ?? "dim");
  const seed = String(generationData.seed ?? randomSeedString());
  const detected = generationData.detected ?? parsePromptForSceneSettings(prompt);
  const useDetectedSettings = generationData.useDetectedSettings !== false;
  const effectiveDetected = generationData.effectiveDetected ?? (useDetectedSettings ? detected : buildDisabledDetectedPayload(detected));

  const gridCells = SCENE_SIZES[sceneSizeKey] ?? SCENE_SIZES.medium;
  const widthPx = gridCells * GRID_SIZE_PX;
  const heightPx = gridCells * GRID_SIZE_PX;

  // Keep scene settings aligned with saved generation options every regeneration.
  await scene.update({
    width: widthPx,
    height: heightPx,
    grid: {
      type: CONST.GRID_TYPES.SQUARE,
      size: GRID_SIZE_PX,
      distance: 5,
      units: "ft"
    }
  });

  await clearGeneratedContent(scene);

  // Same seed + same options => same pseudo-random sequence => same layout.
  const rng = createSeededRng(`${seed}|${theme}|${sceneSizeKey}|${prompt}`);

  const walls = buildThemeWalls(theme, widthPx, heightPx, rng, seed, effectiveDetected);
  const activePackIds = Array.isArray(generationData.enabledAssetPacks)
    ? generationData.enabledAssetPacks
    : getEnabledAssetPackIds();
  let validatedTiles = [];
  if (ENABLE_ASSET_SPAWNING) {
    const tileLayers = buildThemeTiles(theme, widthPx, heightPx, walls, rng, seed, effectiveDetected, activePackIds);
    validatedTiles = await applyTileFallbackModeToTileLayers(tileLayers);
  }
  const lights = buildThemeLights(theme, widthPx, heightPx, rng, seed, lightingMood, effectiveDetected);

  // Generation layers order (premium-style pipeline):
  // 1) walls
  // 2) floor assets
  // 3) props
  // 4) lighting
  // 5) notes
  if (walls.length > 0) {
    await safeEmbeddedCreate(scene, "Wall", walls, "generateSceneLayout.Wall.createEmbeddedDocuments");
  }

  if (validatedTiles.length > 0) {
    await safeEmbeddedCreate(scene, "Tile", validatedTiles, "generateSceneLayout.Tile.createEmbeddedDocuments");
  }

  if (lights.length > 0) {
    await safeEmbeddedCreate(scene, "AmbientLight", lights, "generateSceneLayout.AmbientLight.createEmbeddedDocuments");
  }

  const summaryText = buildPromptSummary(
    prompt,
    sceneSizeKey,
    theme,
    seed,
    lightingMood,
    effectiveDetected,
    isRegeneration,
    useDetectedSettings
  );
  const journalPayload = {
    name: `SceneForge Notes - ${scene.name}`,
    pages: [
      {
        name: "Scene Summary",
        type: "text",
        text: {
          format: 1,
          content: summaryText
        }
      }
    ],
    flags: {
      [MODULE_ID]: {
        [FLAG_GENERATED_KEY]: true,
        sceneId: scene.id,
        seed
      }
    }
  };
  const journal = await safeJournalEntryCreate(journalPayload, "generateSceneLayout.JournalEntry.create");

  const firstPage = journal?.pages?.contents?.[0];
  if (journal && firstPage) {
    const notesToCreate = [
      {
        x: Math.floor(widthPx * 0.5),
        y: Math.floor(heightPx * 0.5),
        entryId: journal.id,
        pageId: firstPage.id,
        iconSize: 40,
        text: "SceneForge Prompt Notes",
        flags: {
          [MODULE_ID]: {
            [FLAG_GENERATED_KEY]: true,
            kind: "note",
            seed
          }
        }
      }
    ];

    // Feature influence: add a treasure note marker when treasure is requested.
    if (effectiveDetected.features.treasure) {
      notesToCreate.push({
        x: Math.floor(widthPx * 0.8),
        y: Math.floor(heightPx * 0.25),
        entryId: journal.id,
        pageId: firstPage.id,
        iconSize: 36,
        text: "Treasure Location",
        flags: {
          [MODULE_ID]: {
            [FLAG_GENERATED_KEY]: true,
            kind: "note",
            noteType: "treasure",
            seed
          }
        }
      });
    }

    await safeEmbeddedCreate(scene, "Note", notesToCreate, "generateSceneLayout.Note.createEmbeddedDocuments");
  }

  const generationLayers = ENABLE_ASSET_SPAWNING
    ? ["walls", "floor-assets", "props", "lighting", "notes"]
    : ["walls", "lighting", "notes"];

  await scene.setFlag(MODULE_ID, FLAG_GENERATION_KEY, {
    generationMode: generationData.generationMode ?? "ai-planner",
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
      costEstimate: {
        preview: "$0.00 mock",
        final: "$0.08 placeholder"
      }
    },
    enabledAssetPacks: activePackIds,
    generationLayers,
    seed,
    moduleVersion: "0.16.4",
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
  return THEME_LABELS[theme] ?? "Dungeon";
}

/**
 * Build beginner-friendly note text showing the exact saved generation data.
 */
function buildPromptSummary(prompt, sceneSizeKey, theme, seed, lightingMood, detected, isRegeneration, useDetectedSettings) {
  const sceneSizeLabel = {
    small: "Small (30x30)",
    medium: "Medium (50x50)",
    large: "Large (70x70)"
  }[sceneSizeKey] ?? "Medium (50x50)";
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
 * Parse an "AI planner" map plan from natural language using local rules only.
 * No external APIs are called.
 */
function parseAiMapPlan(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  const has = (phrase) => text.includes(phrase);
  const matched = (keywords) => keywords.filter((k) => has(k));

  const matchedBiomes = matched(AI_PLANNER_BIOMES);
  const matchedThemes = matched(AI_PLANNER_THEMES);
  const matchedTerrain = matched(AI_PLANNER_TERRAIN_FEATURES);
  const matchedLighting = matched(AI_PLANNER_LIGHTING_MOODS);

  const biome = matchedBiomes[0] ?? "forest";
  const themeRoot = matchedThemes[0] ?? "ruins";
  const theme = `${biome}_${themeRoot}`;

  const roomCountHint = detectCountFromPrompt(text, ["rooms", "room"], 0);
  const sideRoomCount = detectCountFromPrompt(text, ["side rooms", "side room"], has("side room") ? 2 : 0);

  const rooms = [];
  if (has("boss room")) {
    rooms.push({ type: "boss_room", position: detectDirectionalPosition(text, "boss room", "north") });
  }
  if (sideRoomCount > 0 || has("side room")) {
    rooms.push({ type: "side_room", count: Math.max(1, sideRoomCount || 2) });
  }
  if (has("hidden room")) {
    rooms.push({ type: "hidden_room", position: detectDirectionalPosition(text, "hidden room", "east") });
  }
  if (has("puzzle room")) {
    rooms.push({ type: "puzzle_room", position: detectDirectionalPosition(text, "puzzle room", "west") });
  }

  const baseRoomCount = roomCountHint > 0 ? roomCountHint : 3;
  const roomCount = Math.max(
    baseRoomCount,
    rooms.reduce((sum, room) => sum + (Number(room.count) || 1), 0)
  );

  const mapSize = roomCount >= 6 || matchedTerrain.length >= 5 ? "large" : (roomCount <= 2 ? "small" : "medium");
  const estimatedGrid = {
    small: "30x30",
    medium: "50x50",
    large: "70x70"
  }[mapSize] ?? "50x50";

  const lightingMood = matchedLighting[0] ?? (has("torch") || has("torches") ? "torchlit" : "dim");
  const terrainFeatures = dedupeKeywords(matchedTerrain);
  const compositionNotes = buildAiCompositionNotes({ text, rooms, terrainFeatures, biome, lightingMood });

  return {
    theme,
    biome,
    style: "inkarnate",
    mapSize,
    estimatedGrid,
    roomCount,
    rooms,
    terrainFeatures,
    lightingMood,
    compositionNotes
  };
}

/**
 * Phase 2:
 * Build a deterministic layout graph from AI planner output + seed.
 */
function buildLayoutGraphFromPlan(plan, seed) {
  const rng = createSeededRng(`${seed}|layout-graph|${JSON.stringify(plan)}`);
  const positions = ["north", "east", "west", "south", "center", "north-east", "north-west"];
  const entrancePosition = ["south", "west", "east"][randomInt(rng, 0, 2)];

  const nodes = [
    { id: "entrance", type: "entrance", position: entrancePosition },
    { id: "central_area", type: "central_area", position: "center" }
  ];
  const edges = [
    { from: "entrance", to: "central_area" }
  ];

  const sidePositionOrder = ["east", "west", "north-east", "north-west", "south-east", "south-west"];
  let sidePositionIndex = 0;

  for (const room of plan.rooms ?? []) {
    if (room.type === "side_room") {
      const count = Math.max(1, Number(room.count) || 1);
      for (let i = 0; i < count; i += 1) {
        const position = sidePositionOrder[(sidePositionIndex + i) % sidePositionOrder.length];
        const id = `side_room_${position.replace(/[^a-z]/g, "_")}_${i + 1}`;
        nodes.push({ id, type: "side_room", position });
        edges.push({ from: "central_area", to: id });
      }
      sidePositionIndex += count;
      continue;
    }

    const baseId = room.type || "room";
    const id = baseId === "boss_room" ? "boss_room" : `${baseId}_${nodes.length}`;
    const defaultPosition = baseId === "boss_room" ? "north" : positions[randomInt(rng, 0, positions.length - 1)];
    const position = room.position ?? defaultPosition;
    nodes.push({ id, type: baseId, position });
    edges.push({ from: "central_area", to: id });
  }

  if (!nodes.some((node) => node.type === "boss_room")) {
    nodes.push({ id: "boss_room", type: "boss_room", position: "north" });
    edges.push({ from: "central_area", to: "boss_room" });
  }

  const terrainAnchors = buildTerrainAnchorsFromPlan(plan, rng);

  return {
    nodes,
    edges,
    terrainAnchors
  };
}

/**
 * Convert terrain features into deterministic anchor descriptors for graph + prompt.
 */
function buildTerrainAnchorsFromPlan(plan, rng) {
  const anchors = [];
  const features = plan.terrainFeatures ?? [];

  const riverPathOptions = ["north_south", "east_west", "diagonal"];
  if (features.includes("river")) {
    anchors.push({
      type: "river",
      path: riverPathOptions[randomInt(rng, 0, riverPathOptions.length - 1)]
    });
  }
  if (features.includes("bridge")) {
    anchors.push({ type: "bridge", position: "center" });
  }
  if (features.includes("waterfall")) {
    anchors.push({ type: "waterfall", position: "north" });
  }
  if (features.includes("lava")) {
    anchors.push({ type: "lava", path: "south_arc" });
  }
  if (features.includes("cliffs")) {
    anchors.push({ type: "cliffs", position: "map_edges" });
  }
  if (features.includes("road")) {
    anchors.push({ type: "road", path: "entrance_to_center" });
  }
  if (features.includes("docks")) {
    anchors.push({ type: "docks", position: "south_edge" });
  }

  return anchors;
}

/**
 * Compile a strict future-facing image prompt using the AI planner output.
 * This is preview-only text now; no external image generation is called.
 */
function compileInkarnatePrompt(plan, layoutGraph = null) {
  const toTitle = (value) => String(value ?? "").replace(/_/g, " ").trim();
  const hasTerrain = (value) => (plan.terrainFeatures ?? []).includes(value);
  const themeText = `${plan.theme} ${plan.biome}`.toLowerCase();

  const roomSummary = (plan.rooms ?? []).map((room) => {
    const count = room.count ? ` x${room.count}` : "";
    return `${toTitle(room.type)}${count}`;
  }).join(", ");

  const terrainType = (() => {
    if (themeText.includes("forest") || themeText.includes("jungle")) return "lush forest floor with ancient ruin stonework";
    if (themeText.includes("desert")) return "sun-baked sand, weathered flagstones, and dusty rock shelves";
    if (themeText.includes("swamp")) return "muddy wetland ground with mossy roots and saturated soil";
    if (themeText.includes("snow")) return "frosted earth, icy stone, and wind-carved drifts";
    if (themeText.includes("volcanic") || hasTerrain("lava")) return "charred volcanic rock, ash, and heat-scorched masonry";
    if (themeText.includes("cave") || themeText.includes("underground")) return "carved cavern stone, damp mineral surfaces, and worn dungeon pathways";
    return "weathered fantasy terrain with believable natural wear";
  })();

  const vegetationDensity = (() => {
    if (themeText.includes("forest") || themeText.includes("jungle")) return "dense mossy vegetation, creeping vines, and root overgrowth around ruins";
    if (themeText.includes("swamp")) return "thick reeds, low marsh plants, and patchy overgrown banks";
    if (themeText.includes("desert") || themeText.includes("volcanic")) return "sparse hardy vegetation with clear exposed terrain";
    return "moderate natural growth focused near edges and broken structures";
  })();

  const pathSystem = (() => {
    if (hasTerrain("road")) return "ancient cracked stone pathways connecting key combat zones";
    if (hasTerrain("bridge") || hasTerrain("river")) return "clear traversal routes toward crossing points and flanking lanes";
    return "clear primary and secondary paths with readable encounter circulation";
  })();

  const elevation = (() => {
    if (hasTerrain("cliffs")) return "layered elevation shelves with cliff edges, ramps, and tactical high ground";
    if (hasTerrain("waterfall")) return "subtle elevation rise feeding a waterfall edge and lower basin";
    return "gentle elevation variation for depth without blocking map readability";
  })();

  const waterFeatures = (() => {
    if (hasTerrain("waterfall")) return "shallow stream crossing beneath a weathered waterfall lip";
    if (hasTerrain("river")) return "narrow stream channels with natural crossing points and wet shoreline detail";
    if (hasTerrain("pond") || hasTerrain("lake")) return "still water pockets with shoreline vegetation and reflective highlights";
    if (hasTerrain("lava")) return "glowing lava channels replacing water with hazardous molten flow";
    return "minimal water focus, prioritizing dry tactical movement";
  })();

  const architectureStyle = (() => {
    if (themeText.includes("ruins") || themeText.includes("temple")) {
      return "broken temple walls, collapsed pillars, fractured arches, and carved stone relic fragments";
    }
    if (themeText.includes("dungeon") || themeText.includes("crypt")) {
      return "aged dungeon masonry, reinforced chambers, cracked corridors, and ritual stonework";
    }
    if (themeText.includes("castle") || themeText.includes("fortress")) {
      return "fortified stone architecture with damaged battlement remains and defensive geometry";
    }
    if (themeText.includes("village") || themeText.includes("camp") || themeText.includes("tavern")) {
      return "frontier settlement structures with practical timber-stone construction and worn ground detail";
    }
    return "cohesive fantasy architecture with believable ruin and weathering detail";
  })();

  const losBlockers = (() => {
    const blockers = [];
    if (hasTerrain("pillars")) blockers.push("standing and collapsed pillars");
    if (hasTerrain("trees")) blockers.push("tree trunks and heavy roots");
    if (hasTerrain("cliffs")) blockers.push("rock outcrops and cliff protrusions");
    if (hasTerrain("rubble") || themeText.includes("ruins")) blockers.push("scattered rubble and broken wall segments");
    return blockers.length > 0 ? blockers.join(", ") : "intentional stone debris clusters and natural blockers";
  })();

  const storytelling = (() => {
    const notes = [];
    if (hasTerrain("altar")) notes.push("a worn ritual focal point with surrounding debris");
    if (hasTerrain("treasure")) notes.push("subtle treasure-site storytelling through ruined containers and relic fragments");
    if ((plan.rooms ?? []).some((room) => room.type === "boss_room")) notes.push("a dramatic central encounter zone with readable approach lanes");
    if ((plan.rooms ?? []).some((room) => room.type === "hidden_room")) notes.push("a hinted concealed section suggested by broken masonry and offset pathways");
    return notes.length > 0 ? notes.join("; ") : "environmental storytelling through ruin damage, weathering, and traversal wear";
  })();

  const graphGuidance = layoutGraph ? summarizeLayoutGraphForPrompt(layoutGraph) : "no explicit graph guidance";
  const compositionNotes = (plan.compositionNotes ?? []).join("; ") || "balanced composition with strong gameplay readability";

  return [
    "TRUE TOP DOWN BATTLE MAP.",
    "90 DEGREE ORTHOGRAPHIC CAMERA.",
    "GRIDLESS.",
    "DUNGEONS AND DRAGONS VTT MAP.",
    "HAND PAINTED INKARNATE STYLE.",
    "HIGH DETAIL ENVIRONMENT TEXTURES.",
    "PROFESSIONAL FANTASY CARTOGRAPHY.",
    "NO CHARACTERS.",
    "NO TEXT.",
    "NO LABELS.",
    "NO UI ELEMENTS.",
    "NO ISOMETRIC.",
    "NO PERSPECTIVE CAMERA.",
    "NO CINEMATIC ANGLES.",
    `Biome and setting: ${plan.biome}, ${plan.theme}, ${plan.mapSize} scale (${plan.estimatedGrid}), ${plan.lightingMood} mood.`,
    `Terrain direction: ${terrainType}.`,
    `Vegetation density: ${vegetationDensity}.`,
    `Road and path system: ${pathSystem}.`,
    `Elevation language: ${elevation}.`,
    `Water feature treatment: ${waterFeatures}.`,
    `Architectural style: ${architectureStyle}.`,
    `Encounter readability: open combat clearings, clear walkable spaces, clean lane readability, and deliberate chokepoints.`,
    `Line-of-sight blockers: ${losBlockers}.`,
    `Environmental storytelling: ${storytelling}.`,
    `Planned encounter program: ${roomSummary || "primary encounter spaces with supporting side areas"}.`,
    `Creative intent notes: ${compositionNotes}.`,
    `Layout graph is guidance only, prioritize beauty and painterly composition over strict graph fidelity: ${graphGuidance}.`
  ].join("\n");
}

function summarizeLayoutGraphForPrompt(layoutGraph) {
  const entrance = layoutGraph.nodes.find((node) => node.type === "entrance");
  const bossRoom = layoutGraph.nodes.find((node) => node.type === "boss_room");
  const sideRooms = layoutGraph.nodes.filter((node) => node.type === "side_room");
  const river = layoutGraph.terrainAnchors.find((anchor) => anchor.type === "river");
  const bridge = layoutGraph.terrainAnchors.find((anchor) => anchor.type === "bridge");

  const parts = [];
  if (entrance) parts.push(`entrance in ${entrance.position}`);
  if (bossRoom) parts.push(`boss room in ${bossRoom.position}`);
  if (sideRooms.length > 0) {
    const positions = sideRooms.map((room) => room.position).join(" and ");
    parts.push(`side rooms ${positions}`);
  }
  if (river) parts.push(`river runs ${river.path} through center`);
  if (bridge) parts.push(`bridge crosses river ${bridge.position}`);

  return parts.join("; ") || "central area with branching encounters";
}

/**
 * Map AI planner theme output into SceneForge's current supported themes.
 */
function mapAiPlanThemeToSceneTheme(plan) {
  const themeText = `${plan.theme} ${plan.biome}`.toLowerCase();
  if (themeText.includes("tavern") || themeText.includes("village") || themeText.includes("camp")) return "tavern";
  if (themeText.includes("cave") || themeText.includes("underground") || themeText.includes("sewer")) return "cave";
  if (themeText.includes("forest") || themeText.includes("jungle") || themeText.includes("ruins") || themeText.includes("temple")) return "forest-ruins";
  return "dungeon";
}

function mapAiPlanSizeToSceneSizeKey(mapSize) {
  if (mapSize === "small" || mapSize === "large" || mapSize === "medium") return mapSize;
  return "medium";
}

function mapAiPlanLightingToSceneLighting(lightingMood) {
  if (["bright", "dim", "dark", "magical"].includes(lightingMood)) return lightingMood;
  if (lightingMood === "torchlit") return "dim";
  return "dim";
}

/**
 * Apply AI plan room/terrain hints into existing feature toggles.
 */
function applyAiPlanFeaturesToDetected(detected, plan) {
  const clone = foundry.utils.deepClone(detected ?? parsePromptForSceneSettings(""));
  const roomTypes = (plan.rooms ?? []).map((room) => room.type);
  const terrain = plan.terrainFeatures ?? [];

  clone.features.bossRoom = clone.features.bossRoom || roomTypes.includes("boss_room");
  clone.features.hiddenRoom = clone.features.hiddenRoom || roomTypes.includes("hidden_room") || terrain.includes("hidden room");
  clone.features.sideRooms = clone.features.sideRooms || roomTypes.includes("side_room") || terrain.includes("side rooms");
  const plannedSideRoom = plan.rooms.find((room) => room.type === "side_room");
  if (plannedSideRoom?.count) clone.features.sideRoomsCount = Number(plannedSideRoom.count);
  clone.features.pillars = clone.features.pillars || terrain.includes("pillars");
  clone.features.altar = clone.features.altar || terrain.includes("altar");
  clone.features.treasure = clone.features.treasure || terrain.includes("treasure");
  clone.features.cells = clone.features.cells || terrain.includes("prison cells");

  return clone;
}

/**
 * Human-readable AI plan bullet summary for preview mode.
 */
function buildAiPlanReadableSummary(plan) {
  const terrainSummary = plan.terrainFeatures.length > 0 ? plan.terrainFeatures.join(", ") : "none";
  const roomSummary = plan.rooms.length > 0
    ? plan.rooms.map((room) => room.count ? `${room.type} x${room.count}` : room.type).join(", ")
    : "none";
  return [
    `Biome: ${plan.biome}`,
    `Theme: ${plan.theme}`,
    `Style: ${plan.style}`,
    `Map Size: ${plan.mapSize} (${plan.estimatedGrid})`,
    `Room Count: ${plan.roomCount}`,
    `Lighting Mood: ${plan.lightingMood}`,
    `Rooms: ${roomSummary}`,
    `Terrain: ${terrainSummary}`
  ];
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
  const text = prompt.toLowerCase();
  const matchKeywords = (keywords) => keywords.filter((k) => text.includes(k));
  const hasAny = (keywords) => matchKeywords(keywords).length > 0;

  const themeRules = {
    tavern: ["tavern", "inn", "bar", "pub", "alehouse"],
    cave: ["cave", "cavern", "grotto", "underground", "tunnel"],
    "forest-ruins": ["forest", "ruins", "ruined", "forest temple", "temple", "overgrown", "jungle"],
    dungeon: ["dungeon", "crypt", "catacomb", "cells", "prison", "fortress"]
  };

  const themeMatches = {};
  const themeScores = {};
  for (const [themeKey, keywords] of Object.entries(themeRules)) {
    const matched = matchKeywords(keywords);
    themeMatches[themeKey] = matched;
    themeScores[themeKey] = matched.length;
  }

  const sortedThemes = Object.entries(themeScores).sort((a, b) => b[1] - a[1]);
  const bestTheme = sortedThemes[0]?.[1] > 0 ? sortedThemes[0][0] : "dungeon";

  const lightingRules = {
    magical: ["magical", "arcane", "rune", "runes", "glowing sigil", "sigil"],
    night: ["night", "moonlit", "midnight"],
    dark: ["dark", "pitch black", "gloom"],
    bright: ["bright", "sunlit", "well lit"],
    dim: ["dim", "low light", "shadowy"]
  };

  let lightingMood = "dim";
  let matchedLightingKeywords = [];
  for (const mood of ["magical", "night", "dark", "bright", "dim"]) {
    const matched = matchKeywords(lightingRules[mood]);
    if (matched.length > 0) {
      lightingMood = mood;
      matchedLightingKeywords = matched;
      break;
    }
  }

  const sideRoomsCount = detectCountFromPrompt(text, ["side room", "side rooms"], 2);

  const featureRules = {
    bossRoom: ["boss room", "boss chamber", "final chamber", "throne room"],
    sideRooms: ["side room", "side rooms", "wing", "wings"],
    storageRoom: ["storage", "storeroom", "supply room", "pantry"],
    altar: ["altar", "shrine", "sacrificial"],
    pillars: ["pillar", "pillars", "columns", "column"],
    hiddenRoom: ["hidden room", "secret room", "secret chamber", "hidden chamber"],
    treasure: ["treasure", "loot", "hoard", "chest", "vault"],
    water: ["water", "pool", "river", "stream", "flooded"],
    traps: ["trap", "traps", "spike", "pitfall", "tripwire"],
    campfire: ["campfire", "bonfire", "fire pit"],
    bar: ["bar", "counter", "taproom"],
    cells: ["cells", "cell block", "prison cell", "jail"]
  };

  const featureMatchedKeywords = [];
  const features = { sideRoomsCount };
  for (const key of FEATURE_KEYS) {
    const matched = matchKeywords(featureRules[key] ?? []);
    features[key] = matched.length > 0;
    if (matched.length > 0) {
      featureMatchedKeywords.push(...matched);
    }
  }

  // Keep useful implications for common natural prompts.
  if (hasAny(["forest temple", "boss room", "boss chamber"])) features.bossRoom = true;

  const enabledFeatureCount = FEATURE_KEYS.reduce((sum, key) => sum + (features[key] ? 1 : 0), 0);
  let suggestedSize = "medium";
  if (enabledFeatureCount >= 5) suggestedSize = "large";
  else if (enabledFeatureCount <= 1) suggestedSize = "small";

  return {
    theme: bestTheme,
    lightingMood,
    features,
    suggestedSize,
    featureCount: enabledFeatureCount,
    matchedKeywords: {
      theme: dedupeKeywords(themeMatches[bestTheme] ?? []),
      lighting: dedupeKeywords(matchedLightingKeywords),
      features: dedupeKeywords(featureMatchedKeywords)
    }
  };
}

/**
 * Convert scene size key to display text.
 */
function formatSceneSizeLabel(sceneSizeKey) {
  const labels = {
    small: "Small (30x30)",
    medium: "Medium (50x50)",
    large: "Large (70x70)"
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
