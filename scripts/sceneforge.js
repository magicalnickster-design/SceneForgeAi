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

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing SceneForge AI module`);
});

/**
 * Add the "Generate Scene" button to the Scene Directory footer.
 */
Hooks.on("renderSceneDirectory", (app, html) => {
  if (!game.user?.isGM) return;
  if (html.find(".sceneforge-generate-btn").length > 0) return;

  const button = $(`
    <button type="button" class="sceneforge-generate-btn">
      <i class="fas fa-wand-magic-sparkles"></i> Generate Scene
    </button>
  `);

  button.on("click", async () => {
    await openGeneratorDialog();
  });

  html.find(".directory-footer").append(button);
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
});

/**
 * Resolve a Scene document from a Scene Directory <li>.
 * The dataset key can vary by Foundry version, so we check multiple keys.
 */
function getSceneFromDirectoryLi(li) {
  const sceneId =
    li?.data?.("documentId")
    ?? li?.data?.("entryId")
    ?? li?.[0]?.dataset?.documentId
    ?? li?.[0]?.dataset?.entryId;

  if (!sceneId) return null;
  return game.scenes.get(sceneId) ?? null;
}

/**
 * Open the generator dialog from our template.
 */
async function openGeneratorDialog() {
  const content = await renderTemplate(`modules/${MODULE_ID}/templates/generator-dialog.html`);

  const dialog = new Dialog({
    title: "SceneForge AI - Generate Scene",
    content,
    buttons: {
      generate: {
        icon: '<i class="fas fa-wand-magic-sparkles"></i>',
        label: "Generate",
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
      wireAutoDetectUi(dialogHtml);
    }
  });

  dialog.render(true);
}

/**
 * Wire click behavior for "Auto Detect From Prompt".
 * The detected payload is cached in the form's jQuery data so Generate can reuse it.
 */
function wireAutoDetectUi(dialogHtml) {
  const form = dialogHtml.find(".sceneforge-form");
  const autoDetectButton = dialogHtml.find(".sceneforge-autodetect-btn");

  autoDetectButton.on("click", () => {
    const prompt = String(form.find('[name="prompt"]').val() ?? "").trim();
    if (!prompt) {
      ui.notifications.warn("SceneForge AI: Enter a prompt before auto-detecting.");
      return;
    }

    const detected = parsePromptForSceneSettings(prompt);

    // Apply suggested options into dropdowns so the user can accept or tweak.
    form.find('[name="theme"]').val(detected.theme);
    form.find('[name="sceneSize"]').val(detected.suggestedSize);

    // Save detected payload for Generate.
    form.data("sceneforgeDetected", detected);

    renderDetectedResults(dialogHtml, detected);
  });
}

/**
 * Handle first-time generation from dialog values.
 */
async function handleGenerate(dialogHtml) {
  const form = dialogHtml.find(".sceneforge-form");
  const prompt = String(form.find('[name="prompt"]').val() ?? "").trim();
  let sceneSizeKey = String(form.find('[name="sceneSize"]').val() ?? "medium");
  let theme = String(form.find('[name="theme"]').val() ?? "dungeon");

  // If user leaves seed blank, we create one now and persist it in scene flags.
  const seedInput = String(form.find('[name="seed"]').val() ?? "").trim();
  const seed = seedInput || randomSeedString();

  if (!prompt) {
    ui.notifications.warn("SceneForge AI: Please enter a prompt before generating.");
    return;
  }

  // Parse from current prompt during Generate so data always matches latest text.
  const detected = parsePromptForSceneSettings(prompt);

  // Keep selected dropdown values authoritative (user can override suggestions).
  theme = theme || detected.theme;
  sceneSizeKey = sceneSizeKey || detected.suggestedSize;

  const gridCells = SCENE_SIZES[sceneSizeKey] ?? SCENE_SIZES.medium;
  const widthPx = gridCells * GRID_SIZE_PX;
  const heightPx = gridCells * GRID_SIZE_PX;

  const generationData = {
    prompt,
    sceneSizeKey,
    theme,
    lightingMood: detected.lightingMood,
    detected,
    seed,
    moduleVersion: "0.3.0"
  };

  const sceneName = `SceneForge - ${formatThemeLabel(theme)} - ${seed}`;

  try {
    const scene = await Scene.create({
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
          [FLAG_GENERATION_KEY]: generationData
        }
      }
    });

    if (!scene) {
      throw new Error("Scene creation returned no scene document.");
    }

    await generateSceneLayout(scene, generationData);

    if (!seedInput) {
      ui.notifications.info(`SceneForge AI: Seed auto-generated as "${seed}".`);
    }
    ui.notifications.info(`SceneForge AI: Created "${scene.name}" successfully.`);
  } catch (error) {
    console.error(`${MODULE_ID} | Scene generation failed`, error);
    ui.notifications.error("SceneForge AI: Failed to generate scene. Check browser console for details.");
  }
}

/**
 * Render detected values in the dialog so users can review before generating.
 */
function renderDetectedResults(dialogHtml, detected) {
  const content = dialogHtml.find(".sceneforge-detected-content");
  const enabledFeatures = FEATURE_KEYS.filter((key) => detected.features[key]);
  const featureListHtml = enabledFeatures.length > 0
    ? enabledFeatures.map((key) => `<li>${foundry.utils.escapeHTML(formatFeatureLabel(key, detected.features))}</li>`).join("")
    : "<li>No specific feature keywords detected.</li>";

  content.html(`
    <p><strong>Theme:</strong> ${foundry.utils.escapeHTML(formatThemeLabel(detected.theme))}</p>
    <p><strong>Lighting Mood:</strong> ${foundry.utils.escapeHTML(LIGHTING_MOOD_LABELS[detected.lightingMood] ?? "Dim")}</p>
    <p><strong>Suggested Size:</strong> ${foundry.utils.escapeHTML(formatSceneSizeLabel(detected.suggestedSize))}</p>
    <p><strong>Detected Features:</strong></p>
    <ul>${featureListHtml}</ul>
  `);
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

  const walls = buildThemeWalls(theme, widthPx, heightPx, rng, seed, detected);
  const lights = buildThemeLights(theme, widthPx, heightPx, rng, seed, lightingMood, detected);

  if (walls.length > 0) {
    await scene.createEmbeddedDocuments("Wall", walls);
  }

  if (lights.length > 0) {
    await scene.createEmbeddedDocuments("AmbientLight", lights);
  }

  const summaryText = buildPromptSummary(prompt, sceneSizeKey, theme, seed, lightingMood, detected, isRegeneration);
  const journal = await JournalEntry.create({
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
  });

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
    if (detected.features.treasure) {
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

    await scene.createEmbeddedDocuments("Note", notesToCreate);
  }

  await scene.setFlag(MODULE_ID, FLAG_GENERATION_KEY, {
    prompt,
    sceneSizeKey,
    theme,
    lightingMood,
    detected,
    seed,
    moduleVersion: "0.3.0",
    lastGeneratedAt: Date.now()
  });
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
    move: CONST.WALL_SENSE_TYPES.NORMAL,
    sight: CONST.WALL_SENSE_TYPES.NORMAL,
    sound: CONST.WALL_SENSE_TYPES.NORMAL,
    door: CONST.WALL_DOOR_TYPES.NONE,
    ds: CONST.WALL_DOOR_STATES.CLOSED
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
function buildPromptSummary(prompt, sceneSizeKey, theme, seed, lightingMood, detected, isRegeneration) {
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
<p><strong>Seed:</strong> ${foundry.utils.escapeHTML(seed)}</p>
<p><strong>Generation Mode:</strong> ${isRegeneration ? "Regenerated from scene flags" : "Initial generation"}</p>
<p>This layout is deterministic and local-only. No external AI API calls are used.</p>
  `.trim();
}

