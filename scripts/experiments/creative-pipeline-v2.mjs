#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadAiConfig } from "../ai/ai-config.mjs";
import { loadImagePayloads } from "../ai/ai-image-input.mjs";
import { generateStructuredJson } from "../ai/ai-service.mjs";

const DEFAULT_WORKSPACE = "workspace";
const OUTPUT_ROOT = path.join("experiments", "creative_pipeline_v2");
const MODEL = "gpt-image-2";

// Generic mode is the DEFAULT: product identity comes only from the real reference
// photos + general design knowledge, with NO same-category product templates or
// knowledge (this is what stopped the cross-product contamination + distortion).
// Set SELLIFYX_CATEGORY_MODE=1 to opt back into the old per-category archetype mode.
// Read live (not frozen at import) so it can be toggled per run.
function categoryModeEnabled() {
  return process.env.SELLIFYX_CATEGORY_MODE === "1";
}
const IMAGE_EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
// Final delivered image (produced locally by sharp). Configurable via env
// (same names as ai-config.mjs so there is one convention).
const FINAL_IMAGE_SIZE = Number(process.env.FINAL_IMAGE_SIZE) || 800;
const FINAL_IMAGE_FORMAT = "jpeg";
const FINAL_IMAGE_QUALITY = Math.max(1, Math.min(100, Number(process.env.FINAL_IMAGE_JPEG_QUALITY) || 70));
const execFileAsync = promisify(execFile);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function safeOutputSegment(value) {
  return String(value ?? "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "project";
}

const DEFAULT_PRODUCT_DNA = {
  identity: {
    category: "Glass Water Pitcher / Teapot",
    shape: "Large rounded clear glass pitcher body",
    silhouette: "Rounded body with short neck, bamboo lid, right handle, and angled left spout",
    material: "Clear borosilicate glass with natural bamboo lid and stainless steel spring coil filter",
    color: "Transparent clear glass, warm natural bamboo lid, stainless steel coil",
    surface: "Glossy transparent glass with clean reflections and visible water/ice clarity",
    functional_parts: [
      "natural bamboo wooden round lid on top",
      "clear rounded glass body",
      "transparent glass handle on the right",
      "short angled glass pouring spout on the left",
      "visible stainless steel spring coil filter inside/near the spout opening"
    ],
    accessories: ["bamboo lid", "stainless steel spring coil filter"],
    geometry_constraints: [
      "preserve rounded body silhouette",
      "preserve right-side transparent handle",
      "preserve short angled left spout",
      "preserve bamboo lid on top",
      "preserve visible spiral coil filter; never turn it into a perforated plate, holes, or mesh dots",
      "keep product proportions consistent across the batch",
      "do not crop important product parts"
    ],
    must_not_change: [
      "do not remove the wooden lid",
      "do not redesign the spout",
      "do not replace the spring coil filter with a perforated filter",
      "do not change the body silhouette",
      "do not turn the product into a different pitcher or jar"
    ]
  }
};

const GENERIC_PRODUCT_DNA = {
  identity: {
    category: "Generic Ecommerce Product",
    shape: "UNKNOWN product shape from reference image",
    silhouette: "Preserve the exact product silhouette shown in the reference image",
    material: "UNKNOWN material unless visible or stated in product text",
    color: "Preserve visible product colors from the reference image",
    surface: "Preserve visible surface finish from the reference image",
    functional_parts: [
      "all visible main product parts from the reference image",
      "all visible accessories from the reference image",
      "all visible structural details from the reference image"
    ],
    accessories: [],
    geometry_constraints: [
      "preserve exact product silhouette from the reference image",
      "preserve all visible components and proportions",
      "do not remove, simplify, or redesign product parts",
      "do not change the product category",
      "do not invent unsupported accessories"
    ],
    must_not_change: [
      "do not redesign the product",
      "do not change product category",
      "do not remove visible components",
      "do not invent unsupported claims"
    ]
  }
};

const BABY_HIGH_CHAIR_PRODUCT_DNA = {
  identity: {
    category: "Baby High Chair / Children's Dining Chair",
    shape: "Compact child dining chair with rounded seat shell, removable front tray, high backrest, footrest, and four angled metal legs",
    silhouette: "Rounded PP plastic baby seat with curved back, wide dining tray with cup slot, gray tubular legs, lower foot pedal, anti-slip feet, and visible safety belt",
    material: "PP plastic seat and tray, stainless steel or metal legs, safety belt webbing, anti-slip foot pads",
    color: "Light neutral or pastel chair body with gray metal legs and small dark safety belt details",
    surface: "Smooth matte plastic seat and tray, slightly reflective metal legs, fabric safety strap",
    functional_parts: [
      "rounded baby seat shell with high backrest",
      "removable dining tray with cup slot",
      "two-level adjustable chair height",
      "front foot pedal or footrest",
      "four angled metal legs",
      "anti-slip foot pads",
      "3-point safety belt and buckle",
      "seat bucket and tray locking structure"
    ],
    accessories: [
      "removable dining tray",
      "foot pedal",
      "safety belt",
      "lower chair legs",
      "front upper chair legs",
      "rear upper chair legs",
      "foot pads"
    ],
    geometry_constraints: [
      "preserve the rounded baby seat shell and high backrest",
      "preserve the rectangular removable tray with rounded corners and cup slot",
      "preserve four angled metal legs with anti-slip foot pads",
      "preserve the lower footrest/foot pedal",
      "preserve visible safety belt or buckle when the card is about safety",
      "show two height modes only when the card is about adjustable height",
      "do not turn the chair into a stroller, adult chair, car seat, booster seat, or rocking chair",
      "do not remove the tray, footrest, legs, or safety belt when they are relevant to the concept"
    ],
    must_not_change: [
      "do not redesign the high chair silhouette",
      "do not remove the dining tray",
      "do not remove the footrest",
      "do not remove or invent extra legs",
      "do not change the product into a different baby furniture category",
      "do not show unsafe use, standing baby, climbing baby, or unattended risky scenes"
    ]
  }
};

const SINK_ORGANIZER_PRODUCT_DNA = {
  identity: {
    category: "Kitchen Sink Organizer / Storage Rack",
    shape: "Compact rectangular open sink organizer rack with vertical rail structure and lower drainage tray",
    silhouette: "Black rectangular basket rack with raised side rails, open slatted storage area, detachable cloth hanging rod, and sloped base tray for draining",
    material: "ABS plastic unless current product text or reference image proves another material",
    color: "Black or product-accurate color from the reference image",
    surface: "Smooth semi-matte plastic with subtle highlights and realistic sink-side reflections",
    dimensions: "Use only dimensions explicitly found in product text or source images",
    functional_parts: [
      "main rectangular open storage basket",
      "vertical side rails and horizontal rim",
      "lower drainage tray or water-catching base",
      "detachable cloth hanging rod",
      "open slots for sponge, brush, bottle, or cloth storage"
    ],
    accessories: ["detachable cloth hanging rod"],
    geometry_constraints: [
      "preserve the rectangular basket silhouette from the reference image",
      "preserve the vertical rail spacing and open wire-frame structure",
      "preserve the lower tray/base shape and drainage direction",
      "preserve the detachable cloth rod when relevant to the card",
      "do not turn the product into a dish rack, shelf, caddy bag, bottle holder, or faucet accessory",
      "do not add unsupported hooks, suction cups, brand marks, or extra modules"
    ],
    must_not_change: [
      "do not redesign the rack geometry",
      "do not remove the detachable cloth hanging rod when it is part of the concept",
      "do not change the open rail basket into a closed box",
      "do not change product color unless the reference image shows that variant",
      "do not add third-party logos or branded cleaning products"
    ]
  }
};

const TUMBLER_PRODUCT_DNA = {
  identity: {
    category: "Vacuum Insulated Tumbler / Travel Mug",
    shape: "Tall handled tumbler with tapered lower body, rotating lid, and reusable straw",
    silhouette: "Large insulated tumbler with side handle, wide upper body, narrow cup-holder base, rounded lid, and visible straight straw",
    material: "18/8 stainless steel body with transparent rotating lid and reusable straw when supported by source text or reference image",
    color: "Preserve visible tumbler color variants from the reference image",
    surface: "Smooth coated tumbler body with clean stainless rim and soft kitchen or lifestyle reflections",
    functional_parts: [
      "vacuum insulated tumbler body",
      "ergonomic side handle",
      "transparent rotating lid",
      "straight reusable straw",
      "tapered lower body sized for cup-holder style use",
      "double-wall stainless steel construction when supported by source text"
    ],
    accessories: [
      "reusable straw"
    ],
    geometry_constraints: [
      "preserve the tall tumbler silhouette from the reference image",
      "preserve the side handle shape and attachment points",
      "preserve the rotating lid structure and visible straw opening",
      "preserve the tapered lower body and wide upper chamber proportions",
      "do not turn the tumbler into a pitcher, teapot, kettle, bottle, mug without straw, or jar",
      "do not invent spouts, coil filters, bamboo lids, or unrelated drinkware components",
      "keep product proportions and lid-to-body ratio consistent across the batch"
    ],
    must_not_change: [
      "do not redesign the tumbler silhouette",
      "do not remove the handle when the full product is shown",
      "do not replace the rotating lid with a different lid system unless the concept is a detail crop proving the same lid",
      "do not add a spout, spring coil filter, bamboo lid, or pitcher neck",
      "do not change the product into another drinkware category"
    ]
  }
};

const CORDLESS_IMPACT_WRENCH_PRODUCT_DNA = {
  identity: {
    category: "Cordless Impact Wrench / Power Tool",
    shape: "Compact cordless impact wrench with pistol grip, square drive anvil, battery base, and reinforced metal front housing",
    silhouette: "Angular handheld power tool with short front nose, metallic hammer case, dark grip, teal or blue-black body accents, battery pack at the bottom, and visible forward/reverse controls",
    material: "Metal front housing, engineering plastic tool body, rubberized grip surfaces, removable battery pack",
    color: "Preserve the visible body colorway from the reference image, typically teal or blue accents with dark charcoal and metallic silver",
    surface: "Semi-matte industrial plastic with metallic front housing, functional texture, and realistic worksite highlights",
    functional_parts: [
      "square drive anvil or chuck at the front",
      "metal hammer housing",
      "main motor body with vent structure",
      "pistol grip handle",
      "trigger or speed switch area",
      "forward and reverse switch",
      "removable battery pack base",
      "LED work light if visible in the source image",
      "control panel or battery indicator if visible in the source image"
    ],
    accessories: [
      "battery pack",
      "charger",
      "socket set",
      "carry case"
    ],
    geometry_constraints: [
      "preserve the exact impact wrench silhouette from the reference image",
      "preserve the short front nose and square drive anvil geometry",
      "preserve the metallic hammer housing shape and proportions",
      "preserve the grip angle, trigger zone, and battery pack base",
      "preserve vent patterns, control panel placement, and visible switches when they appear in the source",
      "do not turn the tool into a drill, screwdriver, grinder, saw, washer, or other unrelated power tool",
      "keep product proportions consistent across the full campaign",
      "remove all brand logos, brand names, and third-party marks from the tool body and accessories"
    ],
    must_not_change: [
      "do not redesign the square drive front end",
      "do not change the tool into a different power tool category",
      "do not remove the battery base when the concept needs a full tool shot",
      "do not invent unsupported sockets, hoses, or add-on modules",
      "do not show third-party logos, branded labels, or marketplace watermarks"
    ]
  }
};

const EDUCATIONAL_MATH_BOARD_PRODUCT_DNA = {
  identity: {
    category: "Educational Math Toy Board / Montessori Learning Board",
    shape: "Wooden tabletop learning board set with upright math panel, lower storage tray, number tiles, counting sticks, toy clock, and chalkboard mode",
    silhouette: "Rectangular wooden tray base with a fold-up vertical learning board, left clock section, right arithmetic rows, lower storage area, and loose learning pieces",
    material: "Natural wood board and tray, painted number tiles, colored counting sticks, chalkboard panel, eraser block",
    color: "Natural light wood with bright multicolor number tiles and red yellow blue green counting sticks",
    surface: "Smooth wood with matte painted tiles, colorful teaching pieces, and clean tabletop toy finish",
    functional_parts: [
      "rectangular wooden tray base",
      "upright double-panel or fold-up learning board",
      "left analog teaching clock with colored time markers",
      "right arithmetic tile rows for addition subtraction multiplication and division",
      "comparison sign practice area",
      "lower storage tray for tiles and sticks",
      "colored counting sticks",
      "loose number tiles",
      "chalkboard drawing mode",
      "eraser block"
    ],
    accessories: [
      "number tiles",
      "counting sticks",
      "eraser block",
      "chalkboard panel"
    ],
    geometry_constraints: [
      "preserve the rectangular wooden tray silhouette",
      "preserve the upright learning board structure behind the tray",
      "preserve the left clock section and right arithmetic board relationship",
      "preserve the lower storage tray with loose learning pieces",
      "preserve the colored counting sticks and number tiles as teaching components",
      "do not turn the product into a laptop, whiteboard, puzzle cube, abacus, or unrelated toy category",
      "do not simplify the board into a single flat panel without tray depth",
      "keep product proportions and board-to-tray relationship consistent across the batch"
    ],
    must_not_change: [
      "do not remove the wooden tray base",
      "do not remove the upright board structure",
      "do not remove the clock section when the full product is shown",
      "do not remove the arithmetic tile rows when the full product is shown",
      "do not replace the learning pieces with unrelated blocks or beads",
      "do not change the product into another educational toy category"
    ]
  }
};

const EDUCATIONAL_MATH_BOARD_LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the full educational math board set with clear product identity and kid-friendly learning appeal",
    headline: "Hands-On Math Learning",
    unique_composition: "clean ecommerce hero showing the full wooden board set, lower tray, colorful sticks, and number tiles with a short benefit stack",
    unique_camera: "front three-quarter full-product angle with the board open and tray clearly visible",
    unique_background: "bright child-friendly study or playroom environment with soft depth",
    unique_lighting: "soft natural commercial light with crisp wood edges and colorful learning pieces clearly separated",
    unique_focal_point: "complete product silhouette including tray, upright board, clock, math rows, and counting components",
    scene_family: "EDUCATIONAL_TOY_HERO",
    layout_archetype: "PRODUCT_HERO_WITH_BENEFIT_STACK",
    product_position: "right or center-right, full product visible",
    camera_distance: "medium full-product hero shot",
    lighting_direction: "soft front-side daylight",
    prop_strategy: "child-safe study props only; no branded stationery or unrelated toys",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not collapse the board into a generic puzzle tray or flat board"
  },
  {
    image_id: 2,
    role: "Main Feature",
    concept_goal: "Show the interchangeable number tile interaction as the main feature",
    headline: "Interchangeable Number Tiles",
    unique_composition: "close interaction detail with a hand placing or lifting one tile while the full board context remains recognizable",
    unique_camera: "close practical detail angle focused on one arithmetic slot and tile movement",
    unique_background: "clean bright tabletop learning setup with minimal distraction",
    unique_lighting: "controlled top-side detail light that keeps tile edges and wood slots crisp",
    unique_focal_point: "tile slot mechanism and removable number tile action",
    scene_family: "EDUCATIONAL_TOY_FEATURE_DETAIL",
    layout_archetype: "DETAIL_CALLOUT_WITH_INTERACTION",
    product_position: "feature detail dominant with small board context",
    camera_distance: "close feature shot",
    lighting_direction: "top-side detail light",
    prop_strategy: "only hand interaction and nearby learning pieces relevant to the feature",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not remove the board context so much that the product becomes an unrecognizable wooden puzzle"
  },
  {
    image_id: 3,
    role: "Product Detail",
    concept_goal: "Show the complete learning system and included parts clearly",
    headline: "Complete Learning Set",
    unique_composition: "structured product detail layout with the full board centered and the key included parts neatly visible",
    unique_camera: "straight-on full-product detail angle",
    unique_background: "clean neutral studio surface with soft classroom-friendly tone",
    unique_lighting: "even front product light for clear visibility of all parts",
    unique_focal_point: "board structure, tray contents, and included learning components",
    scene_family: "EDUCATIONAL_TOY_PRODUCT_DETAIL",
    layout_archetype: "FULL_PRODUCT_WITH_PARTS_PROOF",
    product_position: "center full product",
    camera_distance: "medium detail shot",
    lighting_direction: "even front studio light",
    prop_strategy: "only included parts and simple learning icons; no unrelated decor",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not turn this into a random lifestyle scene with missing components"
  },
  {
    image_id: 4,
    role: "Use Case",
    concept_goal: "Show a believable child-learning moment using the board correctly",
    headline: "Made For Real Learning",
    unique_composition: "use-case learning scene with a child or child hands engaging the board while the product remains the main subject",
    unique_camera: "natural eye-level learning angle",
    unique_background: "realistic home study or playroom context appropriate for early learning",
    unique_lighting: "warm natural daylight with depth and calm family-safe mood",
    unique_focal_point: "product being used in a real learning moment with clear educational context",
    scene_family: "EDUCATIONAL_TOY_USE_CASE",
    layout_archetype: "LIFESTYLE_LEARNING_CONTEXT",
    product_position: "foreground or midground, clear and uncropped",
    camera_distance: "wide lifestyle shot",
    lighting_direction: "natural side light",
    prop_strategy: "child-safe books, pencils, table, and study context only; no third-party characters or branded items",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not show unrealistic or unsafe child use"
  },
  {
    image_id: 5,
    role: "CTA",
    concept_goal: "Close with a clean purchase-ready image showing the full learning board and simple benefits",
    headline: "Ready For Your Home",
    unique_composition: "conversion layout with full product on one side and neat kid-learning benefit list on the other",
    unique_camera: "straight-on ecommerce conversion angle",
    unique_background: "clean child-learning lifestyle background with soft depth and uncluttered surface",
    unique_lighting: "front-left high-key commercial light",
    unique_focal_point: "complete product presentation with clear conversion hierarchy",
    scene_family: "EDUCATIONAL_TOY_CTA",
    layout_archetype: "PRODUCT_AND_FEATURE_PANEL",
    product_position: "left or center, full product visible",
    camera_distance: "medium conversion product shot",
    lighting_direction: "front-left high-key light",
    prop_strategy: "simple learning icons only; no fake discounts or school brand references",
    beverage_direction: "not applicable",
    forbidden_repetition: "this is the only CTA card; do not add CTA elements to other cards"
  }
];

const SINK_ORGANIZER_LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the sink organizer as a clean high-converting kitchen storage solution",
    headline: "Smart Sink Organizer",
    unique_composition: "marketplace infographic hero with a left text column, product large on the right, size badge below headline, and three benefit rows with icons",
    unique_camera: "front three-quarter product angle at counter height",
    unique_background: "bright premium sink-side kitchen with warm window depth and clean countertop",
    unique_lighting: "soft warm daylight from upper left with realistic product shadows and black plastic highlights",
    unique_focal_point: "complete rectangular rack with open rails, lower tray, and detachable cloth rod visible",
    scene_family: "SINK_ORGANIZER_HERO_INFOGRAPHIC",
    layout_archetype: "LEFT_TEXT_RIGHT_PRODUCT_BENEFIT_STACK",
    product_position: "right third, full product visible",
    camera_distance: "medium full-product ecommerce hero shot",
    lighting_direction: "upper-left warm window light",
    prop_strategy: "generic unlabeled sponge, cloth, brush, and sink context only; no branded bottles",
    beverage_direction: "not applicable; use sink storage props only",
    forbidden_repetition: "do not make this a plain lifestyle render with one headline only"
  },
  {
    image_id: 2,
    role: "Gallery Storage Use",
    concept_goal: "Show real storage capacity for daily sink items",
    headline: "Organize Brushes Sponges And Cloths",
    unique_composition: "loaded product use shot with small callout labels around generic cleaning items and clear product boundaries",
    unique_camera: "slightly elevated front angle looking into the open basket",
    unique_background: "clean sink counter with soft cabinet and window depth",
    unique_lighting: "bright natural kitchen daylight with controlled highlights",
    unique_focal_point: "open basket holding generic unlabeled sink tools without hiding rail structure",
    scene_family: "SINK_ORGANIZER_LOADED_USE",
    layout_archetype: "CENTER_PRODUCT_CALLOUT_LABELS",
    product_position: "center full product",
    camera_distance: "medium use-case shot",
    lighting_direction: "front-left daylight",
    prop_strategy: "unlabeled sponge, brush, cloth, and plain soap dispenser; no logos or readable labels",
    beverage_direction: "not applicable; avoid food or drink props",
    forbidden_repetition: "do not crop the rack or hide the detachable rod"
  },
  {
    image_id: 3,
    role: "Gallery Drain Tray",
    concept_goal: "Prove the drainage tray keeps water moving toward the sink",
    headline: "Tilted Drain Tray Keeps Counters Dry",
    unique_composition: "technical drainage feature ad with water stream, arrow indicator, and close view of lower tray",
    unique_camera: "low front-left feature angle focused on base tray",
    unique_background: "minimal pale technical sink backdrop with subtle measurement-style callout",
    unique_lighting: "crisp top-right light that defines water and tray edges",
    unique_focal_point: "lower sloped tray and water drainage path",
    scene_family: "SINK_ORGANIZER_DRAIN_TRAY_DETAIL",
    layout_archetype: "FEATURE_CALLOUT_WATER_FLOW",
    product_position: "center-right feature crop with full product still recognizable",
    camera_distance: "close feature shot",
    lighting_direction: "top-right crisp technical light",
    prop_strategy: "water stream and simple arrow only; no clutter",
    beverage_direction: "not applicable; water is only for drainage proof",
    forbidden_repetition: "do not invent exact angle numbers unless already in product text"
  },
  {
    image_id: 4,
    role: "Body Detail",
    concept_goal: "Show material and open rail construction clearly",
    headline: "Open Structure Easy To Reach",
    unique_composition: "macro detail of rail rim and basket spacing with a small full-product reference inset",
    unique_camera: "close macro side angle showing rail thickness and rounded edges",
    unique_background: "premium neutral studio counter with soft depth",
    unique_lighting: "side rim light highlighting black plastic texture",
    unique_focal_point: "rail spacing, rounded corners, and sturdy open structure",
    scene_family: "SINK_ORGANIZER_RAIL_DETAIL",
    layout_archetype: "MACRO_DETAIL_WITH_REFERENCE_INSET",
    product_position: "large detail crop with small reference inset",
    camera_distance: "close material detail shot",
    lighting_direction: "right rim light with soft fill",
    prop_strategy: "no branded props; optional plain cloth only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not turn rail detail into a generic plastic basket"
  },
  {
    image_id: 5,
    role: "CTA",
    concept_goal: "Close with a polished conversion image showing a tidy sink area",
    headline: "Ready To Tidy Your Sink",
    unique_composition: "conversion layout with product clean and organized on the left, concise CTA panel and benefit checklist on the right",
    unique_camera: "straight-on ecommerce conversion angle",
    unique_background: "warm clean kitchen sink corner with soft depth and uncluttered countertop",
    unique_lighting: "high-key warm commercial light with realistic contact shadows",
    unique_focal_point: "complete rack in a tidy sink setup with simple CTA hierarchy",
    scene_family: "SINK_ORGANIZER_CTA_TIDY_COUNTER",
    layout_archetype: "LEFT_PRODUCT_RIGHT_CTA_PANEL",
    product_position: "left half, complete product visible",
    camera_distance: "medium full-product conversion shot",
    lighting_direction: "front-left high-key light",
    prop_strategy: "minimal unlabeled sink props only; no repeated clutter",
    beverage_direction: "not applicable",
    forbidden_repetition: "this is the only CTA card; do not add CTA buttons to other cards"
  }
];

const CAMPAIGN_DESIGN_SYSTEM = {
  typography: {
    font_family_direction: "one clean geometric sans-serif family",
    primary_weight: "bold headline",
    secondary_weight: "regular supporting text",
    casing: "Title Case for all main headlines",
    line_break_rule: "break only at complete phrases or natural reading units"
  },
  color_palette: {
    primary_text: "deep navy blue",
    accent: "fresh green",
    secondary_accent: "warm bamboo tan",
    background: "bright warm white with soft natural kitchen tones"
  },
  icon_system: {
    style: "simple line icons inside consistent circular badges",
    stroke_color: "fresh green",
    text_color: "deep navy blue"
  },
  headline_style: {
    casing: "Title Case",
    max_lines: 3,
    safe_margin: "minimum 12 percent from canvas edge"
  },
  cta_style: {
    shape: "rounded ecommerce button",
    color: "fresh green",
    text_color: "white",
    weight: "bold"
  },
  badge_style: {
    shape: "rounded pill or circular badge",
    color: "fresh green or warm bamboo tan",
    consistency: "same visual weight across images"
  },
  background_style: {
    mood: "clean premium kitchen ecommerce",
    depth: "foreground props, midground product, softly blurred background",
    clutter_rule: "depth without clutter"
  },
  spacing_style: {
    whitespace: "generous negative space around headline and product",
    grid: "clear text/product separation",
    edge_safety: "no text or important product part touches the canvas edge"
  },
  beverage_system: {
    objective: "Add subtle controlled beverage variety only when it supports the concept, while product identity, filter accuracy, layout, and background quality remain higher priority.",
    allowed_beverages: [
      "ice-cold clear water with visible ice, condensation, and glass sparkle",
      "hot clear water or light tea with visible gentle steam",
      "pale cucumber mint water with ice and condensation",
      "light amber tea with steam or warm glow",
      "soft peach or orange fruit infusion with ice",
      "very pale berry or herbal infusion with subtle fruit pieces"
    ],
    harmony_rule: "keep beverages natural, translucent, and visually balanced with the navy, fresh green, bamboo tan, and warm white campaign palette; beverage details must stay secondary and must never alter product geometry, spout shape, spring coil filter, layout, typography, or background quality",
    forbidden_beverages: [
      "plain static room-temperature water",
      "neon colored drinks",
      "heavy saturated red or purple drinks",
      "dark cola-like drinks",
      "opaque smoothies",
      "messy fruit overload",
      "every image using lemon water",
      "changing the spout or spring coil filter to support a beverage idea",
      "covering or hiding product identity details with fruit, ice, steam, or liquid color"
    ]
  }
};

const LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the product as a clean daily hydration pitcher",
    headline: "Pure Water Ready For Every Day",
    unique_composition: "left editorial text column, product large on the right third, benefit rows below headline",
    unique_camera: "front three-quarter medium product angle",
    unique_background: "bright airy morning kitchen window scene",
    unique_lighting: "soft back-left morning sunlight with gentle rim highlights on glass",
    unique_focal_point: "complete pitcher silhouette with lid, handle, spout, and coil visible",
    scene_family: "AIRY_KITCHEN_HERO",
    layout_archetype: "LEFT_TEXT_RIGHT_PRODUCT_HERO",
    product_position: "right third",
    camera_distance: "medium full-product shot",
    lighting_direction: "back-left window light",
    prop_strategy: "minimal lemon and mint foreground only",
    beverage_direction: "mostly clear iced water with mint and at most one subtle citrus slice; keep the product silhouette, spout, and spring coil filter more important than the drink",
    forbidden_repetition: "do not reuse marble catalog surface or left text/right product layout in images 02, 03, or 05"
  },
  {
    image_id: 2,
    role: "Feature Detail",
    concept_goal: "Prove the built-in spring coil filter",
    headline: "Built-In Filter For Smooth Pouring",
    unique_composition: "technical feature spread with oversized spout macro inset crossing the center and full product anchored lower-left",
    unique_camera: "front-left close feature angle with spout facing viewer",
    unique_background: "cool pale blue-white technical detail backdrop with faint measurement lines",
    unique_lighting: "crisp top-right studio light for metal coil definition",
    unique_focal_point: "stainless steel spiral coil filter at spout",
    scene_family: "TECHNICAL_FILTER_DETAIL",
    layout_archetype: "MACRO_INSET_CENTER_FEATURE",
    product_position: "lower-left anchor with spout center",
    camera_distance: "close feature shot plus inset",
    lighting_direction: "top-right crisp studio light",
    prop_strategy: "no lemons, no plant props; use clean callout lines only",
    beverage_direction: "mostly empty transparent glass; if water appears, keep it minimal and away from the spring coil so the stainless steel spiral coil remains the hero",
    forbidden_repetition: "do not use lifestyle kitchen depth, marble surface, or product-right hero layout"
  },
  {
    image_id: 3,
    role: "Material",
    concept_goal: "Show glass clarity and premium material feel",
    headline: "Clear Borosilicate Glass",
    unique_composition: "centered glass material study with product on reflective pedestal and sparse text floating above",
    unique_camera: "slightly low eye-level angle emphasizing glass wall thickness and reflection",
    unique_background: "deep soft charcoal-to-warm gradient studio with controlled glass reflections",
    unique_lighting: "side rim light from right plus soft overhead fill",
    unique_focal_point: "clear glass body reflections, bamboo lid texture, and transparent handle",
    scene_family: "DARK_PREMIUM_MATERIAL_STUDIO",
    layout_archetype: "CENTERED_PRODUCT_MATERIAL_STUDY",
    product_position: "center stage",
    camera_distance: "medium close material shot",
    lighting_direction: "right rim light with overhead fill",
    prop_strategy: "no fruit props; use reflection, light streaks, and glass shadow only",
    beverage_direction: "nearly empty clear glass or very clear water only; use reflections rather than drink variation to emphasize material clarity",
    forbidden_repetition: "do not use bright kitchen, family table, lemon/mint props, or left text column"
  },
  {
    image_id: 4,
    role: "Lifestyle",
    concept_goal: "Show daily family table usage",
    headline: "Made For Daily Family Hydration",
    unique_composition: "wide horizontal family dining moment with product foreground center and people softly behind",
    unique_camera: "natural eye-level lifestyle angle pulled wider than other images",
    unique_background: "warm wood dining table with breakfast plates and family bokeh",
    unique_lighting: "warm side daylight from left with soft table shadows",
    unique_focal_point: "pitcher in real serving context",
    scene_family: "WARM_FAMILY_DINING_LIFESTYLE",
    layout_archetype: "FOREGROUND_PRODUCT_LIFESTYLE_DEPTH",
    product_position: "foreground center",
    camera_distance: "wide lifestyle scene",
    lighting_direction: "left warm side light",
    prop_strategy: "family table props, glass cups, breakfast plates; no technical callout inset",
    beverage_direction: "soft peach or light herbal fruit infusion in the pitcher, warm and translucent, with no strong color clash",
    forbidden_repetition: "do not use isolated catalog product, technical measurement callouts, or dark studio"
  },
  {
    image_id: 5,
    role: "CTA",
    concept_goal: "Close with a conversion-focused product ad",
    headline: "Order Today Drink Better Every Day",
    unique_composition: "bold conversion split with product on left, large CTA card on right, trust icons in a bottom strip",
    unique_camera: "straight-on ecommerce conversion angle with stable product geometry",
    unique_background: "warm bamboo tray and soft cream checkout backdrop",
    unique_lighting: "front-left high-key commercial light with clean shadow under product",
    unique_focal_point: "purchase-ready product hero with CTA button and benefit proof",
    scene_family: "WARM_CTA_CHECKOUT",
    layout_archetype: "LEFT_PRODUCT_RIGHT_CTA_PANEL",
    product_position: "left half",
    camera_distance: "medium full-product conversion shot",
    lighting_direction: "front-left high-key light",
    prop_strategy: "bamboo tray and one glass cup only; no repeated lemon/plant cluster",
    beverage_direction: "simple clear iced water or very pale cucumber mint water; do not let drink styling compete with the CTA layout or product shape",
    forbidden_repetition: "do not use left text/right product layout, marble material studio, or family background"
  }
];

const BABY_HIGH_CHAIR_LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the baby high chair as a clean adjustable dining chair for everyday feeding",
    headline: "Adjustable Baby Dining Chair",
    unique_composition: "premium nursery dining hero with product large and fully visible on the right, concise feature stack on the left",
    unique_camera: "front three-quarter full-product angle showing tray, high backrest, legs, footrest, and safety belt",
    unique_background: "warm bright family dining corner with soft nursery details and clean depth",
    unique_lighting: "soft natural window light with gentle highlights on plastic and metal legs",
    unique_focal_point: "complete chair silhouette with removable tray, rounded seat, four legs, footrest, and belt visible",
    scene_family: "NURSERY_DINING_HERO",
    layout_archetype: "LEFT_TEXT_RIGHT_PRODUCT_HERO",
    product_position: "right third, full product visible",
    camera_distance: "medium conversion full-product set-proof shot",
    lighting_direction: "soft side window light",
    prop_strategy: "simple child dining props such as bowl, spoon, and cup; no baby unless seated safely and realistically",
    beverage_direction: "not applicable for hero; use food/table props only as subtle context and never cover the product",
    forbidden_repetition: "do not use glass pitcher beverage styling, COD badges, shipping claims, or cluttered marketplace border"
  },
  {
    image_id: 2,
    role: "Gallery Adjustable Height",
    concept_goal: "Show the two height modes clearly and accurately",
    headline: "Two Height Modes",
    unique_composition: "side-by-side product comparison with high mode labeled 87cm and low mode labeled 60cm",
    unique_camera: "straight-on technical ecommerce comparison angle",
    unique_background: "clean warm off-white studio with thin dimension lines",
    unique_lighting: "even studio light with soft ground shadow",
    unique_focal_point: "same chair in high and low configuration without changing product design",
    scene_family: "HEIGHT_MODE_COMPARISON",
    layout_archetype: "TWO_PRODUCT_DIMENSION_COMPARISON",
    product_position: "left high mode, right low mode",
    camera_distance: "full-product technical shot",
    lighting_direction: "even front studio light",
    prop_strategy: "dimension lines only; no lifestyle props",
    beverage_direction: "not applicable for height comparison; use dimension lines only",
    forbidden_repetition: "do not invent extra adjustment levels or wrong dimensions"
  },
  {
    image_id: 3,
    role: "Feature Tray",
    concept_goal: "Show the removable tray and cup slot",
    headline: "Removable Dining Tray",
    unique_composition: "close product detail with large tray foreground, cup slot highlighted, and small full-chair reference",
    unique_camera: "slight top-down tray detail angle",
    unique_background: "clean kitchen tabletop detail background",
    unique_lighting: "soft top-left product detail light",
    unique_focal_point: "removable tray with rounded corners and cup slot",
    scene_family: "TRAY_DETAIL",
    layout_archetype: "MACRO_DETAIL_WITH_REFERENCE",
    product_position: "tray detail dominant, chair reference small",
    camera_distance: "close feature detail",
    lighting_direction: "top-left soft detail light",
    prop_strategy: "one child cup and spoon only, placed safely on tray",
    beverage_direction: "not applicable for tray detail; if a cup appears, keep it closed or empty and secondary",
    forbidden_repetition: "do not remove the tray, change the cup slot shape, or add unsupported dishwasher claims"
  },
  {
    image_id: 4,
    role: "Feature Safety",
    concept_goal: "Show the 3-point safety belt and stable seating support",
    headline: "3-Point Safety Belt",
    unique_composition: "close-up of seat area and buckle with clear callout, no unsafe baby pose",
    unique_camera: "close front seat angle focused on belt and buckle",
    unique_background: "soft neutral nursery background with product detail sharp",
    unique_lighting: "gentle high-key detail light",
    unique_focal_point: "visible safety belt, buckle, seat bucket, and tray edge",
    scene_family: "SAFETY_BUCKLE_DETAIL",
    layout_archetype: "DETAIL_CALLOUT_SAFETY",
    product_position: "seat and belt centered",
    camera_distance: "close safety detail shot",
    lighting_direction: "front high-key light",
    prop_strategy: "optional seated doll or no baby; never show risky use",
    beverage_direction: "not applicable for safety detail; avoid food or drink props near the buckle",
    forbidden_repetition: "do not claim injury prevention, medical safety, certification, or guarantee without evidence"
  },
  {
    image_id: 5,
    role: "CTA",
    concept_goal: "Close with a clean conversion-focused set proof and product value summary",
    headline: "Ready For Mealtime",
    unique_composition: "final ecommerce ad with complete chair on left and neat parts/features panel on right",
    unique_camera: "straight-on full-product conversion angle",
    unique_background: "warm nursery dining room with clean floor and subtle depth",
    unique_lighting: "front-left high-key commercial light",
    unique_focal_point: "purchase-ready complete high chair and included parts proof",
    scene_family: "HIGH_CHAIR_CTA_SET_PROOF",
    layout_archetype: "LEFT_PRODUCT_RIGHT_FEATURE_PANEL",
    product_position: "left half, full chair visible",
    camera_distance: "medium full-product shot",
    lighting_direction: "front-left high-key light",
    prop_strategy: "show small icons or simple parts list: tray, footrest, safety belt, foot pads; no shipping/payment claims",
    beverage_direction: "not applicable for CTA set proof; use parts/features only",
    forbidden_repetition: "do not include COD, discount, shipping, warranty, fake review, certification, or guarantee badges"
  }
];

const CORDLESS_IMPACT_WRENCH_LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the cordless impact wrench as a serious high-power repair tool with premium ecommerce conversion energy",
    headline: "Cordless Impact Wrench",
    unique_composition: "bold industrial ecommerce hero with headline and benefit stack on the left, tool large on the right, and one compact torque or brushless proof badge",
    unique_camera: "front three-quarter hero angle showing the full tool body, metallic front housing, grip, and battery base",
    unique_background: "premium garage or workbench environment with layered depth, tool shadows, and soft industrial blur",
    unique_lighting: "controlled dramatic workshop lighting with metallic highlights and crisp edge separation",
    unique_focal_point: "full impact wrench silhouette with square drive front end and battery pack clearly visible",
    scene_family: "POWER_TOOL_HERO_GARAGE",
    layout_archetype: "LEFT_TEXT_RIGHT_TOOL_HERO",
    product_position: "right third, full product visible",
    camera_distance: "medium full-tool ecommerce hero shot",
    lighting_direction: "front-left workshop key light with cool metallic rim light",
    prop_strategy: "generic unbranded sockets or charger only if needed; keep the main tool dominant",
    beverage_direction: "not applicable; use industrial work props only",
    forbidden_repetition: "do not make this look like a generic catalog cutout or reuse this same garage hero layout on later cards"
  },
  {
    image_id: 2,
    role: "Feature Power Head",
    concept_goal: "Prove the reinforced front housing and working head details",
    headline: "Reinforced Front Housing",
    unique_composition: "dramatic close feature layout with the anvil and metallic hammer housing dominant, with a small secondary tool silhouette for context",
    unique_camera: "close front-side macro angle focused on square drive anvil and metal nose",
    unique_background: "dark technical workshop backdrop with restrained blue or teal industrial glow",
    unique_lighting: "hard directional light that defines metal edges, texture, and tool geometry",
    unique_focal_point: "square drive front end, metallic housing, and impact-ready nose geometry",
    scene_family: "POWER_TOOL_FRONT_HOUSING_DETAIL",
    layout_archetype: "MACRO_POWER_HEAD_DETAIL",
    product_position: "center-right detail crop with a small context inset if needed",
    camera_distance: "close engineering detail shot",
    lighting_direction: "top-right hard detail light",
    prop_strategy: "no extra props except one generic socket or arrow callout if necessary",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not turn this into a lifestyle scene or a full-width generic hero again"
  },
  {
    image_id: 3,
    role: "Use Case",
    concept_goal: "Show the wrench solving a believable repair task",
    headline: "Built For Real Repair Jobs",
    unique_composition: "real-use action scene with the tool tightening or loosening hardware on a vehicle, bracket, or workshop fixture",
    unique_camera: "dynamic eye-level action angle with the operator hand visible and tool still readable",
    unique_background: "authentic repair environment such as wheel area, gate hardware, motorcycle maintenance, or industrial bracket setup",
    unique_lighting: "workshop task lighting with focused highlights on the tool and fastener",
    unique_focal_point: "tool in real use with correct grip, correct socket alignment, and visible hardware interaction",
    scene_family: "POWER_TOOL_REAL_USE_ACTION",
    layout_archetype: "ACTION_PROOF_USE_CASE",
    product_position: "foreground or midground action focal point",
    camera_distance: "medium action shot",
    lighting_direction: "task-focused side lighting with practical depth",
    prop_strategy: "generic bolts, sockets, metal surfaces, gloves, or workbench hardware; no branded gear",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not use fake sparks, impossible motion blur, or unrelated home decor props"
  },
  {
    image_id: 4,
    role: "Feature Controls",
    concept_goal: "Show the control panel, battery indicator, vents, or directional switch as a clear usability proof",
    headline: "Smart Control Layout",
    unique_composition: "clean technical feature board with close crops of the top control area, switch zone, or battery indicator arranged around one main product view",
    unique_camera: "slight top and side detail angles mixed into one coherent single-scene board",
    unique_background: "clean industrial-tech background with subtle panel lines and restrained glow",
    unique_lighting: "controlled high-contrast feature light that keeps buttons and vents readable",
    unique_focal_point: "control interface, vents, switch logic, and battery-related usability cues",
    scene_family: "POWER_TOOL_CONTROL_SYSTEM",
    layout_archetype: "MAIN_PRODUCT_PLUS_DETAIL_CALLOUTS",
    product_position: "main tool center-right with supporting detail callouts around it",
    camera_distance: "medium tool view with close supporting insets",
    lighting_direction: "front technical light with selective highlights",
    prop_strategy: "feature callout lines only; no lifestyle clutter",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not add random numbers, false warranty claims, or fake certification marks"
  },
  {
    image_id: 5,
    role: "CTA",
    concept_goal: "Close with a conversion image showing the tool as a ready-to-work kit",
    headline: "Ready To Power Your Next Job",
    unique_composition: "conversion layout with the main wrench large on one side and a clean kit or benefit summary panel on the other",
    unique_camera: "straight-on ecommerce conversion angle with the full tool readable and accessories secondary",
    unique_background: "clean premium workbench or garage shelf background with subtle depth",
    unique_lighting: "front-left commercial light with crisp product separation and grounded shadows",
    unique_focal_point: "purchase-ready wrench hero with optional unbranded sockets, battery, charger, or case shown as supporting proof",
    scene_family: "POWER_TOOL_CTA_KIT_PROOF",
    layout_archetype: "PRODUCT_PLUS_KIT_SUMMARY_PANEL",
    product_position: "left or center-left with complete tool visible",
    camera_distance: "medium full-product conversion shot",
    lighting_direction: "front-left commercial key light",
    prop_strategy: "unbranded tool kit props only; keep sockets, battery, and charger subordinate to the main tool",
    beverage_direction: "not applicable",
    forbidden_repetition: "this is the only CTA card; do not add purchase buttons or hard CTA language to earlier cards"
  }
];

const CORDLESS_IMPACT_WRENCH_FULL_15_LAYOUT_CARDS = [
  CORDLESS_IMPACT_WRENCH_LAYOUT_CARDS[0],
  {
    image_id: 2,
    role: "Gallery Full Tool",
    section: "GALLERY",
    concept_goal: "Show the complete cordless impact wrench silhouette clearly with all major parts readable",
    headline: "Complete Tool Design",
    unique_composition: "clean marketplace-style full tool inspection with concise callouts for front housing, grip, vents, and battery base",
    unique_camera: "straight-on three-quarter full-product angle",
    unique_background: "neutral industrial display background with subtle bench shadow",
    unique_lighting: "even commercial light with crisp metallic reflections",
    unique_focal_point: "entire tool silhouette, square drive front, grip, and battery pack",
    scene_family: "POWER_TOOL_FULL_PRODUCT_INSPECTION",
    layout_archetype: "CENTER_TOOL_CALLOUTS",
    product_position: "center full product",
    camera_distance: "full-product inspection shot",
    lighting_direction: "front even commercial light",
    prop_strategy: "no extra props beyond simple icon callouts",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not turn this into a hero garage scene or CTA kit layout"
  },
  {
    image_id: 3,
    role: "Gallery Front Drive",
    section: "GALLERY",
    concept_goal: "Focus on the square drive working end and impact-ready front geometry",
    headline: "Impact-Ready Square Drive",
    unique_composition: "macro hardware detail with enlarged front anvil and a small secondary full-tool reference",
    unique_camera: "tight front macro angle on the anvil and hammer housing",
    unique_background: "dark technical metal backdrop with subtle cyan line accents",
    unique_lighting: "hard directional light shaping edges of the anvil and housing",
    unique_focal_point: "square drive front end and surrounding metal nose",
    scene_family: "POWER_TOOL_ANVIL_MACRO",
    layout_archetype: "LEFT_MACRO_RIGHT_REFERENCE",
    product_position: "macro foreground with small tool reference",
    camera_distance: "macro engineering detail shot",
    lighting_direction: "top-right hard light",
    prop_strategy: "one generic socket only if needed for scale",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not add fake torque numbers or wrong chuck geometry"
  },
  {
    image_id: 4,
    role: "Gallery Controls",
    section: "GALLERY",
    concept_goal: "Show control panel, indicator, and switch areas as source-supported usability proof",
    headline: "Control Panel And Switch Access",
    unique_composition: "feature card with one main product view and two tight insets for controls",
    unique_camera: "slightly elevated angle plus close insets for top panel and side switch",
    unique_background: "clean industrial console-style backdrop",
    unique_lighting: "controlled contrast for button readability",
    unique_focal_point: "control panel, battery indicator, and forward reverse switch zone",
    scene_family: "POWER_TOOL_CONTROL_PANEL_PROOF",
    layout_archetype: "MAIN_VIEW_PLUS_TWO_INSETS",
    product_position: "main tool center-right with insets left or lower-left",
    camera_distance: "medium tool view plus close details",
    lighting_direction: "front technical light",
    prop_strategy: "no lifestyle props",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not replace real controls with invented UI or fake digital screens"
  },
  {
    image_id: 5,
    role: "Gallery Battery Base",
    section: "GALLERY",
    concept_goal: "Prove the removable battery base and bottom balance of the tool",
    headline: "Removable Battery Base",
    unique_composition: "bottom-half product focus with battery pack emphasized and one supporting battery inset",
    unique_camera: "slightly low angle focused on lower handle and battery pack",
    unique_background: "clean workbench background with grounded tool shadow",
    unique_lighting: "soft front-left light with crisp base separation",
    unique_focal_point: "battery pack attachment and lower body proportions",
    scene_family: "POWER_TOOL_BATTERY_BASE_DETAIL",
    layout_archetype: "LOWER_TOOL_BATTERY_FOCUS",
    product_position: "center-right lower body emphasis",
    camera_distance: "medium lower-body detail shot",
    lighting_direction: "front-left balanced light",
    prop_strategy: "single spare battery only if secondary",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not crop away the front end so much that the product identity becomes unclear"
  },
  {
    image_id: 6,
    role: "Gallery Rotation Mode",
    section: "GALLERY",
    concept_goal: "Communicate forward and reverse working logic without copying marketplace clutter",
    headline: "Forward And Reverse Control",
    unique_composition: "clean directional proof layout with two motion arrows and a close callout around the switch region",
    unique_camera: "front-side tool angle with switch area readable",
    unique_background: "dark technical board with restrained motion graphics",
    unique_lighting: "focused feature light with cyan edge glow",
    unique_focal_point: "direction switch and clear tightening/loosening logic",
    scene_family: "POWER_TOOL_DIRECTION_CONTROL",
    layout_archetype: "MOTION_ARROW_SWITCH_CALLOUT",
    product_position: "center with switch callout to one side",
    camera_distance: "medium feature proof shot",
    lighting_direction: "front-right technical light",
    prop_strategy: "motion arrows and one fastener icon only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not use duplicated top-bottom mirrored graphics like noisy marketplace cards"
  },
  {
    image_id: 7,
    role: "Body Wheel Repair",
    section: "BODY",
    concept_goal: "Show believable wheel bolt loosening in a practical repair context",
    headline: "Built For Wheel Bolt Repair",
    unique_composition: "close vehicle wheel action scene with tool aligned to one lug and the operator hand naturally gripping the handle",
    unique_camera: "close side action angle at wheel height",
    unique_background: "garage floor and tire sidewall with realistic service depth",
    unique_lighting: "task-focused workshop light with reflected highlights on metal parts",
    unique_focal_point: "tool engaged with wheel hardware correctly",
    scene_family: "POWER_TOOL_WHEEL_REPAIR_ACTION",
    layout_archetype: "CLOSE_REAL_ACTION_PROOF",
    product_position: "foreground action focal point",
    camera_distance: "close real-use shot",
    lighting_direction: "left task light",
    prop_strategy: "wheel, socket, glove, and lug only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not use fake sparks, impossible hand posture, or wrong socket alignment"
  },
  {
    image_id: 8,
    role: "Body Bench Repair",
    section: "BODY",
    concept_goal: "Show the tool in a clean bench or bracket repair task for workshop credibility",
    headline: "Ready For Workshop Repairs",
    unique_composition: "bench hardware repair scene with tool on a metal bracket, bolts nearby, and controlled background depth",
    unique_camera: "eye-level three-quarter action angle",
    unique_background: "organized workshop bench with pegboard or metal shelf blur",
    unique_lighting: "warm industrial key light with cool rim separation",
    unique_focal_point: "tool solving a metal fastening task",
    scene_family: "POWER_TOOL_BENCH_REPAIR",
    layout_archetype: "WORKBENCH_ACTION_CONTEXT",
    product_position: "midground dominant action tool",
    camera_distance: "medium action shot",
    lighting_direction: "warm left key light and cool rim light",
    prop_strategy: "bolts, bracket, socket extensions, work gloves; all unbranded",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not make this another wheel scene or another static hero"
  },
  {
    image_id: 9,
    role: "Body Kit Proof",
    section: "BODY",
    concept_goal: "Show a clean unbranded kit composition with the tool still as hero",
    headline: "Tool Kit Ready To Go",
    unique_composition: "tool large in foreground with battery, charger, sockets, and case arranged in a disciplined secondary arc",
    unique_camera: "straight-on premium kit presentation angle",
    unique_background: "garage shelf or workbench kit setup with dark neutral depth",
    unique_lighting: "front commercial light with grounded accessory shadows",
    unique_focal_point: "main impact wrench hero supported by accessories",
    scene_family: "POWER_TOOL_KIT_PRESENTATION",
    layout_archetype: "HERO_TOOL_WITH_ACCESSORY_ARC",
    product_position: "left-center hero tool with accessories right and lower-right",
    camera_distance: "medium full-kit shot",
    lighting_direction: "front-left commercial light",
    prop_strategy: "battery, charger, socket set, carry case only, all unbranded",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not let accessories overpower the main tool and do not show brand text on the case or battery"
  },
  {
    image_id: 10,
    role: "Body LED",
    section: "BODY",
    concept_goal: "Show the LED work-light usefulness in a darker repair environment",
    headline: "Work Light For Dark Spaces",
    unique_composition: "tool illuminating a focused repair zone under low ambient light, with the LED glow shaping the nearby hardware",
    unique_camera: "low practical angle looking toward the lit working area",
    unique_background: "under-car, shelf cavity, or shadowed repair corner with realistic darkness",
    unique_lighting: "primary illumination from the tool LED plus minimal ambient fill",
    unique_focal_point: "LED light functionality and usable front-end visibility",
    scene_family: "POWER_TOOL_LED_DARK_SCENE",
    layout_archetype: "LOW_LIGHT_LED_PROOF",
    product_position: "foreground tool with lit work zone ahead",
    camera_distance: "medium dramatic feature shot",
    lighting_direction: "tool-origin light beam plus faint ambient fill",
    prop_strategy: "one fastener zone or bracket only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not make the LED beam cartoonish or transform the front geometry to support the light effect"
  },
  {
    image_id: 11,
    role: "Body Grip Comfort",
    section: "BODY",
    concept_goal: "Highlight ergonomic grip texture and confident handling",
    headline: "Ergonomic Grip Control",
    unique_composition: "close hand-and-handle proof with enlarged grip texture inset and short ergonomic benefits",
    unique_camera: "close side angle on handle with partial tool body visible",
    unique_background: "clean workshop blur with enough negative space for typography",
    unique_lighting: "soft side light emphasizing grip texture and contours",
    unique_focal_point: "rubberized grip shape and hand comfort zone",
    scene_family: "POWER_TOOL_GRIP_ERGONOMICS",
    layout_archetype: "HANDLE_DETAIL_WITH_INSET",
    product_position: "center-right grip emphasis",
    camera_distance: "close ergonomic detail shot",
    lighting_direction: "side contour light",
    prop_strategy: "single work glove or bare hand only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not crop away all front identity so the tool becomes unrecognizable"
  },
  {
    image_id: 12,
    role: "Body Cooling",
    section: "BODY",
    concept_goal: "Show vent structure and airflow logic as a mechanical proof without overclaiming",
    headline: "Vent Design For Airflow",
    unique_composition: "rear-body vent detail with tasteful airflow lines and one main tool view",
    unique_camera: "rear-side close feature angle",
    unique_background: "dark technical airflow backdrop with subtle blue accents",
    unique_lighting: "rim light defining vent edges and rear geometry",
    unique_focal_point: "vent structure and rear body engineering",
    scene_family: "POWER_TOOL_VENT_AIRFLOW",
    layout_archetype: "REAR_VENT_CALLOUT",
    product_position: "center vent detail with supporting full-tool context",
    camera_distance: "close technical rear detail shot",
    lighting_direction: "rear rim light and soft fill",
    prop_strategy: "airflow lines only, no extra clutter",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not invent heat numbers, cooling percentages, or lab certification claims"
  },
  {
    image_id: 13,
    role: "Body Socket Compatibility",
    section: "BODY",
    concept_goal: "Present practical socket/adapter compatibility in a clean, non-cluttered way",
    headline: "Compatible With Common Sockets",
    unique_composition: "tool with a disciplined row of sockets and one adapter proof callout, keeping layout clean and premium",
    unique_camera: "front product angle with accessories arranged low and secondary",
    unique_background: "premium dark workbench with soft depth and minimal distractions",
    unique_lighting: "front-left commercial light with metallic accent highlights",
    unique_focal_point: "tool plus clean compatibility proof",
    scene_family: "POWER_TOOL_SOCKET_COMPATIBILITY",
    layout_archetype: "TOOL_PLUS_SOCKET_ROW",
    product_position: "center-left hero tool with sockets along lower edge",
    camera_distance: "medium product-proof shot",
    lighting_direction: "front-left metallic highlight light",
    prop_strategy: "generic sockets and one adapter only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not turn this into a noisy accessory grid or marketplace collage"
  },
  {
    image_id: 14,
    role: "Body Storage",
    section: "BODY",
    concept_goal: "Show neat storage on a shelf or in a case-ready environment",
    headline: "Easy To Store Between Jobs",
    unique_composition: "clean storage scene with the tool upright near the case and charger on a shelf or bench corner",
    unique_camera: "slightly pulled-back lifestyle product angle",
    unique_background: "organized workshop shelf or garage storage nook",
    unique_lighting: "soft ambient shop light with clean object separation",
    unique_focal_point: "tool standing neatly with compact kit presence",
    scene_family: "POWER_TOOL_STORAGE_SCENE",
    layout_archetype: "ORGANIZED_STORAGE_CONTEXT",
    product_position: "mid-left with storage context around it",
    camera_distance: "wide product-storage shot",
    lighting_direction: "soft ambient upper-left light",
    prop_strategy: "case, charger, one battery, and shelf hardware only",
    beverage_direction: "not applicable",
    forbidden_repetition: "do not make this another CTA panel or another aggressive action scene"
  },
  {
    ...CORDLESS_IMPACT_WRENCH_LAYOUT_CARDS[4],
    image_id: 15,
    section: "CTA"
  }
];

