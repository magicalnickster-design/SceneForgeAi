/**
 * SceneForge AI (MVP)
 * -------------------
 * This module adds a "Generate Scene" button to the Scene Directory.
 * The dialog accepts a prompt, scene size, and theme, then creates:
 *  - a new Scene
 *  - basic walls
 *  - ambient lights
 *  - a Journal Entry + Note with the prompt summary
 *
 * Important: This is intentionally deterministic and does NOT call real AI.
 */

const MODULE_ID = "sceneforge-ai";
const GRID_SIZE_PX = 100;

/**
 * Scene sizes are expressed in grid cells (squares).
 * Foundry Scene width/height are in pixels, so we convert later.
 */
const SCENE_SIZES = {
  small: 30,
  medium: 50,
  large: 70
};

/**
 * Adds module startup logging to make initialization visible in browser console.
 */
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing SceneForge AI module`);
});

/**
 * Inject a "Generate Scene" button into the Scene Directory footer.
 * This hook runs every time the Scene Directory is rendered.
 */
Hooks.on("renderSceneDirectory", (app, html) => {
  // Only GMs should be allowed to generate and create scenes.
  if (!game.user?.isGM) return;

  // Prevent duplicate button insertion when directory re-renders.
  if (html.find(".sceneforge-generate-btn").length > 0) return;

  const button = $(`
    <button type="button" class="sceneforge-generate-btn">
      <i class="fas fa-wand-magic-sparkles"></i> Generate Scene
    </button>
  `);

  button.on("click", async () => {
    await openGeneratorDialog();
  });

  // Foundry directory footers typically host action buttons.
  html.find(".directory-footer").append(button);
});

/**
 * Opens the scene generator dialog UI from our template file.
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
    default: "generate"
  });

  dialog.render(true);
}

/**
 * Handles form submission from the generator dialog.
 * @param {jQuery} dialogHtml - The dialog's jQuery-wrapped HTML root.
 */
async function handleGenerate(dialogHtml) {
  // Read raw values from form fields.
  const prompt = String(dialogHtml.find('[name="prompt"]').val() ?? "").trim();
  const sceneSizeKey = String(dialogHtml.find('[name="sceneSize"]').val() ?? "medium");
  const theme = String(dialogHtml.find('[name="theme"]').val() ?? "dungeon");

  if (!prompt) {
    ui.notifications.warn("SceneForge AI: Please enter a prompt before generating.");
    return;
  }

  // Fallback to medium if an unexpected value is provided.
  const gridCells = SCENE_SIZES[sceneSizeKey] ?? SCENE_SIZES.medium;
  const widthPx = gridCells * GRID_SIZE_PX;
  const heightPx = gridCells * GRID_SIZE_PX;

  // Keep scene names human-readable and include theme context.
  const sceneName = `SceneForge - ${formatThemeLabel(theme)} - ${new Date().toLocaleTimeString()}`;

  try {
    // 1) Create the base scene first.
    const scene = await Scene.create({
      name: sceneName,
      width: widthPx,
      height: heightPx,
      padding: 0.1,
      // v12 grid configuration.
      grid: {
        type: CONST.GRID_TYPES.SQUARE,
        size: GRID_SIZE_PX,
        distance: 5,
        units: "ft"
      },
      // Default background color so the scene is not pure black.
      backgroundColor: "#2b2b2b",
      navigation: true
    });

    if (!scene) {
      throw new Error("Scene creation returned no scene document.");
    }

    // 2) Build walls and lights according to chosen theme.
    const walls = buildThemeWalls(theme, widthPx, heightPx);
    const lights = buildThemeLights(theme, widthPx, heightPx);

    if (walls.length > 0) {
      await scene.createEmbeddedDocuments("Wall", walls);
    }

    if (lights.length > 0) {
      await scene.createEmbeddedDocuments("AmbientLight", lights);
    }

    // 3) Create a Journal Entry with summary text and drop a Note in scene.
    const summaryText = buildPromptSummary(prompt, sceneSizeKey, theme);
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
      ]
    });

    const firstPage = journal?.pages?.contents?.[0];
    if (journal && firstPage) {
      await scene.createEmbeddedDocuments("Note", [
        {
          x: Math.floor(widthPx * 0.5),
          y: Math.floor(heightPx * 0.5),
          entryId: journal.id,
          pageId: firstPage.id,
          iconSize: 40,
          text: "SceneForge Prompt Notes"
        }
      ]);
    }

    ui.notifications.info(`SceneForge AI: Created "${scene.name}" successfully.`);
  } catch (error) {
    console.error(`${MODULE_ID} | Scene generation failed`, error);
    ui.notifications.error("SceneForge AI: Failed to generate scene. Check browser console for details.");
  }
}

/**
 * Create themed wall data.
 * We always include outer boundary walls so tokens stay inside the map.
 */
function buildThemeWalls(theme, widthPx, heightPx) {
  const walls = [];
  const wallDefaults = {
    move: CONST.WALL_SENSE_TYPES.NORMAL,
    sight: CONST.WALL_SENSE_TYPES.NORMAL,
    sound: CONST.WALL_SENSE_TYPES.NORMAL,
    door: CONST.WALL_DOOR_TYPES.NONE,
    ds: CONST.WALL_DOOR_STATES.CLOSED
  };

  const pushWall = (x1, y1, x2, y2) => {
    walls.push({
      c: [x1, y1, x2, y2],
      ...wallDefaults
    });
  };

  // Outer rectangle perimeter.
  pushWall(0, 0, widthPx, 0);
  pushWall(widthPx, 0, widthPx, heightPx);
  pushWall(widthPx, heightPx, 0, heightPx);
  pushWall(0, heightPx, 0, 0);

  // Common helper values.
  const cx = Math.floor(widthPx / 2);
  const cy = Math.floor(heightPx / 2);
  const quarterW = Math.floor(widthPx / 4);
  const quarterH = Math.floor(heightPx / 4);

  switch (theme) {
    case "tavern":
      // Main hall and two side rooms.
      pushWall(quarterW, quarterH, quarterW, heightPx - quarterH);
      pushWall(widthPx - quarterW, quarterH, widthPx - quarterW, heightPx - quarterH);
      pushWall(quarterW, quarterH, widthPx - quarterW, quarterH);
      break;

    case "cave":
      // Jagged-ish cave passages from straight segments.
      pushWall(quarterW, quarterH, cx, quarterH - 120);
      pushWall(cx, quarterH - 120, widthPx - quarterW, quarterH + 40);
      pushWall(quarterW + 80, cy + 70, cx, cy + 160);
      pushWall(cx, cy + 160, widthPx - quarterW - 120, cy + 40);
      break;

    case "forest-ruins":
      // Temple room + two side chambers.
      pushWall(cx - 700, cy - 500, cx + 700, cy - 500);
      pushWall(cx + 700, cy - 500, cx + 700, cy + 500);
      pushWall(cx + 700, cy + 500, cx - 700, cy + 500);
      pushWall(cx - 700, cy + 500, cx - 700, cy - 500);
      // Side chamber dividers.
      pushWall(cx - 300, cy - 500, cx - 300, cy + 500);
      pushWall(cx + 300, cy - 500, cx + 300, cy + 500);
      break;

    case "dungeon":
    default:
      // Basic room-and-corridor style partitions.
      pushWall(quarterW, quarterH, widthPx - quarterW, quarterH);
      pushWall(quarterW, heightPx - quarterH, widthPx - quarterW, heightPx - quarterH);
      pushWall(quarterW, quarterH, quarterW, cy);
      pushWall(widthPx - quarterW, cy, widthPx - quarterW, heightPx - quarterH);
      pushWall(cx - 200, cy, cx + 200, cy);
      break;
  }

  return walls;
}

/**
 * Create themed ambient lights to make the scene immediately playable.
 */
function buildThemeLights(theme, widthPx, heightPx) {
  const lights = [];

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

    // Merge nested config overrides without losing defaults.
    const mergedConfig = foundry.utils.mergeObject(defaultConfig, overrides.config ?? {}, {
      inplace: false
    });

    const lightData = foundry.utils.mergeObject(
      {
        x,
        y,
        rotation: 0,
        walls: true,
        vision: false,
        config: mergedConfig
      },
      overrides,
      { inplace: false }
    );

    // We already merged config above; remove raw override copy to avoid conflicts.
    delete lightData.config;

    lights.push({
      ...lightData,
      config: mergedConfig
    });
  };

  const cx = Math.floor(widthPx / 2);
  const cy = Math.floor(heightPx / 2);

  switch (theme) {
    case "tavern":
      pushLight(cx - 400, cy - 200);
      pushLight(cx + 400, cy - 200);
      pushLight(cx, cy + 200, { config: { bright: 8, dim: 20, color: "#ffd27a" } });
      break;
    case "cave":
      pushLight(cx - 500, cy - 250, { config: { bright: 4, dim: 14, color: "#ffb347" } });
      pushLight(cx + 50, cy, { config: { bright: 4, dim: 14, color: "#ffb347" } });
      pushLight(cx + 450, cy + 220, { config: { bright: 4, dim: 14, color: "#ffb347" } });
      break;
    case "forest-ruins":
      pushLight(cx - 450, cy - 300);
      pushLight(cx + 450, cy - 300);
      pushLight(cx, cy + 260, { config: { bright: 7, dim: 22, color: "#ffc46b" } });
      break;
    case "dungeon":
    default:
      pushLight(cx - 350, cy - 250);
      pushLight(cx + 350, cy - 250);
      pushLight(cx - 350, cy + 250);
      pushLight(cx + 350, cy + 250);
      break;
  }

  return lights;
}

/**
 * Human-readable theme text for scene naming and journal summary.
 */
function formatThemeLabel(theme) {
  const labels = {
    tavern: "Tavern",
    cave: "Cave",
    "forest-ruins": "Forest Ruins",
    dungeon: "Dungeon"
  };

  return labels[theme] ?? "Dungeon";
}

/**
 * Builds the note content shown in the generated Journal Entry.
 */
function buildPromptSummary(prompt, sceneSizeKey, theme) {
  const sceneSizeLabel = {
    small: "Small (30x30)",
    medium: "Medium (50x50)",
    large: "Large (70x70)"
  }[sceneSizeKey] ?? "Medium (50x50)";

  return `
<h2>SceneForge AI Prompt Summary</h2>
<p><strong>Prompt:</strong> ${foundry.utils.escapeHTML(prompt)}</p>
<p><strong>Theme:</strong> ${formatThemeLabel(theme)}</p>
<p><strong>Scene Size:</strong> ${sceneSizeLabel}</p>
<p>This scene was generated by the SceneForge AI MVP using deterministic templates.</p>
  `.trim();
}