/**
 * Parse a natural-language prompt using local keyword rules only.
 * No external API calls are made.
 */
function parsePromptForSceneSettings(prompt) {
  const text = prompt.toLowerCase();
  const has = (keywords) => keywords.some((k) => text.includes(k));
  const countHits = (keywords) => keywords.reduce((sum, k) => sum + (text.includes(k) ? 1 : 0), 0);

  // Theme scoring lets multiple clues compete.
  const themeScores = {
    tavern: countHits(["tavern", "inn", "bar", "pub", "alehouse"]),
    cave: countHits(["cave", "cavern", "grotto", "underground", "tunnel"]),
    "forest-ruins": countHits(["forest", "ruins", "ruined", "temple", "overgrown", "jungle"]),
    dungeon: countHits(["dungeon", "crypt", "catacomb", "cells", "prison", "fortress"])
  };

  const sortedThemes = Object.entries(themeScores).sort((a, b) => b[1] - a[1]);
  const bestTheme = sortedThemes[0]?.[1] > 0 ? sortedThemes[0][0] : "dungeon";

  let lightingMood = "dim";
  if (has(["magical", "arcane", "rune", "runes", "glowing sigil", "sigil"])) lightingMood = "magical";
  else if (has(["night", "moonlit", "midnight"])) lightingMood = "night";
  else if (has(["dark", "pitch black", "gloom"])) lightingMood = "dark";
  else if (has(["bright", "sunlit", "well lit"])) lightingMood = "bright";
  else if (has(["dim", "low light", "shadowy"])) lightingMood = "dim";

  const sideRoomsCount = detectCountFromPrompt(text, ["side room", "side rooms"], 2);

  const features = {
    bossRoom: has(["boss room", "boss chamber", "final chamber", "throne room"]),
    sideRooms: has(["side room", "side rooms", "wing", "wings"]),
    sideRoomsCount,
    storageRoom: has(["storage", "storeroom", "supply room", "pantry"]),
    altar: has(["altar", "shrine", "sacrificial"]),
    pillars: has(["pillar", "pillars", "columns", "column"]),
    hiddenRoom: has(["hidden room", "secret room", "secret chamber", "hidden chamber"]),
    treasure: has(["treasure", "loot", "hoard", "chest", "vault"]),
    water: has(["water", "pool", "river", "stream", "flooded"]),
    traps: has(["trap", "traps", "spike", "pitfall", "tripwire"]),
    campfire: has(["campfire", "bonfire", "fire pit"]),
    bar: has(["bar", "counter", "taproom"]),
    cells: has(["cells", "cell block", "prison cell", "jail"])
  };

  const enabledFeatureCount = FEATURE_KEYS.reduce((sum, key) => sum + (features[key] ? 1 : 0), 0);
  let suggestedSize = "medium";
  if (enabledFeatureCount >= 5) suggestedSize = "large";
  else if (enabledFeatureCount <= 1) suggestedSize = "small";

  return {
    theme: bestTheme,
    lightingMood,
    features,
    suggestedSize,
    featureCount: enabledFeatureCount
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
    const numericRegex = new RegExp(`(\\d+)\\s+${phrase.replace(" ", "\\s+")}`);
    const numericMatch = text.match(numericRegex);
    if (numericMatch) {
      return Math.max(1, Number(numericMatch[1]));
    }

    for (const [word, value] of Object.entries(numberWords)) {
      const wordRegex = new RegExp(`${word}\\s+${phrase.replace(" ", "\\s+")}`);
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