const GENERIC_LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the product with a clean ecommerce hero image",
    headline: "Designed For Everyday Use",
    unique_composition: "premium ecommerce hero with the product large, fully visible, and paired with concise benefit text",
    unique_camera: "front three-quarter full-product angle based on the reference image",
    unique_background: "clean lifestyle environment appropriate to the product category",
    unique_lighting: "soft natural commercial light with product edges clearly visible",
    unique_focal_point: "complete product silhouette and all visible identity-critical components",
    scene_family: "GENERIC_PRODUCT_HERO",
    layout_archetype: "PRODUCT_HERO_WITH_FEATURE_STACK",
    product_position: "right or center-right, full product visible",
    camera_distance: "medium full-product hero shot",
    lighting_direction: "soft front-side commercial light",
    prop_strategy: "only props that clearly fit the product use case; keep props secondary",
    beverage_direction: "not applicable unless the product is a drinkware product",
    forbidden_repetition: "do not use category-specific details from unrelated products"
  },
  {
    image_id: 2,
    role: "Main Feature",
    concept_goal: "Show one main feature or USP from product evidence",
    headline: "Key Feature Highlight",
    unique_composition: "feature-focused ecommerce layout with product detail and short callouts",
    unique_camera: "close detail angle focused on the relevant component",
    unique_background: "simple studio or use-case background that does not distract",
    unique_lighting: "controlled detail lighting",
    unique_focal_point: "one visible product feature supported by evidence",
    scene_family: "GENERIC_FEATURE_DETAIL",
    layout_archetype: "DETAIL_CALLOUT",
    product_position: "feature detail dominant with small product context",
    camera_distance: "close feature shot",
    lighting_direction: "top-side detail light",
    prop_strategy: "minimal props, only if they clarify use",
    beverage_direction: "not applicable unless the product is a drinkware product",
    forbidden_repetition: "do not invent unsupported features or claims"
  },
  {
    image_id: 3,
    role: "Product Detail",
    concept_goal: "Show product structure, material, or included parts",
    headline: "Product Details",
    unique_composition: "structured detail layout with visible product parts and clean spacing",
    unique_camera: "straight-on or slight top-down detail angle",
    unique_background: "clean neutral studio surface",
    unique_lighting: "even product detail light",
    unique_focal_point: "visible structure, materials, or parts from the reference image",
    scene_family: "GENERIC_PRODUCT_DETAIL",
    layout_archetype: "PARTS_OR_MATERIAL_DETAIL",
    product_position: "center detail area",
    camera_distance: "medium detail shot",
    lighting_direction: "even front studio light",
    prop_strategy: "no unrelated props",
    beverage_direction: "not applicable unless the product is a drinkware product",
    forbidden_repetition: "do not add unverified certifications, logos, or extra accessories"
  },
  {
    image_id: 4,
    role: "Use Case",
    concept_goal: "Show the product in a believable use context",
    headline: "Made For Real Life",
    unique_composition: "lifestyle use-case scene with product as the clear focal point",
    unique_camera: "natural eye-level or practical use angle",
    unique_background: "realistic environment appropriate to the product",
    unique_lighting: "warm natural light with depth",
    unique_focal_point: "product being used correctly and safely",
    scene_family: "GENERIC_USE_CASE",
    layout_archetype: "LIFESTYLE_USE_CONTEXT",
    product_position: "foreground or midground, clear and uncropped",
    camera_distance: "wide lifestyle shot",
    lighting_direction: "natural side light",
    prop_strategy: "props should support product use and not change product identity",
    beverage_direction: "not applicable unless the product is a drinkware product",
    forbidden_repetition: "do not show unsafe or unrealistic use"
  },
  {
    image_id: 5,
    role: "CTA",
    concept_goal: "Close with a clean conversion-focused ecommerce image",
    headline: "Ready For Your Home",
    unique_composition: "complete product on one side with neat feature summary on the other",
    unique_camera: "straight-on ecommerce conversion angle",
    unique_background: "clean product-appropriate lifestyle background",
    unique_lighting: "front-left high-key commercial light",
    unique_focal_point: "purchase-ready product presentation without fake offers",
    scene_family: "GENERIC_CTA",
    layout_archetype: "PRODUCT_AND_FEATURE_PANEL",
    product_position: "left or center, full product visible",
    camera_distance: "medium conversion product shot",
    lighting_direction: "front-left high-key light",
    prop_strategy: "simple feature icons only; no fake shipping/payment/discount claims",
    beverage_direction: "not applicable unless the product is a drinkware product",
    forbidden_repetition: "do not include fake review, guarantee, discount, shipping, or certification badges"
  }
];

const TUMBLER_LAYOUT_CARDS = [
  {
    image_id: 1,
    role: "Hero",
    concept_goal: "Introduce the tumbler as a premium daily hydration companion with clear product identity and readable selling points",
    headline: "Designed For Daily Hydration",
    unique_composition: "premium hero layout with full tumbler visible, text stack on one side, and product dominant without clutter",
    unique_camera: "front or slight three-quarter full-product hero angle",
    unique_background: "clean bright home or desk lifestyle background that supports drinkware use",
    unique_lighting: "soft premium daylight with clean edge separation on the tumbler body and lid",
    unique_focal_point: "full tumbler silhouette, handle, rotating lid, and straw",
    scene_family: "TUMBLER_HERO",
    layout_archetype: "PRODUCT_HERO_WITH_BENEFIT_STACK",
    product_position: "right or center-right, full product visible",
    camera_distance: "medium full-product hero shot",
    lighting_direction: "soft side-front daylight",
    prop_strategy: "minimal lifestyle props such as book, desk object, or fruit bowl only when relevant",
    beverage_direction: "use beverage only when it supports hydration or hot-cold proof; avoid defaulting every card to the same lemon drink",
    forbidden_repetition: "do not reuse pitcher, teapot, sink, or family-serving logic from unrelated drinkware"
  },
  {
    image_id: 2,
    role: "Main Feature",
    concept_goal: "Prove the rotating lid and leak-control design clearly",
    headline: "Rotating Lid, Easy Sipping",
    unique_composition: "feature-led close-up of lid system with one main callout and supporting proof text",
    unique_camera: "top-front close detail angle focused on the lid and straw opening",
    unique_background: "clean bright neutral detail background",
    unique_lighting: "controlled soft detail light",
    unique_focal_point: "rotating lid structure and straw opening",
    scene_family: "TUMBLER_LID_DETAIL",
    layout_archetype: "DETAIL_CALLOUT",
    product_position: "feature detail dominant with small product context",
    camera_distance: "tight feature crop",
    lighting_direction: "top-front detail light",
    prop_strategy: "no extra props unless needed for one proof marker",
    beverage_direction: "not required",
    forbidden_repetition: "do not turn this into a generic beauty shot without clear lid proof"
  },
  {
    image_id: 3,
    role: "Product Detail",
    concept_goal: "Show structure, materials, and user-relevant construction details of the tumbler",
    headline: "Built For Everyday Carry",
    unique_composition: "clean product detail layout showing handle, lid, straw, and body construction with clear hierarchy",
    unique_camera: "straight-on or slight top-down detail angle",
    unique_background: "neutral ecommerce inspection background",
    unique_lighting: "even front detail light",
    unique_focal_point: "body shape, handle design, and material finish",
    scene_family: "TUMBLER_STRUCTURE_DETAIL",
    layout_archetype: "PARTS_OR_MATERIAL_DETAIL",
    product_position: "center detail area",
    camera_distance: "medium product-detail shot",
    lighting_direction: "even front studio light",
    prop_strategy: "no unrelated props",
    beverage_direction: "not required",
    forbidden_repetition: "do not invent extra accessories or pitcher-style parts"
  },
  {
    image_id: 4,
    role: "Use Case",
    concept_goal: "Show believable lifestyle use such as commute, desk, or sofa downtime with the tumbler still clearly featured",
    headline: "Ready For Real Life",
    unique_composition: "lifestyle use-case scene where the tumbler remains the clear hero and the environment explains why it fits daily routines",
    unique_camera: "natural eye-level or practical use angle",
    unique_background: "realistic home, desk, commute, or couch context appropriate to a handled tumbler",
    unique_lighting: "warm natural light with visible depth",
    unique_focal_point: "tumbler being used or placed in a believable daily environment",
    scene_family: "TUMBLER_LIFESTYLE_USE",
    layout_archetype: "LIFESTYLE_USE_CONTEXT",
    product_position: "foreground or midground, clear and uncropped",
    camera_distance: "wide lifestyle shot",
    lighting_direction: "natural side light",
    prop_strategy: "props should support hydration, work, travel, or home comfort without clutter",
    beverage_direction: "use context-appropriate hot or cold drink cues only when natural",
    forbidden_repetition: "do not make this a family serving scene or a random kitchen still life with no use-case logic"
  }
];

const TUMBLER_FULL_15_LAYOUT_CARDS = [
  TUMBLER_LAYOUT_CARDS[0],
  {
    image_id: 2,
    role: "Gallery Full Product",
    section: "GALLERY",
    concept_goal: "Show the complete tumbler form clearly with identity-critical parts visible",
    headline: "Complete Tumbler Design",
    unique_composition: "clean full-product inspection layout with subtle labels or proof zones around handle, lid, straw, and base",
    unique_camera: "straight-on full-product angle",
    unique_background: "warm off-white or pale neutral inspection background",
    unique_lighting: "even front studio light with soft base shadow",
    unique_focal_point: "full tumbler silhouette and main components",
    scene_family: "TUMBLER_FULL_PRODUCT",
    layout_archetype: "CENTER_PRODUCT_LABELS",
    product_position: "center full product",
    camera_distance: "full-product inspection shot",
    lighting_direction: "front even studio light",
    prop_strategy: "no props; product identity only",
    beverage_direction: "not required",
    forbidden_repetition: "do not turn this into a lifestyle scene or CTA panel"
  },
  {
    image_id: 3,
    role: "Gallery Capacity",
    section: "GALLERY",
    concept_goal: "Communicate large capacity with a strong but product-safe proof image",
    headline: "Large 1180ML Capacity",
    unique_composition: "full tumbler with clean capacity badge and restrained hydration cue",
    unique_camera: "slightly elevated front angle",
    unique_background: "light hydration backdrop with one simple capacity proof element",
    unique_lighting: "cool-soft top-left light",
    unique_focal_point: "large tumbler body volume and carry-ready proportions",
    scene_family: "TUMBLER_CAPACITY",
    layout_archetype: "CENTER_PRODUCT_CAPACITY_BADGE",
    product_position: "center slightly low",
    camera_distance: "medium full-body capacity shot",
    lighting_direction: "top-left cool soft light",
    prop_strategy: "one simple glass or ice cue only if needed",
    beverage_direction: "cold water or neutral hydration cue only; avoid turning capacity proof into a pitcher scene",
    forbidden_repetition: "do not reuse hero layout or lid-detail layout"
  },
  {
    image_id: 4,
    role: "Gallery Lid",
    section: "GALLERY",
    concept_goal: "Show the rotating lid mechanism and straw pathway accurately",
    headline: "Smart Rotating Lid",
    unique_composition: "macro lid close-up with one small full-product reference area",
    unique_camera: "macro top-front close-up of lid",
    unique_background: "clean pale technical detail background",
    unique_lighting: "bright precise detail light",
    unique_focal_point: "lid slider, straw opening, and top rim relationship",
    scene_family: "TUMBLER_LID_MACRO",
    layout_archetype: "MACRO_FEATURE_WITH_REFERENCE",
    product_position: "macro crop dominant with small inset product",
    camera_distance: "extreme close-up detail shot",
    lighting_direction: "front-right macro light",
    prop_strategy: "no props beyond a clean callout system",
    beverage_direction: "not required",
    forbidden_repetition: "do not mention spout, filter, or pitcher pour logic"
  },
  {
    image_id: 5,
    role: "Gallery Material",
    section: "GALLERY",
    concept_goal: "Prove insulated stainless construction or durable material feel",
    headline: "Durable Insulated Build",
    unique_composition: "material-focused product crop with one supporting proof inset or cutaway-style cue",
    unique_camera: "slight side angle with material emphasis",
    unique_background: "clean commercial background with subtle premium depth",
    unique_lighting: "soft reflective light that defines body finish and rim",
    unique_focal_point: "body finish, steel rim, and solid construction",
    scene_family: "TUMBLER_MATERIAL_PROOF",
    layout_archetype: "MATERIAL_CALL_OUT",
    product_position: "center-right product with one detail inset",
    camera_distance: "medium-close material shot",
    lighting_direction: "side reflection light",
    prop_strategy: "no clutter; one clean inset only",
    beverage_direction: "not required",
    forbidden_repetition: "do not create fake exploded diagrams or impossible cutaways"
  },
  {
    image_id: 6,
    role: "Body Cold Use",
    section: "BODY",
    concept_goal: "Show cold drink use in a refreshing but still premium and realistic way",
    headline: "Cold Drinks Stay Ready",
    unique_composition: "product hero with one cold beverage context and restrained refreshment cues",
    unique_camera: "three-quarter product angle with drink context",
    unique_background: "bright kitchen, desk, or patio refreshment scene",
    unique_lighting: "cool daylight with crisp reflections",
    unique_focal_point: "tumbler as a cold-drink companion",
    scene_family: "TUMBLER_COLD_USE",
    layout_archetype: "REFRESHMENT_CONTEXT",
    product_position: "foreground hero with secondary drink cue",
    camera_distance: "medium lifestyle product shot",
    lighting_direction: "cool side daylight",
    prop_strategy: "ice, citrus, or clear glass only when balanced and relevant",
    beverage_direction: "cold water, iced tea, or subtle fruit infusion",
    forbidden_repetition: "do not reuse the same exact lemon-water setup on every card"
  },
  {
    image_id: 7,
    role: "Body Hot Use",
    section: "BODY",
    concept_goal: "Show that the tumbler also supports warm drink routines without looking plain",
    headline: "Also Made For Warm Sips",
    unique_composition: "premium warm-drink scene with one mug or steam cue beside the tumbler",
    unique_camera: "slight high angle with tabletop warmth and product clarity",
    unique_background: "cozy desk, reading nook, or kitchen morning scene",
    unique_lighting: "warm sunlight with soft shadow depth",
    unique_focal_point: "tumbler in a calm warm-beverage routine",
    scene_family: "TUMBLER_WARM_USE",
    layout_archetype: "COZY_USE_CONTEXT",
    product_position: "mid-right or center with warm context around it",
    camera_distance: "medium warm-lifestyle shot",
    lighting_direction: "warm side-window light",
    prop_strategy: "book, tray, tea cup, or soft textile only",
    beverage_direction: "tea or warm drink steam cue only; keep it realistic and minimal",
    forbidden_repetition: "do not make this another citrus-cold card"
  },
  {
    image_id: 8,
    role: "Body Carry",
    section: "BODY",
    concept_goal: "Prove the handle and portable daily-carry feel",
    headline: "Comfort Grip Handle",
    unique_composition: "hand interaction scene or strong handle-led composition with product fully readable",
    unique_camera: "side angle showing handle ergonomics",
    unique_background: "commute, kitchen, or desk transition context",
    unique_lighting: "clean natural light with tactile handle detail",
    unique_focal_point: "handle comfort and control",
    scene_family: "TUMBLER_HANDLE_USE",
    layout_archetype: "HANDLE_INTERACTION_PROOF",
    product_position: "handle-facing foreground composition",
    camera_distance: "medium-close use shot",
    lighting_direction: "soft cross light",
    prop_strategy: "one human hand only if it improves realism",
    beverage_direction: "not required",
    forbidden_repetition: "do not hide the handle or flatten it into the body"
  },
  {
    image_id: 9,
    role: "Body Desk",
    section: "BODY",
    concept_goal: "Show the tumbler fitting work, study, or long desk sessions",
    headline: "Desk-Ready All Day",
    unique_composition: "organized desk scene with the tumbler clearly separated from background objects",
    unique_camera: "slight side or front desk perspective",
    unique_background: "clean desk, notebook, or laptop-adjacent setting without brand marks",
    unique_lighting: "soft daylight with practical desk depth",
    unique_focal_point: "tumbler in a productive routine",
    scene_family: "TUMBLER_DESK_USE",
    layout_archetype: "DESK_CONTEXT",
    product_position: "foreground on desk or side table",
    camera_distance: "wide practical lifestyle shot",
    lighting_direction: "window-side daylight",
    prop_strategy: "notebook, pen, tablet, or plant only",
    beverage_direction: "not required",
    forbidden_repetition: "do not repeat sofa scene or kitchen-only scene"
  },
  {
    image_id: 10,
    role: "Body Travel",
    section: "BODY",
    concept_goal: "Show car, commute, or on-the-go practicality without deforming product geometry",
    headline: "Made To Move With You",
    unique_composition: "travel-ready layout with cup-holder or carry context while keeping the tumbler as hero",
    unique_camera: "practical side or slightly low angle",
    unique_background: "car console, bag-side, or commute transition context",
    unique_lighting: "clear daylight with clean object separation",
    unique_focal_point: "portable shape and travel compatibility",
    scene_family: "TUMBLER_TRAVEL_USE",
    layout_archetype: "ON_THE_GO_CONTEXT",
    product_position: "foreground or center hero",
    camera_distance: "medium practical shot",
    lighting_direction: "front-side daylight",
    prop_strategy: "generic car, bag, or seat cues only when brand-free and secondary",
    beverage_direction: "not required",
    forbidden_repetition: "do not turn this into a kitchen serving scene"
  },
  {
    image_id: 11,
    role: "Body Color Option",
    section: "BODY",
    concept_goal: "Show available color choices while preserving the same geometry",
    headline: "Clean Color Options",
    unique_composition: "two-color or multi-color variant presentation with consistent scale and pose logic",
    unique_camera: "clean straight-on or matching paired angle",
    unique_background: "bright minimal backdrop with gentle tonal contrast",
    unique_lighting: "even polished catalog light",
    unique_focal_point: "same tumbler in supported color variants",
    scene_family: "TUMBLER_COLOR_VARIANTS",
    layout_archetype: "VARIANT_COMPARISON",
    product_position: "paired centered products or one main plus one secondary",
    camera_distance: "medium paired product shot",
    lighting_direction: "even front soft light",
    prop_strategy: "no extra props besides clean grounding shadow",
    beverage_direction: "not required",
    forbidden_repetition: "do not change geometry between color variants"
  },
  {
    image_id: 12,
    role: "Body Straw Detail",
    section: "BODY",
    concept_goal: "Show reusable straw and sip-ready convenience without inventing other components",
    headline: "Reusable Straw Convenience",
    unique_composition: "tight detail card on straw and lid path with simple supporting proof",
    unique_camera: "macro lid-plus-straw angle",
    unique_background: "light detail background",
    unique_lighting: "clean macro product light",
    unique_focal_point: "straw fit and sip-friendly opening",
    scene_family: "TUMBLER_STRAW_DETAIL",
    layout_archetype: "MACRO_FEATURE_WITH_PROOF",
    product_position: "macro crop dominant",
    camera_distance: "tight feature macro shot",
    lighting_direction: "front-top macro light",
    prop_strategy: "no clutter, one clean inset optional",
    beverage_direction: "not required",
    forbidden_repetition: "do not change the straw into a spout or bottle mouthpiece"
  },
  {
    image_id: 13,
    role: "Body Daily Routine",
    section: "BODY",
    concept_goal: "Show the tumbler naturally fitting a home routine without becoming generic atmosphere",
    headline: "Fits The Everyday Routine",
    unique_composition: "lifestyle scene with strong product presence and one small supporting proof block",
    unique_camera: "wider eye-level home routine shot",
    unique_background: "kitchen island, living room side table, or morning prep environment",
    unique_lighting: "natural home light with depth layers",
    unique_focal_point: "product relevance to daily life",
    scene_family: "TUMBLER_DAILY_ROUTINE",
    layout_archetype: "LIFESTYLE_WITH_PROOF_OVERLAY",
    product_position: "foreground lower third or table hero",
    camera_distance: "wide lifestyle body scene",
    lighting_direction: "natural side light with warm bounce",
    prop_strategy: "one or two routine props only, never cluttered",
    beverage_direction: "use beverage cue only if it feels natural to the routine",
    forbidden_repetition: "do not let this become text-free or concept-free"
  },
  {
    image_id: 14,
    role: "Body Giftable",
    section: "BODY",
    concept_goal: "Present the tumbler as a polished and practical lifestyle item",
    headline: "A Practical Premium Pick",
    unique_composition: "clean aspirational product scene with refined styling and restrained text",
    unique_camera: "slight high-three-quarter premium product angle",
    unique_background: "soft premium shelf, counter, or entryway context",
    unique_lighting: "soft premium sunlight with gentle specular highlights",
    unique_focal_point: "stylish but still functional product presence",
    scene_family: "TUMBLER_ASPIRATIONAL",
    layout_archetype: "PREMIUM_LIFESTYLE_STILL",
    product_position: "center-left or center-right with negative space",
    camera_distance: "medium aspirational product shot",
    lighting_direction: "soft warm side light",
    prop_strategy: "only subtle decor, no unrelated objects",
    beverage_direction: "not required",
    forbidden_repetition: "do not repeat capacity badge or technical callout styling"
  },
  {
    image_id: 15,
    role: "Body Storage",
    section: "BODY",
    concept_goal: "Show compact storage and clean shelf or countertop presence",
    headline: "Clean, Easy To Keep Nearby",
    unique_composition: "product near cabinet, shelf, or counter corner with visible negative space and compactness proof",
    unique_camera: "slightly pulled-back storage angle",
    unique_background: "organized pantry, shelf, or countertop nook",
    unique_lighting: "soft ambient home light",
    unique_focal_point: "manageable footprint and tidy placement",
    scene_family: "TUMBLER_STORAGE_CONTEXT",
    layout_archetype: "ORGANIZED_STORAGE_CONTEXT",
    product_position: "left lower third or center-left",
    camera_distance: "wide storage context shot",
    lighting_direction: "ambient upper-left home light",
    prop_strategy: "shelf, glass, folded cloth, or tray only",
    beverage_direction: "empty, hot tea, or cold water cue only if natural",
    forbidden_repetition: "do not bring back pitcher claims, family dining, or unrelated serving props"
  },
  {
    image_id: 16,
    role: "CTA",
    section: "CTA",
    concept_goal: "Close with a clean conversion-focused tumbler image",
    headline: "Ready For Your Routine",
    unique_composition: "full tumbler on one side with neat feature summary and one clean CTA button",
    unique_camera: "straight-on ecommerce conversion angle",
    unique_background: "clean bright lifestyle background appropriate to tumbler use",
    unique_lighting: "front-left high-key commercial light",
    unique_focal_point: "purchase-ready tumbler presentation without fake offers",
    scene_family: "TUMBLER_CTA",
    layout_archetype: "PRODUCT_AND_FEATURE_PANEL",
    product_position: "left or center, full product visible",
    camera_distance: "medium conversion product shot",
    lighting_direction: "front-left high-key light",
    prop_strategy: "simple feature icons only; no fake shipping, review, or discount blocks",
    beverage_direction: "not required",
    forbidden_repetition: "do not make CTA look like just another hero or just another lifestyle frame"
  }
];

