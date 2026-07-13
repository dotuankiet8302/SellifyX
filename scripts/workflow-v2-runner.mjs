#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCreativePipelineV2, generateFromPlanV2 } from "./experiments/creative-pipeline-v2.mjs";
import { runQcEngine } from "./qc-engine.mjs";
import { runRetryPlanner } from "./retry-planner.mjs";
import { runExportBuilder } from "./export-builder.mjs";

const DEFAULT_WORKSPACE = "workspace";

const V2_STAGES = [
  "product-dna",
  "campaign-design-system",
  "layout-planner",
  "prompt-writer",
  "prompt-reviewer",
  "image-generator",
  "vision-qa",
  "workspace-sync",
  "qc",
  "retry-plan",
  "export"
];

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

function parseArgs(argv) {
  const args = {
    workspace: DEFAULT_WORKSPACE,
    project: null,
    mock: false,
    full15: false,
    requestedImageCount: 0,
    includeCta: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      args.project = argv[index + 1];
      index += 1;
    } else if (arg === "--workspace") {
      args.workspace = argv[index + 1];
      index += 1;
    } else if (arg === "--mock") {
      args.mock = true;
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
    "  npm run workflow:v2 -- --project <project_id>",
    "  npm run workflow:v2:mock -- --project <project_id>",
    "",
    "Options:",
    "  --project <project_id>   Required product folder under workspace/products/",
    "  --workspace <path>        Optional workspace root, defaults to workspace",
    "  --full15                  Legacy shortcut for 15 non-CTA images",
    "  --target-count <number>   Requested non-CTA image count",
    "  --include-cta             Add one CTA image on top of target count",
    "  --mock                    Run without OpenAI"
  ].join("\n");
}

async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