const FULL_15_LAYOUT_CARDS = [
  LAYOUT_CARDS[0],
  {
    image_id: 2,
    role: "Gallery Detail",
    section: "GALLERY",
    concept_goal: "Show the full product cutout with all key parts visible",
    headline: "Complete Pitcher Design",
    unique_composition: "clean catalog-style product focus with small labels around lid, spout, handle, and body",
    unique_camera: "straight-on full-product angle",
    unique_background: "warm off-white product inspection background",
    unique_lighting: "even front studio light with soft base shadow",
    unique_focal_point: "complete product outline and all components",
    scene_family: "GALLERY_FULL_PRODUCT_INSPECTION",
    layout_archetype: "CENTER_PRODUCT_LABELS",
    product_position: "center full product",
    camera_distance: "full-product inspection shot",
    lighting_direction: "front even studio light",
    prop_strategy: "no props; product identity only",
    beverage_direction: "clear iced water only, minimal and neutral so the full product shape, lid, handle, spout, and coil remain readable",
    forbidden_repetition: "do not use lifestyle, family, dark studio, or CTA layout"
  },
  {
    image_id: 3,
    role: "Gallery Capacity",
    section: "GALLERY",
    concept_goal: "Communicate 1800ML capacity with a clear scale feeling",
    headline: "Large 1800ML Capacity",
    unique_composition: "product centered with capacity badge and subtle water fill line proof",
    unique_camera: "slightly elevated front angle",
    unique_background: "light blue hydration backdrop with simple capacity badge",
    unique_lighting: "cool soft top-left light",
    unique_focal_point: "large transparent body volume",
    scene_family: "GALLERY_CAPACITY_PROOF",
    layout_archetype: "CENTER_PRODUCT_CAPACITY_BADGE",
    product_position: "center slightly low",
    camera_distance: "medium full-body capacity shot",
    lighting_direction: "top-left cool soft light",
    prop_strategy: "water fill line and small glass cup only",
    beverage_direction: "clear water fill line with subtle ice and condensation only; no lemon emphasis on this capacity proof image",
    forbidden_repetition: "do not repeat hero kitchen or technical filter callout layout"
  },
  {
    image_id: 4,
    role: "Gallery Filter",
    section: "GALLERY",
    concept_goal: "Show the stainless steel spring coil filter accurately",
    headline: "Spring Coil Filter Spout",
    unique_composition: "large spout close-up on left with secondary full product reference on right",
    unique_camera: "macro close-up of left angled spout",
    unique_background: "clean pale technical background with precise callout line",
    unique_lighting: "harder rim light on stainless steel coil",
    unique_focal_point: "spiral coil inside the spout, not handle",
    scene_family: "GALLERY_SPOUT_COIL_MACRO",
    layout_archetype: "LEFT_MACRO_RIGHT_REFERENCE",
    product_position: "right small reference plus left macro",
    camera_distance: "macro spout shot",
    lighting_direction: "right metal rim light",
    prop_strategy: "no props; technical callout only",
    beverage_direction: "mostly empty/transparent around the spout; do not add fruit, heavy water motion, or droplets that obscure or redesign the spring coil filter",
    forbidden_repetition: "callout line must point only to spout coil, never handle"
  },
  {
    image_id: 5,
    role: "Gallery Lid",
    section: "GALLERY",
    concept_goal: "Highlight the natural bamboo lid and glass neck",
    headline: "Natural Bamboo Lid",
    unique_composition: "top-neck crop with lid texture enlarged and full product ghosted behind",
    unique_camera: "slight top-down crop on lid and neck",
    unique_background: "warm bamboo texture accent backdrop",
    unique_lighting: "warm top light revealing bamboo texture",
    unique_focal_point: "round bamboo lid on top",
    scene_family: "GALLERY_BAMBOO_LID_DETAIL",
    layout_archetype: "TOP_DETAIL_TEXTURE_CALLOUT",
    product_position: "upper center detail crop",
    camera_distance: "close lid detail shot",
    lighting_direction: "top warm texture light",
    prop_strategy: "bamboo texture accent only",
    beverage_direction: "optional very light amber tea below the bamboo lid only if it does not distract from lid texture and product geometry",
    forbidden_repetition: "do not add unrelated certification or eco claims"
  },
  {
    image_id: 6,
    role: "Gallery Pour",
    section: "GALLERY",
    concept_goal: "Show smooth pouring while preserving exact spout geometry",
    headline: "Easy Smooth Pour",
    unique_composition: "diagonal pouring action with product tilted, clean text-safe area on upper right",
    unique_camera: "dynamic side action angle",
    unique_background: "bright sink-side serving scene with water stream",
    unique_lighting: "sparkling side light on pouring water",
    unique_focal_point: "angled spout and controlled pour stream",
    scene_family: "GALLERY_POUR_ACTION",
    layout_archetype: "DIAGONAL_ACTION_TEXT_SAFE",
    product_position: "left diagonal pour",
    camera_distance: "medium action shot",
    lighting_direction: "side sparkle light",
    prop_strategy: "one receiving glass and water stream only",
    beverage_direction: "pale cucumber mint water pouring into the glass; avoid repeating lemon slices as the main visual",
    forbidden_repetition: "do not crop away the spout or turn it into another spout shape"
  },
  {
    image_id: 7,
    role: "Body Feature Filter",
    section: "BODY",
    concept_goal: "Explain the filter benefit in a landing page body section",
    headline: "Keeps Fruit And Ice Inside",
    unique_composition: "split feature diagram with spout coil close-up and three concise proof rows",
    unique_camera: "feature diagram angle",
    unique_background: "technical white-blue diagram surface",
    unique_lighting: "controlled top-right feature light",
    unique_focal_point: "coil filter preventing ice and fruit pieces",
    scene_family: "BODY_FILTER_DIAGRAM",
    layout_archetype: "SPLIT_DIAGRAM_PROOF_ROWS",
    product_position: "left technical crop",
    camera_distance: "close feature diagram",
    lighting_direction: "top-right diagram light",
    prop_strategy: "ice and fruit pieces as proof elements only",
    beverage_direction: "small cucumber, mint, or pale fruit pieces may be shown as filter proof, but keep them sparse and never let them obscure or reshape the spring coil filter",
    forbidden_repetition: "do not use generic handle callout"
  },
  {
    image_id: 8,
    role: "Body Material",
    section: "BODY",
    concept_goal: "Show glass clarity without unsupported certification claims",
    headline: "Clear Glass For Everyday Drinks",
    unique_composition: "minimal material section with product centered and light passing through glass",
    unique_camera: "low material angle",
    unique_background: "soft gray reflective product studio",
    unique_lighting: "backlit glass transparency beam",
    unique_focal_point: "transparent glass wall and water clarity",
    scene_family: "BODY_GLASS_CLARITY_STUDIO",
    layout_archetype: "BACKLIT_CENTER_MATERIAL",
    product_position: "center on reflective surface",
    camera_distance: "medium material shot",
    lighting_direction: "backlight through glass",
    prop_strategy: "reflection only, no fruit props",
    beverage_direction: "very clear water only with crisp reflections, no fruit, no color shift, to show glass clarity",
    forbidden_repetition: "do not say BPA free, lead free, medical, certified, or eco friendly"
  },
  {
    image_id: 9,
    role: "Body Hot Cold",
    section: "BODY",
    concept_goal: "Show hot and cold drink versatility only as visual use cases",
    headline: "Ready For Hot Or Cold Drinks",
    unique_composition: "two-zone temperature visual with tea warmth on one side and iced citrus on the other",
    unique_camera: "front product comparison angle",
    unique_background: "split warm-cool gradient serving backdrop",
    unique_lighting: "warm left light and cool right fill",
    unique_focal_point: "same product shown with hot tea and iced drink context",
    scene_family: "BODY_HOT_COLD_USAGE",
    layout_archetype: "WARM_COOL_SPLIT_USE_CASE",
    product_position: "center bridging two zones",
    camera_distance: "medium use-case shot",
    lighting_direction: "dual warm-cool side light",
    prop_strategy: "steam cup and iced glass as context props",
    beverage_direction: "one side should suggest warm light amber tea with gentle steam, the other side clear iced water with ice and condensation; keep both translucent and campaign-safe",
    forbidden_repetition: "do not add exact temperature numbers unless shown in source evidence"
  },
  {
    image_id: 10,
    role: "Body Kitchen Use",
    section: "BODY",
    concept_goal: "Show daily use on a clean kitchen counter",
    headline: "Made For Daily Serving",
    unique_composition: "kitchen counter body section with product mid-left and serving glasses trailing right",
    unique_camera: "natural counter-level angle",
    unique_background: "modern neutral kitchen counter with shallow shelf depth",
    unique_lighting: "soft overhead kitchen daylight",
    unique_focal_point: "pitcher ready to serve drinks",
    scene_family: "BODY_DAILY_KITCHEN_SERVING",
    layout_archetype: "COUNTER_SERVING_SEQUENCE",
    product_position: "mid-left",
    camera_distance: "wide counter shot",
    lighting_direction: "overhead diffuse kitchen daylight",
    prop_strategy: "two glasses and tray, no family people",
    beverage_direction: "soft orange or peach fruit infusion, translucent and balanced with the bamboo tones",
    forbidden_repetition: "do not repeat hero right-product layout"
  },
  {
    image_id: 11,
    role: "Body Family",
    section: "BODY",
    concept_goal: "Show family table lifestyle without overloading text",
    headline: "Fresh Drinks For The Table",
    unique_composition: "family table scene with product foreground and short headline floating in open wall space",
    unique_camera: "wider lifestyle eye-level angle",
    unique_background: "family dining room with soft people bokeh",
    unique_lighting: "warm window side light",
    unique_focal_point: "pitcher as table centerpiece",
    scene_family: "BODY_FAMILY_TABLE",
    layout_archetype: "LIFESTYLE_FOREGROUND_OPEN_WALL_TEXT",
    product_position: "foreground lower right",
    camera_distance: "wide lifestyle body scene",
    lighting_direction: "warm side window light",
    prop_strategy: "table food and family bokeh, no technical icons",
    beverage_direction: "light herbal tea with a soft warm glow or pale fruit water with ice, table-ready and not another lemon-water hero",
    forbidden_repetition: "do not reuse CTA card or technical diagram"
  },
  {
    image_id: 12,
    role: "Body Storage",
    section: "BODY",
    concept_goal: "Show compact storage and clean countertop presence",
    headline: "Clean Countertop Friendly Design",
    unique_composition: "product near cabinet or shelf with clear negative space and simple dimensions cue",
    unique_camera: "slightly pulled-back countertop angle",
    unique_background: "organized pantry or countertop corner",
    unique_lighting: "soft ambient home light",
    unique_focal_point: "manageable pitcher size and handle clearance",
    scene_family: "BODY_COUNTERTOP_STORAGE",
    layout_archetype: "ORGANIZED_COUNTERTOP_CONTEXT",
    product_position: "left lower third",
    camera_distance: "wide storage context shot",
    lighting_direction: "ambient upper-left home light",
    prop_strategy: "shelf, cup, and folded cloth only",
    beverage_direction: "empty pitcher or clear water only; keep storage focused on product form and countertop fit",
    forbidden_repetition: "do not show refrigerator unless product actually fits"
  },
  {
    image_id: 13,
    role: "Body Cleaning",
    section: "BODY",
    concept_goal: "Suggest easy cleaning visually without unsupported dishwasher claims",
    headline: "Wide Opening For Easy Cleaning",
    unique_composition: "real sink-washing action: one human hand holds a sponge or bottle brush inside the empty pitcher while water rinses the glass walls",
    unique_camera: "close top-down sink action angle showing the open empty pitcher interior",
    unique_background: "clean sink-side counter with running rinse water and realistic wet surface",
    unique_lighting: "bright sink-side daylight with water droplets and glass reflections",
    unique_focal_point: "human hand actively washing the empty wide mouth opening and inner glass wall",
    scene_family: "BODY_CLEANING_OPENING",
    layout_archetype: "REAL_HAND_WASHING_ACTION",
    product_position: "center sink action",
    camera_distance: "close practical cleaning shot",
    lighting_direction: "front-right sink light",
    prop_strategy: "empty pitcher, removed bamboo lid beside sink, sponge or long bottle brush, running rinse water, no drink ingredients",
    beverage_direction: "empty pitcher only because this is a cleaning image; no beverage, no ice, no fruit, no tea",
    action_logic: "The pitcher must be empty before cleaning. No ice, no lemon slices, no tea, no drinking water inside. The hand must visibly clean the inside wall or bottom with a sponge or bottle brush.",
    forbidden_repetition: "do not show the pitcher full of drink while being cleaned; do not claim dishwasher safe unless source text proves it"
  },
  {
    image_id: 14,
    role: "Body Set Proof",
    section: "BODY",
    concept_goal: "Show what the customer receives as a simple product set proof",
    headline: "Pitcher Lid And Filter Details",
    unique_composition: "flat-lay set proof with pitcher, bamboo lid detail, and spout coil detail panels",
    unique_camera: "top-down flat-lay angle",
    unique_background: "warm neutral tabletop flat-lay",
    unique_lighting: "even flat-lay studio light",
    unique_focal_point: "product parts overview",
    scene_family: "BODY_SET_PROOF_FLATLAY",
    layout_archetype: "TOPDOWN_PARTS_OVERVIEW",
    product_position: "center-left flat-lay",
    camera_distance: "top-down set shot",
    lighting_direction: "even overhead flat-lay light",
    prop_strategy: "no extra accessories beyond visible product parts",
    beverage_direction: "empty product parts or clear water droplets only; do not introduce a flavor concept in this proof image",
    forbidden_repetition: "do not invent extra accessories or packaging"
  },
  {
    ...LAYOUT_CARDS[4],
    image_id: 15,
    section: "CTA"
  }
];

const CREATIVE_DIVERSITY_RULES = {
  objective: "Make the five images feel like a coherent campaign set, not five versions of the same ad.",
  required_unique_fields: [
    "scene_family",
    "layout_archetype",
    "product_position",
    "camera_distance",
    "lighting_direction",
    "prop_strategy"
  ],
  shared_consistency_fields: [
    "product_dna",
    "typography_system",
    "color_palette",
    "icon_style",
    "claim_safety"
  ],
  forbidden_batch_patterns: [
    "all images in bright kitchen",
    "all images on white marble",
    "all products on the right",
    "all images with left text column",
    "repeated plant and lemon props",
    "same light direction in every image",
    "same camera distance in every image"
  ]
};

function parseArgs(argv) {
  const args = {
    workspace: DEFAULT_WORKSPACE,
    project: "test_product_01",
    reference: null,
    mock: false,
    retryFailed: false,
    full15: false,
    requestedImageCount: 0,
    includeCta: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      args.workspace = argv[index + 1];
      index += 1;
    } else if (arg === "--project") {
      args.project = argv[index + 1];
      index += 1;
    } else if (arg === "--reference") {
      args.reference = argv[index + 1];
      index += 1;
    } else if (arg === "--mock") {
      args.mock = true;
    } else if (arg === "--retry-failed") {
      args.retryFailed = true;
    } else if (arg === "--full15") {
      args.full15 = true;
    } else if (arg === "--target-count") {
      args.requestedImageCount = Number.parseInt(argv[index + 1], 10) || 0;
      index += 1;
    } else if (arg === "--include-cta") {
      args.includeCta = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  npm run experiment:v2 -- --project <project_id>",
    "  npm run experiment:v2 -- --project <project_id> --full15",
    "  npm run experiment:v2 -- --project <project_id> --target-count 15 --include-cta",
    "  npm run experiment:v2 -- --reference <image_path>",
    "  npm run experiment:v2:mock -- --project <project_id>",
    "",
    "Options:",
    "  --project <project_id>     Product folder under workspace/products/, defaults to test_product_01",
    "  --reference <image_path>    Explicit reference product image",
    "  --workspace <path>          Workspace root, defaults to workspace",
    "  --full15                    Legacy shortcut for 15 non-CTA images",
    "  --target-count <number>     Requested non-CTA image count",
    "  --include-cta               Add one CTA image on top of target count",
    "  --retry-failed              Regenerate failed images from the previous report",
    "  --mock                      Run without OpenAI and create placeholder PNGs"
  ].join("\n");
}

async function loadDotEnv(envPath = ".env") {
  const text = await fs.readFile(envPath, "utf8").catch(() => "");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) {
      const quote = value[0];
      while (index + 1 < lines.length && !value.endsWith(quote)) {
        index += 1;
        value += lines[index].trim();
      }
    }
    value = value.replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function listProductImages(imagesRoot) {
  const entries = await fs.readdir(imagesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((filename) => [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(filename).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

// All input photos of the product, best-scored first, so image generation can pass
// every angle to the model (multi-image reference) instead of a single view.
async function collectReferenceImages({ workspace, project, productText = "", max = 8 } = {}) {
  const imagesRoot = path.join(path.resolve(workspace), "products", project, "input", "images");
  const images = await listProductImages(imagesRoot);
  if (images.length === 0) {
    return [];
  }
  const scored = images
    .map((filename) => ({ filename, score: scoreReferenceFilename(filename, productText) }))
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
  return scored.slice(0, max).map((entry) => path.join(imagesRoot, entry.filename));
}

async function findReferenceImage({ workspace, project, reference, productText = "" }) {
  if (reference) {
    return path.resolve(reference);
  }

  const imagesRoot = path.join(path.resolve(workspace), "products", project, "input", "images");
  const images = await listProductImages(imagesRoot);
  if (images.length === 0) {
    throw new Error(`No reference product images found in ${imagesRoot}`);
  }

  const scoredImages = images.map((filename) => ({
    filename,
    score: scoreReferenceFilename(filename, productText)
  }));
  scoredImages.sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename));
  return path.join(imagesRoot, scoredImages[0].filename);
}

function scoreReferenceFilename(filename, productText = "") {
  const lower = filename.toLowerCase();
  const evidence = normalizeEvidenceText(productText);
  let score = 0;
  for (const token of ["hero", "front", "lid", "filter", "coil", "spout", "pitcher"]) {
    if (lower.includes(token)) score += 3;
  }
  for (const token of ["chair", "highchair", "seat", "full", "hero", "product"]) {
    if (lower.includes(token)) score += 3;
  }
  for (const token of ["wrench", "impact", "tool", "front", "brushless", "product", "hero"]) {
    if (lower.includes(token)) score += 3;
  }
  if (
    evidence.includes("educational toy") ||
    evidence.includes("math learning board") ||
    evidence.includes("montessori") ||
    evidence.includes("number tiles") ||
    evidence.includes("counting sticks")
  ) {
    for (const token of ["main", "full", "open", "set", "board", "math", "toy", "clock", "chalkboard", "product"]) {
      if (lower.includes(token)) score += 3;
    }
    for (const token of ["detail", "close", "macro", "hand"]) {
      if (lower.includes(token)) score -= 4;
    }
  }
  for (const token of ["detail", "spec", "dimension"]) {
    if (lower.includes(token)) score += 1;
  }
  for (const token of ["pour", "hand", "stove", "collage", "dimension", "box", "buckle", "functions", "rotation"]) {
    if (lower.includes(token)) score -= 2;
  }
  return score;
}

function mimeTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstMatch(text, pattern) {
  return String(text ?? "").match(pattern)?.[1]?.trim() ?? "";
}

function normalizeEvidenceText(value = "") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const ARCHETYPE_SIGNAL_MAP = {
  glass_water_pitcher: [
    "glass water pitcher",
    "water pitcher",
    "glass pitcher",
    "teapot",
    "pitcher",
    "jug"
  ],
  cordless_impact_wrench: [
    "impact wrench",
    "cordless wrench",
    "power tool",
    "impact gun",
    "tool kit"
  ],
  baby_high_chair: [
    "baby high chair",
    "high chair",
    "children dining chair",
    "dining chair",
    "ghế ăn",
    "ghe an"
  ],
  sink_organizer: [
    "sink organizer",
    "sink storage",
    "kitchen sink organizer",
    "sponge holder",
    "storage rack for sink",
    "kitchen organizer rack"
  ],
  tumbler_drinkware: [
    "tumbler",
    "travel mug",
    "vacuum insulated tumbler",
    "insulated mug",
    "cup with straw",
    "rotating lid",
    "40oz",
    "1180ml",
    "40 oz"
  ],
  educational_math_board: [
    "educational toy",
    "math learning board",
    "math board",
    "montessori board",
    "learning board",
    "wooden math toy"
  ]
};

function parseStructuredProductFields(productText = "") {
  const labelMap = new Map([
    ["sku", "sku"],
    ["category", "category"],
    ["description", "description"],
    ["colors", "colors"],
    ["target image count", "targetImageCount"],
    ["cta required", "needsCta"]
  ]);
  const fields = {};
  for (const rawLine of String(productText ?? "").split(/\r?\n/)) {
    const separatorIndex = rawLine.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const label = normalizeEvidenceText(rawLine.slice(0, separatorIndex).trim());
    const key = labelMap.get(label);
    if (!key) {
      continue;
    }
    fields[key] = rawLine.slice(separatorIndex + 1).trim();
  }
  return fields;
}

function resolveArchetypeFromSignals(...values) {
  const normalized = values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => normalizeEvidenceText(String(value ?? "")))
    .filter(Boolean);
  for (const [archetypeId, signals] of Object.entries(ARCHETYPE_SIGNAL_MAP)) {
    if (signals.some((signal) => normalized.some((value) => value.includes(normalizeEvidenceText(signal))))) {
      return archetypeId;
    }
  }
  return "";
}

function defaultClassificationSummary({ productFields = {}, productText = "" } = {}) {
  const category = String(productFields.category ?? parseCategoryFromProductText(productText) ?? "").trim();
  const description = String(productFields.description ?? "").trim();
  const fieldArchetype = resolveArchetypeFromSignals(
    productFields.category,
    productFields.description,
    productFields.sku
  );
  return {
    source: fieldArchetype ? "WEB_FIELDS" : "TEXT_FALLBACK",
    detected_category: category || "UNKNOWN",
    detected_product_type: description || category || "UNKNOWN",
    visible_parts: [],
    likely_archetype: fieldArchetype || "",
    confidence: fieldArchetype ? 0.72 : 0.35,
    conflicts_with_user_input: [],
    notes: "Fallback classification without AI image confirmation."
  };
}

function parseBooleanLike(value, defaultValue = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseRequestedImageCountValue(value, fallback = 0) {
  const match = String(value ?? "").match(/(\d+)/);
  if (!match) {
    return fallback;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PRODUCT_ARCHETYPES = [
  {
    id: "glass_water_pitcher",
    productDna: DEFAULT_PRODUCT_DNA,
    layoutCards: LAYOUT_CARDS,
    full15LayoutCards: FULL_15_LAYOUT_CARDS,
    matchKeywords: [
      "glass water pitcher",
      "glass pitcher",
      "teapot",
      "bamboo lid",
      "spring coil filter",
      "filter spout",
      "1800ml",
      "borosilicate"
    ]
  },
  {
    id: "cordless_impact_wrench",
    productDna: CORDLESS_IMPACT_WRENCH_PRODUCT_DNA,
    layoutCards: CORDLESS_IMPACT_WRENCH_LAYOUT_CARDS,
    full15LayoutCards: CORDLESS_IMPACT_WRENCH_FULL_15_LAYOUT_CARDS,
    matchKeywords: [
      "impact wrench",
      "cordless wrench",
      "brushless motor",
      "impact gun",
      "square drive",
      "anvil",
      "forward/reverse",
      "battery level display",
      "led light",
      "tool kit",
      "socket set",
      "power tool",
      "wrench function",
      "electric screwdriver",
      "electric drill"
    ]
  },
  {
    id: "baby_high_chair",
    productDna: BABY_HIGH_CHAIR_PRODUCT_DNA,
    layoutCards: BABY_HIGH_CHAIR_LAYOUT_CARDS,
    matchKeywords: [
      "baby high chair",
      "children's dining chair",
      "children dining chair",
      "ghe an",
      "khay an",
      "day an toan",
      "foot pedal",
      "dining plate",
      "adjustable height",
      "2 muc dieu chinh",
      "nhua pp",
      "thep khong gi"
    ]
  },
  {
    id: "sink_organizer",
    productDna: SINK_ORGANIZER_PRODUCT_DNA,
    layoutCards: SINK_ORGANIZER_LAYOUT_CARDS,
    matchKeywords: [
      "sink organizer",
      "sink storage",
      "kitchen sink organizer",
      "rack stainless",
      "storage rack",
      "detachable cloth rod",
      "cloth hanging rod",
      "drain tray",
      "tilting water collection",
      "sponge holder",
      "kitchen accessories",
      "23 x 9.4 x 10.7"
    ]
  },
  {
    id: "tumbler_drinkware",
    productDna: TUMBLER_PRODUCT_DNA,
    layoutCards: TUMBLER_LAYOUT_CARDS,
    full15LayoutCards: TUMBLER_FULL_15_LAYOUT_CARDS,
    matchKeywords: [
      "tumbler",
      "travel mug",
      "cup with straw",
      "rotating lid",
      "40oz",
      "1180ml",
      "vacuum insulated",
      "double-wall stainless steel",
      "insulated mug"
    ]
  },
  {
    id: "educational_math_board",
    productDna: EDUCATIONAL_MATH_BOARD_PRODUCT_DNA,
    layoutCards: EDUCATIONAL_MATH_BOARD_LAYOUT_CARDS,
    matchKeywords: [
      "educational toy",
      "math learning board",
      "math board",
      "montessori",
      "learning board",
      "number tiles",
      "counting sticks",
      "toy clock",
      "chalkboard",
      "eraser block",
      "addition",
      "subtraction",
      "multiplication",
      "division",
      "comparison sign",
      "learn math",
      "early math",
      "wooden math toy"
    ]
  }
];

function getGenericArchetype() {
  return {
    id: "generic_ecommerce_product",
    productDna: GENERIC_PRODUCT_DNA,
    layoutCards: GENERIC_LAYOUT_CARDS
  };
}

function selectProductArchetype({ productFields = {}, productText = "", classification = null } = {}) {
  // Generic mode: never map the product onto a category archetype. Identity is
  // built from the real reference image instead of a same-category template.
  if (!categoryModeEnabled()) {
    return getGenericArchetype();
  }
  const fieldArchetypeId = resolveArchetypeFromSignals(
    productFields.category,
    productFields.description,
    productFields.sku
  );
  if (fieldArchetypeId) {
    return PRODUCT_ARCHETYPES.find((archetype) => archetype.id === fieldArchetypeId) ?? getGenericArchetype();
  }

  const aiArchetypeId = resolveArchetypeFromSignals(
    classification?.likely_archetype,
    classification?.detected_category,
    classification?.detected_product_type,
    classification?.visible_parts ?? []
  );
  if (aiArchetypeId) {
    return PRODUCT_ARCHETYPES.find((archetype) => archetype.id === aiArchetypeId) ?? getGenericArchetype();
  }

  const normalized = normalizeEvidenceText(productText);
  const scored = PRODUCT_ARCHETYPES
    .map((archetype) => ({
      archetype,
      score: archetype.matchKeywords.filter((keyword) => normalized.includes(normalizeEvidenceText(keyword))).length
    }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 1) {
    return scored[0].archetype;
  }
  return getGenericArchetype();
}

async function analyzeReferenceImagesForClassification({
  workspace,
  project,
  productText = "",
  productFields = {},
  mock = false
} = {}) {
  const config = loadAiConfig({
    ...process.env,
    OPENAI_MOCK: mock ? "true" : process.env.OPENAI_MOCK
  });
  const fallback = defaultClassificationSummary({ productFields, productText });
  const imagesRoot = path.join(path.resolve(workspace), "products", project, "input", "images");

  try {
    const { images } = await loadImagePayloads(imagesRoot, config, { allowTruncate: true });
    if (!images.length) {
      return {
        ...fallback,
        source: "NO_IMAGES",
        notes: "No supported reference images available for AI classification."
      };
    }

    const systemPrompt = [
      "You classify products for an ecommerce creative workflow.",
      "Priority order:",
      "1. Real uploaded product images.",
      "2. Explicit user input fields.",
      "3. product.txt text.",
      "Do not hallucinate product category or function.",
      "Return JSON only."
    ].join("\n");

    const userPrompt = [
      "Classify the product type before prompt writing.",
      `User category: ${productFields.category || "UNKNOWN"}`,
      `User description: ${productFields.description || "UNKNOWN"}`,
      `User SKU: ${productFields.sku || project || "UNKNOWN"}`,
      `User colors: ${productFields.colors || "UNKNOWN"}`,
      "Known archetypes:",
      "- glass_water_pitcher",
      "- cordless_impact_wrench",
      "- baby_high_chair",
      "- sink_organizer",
      "- educational_math_board",
      "- generic_ecommerce_product",
      "",
      "Return an object with these fields:",
      "detected_category",
      "detected_product_type",
      "visible_parts",
      "likely_archetype",
      "confidence",
      "conflicts_with_user_input",
      "notes",
      "",
      "product.txt:",
      productText || "EMPTY"
    ].join("\n");

    const result = await generateStructuredJson({
      taskName: "V2_PRODUCT_CLASSIFICATION",
      systemPrompt,
      userPrompt,
      schemaName: "V2ProductClassification",
      mockResponse: fallback,
      metadata: {
        project,
        stage: "creative-pipeline-v2",
        purpose: "product-classification"
      },
      images
    }, { config });

    return {
      source: config.mockMode ? "MOCK" : "AI_IMAGE_ANALYSIS",
      detected_category: String(result.detected_category ?? fallback.detected_category ?? "UNKNOWN").trim() || "UNKNOWN",
      detected_product_type: String(result.detected_product_type ?? fallback.detected_product_type ?? "UNKNOWN").trim() || "UNKNOWN",
      visible_parts: Array.isArray(result.visible_parts) ? result.visible_parts.map((item) => String(item).trim()).filter(Boolean) : [],
      likely_archetype: String(result.likely_archetype ?? "").trim(),
      confidence: Number.isFinite(Number(result.confidence)) ? Math.max(0, Math.min(1, Number(result.confidence))) : fallback.confidence,
      conflicts_with_user_input: Array.isArray(result.conflicts_with_user_input)
        ? result.conflicts_with_user_input.map((item) => String(item).trim()).filter(Boolean)
        : [],
      notes: String(result.notes ?? "").trim()
    };
  } catch (error) {
    return {
      ...fallback,
      source: "FALLBACK_AFTER_AI_ERROR",
      notes: `AI classification fallback: ${error.message}`
    };
  }
}

function parseCategoryFromProductText(productText = "") {
  const category = firstMatch(productText, /(?:category|product category|danh muc|danh mục)\s*:\s*([^\n]+)/i);
  return category || "";
}

function normalizeCategoryKey(value = "") {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapArchetypeToKnowledgeCategory(archetypeId) {
  if (archetypeId === "baby_high_chair") return "baby_parenting";
  if (archetypeId === "sink_organizer") return "kitchen_accessories";
  if (archetypeId === "cordless_impact_wrench") return "power_tools";
  if (archetypeId === "tumbler_drinkware") return "tumbler";
  if (archetypeId === "educational_math_board") return "educational_toy";
  return "";
}

async function loadCuratedCreativeKnowledge({ workspaceRoot, productText, archetypeId }) {
  const globalPath = path.join(workspaceRoot, "catalog", "_global", "knowledge", "general_creative_learning.md");
  const explicitCategory = normalizeCategoryKey(parseCategoryFromProductText(productText));
  const mappedCategory = mapArchetypeToKnowledgeCategory(archetypeId);
  // In generic mode we deliberately skip same-category product knowledge and keep
  // only the general design knowledge (typography, layout, background, color).
  const categoryKey = categoryModeEnabled() ? (explicitCategory || mappedCategory) : "";
  const categoryPath = categoryKey
    ? path.join(workspaceRoot, "catalog", categoryKey, "knowledge", "category_learning.md")
    : "";
  const [globalKnowledge, categoryKnowledge] = await Promise.all([
    fs.readFile(globalPath, "utf8").catch(() => ""),
    categoryPath ? fs.readFile(categoryPath, "utf8").catch(() => "") : Promise.resolve("")
  ]);

  return {
    global: {
      key: "_global",
      source: path.relative(workspaceRoot, globalPath).replace(/\\/g, "/"),
      content: globalKnowledge
    },
    category: {
      key: categoryKey || "unknown",
      source: categoryPath ? path.relative(workspaceRoot, categoryPath).replace(/\\/g, "/") : "",
      content: categoryKnowledge
    },
    policy: {
      allowed_sources: [
        "workspace/catalog/_global/knowledge/general_creative_learning.md",
        "workspace/catalog/<category>/knowledge/category_learning.md"
      ],
      forbidden_sources: [
        "workspace/knowledge_staging/**",
        "raw imported markdown patches",
        "SKU knowledge from unrelated products"
      ]
    }
  };
}

function flattenCuratedKnowledge(knowledgeBundle) {
  if (!knowledgeBundle) {
    return [
      "CURATED CREATIVE KNOWLEDGE LOCK:",
      "Use only stable cross-category ecommerce design rules and product-category-safe creative rules.",
      "Do not pull raw staging markdown, unrelated SKU knowledge, or product identity facts from other products."
    ].join("\n");
  }
  const lines = [
    "CURATED CREATIVE KNOWLEDGE LOCK:",
    `Allowed sources only: ${knowledgeBundle.policy.allowed_sources.join("; ")}.`,
    `Forbidden sources: ${knowledgeBundle.policy.forbidden_sources.join("; ")}.`
  ];

  if (knowledgeBundle.global.content.trim()) {
    lines.push("Global creative knowledge:");
    lines.push(knowledgeBundle.global.content.trim());
  }
  if (knowledgeBundle.category.content.trim()) {
    lines.push(`Category creative knowledge (${knowledgeBundle.category.key}):`);
    lines.push(knowledgeBundle.category.content.trim());
  }

  return lines.join("\n");
}

function isBabyHighChairProduct(productText = "") {
  const normalized = productText.toLowerCase();
  return [
    "baby high chair",
    "children's dining chair",
    "children dining chair",
    "ghế ăn",
    "ghe an",
    "khay ăn",
    "khay an",
    "dây an toàn",
    "day an toan",
    "foot pedal",
    "dining plate",
    "adjustable height"
  ].some((token) => normalized.includes(token));
}

function isBrandLikePart(value = "") {
  const text = normalizeEvidenceText(String(value ?? ""));
  return [
    "brand",
    "logo",
    "wordmark",
    "store name",
    "seller mark",
    "marketplace watermark",
    "packaging text",
    "label text"
  ].some((token) => text.includes(token));
}

function sanitizeVisibleParts(parts = []) {
  return [...new Set((Array.isArray(parts) ? parts : [])
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .filter((part) => !isBrandLikePart(part)))];
}

function normalizeIdentityArray(parts = []) {
  return [...new Set((Array.isArray(parts) ? parts : [])
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .filter((part) => !isBrandLikePart(part)))];
}

function detectProductFamily(productDna, productFields = {}, classification = null) {
  const text = [
    productDna?.product_archetype,
    productDna?.identity?.category,
    productDna?.identity?.shape,
    productFields.category,
    productFields.description,
    classification?.detected_category,
    classification?.detected_product_type
  ].map((value) => normalizeEvidenceText(String(value ?? ""))).join(" ");

  if (text.includes("tumbler") || text.includes("travel mug") || text.includes("insulated mug")) {
    return "drinkware_tumbler";
  }
  if (text.includes("pitcher") || text.includes("teapot")) {
    return "drinkware_pitcher";
  }
  if (text.includes("sink organizer") || text.includes("storage rack")) {
    return "sink_storage";
  }
  if (text.includes("impact wrench") || text.includes("power tool")) {
    return "power_tool";
  }
  if (text.includes("high chair")) {
    return "baby_furniture";
  }
  if (text.includes("math") || text.includes("montessori")) {
    return "educational_toy";
  }
  return "generic_ecommerce";
}

function buildProductStrategy({
  productDna,
  productFields = {},
  classification = null,
  requestedImageCount = 0,
  includeCta = false
} = {}) {
  const family = detectProductFamily(productDna, productFields, classification);
  const base = {
    product_family: family,
    requested_non_cta_images: requestedImageCount,
    include_cta: includeCta,
    soft_category_reference_only: true,
    usp: [],
    pain_points: [],
    use_cases: [],
    usage_environment: [],
    buyer_intent: [],
    concept_guardrails: [],
    allowed_feature_angles: [],
    forbidden_foreign_features: []
  };

  if (family === "drinkware_tumbler") {
    return {
      ...base,
      usp: [
        "large insulated tumbler capacity",
        "rotating lid and reusable straw convenience",
        "comfortable side handle for daily carry",
        "vacuum insulated everyday drinkware positioning"
      ],
      pain_points: [
        "needs a tumbler that is easy to carry",
        "wants fewer spills during daily movement",
        "needs a drink companion for desk, car, home, or workout routines"
      ],
      use_cases: [
        "desk hydration",
        "home routine",
        "commute or car travel",
        "cold drink refreshment",
        "warm drink comfort"
      ],
      usage_environment: [
        "clean desk",
        "kitchen counter",
        "sofa side table",
        "car or travel-ready context",
        "morning routine environment"
      ],
      buyer_intent: [
        "portable hydration",
        "daily-use convenience",
        "giftable practical drinkware",
        "hot and cold lifestyle flexibility"
      ],
      concept_guardrails: [
        "do not convert the tumbler into a pitcher, teapot, or bottle",
        "do not add serving-scene logic intended for multi-person pour products",
        "use category knowledge as reference only; final concept must come from current product identity and user fields",
        "every image must communicate a clear tumbler-specific proof or use case"
      ],
      allowed_feature_angles: [
        "lid detail",
        "straw detail",
        "handle comfort",
        "capacity proof",
        "material and insulation proof",
        "color variants",
        "desk, commute, home, or refreshment lifestyle"
      ],
      forbidden_foreign_features: [
        "pitcher",
        "teapot",
        "spout",
        "spring coil filter",
        "bamboo lid",
        "pouring spout",
        "1800ml pitcher",
        "family serving pitcher"
      ]
    };
  }

  if (family === "sink_storage") {
    return {
      ...base,
      forbidden_foreign_features: ["straw", "lid", "pitcher", "teapot", "family dining", "bamboo lid"]
    };
  }

  if (family === "power_tool") {
    return {
      ...base,
      forbidden_foreign_features: ["cup", "straw", "pitcher", "teapot", "kitchen sink rack", "baby chair"]
    };
  }

  if (family === "baby_furniture") {
    return {
      ...base,
      forbidden_foreign_features: ["pitcher", "spout", "coil filter", "tool battery", "sink rack"]
    };
  }

  if (family === "educational_toy") {
    return {
      ...base,
      forbidden_foreign_features: ["impact wrench", "pitcher", "sink rack", "travel mug", "bamboo lid"]
    };
  }

  return base;
}

// Philippines-market marketing knowledge used by the AI strategy step. Editable by
// the user; only files they provide should live here.
async function loadMarketKnowledge(workspaceRoot) {
  const marketPath = path.join(path.resolve(workspaceRoot ?? DEFAULT_WORKSPACE), "catalog", "_global", "knowledge", "ph_market_knowledge.md");
  return fs.readFile(marketPath, "utf8").catch(() => "");
}

// AI Product Strategy: analyzes the real product identity against Philippines-market
// buyer behavior to derive pain points → USP → feature angles that drive the layout.
// In mock mode it returns the deterministic strategy so tests/offline stay stable.
async function analyzeProductStrategy({
  productDna,
  productFields = {},
  productText = "",
  classification = null,
  marketKnowledge = "",
  requestedImageCount = 0,
  includeCta = false,
  mock = false,
  project = ""
} = {}) {
  const fallback = buildProductStrategy({ productDna, productFields, classification, requestedImageCount, includeCta });
  const config = loadAiConfig({
    ...process.env,
    OPENAI_MOCK: mock ? "true" : process.env.OPENAI_MOCK
  });
  const identity = productDna?.identity ?? {};

  const systemPrompt = [
    "You are an ecommerce marketing strategist for the PHILIPPINES market (Shopee, Lazada, TikTok Shop shoppers).",
    "From the product's real identity, derive a conversion strategy grounded in Filipino online-shopper behavior.",
    "Rules:",
    "- Use ONLY the given product identity. Never invent features, specs, or claims.",
    "- Never name any other or competing product — describe only THIS product.",
    "- pain_points must reflect real Filipino buyer concerns (value-for-money, durability, practicality for small homes, tropical climate, family use, delivery/authenticity trust).",
    "- usp must be benefit-led and provable from the identity.",
    "- allowed_feature_angles feed the image layout: list distinct, shootable angles.",
    "Return JSON only: { product_family, usp[], pain_points[], use_cases[], usage_environment[], buyer_intent[], allowed_feature_angles[], concept_guardrails[] }."
  ].join("\n");

  const userPrompt = [
    "PRODUCT IDENTITY (locked):",
    `- category: ${identity.category ?? "UNKNOWN"}`,
    `- shape: ${identity.shape ?? "UNKNOWN"}`,
    `- material: ${identity.material ?? "UNKNOWN"}`,
    `- color: ${identity.color ?? "UNKNOWN"}`,
    `- functional parts: ${Array.isArray(identity.functional_parts) ? identity.functional_parts.join(", ") : "UNKNOWN"}`,
    `- product text: ${String(productText).slice(0, 900) || "EMPTY"}`,
    "",
    "PHILIPPINES MARKET MARKETING KNOWLEDGE:",
    marketKnowledge ? marketKnowledge.slice(0, 4000) : "(no market knowledge file provided)",
    "",
    `Plan a campaign of ${requestedImageCount || "several"} images${includeCta ? " plus 1 CTA image" : ""}.`
  ].join("\n");

  let result = null;
  try {
    result = await generateStructuredJson({
      taskName: "V2_PRODUCT_STRATEGY",
      systemPrompt,
      userPrompt,
      schemaName: "V2ProductStrategy",
      mockResponse: fallback,
      metadata: { project, stage: "creative-pipeline-v2", purpose: "product-strategy" }
    }, { config });
  } catch {
    result = fallback;
  }

  const pickArray = (value, fallbackValue) => (Array.isArray(value) && value.length
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : fallbackValue);

  return {
    product_family: result?.product_family || fallback.product_family,
    requested_non_cta_images: requestedImageCount,
    include_cta: includeCta,
    soft_category_reference_only: true,
    usp: pickArray(result?.usp, fallback.usp),
    pain_points: pickArray(result?.pain_points, fallback.pain_points),
    use_cases: pickArray(result?.use_cases, fallback.use_cases),
    usage_environment: pickArray(result?.usage_environment, fallback.usage_environment),
    buyer_intent: pickArray(result?.buyer_intent, fallback.buyer_intent),
    concept_guardrails: pickArray(result?.concept_guardrails, fallback.concept_guardrails),
    allowed_feature_angles: pickArray(result?.allowed_feature_angles, fallback.allowed_feature_angles),
    // Never carry foreign-product names into the strategy; the prompt sanitizer is a
    // second guard, but strategy should not seed contamination in the first place.
    forbidden_foreign_features: [],
    market: "philippines",
    strategy_source: config.mockMode ? "MOCK" : "AI"
  };
}

export async function extractProductDna({
  referenceImage,
  productText = "",
  productFields = {},
  classification = null
} = {}) {
  const archetype = selectProductArchetype({ productFields, productText, classification });
  const productDna = cloneJson(archetype.productDna);
  const sanitizedVisibleParts = sanitizeVisibleParts(classification?.visible_parts);
  const genericCategory = String(
    classification?.detected_category ||
    productFields.category ||
    parseCategoryFromProductText(productText) ||
    productDna.identity.category
  ).trim();
  const genericShape = String(
    classification?.detected_product_type ||
    productFields.description ||
    genericCategory ||
    productDna.identity.shape
  ).trim();
  const genericMaterial = firstMatch(productText, /(?:product material|material|cháº¥t liá»‡u|chat lieu)\s*:\s*([^\n]+)/i);
  const genericColor = firstMatch(productText, /(?:product color|color|mÃ u sáº¯c|mau sac)\s*:\s*([^\n]+)/i)
    || String(productFields.colors ?? "").trim();
  const genericDimensions = firstMatch(productText, /(?:dimensions|kich thuoc|kÃ­ch thÆ°á»›c|size|product size)\s*:\s*([^\n]+)/i);
  if (archetype.id === "generic_ecommerce_product") {
    productDna.identity.category = genericCategory || "Generic Ecommerce Product";
    productDna.identity.shape = genericShape || "UNKNOWN product shape from reference image";
    if (genericMaterial) {
      productDna.identity.material = genericMaterial;
    }
    if (genericColor) {
      productDna.identity.color = genericColor;
    }
    if (genericDimensions) {
      productDna.identity.dimensions = genericDimensions;
      productDna.identity.geometry_constraints.push(`if a dimension label appears, it must read exactly: ${genericDimensions}`);
    }
    if (sanitizedVisibleParts.length > 0) {
      productDna.identity.functional_parts = sanitizedVisibleParts;
      productDna.identity.geometry_constraints = [
        ...new Set([
          ...productDna.identity.geometry_constraints,
          ...sanitizedVisibleParts.map((part) => `preserve visible part: ${part}`)
        ])
      ];
    }
  }
  if (archetype.id === "tumbler_drinkware") {
    const material = firstMatch(productText, /(?:material|chat lieu|ch[aá]t li[eệ]u)\s*:\s*([^\n]+)/i);
    const color = firstMatch(productText, /(?:color|mau sac|m[aà]u s[aắ]c)\s*:\s*([^\n]+)/i)
      || String(productFields.colors ?? "").trim();
    const capacity = firstMatch(productText, /(?:dung tich|dung tích|capacity)\s*:\s*([^\n]+)/i);
    const insulation = firstMatch(productText, /(?:giu nhiet|giữ nhiệt|insulated|cach nhiet|cách nhiệt)\s*:\s*([^\n]+)/i);
    if (material) {
      productDna.identity.material = material;
    }
    if (color) {
      productDna.identity.color = color;
    }
    if (capacity) {
      productDna.identity.dimensions = capacity;
      productDna.identity.functional_parts.push(`source-supported capacity: ${capacity}`);
      productDna.identity.geometry_constraints.push(`if a capacity badge appears, it must read exactly: ${capacity}`);
    }
    if (insulation) {
      productDna.identity.functional_parts.push(`source-supported insulation detail: ${insulation}`);
    }
    if (sanitizedVisibleParts.length > 0) {
      productDna.identity.functional_parts = normalizeIdentityArray([
        ...productDna.identity.functional_parts,
        ...sanitizedVisibleParts
      ]);
    }
  }
  if (archetype.id === "sink_organizer") {
    const dimensions = firstMatch(productText, /(?:product size|size|kích thước|kich thuoc)\s*:\s*([^\n]+)/i);
    const material = firstMatch(productText, /(?:product material|material|chất liệu|chat lieu)\s*:\s*([^\n]+)/i);
    const color = firstMatch(productText, /(?:product color|color|màu sắc|mau sac)\s*:\s*([^\n]+)/i);
    if (dimensions) {
      productDna.identity.dimensions = dimensions;
      productDna.identity.functional_parts.push(`source-supported dimensions: ${dimensions}`);
      productDna.identity.geometry_constraints.push(`if a dimension badge appears, it must read exactly: ${dimensions}`);
    }
    if (material) {
      productDna.identity.material = material;
    }
    if (color) {
      productDna.identity.color = color;
    }
  }
  if (archetype.id === "educational_math_board") {
    const dimensions = firstMatch(productText, /(?:dimensions|kich thuoc|kích thước|size)\s*:\s*([^\n]+)/i);
    if (dimensions) {
      productDna.identity.dimensions = dimensions;
      productDna.identity.geometry_constraints.push(`if a size badge appears, it must read exactly: ${dimensions}`);
    }
  }
  productDna.identity.functional_parts = normalizeIdentityArray(productDna.identity.functional_parts);
  productDna.identity.accessories = normalizeIdentityArray(productDna.identity.accessories);
  productDna.identity.geometry_constraints = normalizeIdentityArray(productDna.identity.geometry_constraints);
  productDna.identity.must_not_change = normalizeIdentityArray(productDna.identity.must_not_change);
  productDna.product_archetype = archetype.id;
  productDna.source = {
    reference_image: referenceImage ? path.basename(referenceImage) : "",
    product_text_available: productText.trim().length > 0,
    web_fields: productFields,
    classification
  };
  return productDna;
}

export function buildCampaignDesignSystem({ productDna, knowledgeBundle } = {}) {
  const system = cloneJson(CAMPAIGN_DESIGN_SYSTEM);
  const identityText = [
    productDna?.identity?.category,
    productDna?.identity?.shape,
    productDna?.identity?.silhouette
  ].join(" ").toLowerCase();

  if (identityText.includes("impact wrench") || identityText.includes("power tool")) {
    system.typography.font_family_direction = "one bold industrial sans-serif family";
    system.typography.primary_weight = "extra bold headline";
    system.color_palette.accent = "tool teal";
    system.color_palette.secondary_accent = "industrial silver";
    system.color_palette.background = "dark workshop neutrals with controlled highlights";
    system.icon_system.stroke_color = "tool teal";
    system.badge_style.color = "tool teal or industrial silver";
    system.background_style.mood = "premium industrial ecommerce";
    system.background_style.depth = "foreground hardware detail, midground hero tool, softly blurred workshop background";
    system.cta_style.color = "tool teal";
  }

  if (
    identityText.includes("educational math toy") ||
    identityText.includes("montessori learning board") ||
    identityText.includes("math learning board")
  ) {
    system.typography.font_family_direction = "one friendly rounded sans-serif family";
    system.color_palette.accent = "playful learning green";
    system.color_palette.secondary_accent = "primary-color toy red yellow blue mix";
    system.color_palette.background = "bright warm white with child-safe study room tones";
    system.icon_system.stroke_color = "playful learning green";
    system.badge_style.color = "playful learning green or soft primary-color accent";
    system.background_style.mood = "premium educational toy ecommerce";
    system.background_style.depth = "foreground learning pieces, midground hero product, softly blurred study or play background";
    system.cta_style.color = "playful learning green";
  }

  if (knowledgeBundle?.category?.content && /friendly and rounded/i.test(knowledgeBundle.category.content)) {
    system.typography.font_family_direction = "one friendly rounded sans-serif family";
  }

  if (identityText.includes("tumbler") || identityText.includes("travel mug") || identityText.includes("insulated tumbler")) {
    system.typography.font_family_direction = "one clean geometric sans-serif family";
    system.typography.primary_weight = "bold headline";
    system.color_palette.accent = "fresh sage green";
    system.color_palette.secondary_accent = "soft blush or warm cream";
    system.color_palette.background = "bright warm white with calm lifestyle neutrals";
    system.icon_system.stroke_color = "fresh sage green";
    system.badge_style.color = "fresh sage green or soft cream contrast";
    system.background_style.mood = "premium drinkware ecommerce";
    system.background_style.depth = "foreground routine cue, midground hero tumbler, softly blurred home or desk background";
    system.cta_style.color = "fresh sage green";
    system.beverage_system.objective = "Add controlled beverage variety only when it supports tumbler use cases such as desk hydration, commute refreshment, or warm-drink comfort while keeping tumbler identity, lid accuracy, and layout clarity as top priority.";
    system.beverage_system.allowed_beverages = [
      "ice-cold clear water with visible ice and condensation",
      "light iced tea with subtle citrus or mint accents",
      "soft fruit infusion with pale natural color",
      "warm tea with gentle steam",
      "clean hydration cue without overfilling the scene"
    ];
    system.beverage_system.harmony_rule = "keep drinks natural, translucent, and visually balanced with calm cream, blush, sage, navy, and bright neutral tones; beverage styling must stay secondary and must never distort tumbler geometry, lid structure, handle shape, or typography clarity";
    system.beverage_system.forbidden_beverages = [
      "plain dead-looking room-temperature water as the only creative signal",
      "neon colored drinks",
      "heavy saturated red or purple drinks",
      "opaque smoothies unless the current product evidence truly supports blender-style smoothie positioning",
      "messy fruit overload",
      "every image using the exact same lemon-water setup",
      "changing the product into a pitcher or adding spouts or filters to support a beverage idea",
      "covering or hiding product identity details with fruit, steam, or liquid color"
    ];
  }

  return system;
}

function selectLayoutCards({ productDna, full15 }) {
  const archetype = PRODUCT_ARCHETYPES.find((item) => item.id === productDna?.product_archetype);
  if (archetype) {
    return full15 && archetype.full15LayoutCards ? archetype.full15LayoutCards : archetype.layoutCards;
  }
  return GENERIC_LAYOUT_CARDS;
}

function splitCtaCards(cards = []) {
  const nonCta = [];
  let ctaCard = null;
  for (const card of cards) {
    if (card.role === "CTA" || card.section === "CTA") {
      if (!ctaCard) {
        ctaCard = card;
      }
      continue;
    }
    nonCta.push(card);
  }
  return { nonCta, ctaCard };
}

function makeLayoutVariantCard(template, variantIndex) {
  const variantNumber = variantIndex + 1;
  return {
    ...cloneJson(template),
    headline: `${template.headline} ${variantNumber}`,
    concept_goal: `${template.concept_goal} Additional campaign variation ${variantNumber} with a clearly different proof angle.`,
    unique_composition: `${template.unique_composition}; variation ${variantNumber} must not repeat earlier layout balance, crop, or information hierarchy.`,
    unique_camera: `${template.unique_camera}; variation ${variantNumber} must use a noticeably different camera height, yaw, or crop scale than earlier cards.`,
    unique_background: `${template.unique_background}; variation ${variantNumber} must use a distinct environment treatment from earlier cards.`,
    unique_lighting: `${template.unique_lighting}; variation ${variantNumber} must not repeat the exact previous light direction and mood.`,
    unique_focal_point: `${template.unique_focal_point}; variation ${variantNumber} must prove a different visual angle of the same product.`,
    scene_family: `${template.scene_family}_VAR_${variantNumber}`,
    layout_archetype: `${template.layout_archetype}_VAR_${variantNumber}`,
    forbidden_repetition: `${template.forbidden_repetition}; this additional variation must not look like a duplicate of any earlier card`
  };
}

function buildRequestedLayoutCards({
  productDna,
  requestedImageCount = 0,
  includeCta = false,
  full15 = false
}) {
  const archetype = PRODUCT_ARCHETYPES.find((item) => item.id === productDna?.product_archetype);
  const baseCards = archetype
    ? (full15 && archetype.full15LayoutCards ? archetype.full15LayoutCards : archetype.layoutCards)
    : GENERIC_LAYOUT_CARDS;
  const extendedCards = archetype?.full15LayoutCards ?? GENERIC_LAYOUT_CARDS;
  const { nonCta: primaryNonCta, ctaCard: primaryCta } = splitCtaCards(baseCards);
  const { nonCta: extendedNonCta, ctaCard: extendedCta } = splitCtaCards(extendedCards);
  const pool = [...primaryNonCta];
  for (const card of extendedNonCta) {
    if (!pool.some((existing) => existing.headline === card.headline && existing.role === card.role)) {
      pool.push(card);
    }
  }
  const preliminaryPool = pool.length > 0 ? pool : splitCtaCards(GENERIC_LAYOUT_CARDS).nonCta;
  let heroSeen = false;
  const safePool = preliminaryPool.filter((card) => {
    if (card.role !== "Hero") {
      return true;
    }
    if (heroSeen) {
      return false;
    }
    heroSeen = true;
    return true;
  });
  const recyclablePool = safePool.filter((card) => card.role !== "Hero");
  const variantPool = recyclablePool.length > 0 ? recyclablePool : safePool;
  const fallbackCount = primaryNonCta.length || 4;
  const contentCount = Math.max(1, requestedImageCount || fallbackCount);
  const cards = [];

  for (let index = 0; index < contentCount; index += 1) {
    const template = safePool[index] ?? makeLayoutVariantCard(variantPool[(index - safePool.length) % variantPool.length], index - safePool.length + 1);
    const sourceCard = safePool[index] ? cloneJson(template) : template;
    sourceCard.image_id = index + 1;
    if (!safePool[index]) {
      sourceCard.section = sourceCard.section || "BODY";
      sourceCard.role = sourceCard.role === "Hero" ? "Additional Feature" : sourceCard.role;
    }
    cards.push(sourceCard);
  }

  if (includeCta) {
    const ctaTemplate = cloneJson(primaryCta ?? extendedCta ?? GENERIC_LAYOUT_CARDS.find((card) => card.role === "CTA") ?? {
      ...LAYOUT_CARDS[4],
      role: "CTA",
      section: "CTA"
    });
    ctaTemplate.image_id = cards.length + 1;
    ctaTemplate.section = "CTA";
    cards.push(ctaTemplate);
  }

  return cards;
}

// Creative fields the AI concept planner may rewrite. Structural/identity fields
// (image_id, role, section, beverage_direction, forbidden_repetition) are kept
// from the deterministic scaffold so downstream stays stable and safe.
const CONCEPT_CREATIVE_FIELDS = [
  "headline",
  "concept_goal",
  "unique_composition",
  "unique_camera",
  "unique_background",
  "unique_lighting",
  "unique_focal_point",
  "prop_strategy",
  "scene_family",
  "layout_archetype",
  "product_position",
  "camera_distance",
  "lighting_direction"
];

function overlayCreativeFields(baseCard, aiCard) {
  const merged = cloneJson(baseCard);
  if (!aiCard || typeof aiCard !== "object") {
    return merged;
  }
  for (const field of CONCEPT_CREATIVE_FIELDS) {
    const value = aiCard[field];
    if (typeof value === "string" && value.trim()) {
      merged[field] = value.trim();
    }
  }
  return merged;
}

// Force structural uniqueness on the keys the prompt reviewer checks, so an AI
// that accidentally repeats a scene_family/archetype doesn't collapse diversity.
function ensureUniqueStructuralKeys(cards) {
  for (const key of ["scene_family", "layout_archetype"]) {
    const seen = new Map();
    for (const card of cards) {
      const value = String(card[key] ?? "").trim() || key.toUpperCase();
      const count = seen.get(value) ?? 0;
      seen.set(value, count + 1);
      card[key] = count === 0 ? value : `${value}_${card.image_id}`;
    }
  }
  return cards;
}

function conceptCardsForAi(cards) {
  return cards.map((card) => ({
    image_id: card.image_id,
    role: card.role,
    section: card.section ?? "",
    headline: card.headline,
    concept_goal: card.concept_goal,
    unique_composition: card.unique_composition,
    unique_camera: card.unique_camera,
    unique_background: card.unique_background,
    unique_lighting: card.unique_lighting,
    unique_focal_point: card.unique_focal_point,
    prop_strategy: card.prop_strategy,
    scene_family: card.scene_family,
    layout_archetype: card.layout_archetype
  }));
}

// AI Concept Planner: turns the deterministic scaffold into N genuinely distinct
// creative concepts grounded in the product DNA. In mock mode it returns the
// scaffold unchanged (so tests and offline runs stay deterministic).
async function planCreativeConcepts({
  productDna,
  productStrategy,
  requestedImageCount = 0,
  includeCta = false,
  full15 = false,
  mock = false,
  project = ""
} = {}) {
  const baseCards = buildRequestedLayoutCards({ productDna, requestedImageCount, includeCta, full15 });
  const config = loadAiConfig({
    ...process.env,
    OPENAI_MOCK: mock ? "true" : process.env.OPENAI_MOCK
  });
  const mockResponse = { cards: conceptCardsForAi(baseCards) };
  const identity = productDna?.identity ?? {};

  const systemPrompt = [
    "You are a senior ecommerce creative director planning a multi-image product campaign.",
    "Your job: give EACH image a DISTINCT concept — a different selling angle, proof point, scene, composition and camera.",
    "Hard rules:",
    "- Ground every concept ONLY in the given product identity. Never invent features, parts, claims, or accessories.",
    "- No two cards may share the same concept_goal, headline, focal point, scene, composition or camera treatment.",
    "- Keep the exact same product identity in every image (same shape, parts, material, color).",
    "- Preserve each card's image_id, role and section. Only rewrite the creative fields.",
    "Return JSON only: { \"cards\": [ { image_id, headline, concept_goal, unique_composition, unique_camera, unique_background, unique_lighting, unique_focal_point, prop_strategy, scene_family, layout_archetype } ] }."
  ].join("\n");

  const angleIdeas = [
    "full hero identity", "single killer feature", "material / build quality close-up",
    "real use-in-context", "size / scale reference", "what's-in-the-box / parts",
    "before-after or problem-solution", "detail macro of a functional part",
    "lifestyle environment", "durability / safety proof", "comparison of modes / options",
    "in-hand or in-use action", "clean conversion CTA"
  ];

  const userPrompt = [
    `Plan ${baseCards.length} distinct campaign images for this product.`,
    "PRODUCT IDENTITY (locked, do not change):",
    `- category: ${identity.category ?? "UNKNOWN"}`,
    `- shape: ${identity.shape ?? "UNKNOWN"}`,
    `- material: ${identity.material ?? "UNKNOWN"}`,
    `- color: ${identity.color ?? "UNKNOWN"}`,
    `- functional parts: ${Array.isArray(identity.functional_parts) ? identity.functional_parts.join(", ") : (identity.functional_parts ?? "UNKNOWN")}`,
    `- key selling points: ${Array.isArray(productStrategy?.selling_points) ? productStrategy.selling_points.join("; ") : "UNKNOWN"}`,
    "",
    "Spread the images across clearly different angles (pick a different one per image where possible):",
    angleIdeas.map((idea) => `- ${idea}`).join("\n"),
    "",
    "Scaffold to rewrite (keep image_id/role/section, make each concept clearly different):",
    JSON.stringify(conceptCardsForAi(baseCards), null, 2)
  ].join("\n");

  let aiCards = mockResponse.cards;
  try {
    const result = await generateStructuredJson({
      taskName: "V2_CONCEPT_PLANNER",
      systemPrompt,
      userPrompt,
      schemaName: "V2ConceptPlan",
      mockResponse,
      metadata: { project, stage: "creative-pipeline-v2", purpose: "concept-planning" }
    }, { config });
    if (Array.isArray(result?.cards) && result.cards.length > 0) {
      aiCards = result.cards;
    }
  } catch {
    aiCards = mockResponse.cards;
  }

  const aiById = new Map(aiCards.map((card) => [card.image_id, card]));
  const merged = baseCards.map((card, index) => overlayCreativeFields(card, aiById.get(card.image_id) ?? aiCards[index]));
  return { cards: ensureUniqueStructuralKeys(merged), source: config.mockMode ? "MOCK" : "AI" };
}

// AI Concept Review: scores diversity across the planned concepts and rewrites
// any that are too similar. In mock mode it passes the cards through unchanged.
async function reviewConceptDiversity({
  cards = [],
  productDna,
  mock = false,
  project = ""
} = {}) {
  const config = loadAiConfig({
    ...process.env,
    OPENAI_MOCK: mock ? "true" : process.env.OPENAI_MOCK
  });
  const mockResponse = {
    status: "PASS",
    diversity_score: 1,
    issues: [],
    cards: conceptCardsForAi(cards)
  };
  const identity = productDna?.identity ?? {};

  const systemPrompt = [
    "You are a strict creative reviewer checking a multi-image ecommerce campaign for concept diversity.",
    "Flag any two images that share the same idea, headline, focal point, scene or composition.",
    "Rewrite the weaker/duplicate ones so every image has a clearly distinct concept, still grounded only in the product identity.",
    "Never invent features or claims. Keep image_id, role and section unchanged.",
    "Return JSON only: { status: 'PASS'|'REWRITTEN', diversity_score: 0..1, issues: [string], cards: [ { image_id, headline, concept_goal, unique_composition, unique_camera, unique_background, unique_lighting, unique_focal_point, prop_strategy, scene_family, layout_archetype } ] }."
  ].join("\n");

  const userPrompt = [
    "PRODUCT IDENTITY (locked):",
    `- category: ${identity.category ?? "UNKNOWN"}`,
    `- shape: ${identity.shape ?? "UNKNOWN"}`,
    `- functional parts: ${Array.isArray(identity.functional_parts) ? identity.functional_parts.join(", ") : (identity.functional_parts ?? "UNKNOWN")}`,
    "",
    "Concepts to review and de-duplicate:",
    JSON.stringify(conceptCardsForAi(cards), null, 2)
  ].join("\n");

  let review = mockResponse;
  try {
    const result = await generateStructuredJson({
      taskName: "V2_CONCEPT_REVIEW",
      systemPrompt,
      userPrompt,
      schemaName: "V2ConceptReview",
      mockResponse,
      metadata: { project, stage: "creative-pipeline-v2", purpose: "concept-review" }
    }, { config });
    if (result && typeof result === "object") {
      review = result;
    }
  } catch {
    review = mockResponse;
  }

  const revisedCards = Array.isArray(review.cards) && review.cards.length > 0 ? review.cards : mockResponse.cards;
  const revisedById = new Map(revisedCards.map((card) => [card.image_id, card]));
  const merged = cards.map((card, index) => overlayCreativeFields(card, revisedById.get(card.image_id) ?? revisedCards[index]));
  return {
    cards: ensureUniqueStructuralKeys(merged),
    report: {
      status: review.status === "REWRITTEN" ? "REWRITTEN" : "PASS",
      diversity_score: Number.isFinite(Number(review.diversity_score)) ? Number(review.diversity_score) : null,
      issues: Array.isArray(review.issues) ? review.issues.map((issue) => String(issue)).filter(Boolean) : [],
      source: config.mockMode ? "MOCK" : "AI"
    }
  };
}

export function buildCreativeDiversityPlan({ layoutCards = LAYOUT_CARDS } = {}) {
  return {
    status: "READY",
    ...cloneJson(CREATIVE_DIVERSITY_RULES),
    cards: cloneJson(layoutCards).map((card) => ({
      image_id: card.image_id,
      role: card.role,
      scene_family: card.scene_family,
      layout_archetype: card.layout_archetype,
      product_position: card.product_position,
      camera_distance: card.camera_distance,
      lighting_direction: card.lighting_direction,
      prop_strategy: card.prop_strategy,
      beverage_direction: card.beverage_direction,
      forbidden_repetition: card.forbidden_repetition
    }))
  };
}

export function buildLayoutPlan({ productDna, campaignDesignSystem, creativeDiversityPlan, layoutCards = null } = {}) {
  const selectedLayoutCards = layoutCards ?? selectLayoutCards({ productDna, full15: false });
  const diversityPlan = creativeDiversityPlan ?? buildCreativeDiversityPlan({ layoutCards: selectedLayoutCards });
  const diversityById = new Map(diversityPlan.cards.map((card) => [card.image_id, card]));
  return {
    target_image_count: selectedLayoutCards.length,
    planning_inputs: {
      product_category: productDna?.identity?.category ?? "UNKNOWN",
      typography_system: campaignDesignSystem?.typography?.font_family_direction ?? "UNKNOWN",
      creative_diversity_status: diversityPlan.status
    },
    cards: cloneJson(selectedLayoutCards).map((card) => ({
      ...card,
      creative_diversity: diversityById.get(card.image_id)
    })),
    status: "READY"
  };
}

// Cross-archetype product/feature nouns. Naming any of these in an image prompt
// — even to forbid it — pulls the image model toward drawing it (negative-prompt
// backfire), which is what contaminated tumblers with GLASSPOT (pitcher) parts
// and deformed them. We strip any that are NOT part of THIS product's identity.
const CROSS_PRODUCT_NOUNS = [
  "pitcher", "teapot", "tea pot", "kettle", "carafe", "jug", "decanter",
  "pouring spout", "spout", "spring coil filter", "coil filter", "bamboo lid",
  "family serving pitcher", "family serving", "1800ml pitcher", "1800ml",
  "kitchen sink rack", "sink rack", "dish rack", "drying rack", "faucet",
  "stroller", "car seat", "booster seat", "rocking chair",
  "impact wrench", "power drill", "angle grinder", "grinder",
  "abacus", "whiteboard", "puzzle cube", "laptop", "travel mug", "tool battery"
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Remove foreign-product mentions from a finished image prompt so the model never
// sees a competing product name. Terms that ARE part of this product's identity
// are kept (e.g. "high chair" stays for a baby high chair).
function sanitizeForeignMentions(promptText, nativeIdentityText = "") {
  const native = String(nativeIdentityText).toLowerCase();
  const foreign = CROSS_PRODUCT_NOUNS.filter((noun) => !native.includes(noun));
  if (foreign.length === 0) {
    return promptText;
  }
  // Trailing "s?" so plurals ("spouts", "coil filters", "bamboo lids") match too.
  const foreignRe = new RegExp(`\\b(${foreign.map(escapeRegExp).join("|")})s?\\b`, "gi");
  const mentionsForeign = (text) => {
    foreignRe.lastIndex = 0;
    return foreignRe.test(text);
  };
  return promptText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (/^forbidden foreign features\s*:/i.test(trimmed)) {
        return "";
      }
      if (!mentionsForeign(line)) {
        return line;
      }
      // Rebuild the line clause-by-clause, dropping any clause that names a
      // foreign product, and stripping foreign nouns from mixed lists.
      const clauses = line.split(/;\s*/).map((clause) => {
        if (/\b(turn|convert|redesign|reuse|replace|invent|add|introduce)\b/i.test(clause) && mentionsForeign(clause)) {
          return "";
        }
        const items = clause.split(/,\s*/).filter((item) => !mentionsForeign(item));
        return items.join(", ");
      }).filter((clause) => {
        const c = clause.trim();
        return c && !/^(do not|don't|forbidden|avoid|never)[:.\s]*$/i.test(c);
      });
      const rebuilt = clauses.join("; ");
      return mentionsForeign(rebuilt) ? rebuilt.replace(foreignRe, "").replace(/\s{2,}/g, " ").replace(/,\s*,/g, ",").trim() : rebuilt;
    })
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function flattenIdentity(identity) {
  return [
    `Category: ${identity.category}.`,
    `Shape: ${identity.shape}.`,
    `Silhouette: ${identity.silhouette}.`,
    `Material: ${identity.material}.`,
    `Color: ${identity.color}.`,
    `Surface: ${identity.surface}.`,
    identity.dimensions ? `Dimensions: ${identity.dimensions}.` : "",
    `Functional parts: ${identity.functional_parts.join("; ")}.`,
    `Accessories: ${identity.accessories.join("; ")}.`,
    `Geometry constraints: ${identity.geometry_constraints.join("; ")}.`,
    `Must not change: ${identity.must_not_change.join("; ")}.`
  ].filter(Boolean).join("\n");
}

function identityReferenceParts(identity) {
  const family = detectProductFamily({ identity }, {}, null);

  if (family === "sink_storage") {
    return "Preserve product geometry, rectangular rack silhouette, rail spacing, lower tray, detachable cloth rod, materials, color, and proportions. The reference image locks identity only; it does not lock the final camera pose, crop, or scale.";
  }
  if (family === "baby_furniture") {
    return "Preserve product geometry, rounded seat shell, tray, four legs, footrest, safety belt, materials, color, and proportions. The reference image locks identity only; it does not lock the final camera pose, crop, or scale.";
  }
  if (family === "educational_toy") {
    return "Preserve product geometry, wooden tray base, upright learning board, left clock section, right arithmetic rows, lower storage tray, number tiles, counting sticks, chalkboard mode, materials, colors, and proportions. The reference image locks identity only; it does not lock the final camera pose, crop, or scale.";
  }
  if (family === "drinkware_tumbler") {
    return "Preserve product geometry, tumbler silhouette, handle, rotating lid, straw, rim, tapered lower body, materials, and proportions. The reference image locks identity only; it does not lock the final camera pose, crop, or scale.";
  }
  if (family === "drinkware_pitcher") {
    return "Preserve product geometry, handle, lid, spout, spring coil filter, materials, and proportions. The reference image locks identity only; it does not lock the final camera pose, crop, or scale.";
  }
  return "Preserve product geometry, silhouette, all visible components, materials, colors, and proportions from the reference image. The reference image locks identity only; it does not lock the final camera pose, crop, or scale.";
}

function noCropParts(identity) {
  const family = detectProductFamily({ identity }, {}, null);

  if (family === "sink_storage") {
    return "Do not crop the rack body, lower tray, detachable cloth rod, open rails, or main storage area.";
  }
  if (family === "baby_furniture") {
    return "Do not crop the tray, seat shell, legs, footrest, safety belt, or main chair body.";
  }
  if (family === "educational_toy") {
    return "Do not crop the tray base, upright board, left clock section, arithmetic rows, lower storage tray, or key learning components when the full product is required.";
  }
  if (family === "drinkware_tumbler") {
    return "Do not crop the handle, rotating lid, straw, tapered lower body, or main tumbler silhouette.";
  }
  if (family === "drinkware_pitcher") {
    return "Do not crop the handle, lid, spout, or main body.";
  }
  return "Do not crop the main product body or identity-critical visible components.";
}

function usesBeverageSystem(productDna) {
  const text = [
    productDna?.identity?.category,
    productDna?.identity?.shape,
    productDna?.identity?.silhouette,
    productDna?.identity?.functional_parts?.join(" ")
  ].join(" ").toLowerCase();
  return (
    text.includes("pitcher")
    || text.includes("teapot")
    || text.includes("drink")
    || text.includes("hydration")
    || text.includes("tumbler")
    || text.includes("travel mug")
    || text.includes("straw")
  );
}

function flattenProductStrategy(strategy) {
  if (!strategy) {
    return "";
  }
  return [
    "PRODUCT STRATEGY LOCK:",
    `Product family: ${strategy.product_family}.`,
    `USP: ${strategy.usp.join("; ") || "UNKNOWN"}.`,
    `Pain points: ${strategy.pain_points.join("; ") || "UNKNOWN"}.`,
    `Use cases: ${strategy.use_cases.join("; ") || "UNKNOWN"}.`,
    `Usage environment: ${strategy.usage_environment.join("; ") || "UNKNOWN"}.`,
    `Buyer intent: ${strategy.buyer_intent.join("; ") || "UNKNOWN"}.`,
    `Allowed feature angles: ${strategy.allowed_feature_angles.join("; ") || "UNKNOWN"}.`,
    `Concept guardrails: ${strategy.concept_guardrails.join("; ") || "UNKNOWN"}.`,
    `Forbidden foreign features: ${strategy.forbidden_foreign_features.join("; ") || "NONE"}.`,
    "Use category knowledge only as soft reference. Final concept must match the current product identity, current user fields, and current reference image."
  ].join("\n");
}

function isFeatureDetailCard(card = {}) {
  const role = String(card.role ?? "").toLowerCase();
  const archetype = String(card.layout_archetype ?? "").toLowerCase();
  const sceneFamily = String(card.scene_family ?? "").toLowerCase();
  const composition = String(card.unique_composition ?? "").toLowerCase();

  return (
    role.includes("feature")
    || role.includes("detail")
    || archetype.includes("detail")
    || archetype.includes("macro")
    || archetype.includes("callout")
    || sceneFamily.includes("detail")
    || sceneFamily.includes("control")
    || sceneFamily.includes("anvil")
    || composition.includes("callout")
    || composition.includes("inset")
    || composition.includes("macro")
  );
}

function isUseCaseCard(card = {}) {
  const role = String(card.role ?? "").toLowerCase();
  const archetype = String(card.layout_archetype ?? "").toLowerCase();
  const sceneFamily = String(card.scene_family ?? "").toLowerCase();
  const composition = String(card.unique_composition ?? "").toLowerCase();

  return (
    role.includes("use")
    || role.includes("lifestyle")
    || archetype.includes("lifestyle")
    || archetype.includes("use_context")
    || sceneFamily.includes("lifestyle")
    || sceneFamily.includes("use_case")
    || composition.includes("lifestyle")
    || composition.includes("use-case")
  );
}

function flattenDesignSystem(system, productDna) {
  const lines = [
    `Typography: ${system.typography.font_family_direction}; ${system.typography.primary_weight}; ${system.typography.secondary_weight}; ${system.typography.casing}.`,
    `Colors: primary text ${system.color_palette.primary_text}; accent ${system.color_palette.accent}; secondary accent ${system.color_palette.secondary_accent}; background ${system.color_palette.background}.`,
    `Icons: ${system.icon_system.style}; stroke ${system.icon_system.stroke_color}; text ${system.icon_system.text_color}.`,
    `CTA: ${system.cta_style.shape}; ${system.cta_style.color}; ${system.cta_style.text_color}.`,
    `Spacing: ${system.spacing_style.whitespace}; ${system.spacing_style.grid}; ${system.spacing_style.edge_safety}.`
  ];
  if (usesBeverageSystem(productDna)) {
    lines.push(`Beverage system: ${system.beverage_system.objective} Allowed: ${system.beverage_system.allowed_beverages.join("; ")}. Harmony: ${system.beverage_system.harmony_rule}. Forbidden: ${system.beverage_system.forbidden_beverages.join("; ")}.`);
  }
  return lines.join("\n");
}

export function writePrompts({ productDna, campaignDesignSystem, layoutPlan, referenceImage, knowledgeBundle, productStrategy }) {
  return layoutPlan.cards.map((card) => {
    const isCtaCard = card.role === "CTA" || card.section === "CTA";
    const featureDetailCard = isFeatureDetailCard(card);
    const useCaseCard = isUseCaseCard(card);
    const ctaDisciplineLock = isCtaCard
      ? [
          "CTA DISCIPLINE LOCK:",
          "This is the only CTA image in the campaign. It may include one clear purchase button such as Add To Cart or Order Now.",
          "Keep the CTA confident but not aggressive."
        ]
      : [
          "CTA DISCIPLINE LOCK:",
          "This is not a CTA image. Do not include Add To Cart, Shop Now, Order Now, Buy Now, cart buttons, checkout badges, discount badges, or purchase buttons.",
          "Use educational, proof, lifestyle, or gallery text only. The customer should not feel pressured on this image."
        ];
    const featureDetailLock = featureDetailCard
      ? [
          "FEATURE DETAIL CONVERSION LOCK:",
          "This card must not be only a beautiful close-up.",
          "The image must communicate one clear product proof immediately.",
          "Include a strong visible headline tied to the exact feature being shown.",
          "Include at least one concise supporting proof line or feature-benefit line.",
          "Include at least one visual callout, inset, pointer, label zone, or proof marker that explains what the viewer should notice.",
          "Do not let the composition become text-free, concept-free, or ambiguous.",
          "The viewer should understand the exact feature focus within one second."
        ]
      : [];
    const useCaseConceptLock = useCaseCard
      ? [
          "USE CASE CONVERSION LOCK:",
          "This card must not become a generic empty lifestyle render.",
          "The image must communicate one believable real-life use context immediately.",
          "Keep a strong visible headline and at least one supporting line that explains why this product fits that situation.",
          "Add at least one small proof block, icon-assisted benefit line, or short use-case callout so the image reads like a real ecommerce ad, not only a room scene.",
          "The typography overlay must be visibly present in the final composition; do not quietly omit the headline or supporting text.",
          "The text structure should be: headline first, supporting line second, proof signal third.",
          "Show a clear reason-to-exist for the scene: space-saving, portability, extra seating, home use, study use, dining use, event use, or another source-supported use case.",
          "The environment must support the message, not act as random decoration.",
          "Do not reduce the scene to a nice room with the product merely sitting there.",
          "Do not rely on atmosphere alone. The scene must visually prove the use case and the overlay text must name that use case clearly.",
          "Do not let this image become concept-free, text-free, or merely atmospheric.",
          "The viewer should understand within one second where and why the product is being used."
        ]
      : [];
    const viewpointVariationLock = [
      "VIEWPOINT VARIATION LOCK:",
      "Use the reference image to preserve product identity, not to freeze the exact viewing angle from the source photo.",
      "You may rotate the product viewpoint, change left-right orientation, adjust camera height, and change crop scale as long as product geometry and identity-critical parts remain accurate.",
      "Follow the planned camera, product position, and camera distance for this specific card even if that differs from the source photo.",
      "Do not keep every card at the same three-quarter view unless this card explicitly requires that exact view.",
      "Create real batch variety through camera angle, framing, product size in frame, and scene staging while preserving the same product identity.",
      "If the reference image is straight-on or static, you must still reinterpret it into the planned shot type for this card rather than reusing the same pose mechanically."
    ];
    const debrandLock = [
      "DEBRAND LOCK:",
      "Preserve the real product shape, structure, proportions, and components from the reference image, but do not preserve any brand identity from the source image.",
      "Remove or avoid all visible brand names, brand logos, wordmarks, store names, seller marks, certification seals, guarantee badges, marketplace watermarks, and readable branded packaging.",
      "This debrand rule applies to the main product body, accessories, cups, lids, tools, props, packaging, and any background object with readable branding.",
      "If the reference image contains a printed logo or product name on the main product body, keep the same product form but render that branded area as clean, unbranded, or generic.",
      "Do not recreate NUTRIBULLET, MAKITA, or any other third-party brand text from the reference image.",
      "Product identity means geometry and components, not trademarked text or logos."
    ];
    const promptText = [
      "Create exactly one premium ecommerce image using the provided reference photos.",
      "No text-to-image fallback. Use the reference photos (multiple angles are provided) as the single source of the product's real shape.",
      "PRODUCT IDENTITY LOCK:",
      flattenIdentity(productDna.identity),
      "PRODUCT FIDELITY LOCK:",
      "Reproduce the product EXACTLY as in the reference photos: same silhouette, same lid design, same handle, same straw, same proportions and thickness.",
      "The product must stand upright and level on its base — never tilted, leaning, floating, warped, melted, stretched, or bent.",
      "Show the COMPLETE product from lid to base at TRUE proportions. The full body height, the tapered lower body, and the base must be fully visible and must NOT be shortened, squashed, compressed, foreshortened, or cropped to fit the headline, props, or a square frame. Keep the real height-to-width ratio; if space is tight, make the product smaller as a whole rather than cutting or squashing the base.",
      "The lid has ONLY the openings visible in the reference photos (a single straw hole). The straw enters through that one real straw hole only — never through a closed lid surface, never through a spot with no hole, never pointing down into the ground or floating in mid-air.",
      "Do not redesign, simplify, merge, or invent any part. Cross-check every angle against the reference photos before finalizing.",
      "REQUIRED ON-IMAGE TEXT:",
      "This image MUST include a short readable headline plus a one-line benefit caption that makes THIS image's specific concept obvious at a glance. No image may be left without guiding text.",
      "CLAIM SAFETY LOCK:",
      "Visible text may use only the planned headline and source-supported product facts from Product Identity Lock.",
      "Do not invent measurements, materials, certifications, ratings, reviews, guarantees, temperature ranges, performance promises, odor claims, antibacterial claims, eco claims, or premium-quality claims.",
      "If dimensions are shown, copy the exact dimension text from Product Identity Lock and do not change numbers or units.",
      "Supporting prop labels, third-party logos, branded packaging, and readable product labels are forbidden.",
      ...debrandLock,
      flattenProductStrategy(productStrategy),
      "TYPOGRAPHY AND COLOR LOCK:",
      flattenDesignSystem(campaignDesignSystem, productDna),
      flattenCuratedKnowledge(knowledgeBundle),
      "LAYOUT LOCK:",
      `Image role: ${card.role}.`,
      `Concept goal: ${card.concept_goal}.`,
      `Headline: ${card.headline}.`,
      `Composition: ${card.unique_composition}.`,
      `Camera: ${card.unique_camera}.`,
      `Lighting: ${card.unique_lighting}.`,
      `Background: ${card.unique_background}.`,
      `Focal point: ${card.unique_focal_point}.`,
      "CREATIVE DIVERSITY LOCK:",
      `Scene family: ${card.scene_family}.`,
      `Layout archetype: ${card.layout_archetype}.`,
      `Product position: ${card.product_position}.`,
      `Camera distance: ${card.camera_distance}.`,
      `Lighting direction: ${card.lighting_direction}.`,
      `Prop strategy: ${card.prop_strategy}.`,
      usesBeverageSystem(productDna) ? "BEVERAGE VARIATION LOCK:" : "PROP AND CONTEXT LOCK:",
      usesBeverageSystem(productDna)
        ? `Beverage direction: ${card.beverage_direction ?? "Use a campaign-safe translucent beverage only when it supports the concept; do not default every image to lemon water."}.`
        : `Prop direction: ${card.beverage_direction ?? "Use only product-relevant generic props when they support the concept."}.`,
      usesBeverageSystem(productDna) ? `Beverage harmony: ${campaignDesignSystem.beverage_system.harmony_rule}.` : "All props must be generic, unlabeled, logo-free, and subordinate to product identity.",
      usesBeverageSystem(productDna) ? `Allowed beverage family: ${campaignDesignSystem.beverage_system.allowed_beverages.join("; ")}.` : "Do not introduce unrelated product categories or decorative clutter.",
      usesBeverageSystem(productDna) ? `Forbidden beverage choices: ${campaignDesignSystem.beverage_system.forbidden_beverages.join("; ")}.` : "Do not show third-party logos, brand names, readable labels, or branded packaging.",
      usesBeverageSystem(productDna)
        ? "Beverage is a secondary creative layer. If beverage variety conflicts with product geometry, key feature accuracy, background depth, layout quality, or typography quality, prioritize the product and layout."
        : "Context props are secondary. If prop styling conflicts with product accuracy, layout quality, typography quality, or reference identity, prioritize the product and layout.",
      ...viewpointVariationLock,
      card.action_logic ? `Action logic: ${card.action_logic}.` : "",
      `Forbidden repetition: ${card.forbidden_repetition}.`,
      "Do not collapse this card back into a bright kitchen / white marble / product-right / left-text-column template unless explicitly planned above.",
      ...featureDetailLock,
      ...useCaseConceptLock,
      ...ctaDisciplineLock,
      "Reference Image Usage:",
      `Use ${path.basename(referenceImage ?? "")} as the product reference. ${identityReferenceParts(productDna.identity)}`,
      `${noCropParts(productDna.identity)} Keep text readable and consistent with the campaign system. Do not show third-party logos, brand names, readable labels, or branded packaging on any prop.`,
      "When changing the angle, preserve the same real product structure instead of flattening it into a pasted cutout from the source image."
    ].join("\n");

    // Strip foreign-product names so the image model is never nudged toward a
    // competing product (e.g. pitcher parts leaking onto a tumbler).
    const nativeIdentityText = [
      productDna.identity.category,
      productDna.identity.shape,
      productDna.identity.silhouette,
      productDna.identity.material,
      (productDna.identity.functional_parts ?? []).join(" "),
      (productDna.identity.accessories ?? []).join(" ")
    ].join(" ");
    const cleanPromptText = sanitizeForeignMentions(promptText, nativeIdentityText);

    return {
      image_id: card.image_id,
      role: card.role,
      source_layout_card: card,
      reference_image: referenceImage ? path.basename(referenceImage) : "",
      prompt_text: cleanPromptText,
      status: "READY"
    };
  });
}

function uniqueCount(values) {
  return new Set(values.filter(Boolean)).size;
}

function meaningfulVariationRepeats(values = [], ignoredPatterns = []) {
  const filtered = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .filter((value) => !ignoredPatterns.some((pattern) => pattern.test(value)));
  return filtered.length > 1 && new Set(filtered).size !== filtered.length;
}

function promptHasAll(prompt, phrases) {
  return phrases.every((phrase) => prompt.includes(phrase));
}

function promptContainsForbiddenForeignFeature(prompt, strategy = null) {
  if (!strategy?.forbidden_foreign_features?.length) {
    return false;
  }
  const planningSurface = [
    prompt?.source_layout_card?.role,
    prompt?.source_layout_card?.concept_goal,
    prompt?.source_layout_card?.headline,
    prompt?.source_layout_card?.unique_composition,
    prompt?.source_layout_card?.unique_background,
    prompt?.source_layout_card?.unique_focal_point,
    prompt?.source_layout_card?.prop_strategy
  ].join(" ");
  const normalizedPrompt = normalizeEvidenceText(planningSurface);
  return strategy.forbidden_foreign_features.some((feature) => {
    const normalizedFeature = normalizeEvidenceText(feature).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`(^|[^a-z0-9])${normalizedFeature}([^a-z0-9]|$)`, "i");
    return matcher.test(normalizedPrompt);
  });
}

function reviewOnePrompt(prompt, productStrategy = null) {
  const hasContextLock = prompt.prompt_text.includes("BEVERAGE VARIATION LOCK:") || prompt.prompt_text.includes("PROP AND CONTEXT LOCK:");
  const featureDetailCard = isFeatureDetailCard(prompt.source_layout_card);
  const useCaseCard = isUseCaseCard(prompt.source_layout_card);
  const checks = {
    identity_lock_present: promptHasAll(prompt.prompt_text, [
      "PRODUCT IDENTITY LOCK:",
      "Functional parts:",
      "Geometry constraints:",
      "Must not change:"
    ]),
    typography_lock_present: promptHasAll(prompt.prompt_text, [
      "TYPOGRAPHY AND COLOR LOCK:",
      "one clean geometric sans-serif",
      "Title Case",
      "deep navy blue"
    ]),
    layout_lock_present: promptHasAll(prompt.prompt_text, ["LAYOUT LOCK:", "Composition:", "Camera:", "Lighting:", "Background:"]),
    creative_diversity_lock_present: promptHasAll(prompt.prompt_text, [
      "CREATIVE DIVERSITY LOCK:",
      "Scene family:",
      "Layout archetype:",
      "Product position:",
      "Forbidden repetition:"
    ]),
    brand_safety_lock_present: promptHasAll(prompt.prompt_text, [
      "DEBRAND LOCK:",
      "do not preserve any brand identity from the source image",
      "Remove or avoid all visible brand names, brand logos, wordmarks",
      "This debrand rule applies to the main product body",
      "keep the same product form but render that branded area as clean, unbranded, or generic",
      "Product identity means geometry and components, not trademarked text or logos"
    ]),
    context_lock_present: hasContextLock,
    cta_discipline_lock_present: prompt.prompt_text.includes("CTA DISCIPLINE LOCK:"),
    reference_image_required: prompt.prompt_text.includes("No text-to-image fallback") && prompt.reference_image.length > 0,
    no_identity_crop_rule_present: prompt.prompt_text.includes("Do not crop"),
    feature_detail_conversion_lock_present: featureDetailCard
      ? promptHasAll(prompt.prompt_text, [
          "FEATURE DETAIL CONVERSION LOCK:",
          "must not be only a beautiful close-up",
          "Include a strong visible headline",
          "Include at least one concise supporting proof line",
          "Include at least one visual callout"
        ])
      : true,
    product_strategy_lock_present: promptHasAll(prompt.prompt_text, [
      "PRODUCT STRATEGY LOCK:",
      "Product family:",
      "Use category knowledge only as soft reference"
    ]),
    no_cross_product_contamination: !promptContainsForbiddenForeignFeature(prompt, productStrategy),
    use_case_conversion_lock_present: useCaseCard
      ? promptHasAll(prompt.prompt_text, [
          "USE CASE CONVERSION LOCK:",
          "must not become a generic empty lifestyle render",
          "Keep a strong visible headline",
          "at least one supporting line",
          "proof block, icon-assisted benefit line, or short use-case callout",
          "The typography overlay must be visibly present in the final composition",
          "Do not reduce the scene to a nice room with the product merely sitting there",
          "The viewer should understand within one second where and why the product is being used"
        ])
      : true
  };
  const issues = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  return {
    image_id: prompt.image_id,
    status: issues.length === 0 ? "PASS" : "FAIL",
    checks,
    issues
  };
}

function strengthenPrompt(prompt, review) {
  if (review.status === "PASS") {
    return prompt;
  }
  const repairLines = [
    "PROMPT REVIEW REPAIR:",
    "Before rendering, enforce the missing locks above.",
    "Reject any layout that repeats another card's background, camera, composition, typography direction, or product crop.",
    "Apply beverage variety carefully only when it does not weaken product identity, key feature accuracy, background depth, layout quality, or typography quality.",
    "Preserve the reference product exactly and keep all identity-critical parts fully visible when relevant.",
    "Remove all brand names, brand logos, store names, watermarks, and printed trademarks from the main product body and every accessory while preserving product geometry.",
    "If any phrase or feature belongs to another product family, remove it completely and rebuild the prompt around the current product family only."
  ];
  return {
    ...prompt,
    prompt_text: `${prompt.prompt_text}\n${repairLines.join("\n")}`,
    status: "REWRITTEN_AFTER_REVIEW"
  };
}

function sequentialViewpointStrategy({ imageIndex, currentCard }) {
  const role = String(currentCard?.role ?? "").toLowerCase();
  if (role.includes("feature") || role.includes("detail")) {
    return [
      "Move to a noticeably tighter feature-led viewpoint than the previous image.",
      "Raise or lower the camera enough that the product structure reads differently from the previous frame.",
      "Emphasize a different side, hinge zone, seat plane, backrest plane, or structural relationship instead of repeating the same hero pose."
    ];
  }
  if (role.includes("use")) {
    return [
      "Pull the product into a wider real-life context than the previous image.",
      "Make the product smaller in frame or shift it deeper into the scene so the framing is clearly different.",
      "Use a more practical side-oriented or room-context angle instead of repeating the same centered showcase pose."
    ];
  }
  if (role.includes("cta")) {
    return [
      "Use a cleaner conversion-focused framing than the previous image.",
      "Change the product scale or left-right balance so it does not feel like the same shot with a CTA button added.",
      "Prefer a straighter or opposite-side presentation if earlier frames already used a repeated three-quarter pose."
    ];
  }
  if (imageIndex === 1) {
    return [
      "Use a noticeably different angle from image 1, ideally lower or closer.",
      "Do not reuse the same front three-quarter showcase pose.",
      "Change product scale in frame so the second image feels like a new shot, not the same shot with new text."
    ];
  }
  if (imageIndex === 2) {
    return [
      "Use a noticeably different angle from image 2, ideally higher, more top-down, or more cropped.",
      "Rotate the viewpoint enough that leg overlap, seat plane, or structural silhouette reads differently.",
      "Do not repeat the same medium-distance three-quarter framing."
    ];
  }
  return [
    "Change at least three visual dimensions from the previous image: camera height, distance, yaw direction, crop scale, or room depth.",
    "Do not let this card fall back to the same safe three-quarter pose as earlier images.",
    "Make this image feel like a new shot built from the same product, not the same product pasted into a new background."
  ];
}

function applySequentialViewpointDifferentiation({ prompt, previousCard, currentCard, imageIndex }) {
  if (!previousCard || !currentCard) {
    return prompt;
  }
  const lines = [
    "PROMPT DIFFERENTIATION LOCK:",
    `This is image ${currentCard.image_id}. It must look clearly different from image ${previousCard.image_id}.`,
    `Previous image camera summary: ${previousCard.unique_camera}.`,
    `Previous image framing summary: ${previousCard.camera_distance}; product position ${previousCard.product_position}.`,
    `Current image target camera summary: ${currentCard.unique_camera}.`,
    `Current image target framing summary: ${currentCard.camera_distance}; product position ${currentCard.product_position}.`,
    "Do not reuse the same dominant product pose, same leg overlap, same facing direction, same crop scale, or same camera height as the previous image unless the card explicitly requires it.",
    ...sequentialViewpointStrategy({ imageIndex, currentCard }),
    "Based on the same reference product, rebuild the object faithfully from a genuinely different shot setup rather than recycling the previous viewpoint."
  ];
  return {
    ...prompt,
    prompt_text: `${prompt.prompt_text}\n${lines.join("\n")}`
  };
}

export function reviewAndRewritePrompts({ prompts, layoutPlan, campaignDesignSystem, productStrategy }) {
  const layoutChecks = {
    repeated_background: uniqueCount(layoutPlan.cards.map((card) => card.unique_background)) !== layoutPlan.cards.length,
    repeated_layout: uniqueCount(layoutPlan.cards.map((card) => card.unique_composition)) !== layoutPlan.cards.length,
    repeated_composition: uniqueCount(layoutPlan.cards.map((card) => card.unique_composition)) !== layoutPlan.cards.length,
    repeated_camera: uniqueCount(layoutPlan.cards.map((card) => card.unique_camera)) !== layoutPlan.cards.length,
    repeated_lighting: uniqueCount(layoutPlan.cards.map((card) => card.unique_lighting)) !== layoutPlan.cards.length,
    repeated_scene_family: uniqueCount(layoutPlan.cards.map((card) => card.scene_family)) !== layoutPlan.cards.length,
    repeated_layout_archetype: uniqueCount(layoutPlan.cards.map((card) => card.layout_archetype)) !== layoutPlan.cards.length,
    repeated_product_position: uniqueCount(layoutPlan.cards.map((card) => card.product_position)) !== layoutPlan.cards.length,
    repeated_camera_distance: uniqueCount(layoutPlan.cards.map((card) => card.camera_distance)) !== layoutPlan.cards.length,
    repeated_lighting_direction: uniqueCount(layoutPlan.cards.map((card) => card.lighting_direction)) !== layoutPlan.cards.length,
    repeated_prop_strategy: uniqueCount(layoutPlan.cards.map((card) => card.prop_strategy)) !== layoutPlan.cards.length,
    repeated_beverage_direction: meaningfulVariationRepeats(
      layoutPlan.cards.map((card) => card.beverage_direction),
      [/^not required$/i, /^not applicable/i]
    ),
    creative_diversity_present: prompts.every((prompt) => prompt.prompt_text.includes("CREATIVE DIVERSITY LOCK:")),
    beverage_variation_present: prompts.every((prompt) => prompt.prompt_text.includes("BEVERAGE VARIATION LOCK:") || prompt.prompt_text.includes("PROP AND CONTEXT LOCK:")),
    beverage_harmony_present: prompts.every((prompt) => prompt.prompt_text.includes("Beverage harmony:") || prompt.prompt_text.includes("All props must be generic")),
    cta_discipline_present: prompts.every((prompt) => prompt.prompt_text.includes("CTA DISCIPLINE LOCK:")),
    only_one_cta_card: layoutPlan.cards.filter((card) => card.role === "CTA" || card.section === "CTA").length === 1,
    typography_consistency: campaignDesignSystem.typography.casing === "Title Case for all main headlines",
    color_consistency: campaignDesignSystem.color_palette.primary_text === "deep navy blue",
    campaign_consistency: prompts.every((prompt) => prompt.prompt_text.includes("TYPOGRAPHY AND COLOR LOCK:"))
  };
  const differentiated_prompts = prompts.map((prompt, index) => applySequentialViewpointDifferentiation({
    prompt,
    previousCard: index > 0 ? layoutPlan.cards[index - 1] : null,
    currentCard: layoutPlan.cards[index],
    imageIndex: index
  }));
  const prompt_reviews = differentiated_prompts.map((prompt) => reviewOnePrompt(prompt, productStrategy));
  const rewritten_prompts = differentiated_prompts.map((prompt, index) => strengthenPrompt(prompt, prompt_reviews[index]));
  const failedChecks = Object.entries(layoutChecks)
    .filter(([key, value]) => key.startsWith("repeated_") ? value : !value)
    .map(([key]) => key);
  const failedPrompts = prompt_reviews.filter((review) => review.status === "FAIL");
  return {
    status: failedChecks.length === 0 && failedPrompts.length === 0 ? "PASS" : "REWRITTEN",
    layout_checks: layoutChecks,
    prompt_reviews,
    rewritten_count: failedPrompts.length,
    rewritten_prompts,
    issues: [...failedChecks, ...failedPrompts.flatMap((review) => review.issues.map((issue) => `IMAGE_${review.image_id}:${issue}`))]
  };
}

async function postImageEdit({ referenceImage, referenceImages, promptText }) {
  // Prefer the full set of reference photos so the model sees every angle of the
  // real product (lid, handle, straw hole, proportions) and stops hallucinating.
  const refs = (Array.isArray(referenceImages) && referenceImages.length > 0)
    ? referenceImages
    : (referenceImage ? [referenceImage] : []);
  if (refs.length === 0) {
    throw new Error("No reference image provided to image edit.");
  }
  const formData = new FormData();
  // Explicit image-model default (never fall back to a chat model).
  formData.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2");
  formData.append("prompt", promptText);
  formData.append("size", process.env.OPENAI_IMAGE_SIZE || "1024x1024");
  // Optional OpenAI image params — only sent when configured (else API defaults).
  //   OPENAI_IMAGE_QUALITY: low | medium | high | auto   (detail vs cost)
  //   OPENAI_IMAGE_INPUT_FIDELITY: low | high            (how closely to match the reference product)
  //   OPENAI_IMAGE_BACKGROUND: opaque | transparent | auto
  //   OPENAI_IMAGE_OUTPUT_FORMAT: png | jpeg | webp
  const optionalParams = {
    quality: process.env.OPENAI_IMAGE_QUALITY,
    input_fidelity: process.env.OPENAI_IMAGE_INPUT_FIDELITY,
    background: process.env.OPENAI_IMAGE_BACKGROUND,
    output_format: process.env.OPENAI_IMAGE_OUTPUT_FORMAT
  };
  for (const [key, value] of Object.entries(optionalParams)) {
    if (value && String(value).trim()) {
      formData.append(key, String(value).trim());
    }
  }
  const fieldName = refs.length > 1 ? "image[]" : "image";
  for (const ref of refs) {
    const bytes = await fs.readFile(ref);
    formData.append(fieldName, new Blob([bytes], { type: mimeTypeFor(ref) }), path.basename(ref));
  }

  const endpoint = process.env.OPENAI_IMAGE_EDIT_ENDPOINT || IMAGE_EDIT_ENDPOINT;
  const apiKey = process.env.OPENAI_API_KEY || "";
  const keyMask = apiKey ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}` : "(EMPTY)";
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const startedAt = Date.now();
  console.log(`[IMAGE-API] → POST ${endpoint} | model=${model} | key=${keyMask} | refs=${refs.length} | mock=${process.env.OPENAI_MOCK}`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });
  const contentType = response.headers.get("content-type") || "";
  console.log(`[IMAGE-API] ← ${response.status} ${contentType} (${Date.now() - startedAt}ms)`);
  if (!response.ok) {
    const body = await response.text();
    console.log(`[IMAGE-API] ✖ error body: ${body.slice(0, 300)}`);
    throw new Error(`Image edit failed ${response.status} ${contentType}: ${body}`);
  }
  if (contentType.toLowerCase().startsWith("image/")) {
    return Buffer.from(await response.arrayBuffer());
  }
  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image edit response did not include image binary or b64_json.");
  }
  return Buffer.from(b64, "base64");
}

async function fileExists(targetPath) {
  return fs.stat(targetPath).then((stat) => stat.isFile()).catch(() => false);
}

async function removeGeneratedImageFiles(targetRoot) {
  await fs.mkdir(targetRoot, { recursive: true });
  const entries = await fs.readdir(targetRoot).catch(() => []);
  await Promise.all(entries
    .filter((entry) => /^image_\d+\.(jpg|jpeg|png)$/i.test(entry))
    .map((entry) => fs.unlink(path.join(targetRoot, entry)).catch(() => {})));
}

function imageFilename(imageId) {
  return `image_${String(imageId).padStart(2, "0")}.jpg`;
}

// Cross-platform (Linux/Windows/macOS) image finalize: resize to cover a square,
// flatten transparency onto white, and encode JPEG. Replaces the old PowerShell path.
async function saveFinalJpegFromBuffer({ imageBuffer, outputPath }) {
  await sharp(imageBuffer)
    .resize(FINAL_IMAGE_SIZE, FINAL_IMAGE_SIZE, { fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: FINAL_IMAGE_QUALITY })
    .toFile(outputPath);
}

// Run async tasks with a bounded concurrency pool; results keep input order.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function generateImages({
  prompts,
  referenceImage,
  referenceImages = [],
  outputRoot,
  mock,
  retryImageIds = [],
  onImageProgress = null
}) {
  const imagesRoot = path.join(outputRoot, "images");
  await fs.mkdir(imagesRoot, { recursive: true });
  const shouldRetry = new Set(retryImageIds);
  if (shouldRetry.size === 0) {
    await removeGeneratedImageFiles(imagesRoot);
  }
  let mockJpegBytes = null;
  if (mock) {
    mockJpegBytes = await sharp({
      create: { width: FINAL_IMAGE_SIZE, height: FINAL_IMAGE_SIZE, channels: 3, background: "#e9edf2" }
    }).jpeg({ quality: 80 }).toBuffer();
  }

  // How many images to generate at once. Real API calls run in parallel batches;
  // tune with SELLIFYX_IMAGE_CONCURRENCY (default 5).
  const concurrency = mock ? prompts.length : Math.max(1, Number(process.env.SELLIFYX_IMAGE_CONCURRENCY ?? 5));
  const total = prompts.length;
  let completed = 0;
  const report = (image, verb) => {
    completed += 1;
    if (typeof onImageProgress === "function") {
      const suffix = image.status === "FAILED" ? " (lỗi)" : image.status === "SKIPPED_EXISTING" ? " (giữ nguyên)" : "";
      onImageProgress({ done: completed, total, imageId: image.image_id, status: image.status, label: `${verb} ${completed}/${total} ảnh — ảnh ${image.image_id}${suffix}` });
    }
  };

  const images = await mapWithConcurrency(prompts, concurrency, async (prompt) => {
    const filename = imageFilename(prompt.image_id);
    const outputPath = path.join(imagesRoot, filename);
    const shouldSkip = shouldRetry.size > 0 && !shouldRetry.has(prompt.image_id);
    if (shouldSkip && await fileExists(outputPath)) {
      const entry = { image_id: prompt.image_id, filename, status: "SKIPPED_EXISTING", generation_mode: "RETRY_UNCHANGED" };
      report(entry, "Bỏ qua");
      return entry;
    }
    try {
      if (mock) {
        await fs.writeFile(outputPath, mockJpegBytes);
      } else {
        const imageBytes = await postImageEdit({ referenceImage, referenceImages, promptText: prompt.prompt_text });
        await saveFinalJpegFromBuffer({ imageBuffer: imageBytes, outputPath, imageId: prompt.image_id });
      }
      const entry = {
        image_id: prompt.image_id,
        filename,
        width: FINAL_IMAGE_SIZE,
        height: FINAL_IMAGE_SIZE,
        format: FINAL_IMAGE_FORMAT,
        quality: FINAL_IMAGE_QUALITY,
        status: "CREATED",
        generation_mode: mock ? "MOCK" : "IMAGE_REFERENCE",
        model: mock ? "mock" : MODEL
      };
      report(entry, "Đã tạo");
      return entry;
    } catch (error) {
      const entry = {
        image_id: prompt.image_id,
        filename,
        status: "FAILED",
        generation_mode: mock ? "MOCK" : "IMAGE_REFERENCE",
        model: mock ? "mock" : MODEL,
        error: error.message
      };
      report(entry, "Xong");
      return entry;
    }
  });
  return images;
}

// System QA (deterministic — NO AI, no image sending, no auto-retry loop).
// It only verifies the plan is well-formed: every image has a main text (headline)
// and a sub text, and the main text is actually present in the prompt so it renders.
// The real look of each image is judged by the HUMAN in the post-generation review.
export function runVisionQa({ generatedImages, prompts }) {
  const promptById = new Map(prompts.map((prompt) => [prompt.image_id, prompt]));
  const results = generatedImages.map((image) => {
    const prompt = promptById.get(image.image_id);
    const card = prompt?.source_layout_card ?? {};
    const promptText = prompt?.prompt_text ?? "";

    if (image.status !== "CREATED" && image.status !== "SKIPPED_EXISTING") {
      return {
        image_id: image.image_id,
        filename: image.filename,
        status: "FAIL",
        review_mode: "GENERATION_FAILED",
        checks: {},
        failure_reasons: [image.error ?? "Image generation failed"]
      };
    }

    const mainText = String(card.headline ?? "").trim();
    const subText = String(card.caption ?? card.concept_goal ?? "").trim();
    const hasMain = mainText.length > 0;
    const hasSub = subText.length > 0;
    // Main text is consistent with the concept layout if it also appears in the prompt.
    const mainInPrompt = hasMain && promptText.toLowerCase().includes(mainText.toLowerCase());

    const reasons = [];
    if (!hasMain) reasons.push("Thiếu text chính (headline)");
    if (!hasSub) reasons.push("Thiếu text phụ");
    if (hasMain && !mainInPrompt) reasons.push("Text chính không khớp với prompt/concept");

    return {
      image_id: image.image_id,
      filename: image.filename,
      status: reasons.length === 0 ? "PASS" : "FAIL",
      review_mode: "SYSTEM_TEXT_CHECK",
      checks: {
        has_main_text: hasMain,
        has_sub_text: hasSub,
        main_matches_concept: mainInPrompt
      },
      failure_reasons: reasons
    };
  });

  return {
    status: results.every((result) => result.status === "PASS") ? "PASS" : "FAIL",
    results
  };
}

export async function exportFinalImages({ outputRoot, generatedImages, visionReview }) {
  const finalRoot = path.join(outputRoot, "final_export");
  await fs.mkdir(finalRoot, { recursive: true });
  await removeGeneratedImageFiles(finalRoot);
  const passedIds = new Set(visionReview.results.filter((result) => result.status === "PASS").map((result) => result.image_id));
  const keepable = (status) => status === "CREATED" || status === "SKIPPED_EXISTING";
  const exported = [];
  for (const image of generatedImages) {
    if (!passedIds.has(image.image_id) || !keepable(image.status)) continue;
    const source = path.join(outputRoot, "images", image.filename);
    const target = path.join(finalRoot, image.filename);
    await fs.copyFile(source, target);
    exported.push(image.filename);
  }
  return {
    status: exported.length === generatedImages.filter((image) => keepable(image.status)).length ? "EXPORTED" : "PARTIAL",
    final_export_dir: finalRoot,
    files: exported
  };
}

async function readProductText({ workspace, project }) {
  const productPath = path.join(path.resolve(workspace), "products", project, "input", "product.txt");
  return fs.readFile(productPath, "utf8").catch(() => "");
}

async function previousFailedIds(reportPath) {
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  return report.vision_review?.results
    ?.filter((result) => result.status === "FAIL")
    ?.map((result) => result.image_id) ?? [];
}

export async function runCreativePipelineV2(options) {
  // Progress reporting must never break the pipeline, so every call is guarded.
  const reportProgress = (key, label) => {
    try {
      options.onProgress?.({ key, label });
    } catch {
      /* ignore progress sink errors */
    }
  };
  const projectSegment = safeOutputSegment(options.project);
  const outputBase = options.full15 ? `${OUTPUT_ROOT}_${projectSegment}_full15` : `${OUTPUT_ROOT}_${projectSegment}`;
  const outputRoot = path.resolve(options.outputRoot ?? (options.mock ? `${outputBase}_mock` : outputBase));
  await fs.mkdir(outputRoot, { recursive: true });
  const productText = await readProductText(options);
  const productFields = parseStructuredProductFields(productText);
  const referenceImage = await findReferenceImage({ ...options, productText });
  const referenceImages = await collectReferenceImages({
    workspace: options.workspace ?? DEFAULT_WORKSPACE,
    project: options.project,
    productText
  });
  if (!options.mock && !process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY. Set it in .env or run npm run experiment:v2:mock.");
  }

  const reportPath = path.join(outputRoot, "validation_report.json");
  reportProgress("classify", "Phân loại ảnh tham chiếu");
  const classification = await analyzeReferenceImagesForClassification({
    workspace: options.workspace ?? DEFAULT_WORKSPACE,
    project: options.project,
    productText,
    productFields,
    mock: options.mock
  });
  reportProgress("dna", "Trích xuất Product DNA");
  const productDna = await extractProductDna({
    referenceImage,
    productText,
    productFields,
    classification
  });
  reportProgress("knowledge", "Nạp kiến thức sáng tạo");
  const knowledgeBundle = await loadCuratedCreativeKnowledge({
    workspaceRoot: path.resolve(options.workspace ?? DEFAULT_WORKSPACE),
    productText,
    archetypeId: productDna.product_archetype
  });
  const requestedImageCount = parseRequestedImageCountValue(
    options.requestedImageCount || productFields.targetImageCount,
    options.full15 ? 15 : 0
  );
  const includeCta = typeof options.includeCta === "boolean"
    ? options.includeCta
    : parseBooleanLike(productFields.needsCta, false);
  reportProgress("strategy", "Phân tích chiến lược thị trường (Philippines)");
  const marketKnowledge = await loadMarketKnowledge(options.workspace ?? DEFAULT_WORKSPACE);
  const productStrategy = await analyzeProductStrategy({
    productDna,
    productFields,
    productText,
    classification,
    marketKnowledge,
    requestedImageCount,
    includeCta,
    mock: options.mock,
    project: options.project
  });
  reportProgress("layout", "Sinh concept sáng tạo");
  const conceptFull15 = options.full15 || requestedImageCount >= 15;
  const conceptPlan = await planCreativeConcepts({
    productDna,
    productStrategy,
    requestedImageCount,
    includeCta,
    full15: conceptFull15,
    mock: options.mock,
    project: options.project
  });
  reportProgress("concept-review", "Review độ đa dạng concept");
  const conceptReview = await reviewConceptDiversity({
    cards: conceptPlan.cards,
    productDna,
    mock: options.mock,
    project: options.project
  });
  const layoutCards = conceptReview.cards;
  const campaignDesignSystem = buildCampaignDesignSystem({ productDna, knowledgeBundle });
  const creativeDiversityPlan = buildCreativeDiversityPlan({ layoutCards });
  const layoutPlan = buildLayoutPlan({ productDna, campaignDesignSystem, creativeDiversityPlan, layoutCards });
  reportProgress("prompt", "Viết prompt cho từng ảnh");
  const prompts = writePrompts({ productDna, campaignDesignSystem, layoutPlan, referenceImage, knowledgeBundle, productStrategy });
  reportProgress("review", "Review & tinh chỉnh prompt");
  const promptReview = reviewAndRewritePrompts({ prompts, layoutPlan, campaignDesignSystem, productStrategy });
  const finalPrompts = promptReview.rewritten_prompts;

  // planOnly stops before image generation so the layout + prompts can be
  // reviewed first. Images/vision/export stay empty until the generate phase.
  let generatedImages = [];
  let visionReview = { status: "PENDING", results: [] };
  let finalExport = { status: "PENDING", final_export_dir: "", files: [] };
  let retryImageIds = [];
  if (!options.planOnly) {
    retryImageIds = options.retryFailed ? await previousFailedIds(reportPath).catch(() => []) : [];
    reportProgress("generate", `Tạo ${finalPrompts.length} ảnh`);
    generatedImages = await generateImages({
      prompts: finalPrompts,
      referenceImage,
      referenceImages,
      outputRoot,
      mock: options.mock,
      retryImageIds,
      onImageProgress: (info) => reportProgress("generate", info.label)
    });
    // Deterministic system check only (no AI, no auto-retry). The human reviews the
    // actual images afterwards and regenerates the ones they don't like.
    reportProgress("vision", "Kiểm tra hệ thống (text)");
    visionReview = runVisionQa({ generatedImages, prompts: finalPrompts });
    reportProgress("export-images", "Xuất ảnh cuối");
    finalExport = await exportFinalImages({ outputRoot, generatedImages, visionReview });
  }
  const generationStatistics = {
    total_requested: finalPrompts.length,
    created: generatedImages.filter((image) => image.status === "CREATED").length,
    failed: generatedImages.filter((image) => image.status === "FAILED").length,
    skipped_existing: generatedImages.filter((image) => image.status === "SKIPPED_EXISTING").length,
    retry_failed_mode: options.retryFailed,
    retry_image_ids: retryImageIds
  };
  const sectionSummary = {
    hero: layoutCards.filter((card) => card.role === "Hero").length,
    gallery_extra: layoutCards.filter((card) => card.section === "GALLERY").length,
    gallery_total_including_hero: layoutCards.filter((card) => card.role === "Hero").length + layoutCards.filter((card) => card.section === "GALLERY").length,
    body_extra: layoutCards.filter((card) => card.section === "BODY").length,
    cta: layoutCards.filter((card) => card.role === "CTA" || card.section === "CTA").length,
    body_total_including_cta: layoutCards.filter((card) => card.section === "BODY").length + layoutCards.filter((card) => card.role === "CTA" || card.section === "CTA").length,
    total_images: layoutCards.length,
    requested_non_cta_images: requestedImageCount,
    requested_cta_images: includeCta ? 1 : 0,
    note: "Target Image Count is interpreted as non-CTA images. CTA is appended separately when CTA Required is enabled."
  };

  const report = {
    experiment: "creative-pipeline-v2",
    campaign_mode: `requested_${requestedImageCount}_plus_cta_${includeCta ? "yes" : "no"}`,
    mode: options.mock ? "mock" : "live",
    model: options.mock ? "mock" : MODEL,
    endpoint: "/v1/images/edits",
    output_spec: {
      width: FINAL_IMAGE_SIZE,
      height: FINAL_IMAGE_SIZE,
      format: FINAL_IMAGE_FORMAT,
      extension: ".jpg",
      quality: FINAL_IMAGE_QUALITY
    },
    production_workflow_modified: false,
    project_id: options.project,
    reference_image: referenceImage,
    input_priority: [
      "web_fields",
      "ai_image_classification",
      "product_text"
    ],
    product_classification: classification,
    output_dir: outputRoot,
    section_summary: sectionSummary,
    product_dna: productDna,
    product_strategy: productStrategy,
    curated_creative_knowledge: knowledgeBundle,
    campaign_design_system: campaignDesignSystem,
    creative_diversity_plan: creativeDiversityPlan,
    concept_review: conceptReview.report,
    layout_plan: layoutPlan,
    prompt_writer: {
      prompts: finalPrompts
    },
    prompt_review: promptReview,
    image_generation: {
      images: generatedImages
    },
    vision_review: visionReview,
    final_export: finalExport,
    generation_statistics: generationStatistics,
    plan_only: Boolean(options.planOnly),
    status: options.planOnly ? "PLAN_READY" : "GENERATED",
    created_at: new Date().toISOString()
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // In plan mode, persist the plan next to the SKU so the generate phase can
  // reuse the exact same layout + prompts (WYSIWYG with the preview).
  let planPath = "";
  if (options.planOnly) {
    planPath = planReportPath(options.workspace, options.project);
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  console.log(`Product DNA: READY`);
  console.log(`Campaign Design System: READY`);
  console.log(`Creative Diversity Planner: ${creativeDiversityPlan.status}`);
  console.log(`Layout Planner: ${layoutPlan.status}`);
  console.log(`Prompt Reviewer: ${promptReview.status}`);
  console.log(`Vision QA: ${visionReview.status}`);
  console.log(`Output: ${outputRoot}`);
  console.log(`Report: ${reportPath}`);
  return { report, reportPath, outputRoot, planPath, planOnly: Boolean(options.planOnly) };
}

// Location of the persisted plan for a SKU, stable regardless of run options.
function planReportPath(workspace, project) {
  return path.join(path.resolve(workspace ?? DEFAULT_WORKSPACE), "products", project, "v2_pipeline", "plan_report.json");
}

function resolveV2OutputRoot(options) {
  const projectSegment = safeOutputSegment(options.project);
  const outputBase = options.full15 ? `${OUTPUT_ROOT}_${projectSegment}_full15` : `${OUTPUT_ROOT}_${projectSegment}`;
  return path.resolve(options.outputRoot ?? (options.mock ? `${outputBase}_mock` : outputBase));
}

// Phase B: generate images from a previously saved plan, reusing the exact
// layout + prompts so the output matches what was previewed.
export async function generateFromPlanV2(options) {
  const reportProgress = (key, label) => {
    try {
      options.onProgress?.({ key, label });
    } catch {
      /* ignore progress sink errors */
    }
  };
  const planPath = planReportPath(options.workspace, options.project);
  let planReport;
  try {
    planReport = JSON.parse(await fs.readFile(planPath, "utf8"));
  } catch {
    throw Object.assign(
      new Error("Chưa có bản kế hoạch (plan). Hãy tạo kế hoạch trước khi tạo ảnh."),
      { code: "V2_PLAN_NOT_FOUND" }
    );
  }
  const finalPrompts = planReport.prompt_writer?.prompts ?? [];
  if (finalPrompts.length === 0) {
    throw Object.assign(new Error("Bản kế hoạch không có prompt nào để tạo ảnh."), { code: "V2_PLAN_EMPTY" });
  }

  const outputRoot = resolveV2OutputRoot(options);
  await fs.mkdir(outputRoot, { recursive: true });
  const reportPath = path.join(outputRoot, "validation_report.json");
  const referenceImage = planReport.reference_image;
  const productStrategy = planReport.product_strategy ?? null;
  const productText = await readProductText(options);
  const referenceImages = await collectReferenceImages({
    workspace: options.workspace ?? DEFAULT_WORKSPACE,
    project: options.project,
    productText
  });

  // Partial regenerate: only re-create the selected image ids (user's "tạo lại ảnh
  // đã chọn"); the rest are kept as-is (SKIPPED_EXISTING).
  const regenIds = Array.isArray(options.regenerateImageIds)
    ? options.regenerateImageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id))
    : [];
  reportProgress("generate", regenIds.length ? `Tạo lại ${regenIds.length} ảnh đã chọn` : `Tạo ${finalPrompts.length} ảnh`);
  const generatedImages = await generateImages({
    prompts: finalPrompts,
    referenceImages,
    referenceImage,
    outputRoot,
    mock: options.mock,
    retryImageIds: regenIds,
    onImageProgress: (info) => reportProgress("generate", info.label)
  });
  // Deterministic system check only — human reviews the images afterwards.
  reportProgress("vision", "Kiểm tra hệ thống (text)");
  const visionReview = runVisionQa({ generatedImages, prompts: finalPrompts });
  reportProgress("export-images", "Xuất ảnh cuối");
  const finalExport = await exportFinalImages({ outputRoot, generatedImages, visionReview });

  const report = {
    ...planReport,
    output_dir: outputRoot,
    image_generation: { images: generatedImages },
    vision_review: visionReview,
    final_export: finalExport,
    generation_statistics: {
      total_requested: finalPrompts.length,
      created: generatedImages.filter((image) => image.status === "CREATED").length,
      failed: generatedImages.filter((image) => image.status === "FAILED").length,
      skipped_existing: generatedImages.filter((image) => image.status === "SKIPPED_EXISTING").length,
      retry_failed_mode: false,
      retry_image_ids: []
    },
    plan_only: false,
    status: "GENERATED",
    generated_at: new Date().toISOString()
  };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath, outputRoot, planOnly: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  await loadDotEnv();
  await runCreativePipelineV2(args);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