async function writeJson(targetPath, value) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyFileEnsuringDir(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function safeCopyImage(source, destination) {
  try {
    await copyFileEnsuringDir(source, destination);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cleanGeneratedOutputs(projectRoot) {
  for (const relative of ["03_prompts", "04_images", "05_qc", "06_retry", "07_export"]) {
    await fs.rm(path.join(projectRoot, relative), { recursive: true, force: true });
  }
}

function promptFilename(imageId) {
  return `prompt_${String(imageId).padStart(3, "0")}.json`;
}

function imageFilename(imageId) {
  return `image_${String(imageId).padStart(3, "0")}.jpg`;
}

function toProductUnderstanding({ projectId, report }) {
  const identity = report.product_dna?.identity ?? {};
  return {
    project_id: projectId,
    product_name: identity.category ?? "UNKNOWN",
    product_description: identity.silhouette ?? "UNKNOWN",
    product_category: identity.category ?? "UNKNOWN",
    product_type: identity.shape ?? "UNKNOWN",
    product_identity_lock: {
      short_identity: identity.shape ?? "UNKNOWN",
      detailed_identity: identity.silhouette ?? "UNKNOWN",
      visible_shape: identity.shape ?? "UNKNOWN",
      main_structure: identity.silhouette ?? "UNKNOWN",
      components: identity.functional_parts ?? [],
      accessories: identity.accessories ?? [],
      colors: [identity.color].filter(Boolean),
      materials: [identity.material].filter(Boolean),
      variants: [],
      dimensions: [],
      functions: [],
      features: identity.functional_parts ?? [],
      must_preserve: identity.geometry_constraints ?? [],
      must_not_change: identity.must_not_change ?? []
    },
    image_evidence_map: [
      {
        image_id: "reference_001",
        filename: path.basename(report.reference_image ?? ""),
        image_type: "REFERENCE_IMAGE",
        visible_product_parts: identity.functional_parts ?? [],
        visible_features: identity.geometry_constraints ?? [],
        visible_text_claims: [],
        notes: "V2 pipeline uses reference image edit as source of truth."
      }
    ],
    image_content_analysis: "AVAILABLE",
    uncertain_fields: [],
    forbidden_claims: [
      "fake reviews",
      "fake ratings",
      "fake certifications",
      "third-party logos",
      "unsupported claims"
    ],
    confidence: {
      overall_confidence: 0.85,
      evidence_confidence: 0.85,
      identity_confidence: 0.85
    },
    status: "READY",
    created_at: new Date().toISOString()
  };
}

function toStoryboard({ projectId, report }) {
  const cards = report.layout_plan.cards.map((card) => ({
    image_id: card.image_id,
    role: card.role,
    primary_message: card.concept_goal,
    english_headline: card.headline,
    visual_proof: card.unique_focal_point,
    product_component_focus: report.product_dna.identity.functional_parts ?? [],
    source_reference_image: path.basename(report.reference_image ?? ""),
    render_mode: "PRODUCT_CUTOUT_TEMPLATE",
    text_safe_area: "CENTER_SAFE",
    qc_expectation: [
      "Reference image must be used",
      "Campaign typography must stay consistent",
      "No third-party logos or branded props"
    ]
  }));
  return {
    project_id: projectId,
    source_product_understanding: "01_product_reader/product_understanding.json",
    target_image_count: cards.length,
    cards,
    status: "READY",
    created_at: new Date().toISOString()
  };
}

function toPromptJson({ projectId, prompt }) {
  return {
    project_id: projectId,
    image_id: prompt.image_id,
    source_storyboard: "02_storyboard/storyboard.json",
    role: prompt.role,
    render_mode: "PRODUCT_CUTOUT_TEMPLATE",
    english_headline: prompt.source_layout_card?.headline ?? "",
    prompt_text: prompt.prompt_text,
    negative_constraints: [
      "no collage",
      "no grid",
      "no contact sheet",
      "no split screen",
      "no multiple products",
      "no fake reviews",
      "no fake ratings",
      "no fake certification",
      "no fake logo",
      "no third-party brand labels",
      "no third-party brand names",
      "no visible logos",
      "no readable branded packaging",
      "no product redesign"
    ],
    text_rules: {
      language: "English",
      max_headline_lines: 3,
      no_image_numbers: true,
      must_not_overlap_product: true
    },
    product_identity_lock: {},
    qc_expectation: [
      "Use V2 campaign design system",
      "Use reference image for product identity",
      "Keep typography readable"
    ],
    status: prompt.status === "REWRITTEN_AFTER_REVIEW" ? "READY" : prompt.status,
    created_at: new Date().toISOString()
  };
}

async function syncV2ReportToWorkspace({ workspaceRoot, projectId, report }) {
  const projectRoot = path.join(workspaceRoot, "products", projectId);
  await cleanGeneratedOutputs(projectRoot);

  await writeJson(
    path.join(projectRoot, "01_product_reader", "product_understanding.json"),
    toProductUnderstanding({ projectId, report })
  );
  await writeJson(
    path.join(projectRoot, "02_storyboard", "storyboard.json"),
    toStoryboard({ projectId, report })
  );

  const promptRoot = path.join(projectRoot, "03_prompts");
  for (const prompt of report.prompt_writer.prompts) {
    await writeJson(path.join(promptRoot, promptFilename(prompt.image_id)), toPromptJson({ projectId, prompt }));
  }

  const imagesRoot = path.join(projectRoot, "04_images");
  const manifestImages = [];
  for (const image of report.image_generation.images) {
    // SKIPPED_EXISTING = kept from a partial regenerate; its file still exists in the
    // experiment output, so copy it too (otherwise those images vanish from workspace).
    const keepable = image.status === "CREATED" || image.status === "SKIPPED_EXISTING";
    if (!keepable) {
      manifestImages.push({
        image_id: image.image_id,
        prompt_file: promptFilename(image.image_id),
        filename: imageFilename(image.image_id),
        width: 800,
        height: 800,
        format: "jpg",
        render_mode: "PRODUCT_CUTOUT_TEMPLATE",
        source_reference_image: path.basename(report.reference_image ?? ""),
        model_used: report.model,
        generation_mode: image.generation_mode,
        status: "FAILED",
        error: image.error ?? "V2 image generation failed.",
        created_at: new Date().toISOString()
      });
      continue;
    }
    const source = path.join(report.output_dir, "images", image.filename);
    const targetName = imageFilename(image.image_id);
    const copied = await safeCopyImage(source, path.join(imagesRoot, targetName));
    if (!copied) {
      manifestImages.push({
        image_id: image.image_id,
        prompt_file: promptFilename(image.image_id),
        filename: targetName,
        width: image.width ?? 800,
        height: image.height ?? 800,
        format: "jpg",
        render_mode: "PRODUCT_CUTOUT_TEMPLATE",
        source_reference_image: path.basename(report.reference_image ?? ""),
        model_used: report.model,
        generation_mode: image.generation_mode,
        status: "FAILED",
        error: `Missing generated image file: ${image.filename}`,
        created_at: new Date().toISOString()
      });
      continue;
    }
    manifestImages.push({
      image_id: image.image_id,
      prompt_file: promptFilename(image.image_id),
      filename: targetName,
      width: image.width ?? 800,
      height: image.height ?? 800,
      format: "jpg",
      render_mode: "PRODUCT_CUTOUT_TEMPLATE",
      source_reference_image: path.basename(report.reference_image ?? ""),
      model_used: report.model,
      generation_mode: image.generation_mode,
      status: "CREATED",
      error: "",
      created_at: new Date().toISOString()
    });
  }
  await writeJson(path.join(imagesRoot, "image_manifest.json"), {
    project_id: projectId,
    source_prompt_folder: "03_prompts",
    images: manifestImages
  });

  await writeJson(path.join(projectRoot, "logs", "decision_log.json"), {
    project_id: projectId,
    decisions: [
      {
        decision_id: "decision_001",
        stage: "CREATIVE_PIPELINE_V2",
        decision: "Created campaign images using V2 creative pipeline",
        reason: "V2 replaces the old V1 worker chain for web generation while keeping workspace artifact compatibility.",
        owner: "Creative Pipeline V2",
        evidence: ["input/product.txt", "input/images/"],
        timestamp: new Date().toISOString()
      }
    ]
  });
  await writeJson(path.join(projectRoot, "v2_pipeline", "validation_report.json"), report);
}

async function writeWorkflowLog(logPath, log) {
  await writeJson(logPath, log);
}

function stageError(error) {
  if (error?.code) {
    return `${error.code}: ${error.message}`;
  }
  return error?.message ?? String(error);
}

export async function runWorkflowV2(options) {
  await loadDotEnv();
  const workspaceRoot = path.resolve(options.workspace ?? DEFAULT_WORKSPACE);
  const projectId = options.project;
  if (!projectId) {
    throw Object.assign(new Error("Missing --project <project_id>."), { code: "MISSING_PROJECT_ARGUMENT" });
  }

  const projectRoot = path.join(workspaceRoot, "products", projectId);
  const logPath = path.join(projectRoot, "logs", "workflow_run_log.json");
  const log = {
    project_id: projectId,
    pipeline: "creative_pipeline_v2",
    status: "RUNNING",
    stages: [],
    created_at: new Date().toISOString(),
    finished_at: ""
  };
  await writeWorkflowLog(logPath, log);

  function startStage(stage) {
    const stageLog = {
      stage,
      status: "RUNNING",
      started_at: new Date().toISOString(),
      finished_at: "",
      error: ""
    };
    log.stages.push(stageLog);
    return stageLog;
  }

  const reportProgress = (key, label) => {
    try {
      options.onProgress?.({ key, label });
    } catch {
      /* ignore progress sink errors */
    }
  };

  const planOnly = Boolean(options.planOnly);
  const fromPlan = Boolean(options.fromPlan);

  try {
    console.log(planOnly ? "Dang lap ke hoach Creative Pipeline V2..." : "Dang chay Creative Pipeline V2...");
    const pipelineStage = startStage(planOnly ? "creative-plan" : "creative-pipeline-v2");
    await writeWorkflowLog(logPath, log);
    const { report } = fromPlan
      ? await generateFromPlanV2({
          workspace: workspaceRoot,
          project: projectId,
          mock: Boolean(options.mock),
          full15: Boolean(options.full15),
          regenerateImageIds: options.regenerateImageIds,
          onProgress: options.onProgress
        })
      : await runCreativePipelineV2({
          workspace: workspaceRoot,
          project: projectId,
          mock: Boolean(options.mock),
          full15: Boolean(options.full15),
          requestedImageCount: Number(options.requestedImageCount) || 0,
          includeCta: options.includeCta,
          planOnly,
          onProgress: options.onProgress
        });

    // Plan phase stops here: no images generated, nothing to sync/qc/export.
    if (planOnly) {
      pipelineStage.status = "PASS";
      pipelineStage.finished_at = new Date().toISOString();
      log.status = "PLAN_READY";
      log.finished_at = new Date().toISOString();
      await writeWorkflowLog(logPath, log);
      return { projectId, projectRoot, logPath, log, report, planOnly: true };
    }

    const createdImages = report.image_generation?.images?.filter((image) => image.status === "CREATED") ?? [];
    if (createdImages.length === 0) {
      throw Object.assign(new Error("Creative Pipeline V2 did not create any image. Workspace sync was skipped."), {
        code: "V2_NO_IMAGES_CREATED"
      });
    }
    pipelineStage.status = "PASS";
    pipelineStage.finished_at = new Date().toISOString();
    await writeWorkflowLog(logPath, log);

    reportProgress("workspace-sync", "Đồng bộ ảnh vào workspace");
    const syncStage = startStage("workspace-sync");
    await syncV2ReportToWorkspace({ workspaceRoot, projectId, report });
    syncStage.status = "PASS";
    syncStage.finished_at = new Date().toISOString();
    await writeWorkflowLog(logPath, log);

    for (const stage of [
      { name: "qc", label: "QC Engine kiểm định", run: runQcEngine },
      { name: "retry-plan", label: "Lập kế hoạch retry", run: runRetryPlanner },
      { name: "export", label: "Đóng gói bản xuất", run: runExportBuilder }
    ]) {
      reportProgress(stage.name, stage.label);
      const stageLog = startStage(stage.name);
      await writeWorkflowLog(logPath, log);
      await stage.run({ workspace: workspaceRoot, project: projectId, mock: Boolean(options.mock) });
      stageLog.status = "PASS";
      stageLog.finished_at = new Date().toISOString();
      await writeWorkflowLog(logPath, log);
    }

    log.status = "COMPLETED";
    log.finished_at = new Date().toISOString();
    await writeWorkflowLog(logPath, log);
    return { projectId, projectRoot, logPath, log, report, planOnly: false };
  } catch (error) {
    const current = log.stages.at(-1);
    if (current && current.status !== "PASS") {
      current.status = "FAIL";
      current.finished_at = new Date().toISOString();
      current.error = stageError(error);
    }
    log.status = "FAILED";
    log.finished_at = new Date().toISOString();
    await writeWorkflowLog(logPath, log);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await runWorkflowV2(args);
  console.log(`Workflow V2 hoan tat cho project ${result.projectId}.`);
  console.log(`Workflow log: ${result.logPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Workflow V2 that bai: ${error.message}`);
    if (error.code) {
      console.error(`Ma loi: ${error.code}`);
    }
    process.exitCode = 1;
  });
}
