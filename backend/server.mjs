#!/usr/bin/env node
import "../scripts/load-env.mjs"; // MUST be first: loads .env before other modules read config
import http from "node:http";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflowV2 } from "../scripts/workflow-v2-runner.mjs";
import { runImageGenerator } from "../scripts/image-generator.mjs";
import { analyzeFeedbackLearning, renderLearningMarkdown } from "../scripts/feedback-learning-engine.mjs";
import { analyzeImportedKnowledge, renderImportedKnowledgeMarkdown } from "../scripts/knowledge-ingestion-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadLocalEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();

const frontendRoot = path.join(repoRoot, "frontend");
const workspaceRoot = path.join(repoRoot, "workspace");
const productsRoot = path.join(workspaceRoot, "products");
const catalogRoot = path.join(workspaceRoot, "catalog");
const knowledgeStagingRoot = path.join(workspaceRoot, "knowledge_staging");
const port = Number.parseInt(process.env.PORT ?? "4000", 10);
const internalAccessKey = process.env.INTERNAL_ACCESS_KEY ?? "";
const jobs = new Map();

const productFieldDefinitions = [
  ["sku", "SKU"],
  ["category", "Category"],
  ["description", "Description"],
  ["colors", "Colors"],
  ["targetImageCount", "Target Image Count"],
  ["needsCta", "CTA Required"]
];

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".zip", "application/zip"]
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendError(response, statusCode, message, code = "REQUEST_FAILED") {
  sendJson(response, statusCode, { error: { code, message } });
}

function statusCodeForError(error) {
  if (error?.code === "BODY_TOO_LARGE") {
    return 413;
  }
  if (
    typeof error?.code === "string" &&
    (error.code.startsWith("MISSING_") || error.code.startsWith("INVALID_"))
  ) {
    return 400;
  }
  return 500;
}

function isAuthorized(request) {
  if (!internalAccessKey) {
    return true;
  }
  return request.headers["x-sellifyx-key"] === internalAccessKey;
}

function parseRequestUrl(request) {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
}

function sanitizeProjectId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || normalized.length > 80) {
    throw Object.assign(new Error("Project ID must be 1-80 characters using letters, numbers, dash, or underscore."), {
      code: "INVALID_PROJECT_ID"
    });
  }
  return normalized;
}

function sanitizeCatalogSegment(value, label = "Category") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || normalized.length > 80) {
    throw Object.assign(new Error(`${label} is required and must be 1-80 characters.`), {
      code: `INVALID_${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
    });
  }
  return normalized;
}

function projectRoot(projectId) {
  return path.join(productsRoot, sanitizeProjectId(projectId));
}

function catalogProductRoot(category, sku) {
  return path.join(catalogRoot, sanitizeCatalogSegment(category, "Category"), sanitizeProjectId(sku));
}

async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 40 * 1024 * 1024) {
      throw Object.assign(new Error("Request body is too large."), { code: "BODY_TOO_LARGE" });
    }
  }
  return body ? JSON.parse(body) : {};
}

function decodeTextFile(file) {
  const raw = String(file.dataUrl ?? file.base64 ?? "");
  const match = raw.match(/^data:[^;]+;base64,(.+)$/);
  if (match || file.base64) {
    return Buffer.from(match ? match[1] : raw, "base64").toString("utf8");
  }
  return String(file.text ?? file.content ?? "");
}

function safeMarkdownFilename(name, index) {
  const base = String(name ?? `experience_${index + 1}.md`)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100) || `experience_${index + 1}.md`;
  return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
}

function safeTimestamp(value = new Date().toISOString()) {
  return String(value).replace(/[:.]/g, "-");
}

function decodeImage(image) {
  const raw = String(image.dataUrl ?? image.base64 ?? "");
  const match = raw.match(/^data:[^;]+;base64,(.+)$/);
  return Buffer.from(match ? match[1] : raw, "base64");
}

function productFieldsToText(productFields = {}, fallbackText = "") {
  const lines = [];
  for (const [key, label] of productFieldDefinitions) {
    const value = String(productFields[key] ?? "").trim();
    if (value) {
      lines.push(`${label}: ${value}`);
    }
  }
  const extraText = String(fallbackText ?? "").trim();
  if (extraText) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(extraText);
  }
  return lines.join("\n").trim();
}

function parseProductFields(productText = "") {
  const fields = Object.fromEntries(productFieldDefinitions.map(([key]) => [key, ""]));
  const lines = String(productText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const label = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    const field = productFieldDefinitions.find(([, definitionLabel]) => definitionLabel.toLowerCase() === label);
    if (field) {
      fields[field[0]] = value;
    }
  }
  return fields;
}

function imageUrl(projectId, filename) {
  return `/api/projects/${encodeURIComponent(projectId)}/input/images/${encodeURIComponent(filename)}`;
}

function generatedImageUrl(projectId, filename) {
  return `/api/projects/${encodeURIComponent(projectId)}/generated/images/${encodeURIComponent(filename)}`;
}

function normalizeProjectPayload(payload) {
  const productFields = {
    ...(payload.productFields ?? {})
  };
  const sku = sanitizeProjectId(payload.sku ?? payload.projectId ?? productFields.sku);
  // Category is optional now (generic mode uses general knowledge, not category
  // knowledge). Default it so catalog folders still have a stable home.
  const category = String(payload.category ?? productFields.category ?? "").trim() || "uncategorized";
  productFields.sku = sku;
  productFields.category = category;
  return {
    sku,
    category,
    productFields
  };
}

async function listInputImages(projectId) {
  const imagesRoot = path.join(projectRoot(projectId), "input", "images");
  const entries = await fs.readdir(imagesRoot, { withFileTypes: true }).catch(() => []);
  const supported = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile() || !supported.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    const stat = await fs.stat(path.join(imagesRoot, entry.name));
    images.push({
      filename: entry.name,
      size: stat.size,
      url: imageUrl(projectId, entry.name)
    });
  }
  return images.sort((a, b) => a.filename.localeCompare(b.filename));
}

async function readProjectInput(projectId) {
  const inputRoot = path.join(projectRoot(projectId), "input");
  const productText = await fs.readFile(path.join(inputRoot, "product.txt"), "utf8").catch(() => "");
  return {
    projectId: sanitizeProjectId(projectId),
    sku: sanitizeProjectId(projectId),
    productText,
    productFields: parseProductFields(productText),
    images: await listInputImages(projectId)
  };
}

async function listGeneratedImages(projectId) {
  const imagesRoot = path.join(projectRoot(projectId), "04_images");
  const manifest = await readJsonFile(path.join(imagesRoot, "image_manifest.json"), { images: [] });
  const entries = await fs.readdir(imagesRoot, { withFileTypes: true }).catch(() => []);
  const supported = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const files = entries
    .filter((entry) => entry.isFile() && supported.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(files.map(async (filename) => {
    const stat = await fs.stat(path.join(imagesRoot, filename));
    const manifestEntry = Array.isArray(manifest.images)
      ? manifest.images.find((image) => image.filename === filename)
      : null;
    return {
      imageId: manifestEntry?.image_id ?? null,
      filename,
      status: manifestEntry?.status ?? "UNKNOWN",
      size: stat.size,
      url: generatedImageUrl(projectId, filename)
    };
  }));
}

async function ensureCatalogFolders({ category, sku }) {
  const root = catalogProductRoot(category, sku);
  const folders = [
    root,
    path.join(root, "generated_images", "approved"),
    path.join(root, "generated_images", "failed"),
    path.join(root, "generated_images", "liked"),
    path.join(root, "knowledge")
  ];
  await Promise.all(folders.map((folder) => fs.mkdir(folder, { recursive: true })));
  return root;
}

async function ensureCategoryKnowledgeFolder(category) {
  const root = path.join(catalogRoot, sanitizeCatalogSegment(category, "Category"), "knowledge");
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function ensureGlobalKnowledgeFolder() {
  const root = path.join(catalogRoot, "_global", "knowledge");
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function ensureKnowledgeStagingFolder(category) {
  const root = path.join(knowledgeStagingRoot, sanitizeCatalogSegment(category, "Category"));
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function syncCatalogFromProject(projectId) {
  const input = await readProjectInput(projectId);
  const category = input.productFields.category;
  if (!category) {
    return null;
  }
  const sku = input.productFields.sku || projectId;
  const root = await ensureCatalogFolders({ category, sku });
  await fs.writeFile(
    path.join(root, "product_input.json"),
    `${JSON.stringify({
      sku,
      category,
      productFields: input.productFields,
      productText: input.productText,
      updated_at: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );

  const generated = await listGeneratedImages(projectId);
  const approvedRoot = path.join(root, "generated_images", "approved");
  for (const image of generated.filter((item) => item.status === "CREATED")) {
    await fs.copyFile(
      path.join(projectRoot(projectId), "04_images", image.filename),
      path.join(approvedRoot, image.filename)
    ).catch(() => {});
  }
  return root;
}

async function appendFeedbackKnowledge({ projectId, imageIds = [], feedback = "", rating = "needs_fix" }) {
  const input = await readProjectInput(projectId);
  const category = input.productFields.category;
  if (!category) {
    throw Object.assign(new Error("Category is required before saving product knowledge."), { code: "MISSING_CATEGORY" });
  }
  const sku = input.productFields.sku || projectId;
  const root = await ensureCatalogFolders({ category, sku });
  const knowledgePath = path.join(root, "knowledge", "feedback_learning.md");
  const rawPath = path.join(root, "knowledge", "raw_feedback_log.md");
  const jsonlPath = path.join(root, "knowledge", "feedback_learning.jsonl");
  const categoryKnowledgeRoot = await ensureCategoryKnowledgeFolder(category);
  const globalKnowledgeRoot = await ensureGlobalKnowledgeFolder();
  const timestamp = new Date().toISOString();
  const generated = await listGeneratedImages(projectId);
  const learning = await analyzeFeedbackLearning({
    projectId,
    sku,
    category,
    imageIds,
    feedback,
    rating,
    productFields: input.productFields,
    productText: input.productText,
    generatedImages: generated
  }).catch(() => ({
    ...{
      summary: "AI feedback analysis failed; stored raw feedback only.",
      sku_learning: ["Review raw feedback manually before reusing."],
      category_learning: [],
      global_learning: [],
      repair_instructions: [String(feedback || "").trim()].filter(Boolean),
      reject_from_global: [String(feedback || "").trim()].filter(Boolean),
      confidence: 0.2
    },
    rating
  }));
  const section = renderLearningMarkdown({
    timestamp,
    projectId,
    sku,
    category,
    imageIds,
    rating,
    feedback,
    learning
  });
  await fs.appendFile(knowledgePath, `${section}\n`, "utf8");
  await fs.appendFile(rawPath, `${[
    `## Raw Feedback ${timestamp}`,
    "",
    `- SKU: ${sku}`,
    `- Category: ${category}`,
    `- Images: ${imageIds.length > 0 ? imageIds.join(", ") : "UNKNOWN"}`,
    `- Rating: ${rating}`,
    "",
    String(feedback || "No feedback text provided.").trim(),
    ""
  ].join("\n")}\n`, "utf8");
  await fs.appendFile(jsonlPath, `${JSON.stringify({
    timestamp,
    projectId,
    sku,
    category,
    imageIds,
    rating,
    feedback,
    learning
  })}\n`, "utf8");
  // Feedback is intentionally kept SKU-local. It must NOT auto-write to the shared
  // category or GLOBAL knowledge — that was the cross-product contamination path.
  // Only files the user explicitly imports may enter category/global knowledge.
  const targetFolder = String(rating).toLowerCase().includes("liked") || String(rating).toLowerCase().includes("good")
    ? "liked"
    : "failed";
  const targetRoot = path.join(root, "generated_images", targetFolder);
  for (const imageId of imageIds.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value))) {
    const image = generated.find((item) => item.imageId === imageId);
    if (!image) {
      continue;
    }
    await fs.copyFile(
      path.join(projectRoot(projectId), "04_images", image.filename),
      path.join(targetRoot, image.filename)
    ).catch(() => {});
  }
  return { knowledgePath, rawPath, jsonlPath, learning };
}

async function importMarkdownExperience({ projectId, files = [], scope = "sku" }) {
  const input = await readProjectInput(projectId);
  const category = input.productFields.category;
  if (!category) {
    throw Object.assign(new Error("Category is required before importing markdown knowledge."), { code: "MISSING_CATEGORY" });
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw Object.assign(new Error("At least one markdown file is required."), { code: "MISSING_MARKDOWN_FILES" });
  }
  const sku = input.productFields.sku || projectId;
  const skuRoot = await ensureCatalogFolders({ category, sku });
  const normalizedScope = ["sku", "category", "global"].includes(String(scope).toLowerCase())
    ? String(scope).toLowerCase()
    : "sku";
  let ownerRoot = skuRoot;
  if (normalizedScope === "category") {
    ownerRoot = await ensureCategoryKnowledgeFolder(category);
  } else if (normalizedScope === "global") {
    ownerRoot = await ensureGlobalKnowledgeFolder();
  }
  const targetRoot = normalizedScope === "sku"
    ? path.join(ownerRoot, "knowledge", "imported_markdown")
    : path.join(ownerRoot, "imported_markdown");
  await fs.mkdir(targetRoot, { recursive: true });
  const timestamp = new Date().toISOString();
  const saved = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const filename = `${timestamp.replace(/[:.]/g, "-")}_${safeMarkdownFilename(file.name, index)}`;
    const text = decodeTextFile(file);
    const content = [
      `<!-- Imported SellifyX experience file -->`,
      `<!-- SKU: ${sku} | Category: ${category} | Scope: ${normalizedScope} | Imported: ${timestamp} -->`,
      "",
      text.trim(),
      ""
    ].join("\n");
    await fs.writeFile(path.join(targetRoot, filename), content, "utf8");
    saved.push(filename);
  }
  await fs.appendFile(
    normalizedScope === "sku"
      ? path.join(ownerRoot, "knowledge", "imported_experience_index.md")
      : path.join(ownerRoot, "imported_experience_index.md"),
    `${[
      `## Imported Markdown ${timestamp}`,
      "",
      `- SKU: ${sku}`,
      `- Category: ${category}`,
      `- Scope: ${normalizedScope}`,
      `- Files: ${saved.join(", ")}`,
      "",
      "### Usage Rule",
      "",
      "- Treat imported markdown as experience evidence.",
      "- Do not promote product-specific identity facts to global knowledge without review.",
      "- Extract reusable creative, typography, layout, claim-safety, and brand-safety rules cautiously.",
      ""
    ].join("\n")}\n`,
    "utf8"
  );
  return { targetRoot, saved, scope: normalizedScope };
}

async function importExternalKnowledge({
  category = "",
  sku = "",
  files = [],
  scope = "category",
  sourceLabel = ""
}) {
  const normalizedCategory = String(category).trim();
  if (!normalizedCategory) {
    throw Object.assign(new Error("Category is required before importing knowledge."), { code: "MISSING_CATEGORY" });
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw Object.assign(new Error("At least one markdown file is required."), { code: "MISSING_MARKDOWN_FILES" });
  }

  const normalizedScope = ["sku", "category", "global"].includes(String(scope).toLowerCase())
    ? String(scope).toLowerCase()
    : "category";
  const normalizedSku = sku ? sanitizeProjectId(sku) : "";
  if (normalizedScope === "sku" && !normalizedSku) {
    throw Object.assign(new Error("SKU is required when importing SKU-specific knowledge."), { code: "MISSING_SKU" });
  }
  const timestamp = new Date().toISOString();
  const stagingRoot = await ensureKnowledgeStagingFolder(normalizedCategory);
  const reviewKey = `${safeTimestamp(timestamp)}_${normalizedScope}${normalizedSku ? `_${normalizedSku}` : ""}`;
  const reviewRoot = path.join(stagingRoot, "pending_review", reviewKey);
  const rawRoot = path.join(reviewRoot, "raw");
  await fs.mkdir(rawRoot, { recursive: true });
  const decodedFiles = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const filename = `${safeTimestamp(timestamp)}_${safeMarkdownFilename(file.name, index)}`;
    const text = decodeTextFile(file).trim();
    await fs.writeFile(
      path.join(rawRoot, filename),
      [
        "<!-- Imported SellifyX experience file -->",
        `<!-- Category: ${normalizedCategory} | SKU: ${normalizedSku || "N/A"} | Scope: ${normalizedScope} | Imported: ${timestamp} -->`,
        "",
        text,
        ""
      ].join("\n"),
      "utf8"
    );
    decodedFiles.push({ name: filename, text });
  }

  const distilled = await analyzeImportedKnowledge({
    category: normalizedCategory,
    sku: normalizedSku,
    scope: normalizedScope,
    sourceLabel,
    files: decodedFiles
  }).catch(() => ({
    summary: `Fallback import for ${decodedFiles.length} markdown file(s).`,
    source_label: sourceLabel || "Imported Markdown",
    scope: normalizedScope,
    category_rules: [],
    global_rules: [],
    sku_rules: [],
    rejected_rules: [],
    tags: [normalizedCategory, normalizedScope].filter(Boolean),
    confidence: 0.2
  }));

  const markdown = renderImportedKnowledgeMarkdown({
    timestamp,
    category: normalizedCategory,
    sku: normalizedSku,
    scope: normalizedScope,
    sourceLabel,
    files: decodedFiles,
    distilled
  });

  await fs.writeFile(path.join(reviewRoot, "distilled_review.md"), `${markdown}\n`, "utf8");
  await fs.writeFile(
    path.join(reviewRoot, "distilled_review.json"),
    `${JSON.stringify({
      timestamp,
      category: normalizedCategory,
      sku: normalizedSku,
      scope: normalizedScope,
      sourceLabel,
      files: decodedFiles.map((file) => file.name),
      distilled,
      status: "PENDING_REVIEW"
    }, null, 2)}\n`,
    "utf8"
  );
  await fs.appendFile(
    path.join(stagingRoot, "review_index.jsonl"),
    `${JSON.stringify({
      timestamp,
      review_root: reviewRoot,
      category: normalizedCategory,
      sku: normalizedSku,
      scope: normalizedScope,
      sourceLabel,
      files: decodedFiles.map((file) => file.name),
      distilled,
      status: "PENDING_REVIEW"
    })}\n`,
    "utf8"
  );

  return {
    targetRoot: reviewRoot,
    saved: decodedFiles.map((file) => file.name),
    scope: normalizedScope,
    distilled,
    status: "PENDING_REVIEW"
  };
}

async function appendProjectImages({ projectId, images = [] }) {
  const inputRoot = path.join(projectRoot(projectId), "input");
  const imagesRoot = path.join(inputRoot, "images");
  await fs.mkdir(imagesRoot, { recursive: true });

  const existing = await fs.readdir(imagesRoot).catch(() => []);
  let offset = existing.length;
  for (const image of images) {
    offset += 1;
    const ext = path.extname(image.name ?? "").toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    const baseName = String(image.name ?? "image")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 90) || "image";
    const cleanBase = baseName.toLowerCase().endsWith(safeExt) ? baseName.slice(0, -safeExt.length) : baseName;
    const filename = `${String(offset).padStart(2, "0")}_${Date.now()}_${cleanBase}${safeExt}`;
    await fs.writeFile(path.join(imagesRoot, filename), decodeImage(image));
  }
}

async function writeProjectInput({ projectId, productText, productFields, images = [] }) {
  const root = projectRoot(projectId);
  const inputRoot = path.join(root, "input");
  const imagesRoot = path.join(inputRoot, "images");
  await fs.mkdir(imagesRoot, { recursive: true });
  const formattedProductText = productFieldsToText(productFields, productText);
  await fs.writeFile(path.join(inputRoot, "product.txt"), formattedProductText, "utf8");
  await appendProjectImages({ projectId, images });
  await syncCatalogFromProject(projectId).catch(() => null);
}

async function summarizeProject(projectId) {
  const root = projectRoot(projectId);
  const log = await readJsonFile(path.join(root, "logs", "workflow_run_log.json"), null);
  const exportSummary = await readJsonFile(path.join(root, "07_export", "summary.json"), null);
  const product = await readJsonFile(path.join(root, "01_product_reader", "product_understanding.json"), null);
  const zipPath = path.join(root, "07_export", "final_package.zip");
  const finalImagesRoot = path.join(root, "07_export", "final_images");
  const finalImages = await fs.readdir(finalImagesRoot).catch(() => []);
  const planPath = path.join(root, "v2_pipeline", "plan_report.json");

  return {
    projectId,
    sku: projectId,
    category: parseProductFields(await fs.readFile(path.join(root, "input", "product.txt"), "utf8").catch(() => "")).category,
    name: product?.product_name ?? projectId,
    status: log?.status ?? "INPUT_READY",
    productStatus: product?.status ?? "",
    createdAt: log?.created_at ?? "",
    finishedAt: log?.finished_at ?? "",
    stages: log?.stages ?? [],
    exportStatus: exportSummary?.status ?? "",
    imageCount: exportSummary?.summary?.total_images ?? finalImages.length,
    inputImageCount: (await listInputImages(projectId)).length,
    generatedImages: await listGeneratedImages(projectId),
    hasPackage: await fileExists(zipPath),
    hasPlan: await fileExists(planPath)
  };
}

async function listProjects() {
  await fs.mkdir(productsRoot, { recursive: true });
  const entries = await fs.readdir(productsRoot, { withFileTypes: true });
  const projects = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => summarizeProject(entry.name))
  );
  return projects.sort((a, b) => (b.createdAt || b.projectId).localeCompare(a.createdAt || a.projectId));
}

async function runWithRequestedAiMode(mock, task) {
  const previousMock = process.env.OPENAI_MOCK;
  process.env.OPENAI_MOCK = mock ? "true" : "false";
  try {
    return await task();
  } finally {
    if (previousMock === undefined) {
      delete process.env.OPENAI_MOCK;
    } else {
      process.env.OPENAI_MOCK = previousMock;
    }
  }
}

function addJobEvent(job, message, level = "info") {
  job.events.push({
    timestamp: new Date().toISOString(),
    level,
    message
  });
}

// Builds an onProgress sink that records live pipeline sub-steps onto job.steps
// so the UI can render a checklist that advances as work happens.
function createJobProgress(job) {
  job.steps = job.steps ?? [];
  return ({ key, label }) => {
    const current = job.steps[job.steps.length - 1];
    // Same key as the running step → live-update its label (e.g. "Đã tạo 3/15 ảnh")
    // instead of adding a new step. Keeps one checklist row that ticks up.
    if (current && current.key === (key ?? label) && current.status === "running") {
      current.label = label ?? current.label;
      addJobEvent(job, label ?? key);
      return;
    }
    for (const step of job.steps) {
      if (step.status === "running") {
        step.status = "done";
        step.finishedAt = new Date().toISOString();
      }
    }
    job.steps.push({
      key: key ?? label,
      label: label ?? key,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: ""
    });
    addJobEvent(job, label ?? key);
  };
}

function finalizeJobSteps(job, outcome) {
  for (const step of job.steps ?? []) {
    if (step.status === "running") {
      step.status = outcome === "fail" ? "fail" : "done";
      step.finishedAt = new Date().toISOString();
    }
  }
}

function parseRequestedImageCount(value) {
  const match = String(value ?? "").match(/(\d+)/);
  if (!match) {
    return 0;
  }
  return Number.parseInt(match[1], 10) || 0;
}

function parseBooleanField(value, defaultValue = false) {
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

async function resolveWorkflowRunOptions(projectId) {
  const input = await readProjectInput(projectId).catch(() => ({ productFields: {} }));
  const requestedImageCount = parseRequestedImageCount(input?.productFields?.targetImageCount);
  const includeCta = parseBooleanField(input?.productFields?.needsCta, false);
  return {
    requestedImageCount,
    includeCta,
    totalRequestedImages: requestedImageCount + (includeCta ? 1 : 0),
    full15: requestedImageCount >= 15
  };
}

async function runProjectJob(projectId, mock, { mode = "full", regenerateImageIds = [] } = {}) {
  const workflowOptions = await resolveWorkflowRunOptions(projectId);
  const planOnly = mode === "plan";
  const fromPlan = mode === "generate";
  const jobType = mode === "plan" ? "PLAN" : mode === "generate" ? "GENERATE" : "RUN";
  const jobId = `${projectId}-${mode}-${Date.now()}`;
  const job = {
    jobId,
    projectId,
    status: "RUNNING",
    type: jobType,
    mode: mock ? "MOCK" : "AI",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    error: "",
    events: [],
    steps: []
  };
  const intro = planOnly
    ? `Đã nhận lệnh tạo kế hoạch cho SKU ${projectId}.`
    : fromPlan
      ? `Đã nhận lệnh tạo ảnh từ kế hoạch cho SKU ${projectId}.`
      : `Đã nhận lệnh chạy workflow cho SKU ${projectId}.`;
  addJobEvent(job, intro);
  addJobEvent(job, `Chế độ chạy: ${mock ? "Mock test" : "AI thật"}.`);
  addJobEvent(
    job,
    `So anh noi dung yeu cau: ${workflowOptions.requestedImageCount || 0}. CTA: ${workflowOptions.includeCta ? "BAT" : "TAT"}. Tong anh muc tieu: ${workflowOptions.totalRequestedImages}.`
  );
  jobs.set(jobId, job);

  const onProgress = createJobProgress(job);

  (async () => {
    onProgress({
      key: "startup",
      label: planOnly ? "Khởi động (lập kế hoạch)" : "Khởi động Creative Pipeline V2"
    });
    await runWithRequestedAiMode(mock, () => runWorkflowV2({
      workspace: workspaceRoot,
      project: projectId,
      mock,
      full15: workflowOptions.full15,
      requestedImageCount: workflowOptions.requestedImageCount,
      includeCta: workflowOptions.includeCta,
      planOnly,
      fromPlan,
      regenerateImageIds,
      onProgress
    }));
    // Plan phase produces no images, so there is nothing to sync to the catalog.
    if (!planOnly) {
      onProgress({ key: "catalog-sync", label: "Đồng bộ vào kho catalog" });
      await syncCatalogFromProject(projectId);
    }
    finalizeJobSteps(job, "done");
    job.status = "COMPLETED";
    job.finishedAt = new Date().toISOString();
    addJobEvent(job, planOnly ? "Đã tạo xong kế hoạch." : "Workflow hoan tat.");
  })().catch((error) => {
    finalizeJobSteps(job, "fail");
    job.status = "FAILED";
    job.finishedAt = new Date().toISOString();
    job.error = error?.message ?? "Workflow failed.";
    addJobEvent(job, job.error, "error");
  });

  return job;
}

// Reads the persisted plan (if any) and returns a trimmed view for the preview UI.
function planReportFilePath(projectId) {
  return path.join(projectRoot(projectId), "v2_pipeline", "plan_report.json");
}

function buildPlanImages(report) {
  const cardById = new Map((report.layout_plan?.cards ?? []).map((card) => [card.image_id, card]));
  return (report.prompt_writer?.prompts ?? []).map((prompt) => {
    const card = cardById.get(prompt.image_id) ?? prompt.source_layout_card ?? {};
    return {
      imageId: prompt.image_id,
      role: card.role ?? prompt.role ?? "",
      section: card.section ?? "",
      mainText: card.headline ?? prompt.source_layout_card?.headline ?? "",
      subText: card.caption ?? card.concept_goal ?? "",
      concept: card.concept_goal ?? "",
      composition: card.unique_composition ?? "",
      camera: card.unique_camera ?? "",
      background: card.unique_background ?? "",
      lighting: card.unique_lighting ?? "",
      focal: card.unique_focal_point ?? "",
      promptText: prompt.prompt_text ?? ""
    };
  });
}

async function readProjectPlan(projectId) {
  const report = await readJsonFile(planReportFilePath(projectId), null);
  if (!report) {
    return null;
  }
  return {
    status: report.status ?? "PLAN_READY",
    createdAt: report.created_at ?? "",
    editedAt: report.edited_at ?? "",
    referenceImage: report.reference_image ?? "",
    sectionSummary: report.section_summary ?? null,
    productDna: report.product_dna ?? null,
    conceptReview: report.concept_review ?? null,
    promptReview: report.prompt_review
      ? {
          status: report.prompt_review.status ?? "",
          rewrittenCount: report.prompt_review.rewritten_count ?? 0,
          issues: Array.isArray(report.prompt_review.issues) ? report.prompt_review.issues : []
        }
      : null,
    layoutCards: report.layout_plan?.cards ?? [],
    images: buildPlanImages(report)
  };
}

// Apply user edits (main text / sub text / prompt) back into the plan so the next
// "Tạo ảnh" uses exactly what the user reviewed. The on-image text is enforced via
// a USER TEXT OVERRIDE block appended to the prompt.
async function updateProjectPlan(projectId, edits = []) {
  const planPath = planReportFilePath(projectId);
  const report = await readJsonFile(planPath, null);
  if (!report) {
    throw Object.assign(new Error("Chưa có bản kế hoạch để chỉnh sửa."), { code: "PLAN_NOT_FOUND" });
  }
  const editById = new Map(edits
    .filter((edit) => Number.isInteger(Number(edit.imageId)))
    .map((edit) => [Number(edit.imageId), edit]));
  const cardById = new Map((report.layout_plan?.cards ?? []).map((card) => [card.image_id, card]));

  for (const prompt of report.prompt_writer?.prompts ?? []) {
    const edit = editById.get(prompt.image_id);
    if (!edit) {
      continue;
    }
    const card = cardById.get(prompt.image_id);
    const main = typeof edit.mainText === "string" ? edit.mainText.trim() : (card?.headline ?? "");
    const sub = typeof edit.subText === "string" ? edit.subText.trim() : (card?.caption ?? "");
    if (card) {
      if (typeof edit.mainText === "string") card.headline = main;
      if (typeof edit.subText === "string") card.caption = sub;
    }
    if (prompt.source_layout_card) {
      if (typeof edit.mainText === "string") prompt.source_layout_card.headline = main;
      if (typeof edit.subText === "string") prompt.source_layout_card.caption = sub;
    }
    let base = typeof edit.promptText === "string" && edit.promptText.trim() ? edit.promptText : prompt.prompt_text;
    base = String(base).replace(/\nUSER TEXT OVERRIDE:[\s\S]*$/i, "").trimEnd();
    const overrideLines = ["USER TEXT OVERRIDE:"];
    if (main) overrideLines.push(`The main on-image headline must read exactly: "${main}".`);
    if (sub) overrideLines.push(`The secondary caption must read exactly: "${sub}".`);
    prompt.prompt_text = overrideLines.length > 1 ? `${base}\n${overrideLines.join("\n")}` : base;
  }
  report.edited_at = new Date().toISOString();
  await fs.writeFile(planPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return readProjectPlan(projectId);
}

// Inject the user's feedback into the selected images' prompts so the regenerate
// actually follows the feedback (fixes the old "feedback ignored on repair" gap).
async function applyFeedbackToPlanPrompts(projectId, imageIds = [], feedback = "") {
  const text = String(feedback ?? "").trim();
  if (!text) {
    return;
  }
  const planPath = planReportFilePath(projectId);
  const report = await readJsonFile(planPath, null);
  if (!report) {
    return;
  }
  const ids = new Set(imageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)));
  for (const prompt of report.prompt_writer?.prompts ?? []) {
    if (!ids.has(prompt.image_id)) {
      continue;
    }
    let base = String(prompt.prompt_text ?? "").replace(/\nUSER FEEDBACK[\s\S]*$/i, "").trimEnd();
    prompt.prompt_text = `${base}\nUSER FEEDBACK (fix exactly this, keep everything else): ${text}`;
  }
  report.edited_at = new Date().toISOString();
  await fs.writeFile(planPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function runRepairJob({ projectId, imageIds, feedback, mock }) {
  const jobId = `${projectId}-repair-${Date.now()}`;
  const job = {
    jobId,
    projectId,
    status: "RUNNING",
    type: "REPAIR",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    error: "",
    imageIds,
    mode: mock ? "MOCK" : "AI",
    events: [],
    steps: []
  };
  addJobEvent(job, `Đã nhận lệnh sửa ảnh ${imageIds.join(", ")} cho SKU ${projectId}.`);
  addJobEvent(job, `Chế độ sửa ảnh: ${mock ? "Mock test" : "AI thật"}.`);
  jobs.set(jobId, job);

  const onProgress = createJobProgress(job);

  (async () => {
    onProgress({ key: "feedback", label: "Lưu & chắt lọc feedback" });
    const feedbackResult = await appendFeedbackKnowledge({ projectId, imageIds, feedback, rating: "needs_fix" });
    addJobEvent(job, `Đã chắt lọc feedback: ${feedbackResult.learning?.summary ?? "saved"}.`);
    for (const imageId of imageIds) {
      onProgress({ key: `regen-${imageId}`, label: `Tạo lại ảnh ${imageId}` });
      await runWithRequestedAiMode(mock, () => runImageGenerator({ workspace: workspaceRoot, project: projectId, mock, image: imageId }));
    }
    onProgress({ key: "catalog-sync", label: "Đồng bộ lại catalog" });
    await syncCatalogFromProject(projectId);
  })()
    .then(() => {
      finalizeJobSteps(job, "done");
      job.status = "COMPLETED";
      job.finishedAt = new Date().toISOString();
      addJobEvent(job, "Sửa ảnh hoàn tất.");
    })
    .catch((error) => {
      finalizeJobSteps(job, "fail");
      job.status = "FAILED";
      job.finishedAt = new Date().toISOString();
      job.error = error?.message ?? "Repair failed.";
      addJobEvent(job, job.error, "error");
    });

  return job;
}

async function serveStatic(request, response, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const targetPath = path.resolve(frontendRoot, `.${decodeURIComponent(requestedPath)}`);
  if (!targetPath.startsWith(frontendRoot)) {
    sendError(response, 403, "Forbidden.", "FORBIDDEN");
    return;
  }

  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile()) {
      sendError(response, 404, "Not found.", "NOT_FOUND");
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(targetPath).toLowerCase()) ?? "application/octet-stream"
    });
    createReadStream(targetPath).pipe(response);
  } catch {
    sendError(response, 404, "Not found.", "NOT_FOUND");
  }
}

async function servePackage(response, projectId) {
  const zipPath = path.join(projectRoot(projectId), "07_export", "final_package.zip");
  if (!await fileExists(zipPath)) {
    sendError(response, 404, "Export package is not ready.", "PACKAGE_NOT_READY");
    return;
  }
  response.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${sanitizeProjectId(projectId)}_sellifyx_export.zip"`
  });
  createReadStream(zipPath).pipe(response);
}

async function routeApi(request, response, url) {
  if (!isAuthorized(request)) {
    sendError(response, 401, "Missing or invalid internal access key.", "UNAUTHORIZED");
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, workspace: workspaceRoot });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, { projects: await listProjects() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    const payload = await readRequestJson(request);
    const { sku: projectId, productFields } = normalizeProjectPayload(payload);
    if (!Array.isArray(payload.images) || payload.images.length === 0) {
      sendError(response, 400, "At least one product image is required.", "MISSING_IMAGES");
      return;
    }
    await writeProjectInput({
      projectId,
      productText: payload.productText,
      productFields,
      images: payload.images
    });
    const job = payload.runNow ? await runProjectJob(projectId, Boolean(payload.mock)) : null;
    sendJson(response, 201, { project: await summarizeProject(projectId), input: await readProjectInput(projectId), job });
    return;
  }

  const generatedImageMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generated\/images\/(.+)$/);
  if (generatedImageMatch) {
    const projectId = sanitizeProjectId(generatedImageMatch[1]);
    const filename = path.basename(decodeURIComponent(generatedImageMatch[2]));
    const imagesRoot = path.join(projectRoot(projectId), "04_images");
    const targetPath = path.resolve(imagesRoot, filename);
    if (!targetPath.startsWith(imagesRoot)) {
      sendError(response, 403, "Forbidden.", "FORBIDDEN");
      return;
    }
    if (request.method === "GET") {
      if (!await fileExists(targetPath)) {
        sendError(response, 404, "Generated image not found.", "GENERATED_IMAGE_NOT_FOUND");
        return;
      }
      response.writeHead(200, {
        "content-type": contentTypes.get(path.extname(targetPath).toLowerCase()) ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      createReadStream(targetPath).pipe(response);
      return;
    }
  }

  const inputImageMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/input\/images\/(.+)$/);
  if (inputImageMatch) {
    const projectId = sanitizeProjectId(inputImageMatch[1]);
    const filename = path.basename(decodeURIComponent(inputImageMatch[2]));
    const imagesRoot = path.join(projectRoot(projectId), "input", "images");
    const targetPath = path.resolve(imagesRoot, filename);
    if (!targetPath.startsWith(imagesRoot)) {
      sendError(response, 403, "Forbidden.", "FORBIDDEN");
      return;
    }
    if (request.method === "GET") {
      if (!await fileExists(targetPath)) {
        sendError(response, 404, "Image not found.", "IMAGE_NOT_FOUND");
        return;
      }
      response.writeHead(200, {
        "content-type": contentTypes.get(path.extname(targetPath).toLowerCase()) ?? "application/octet-stream",
        "cache-control": "no-store"
      });
      createReadStream(targetPath).pipe(response);
      return;
    }
    if (request.method === "DELETE") {
      if (!await fileExists(targetPath)) {
        sendError(response, 404, "Image not found.", "IMAGE_NOT_FOUND");
        return;
      }
      await fs.unlink(targetPath);
      sendJson(response, 200, { input: await readProjectInput(projectId), project: await summarizeProject(projectId) });
      return;
    }
  }

  const inputMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/input$/);
  if (inputMatch) {
    const projectId = sanitizeProjectId(inputMatch[1]);
    if (request.method === "GET") {
      sendJson(response, 200, { input: await readProjectInput(projectId), project: await summarizeProject(projectId) });
      return;
    }
    if (request.method === "PUT") {
      const payload = await readRequestJson(request);
      const existing = await readProjectInput(projectId);
      const productFields = {
        ...existing.productFields,
        ...(payload.productFields ?? {}),
        sku: projectId
      };
      if (!String(productFields.category ?? "").trim()) {
        productFields.category = "uncategorized";
      }
      await writeProjectInput({
        projectId,
        productText: payload.productText,
        productFields,
        images: Array.isArray(payload.images) ? payload.images : []
      });
      const job = payload.runNow ? await runProjectJob(projectId, Boolean(payload.mock)) : null;
      sendJson(response, 200, { input: await readProjectInput(projectId), project: await summarizeProject(projectId), job });
      return;
    }
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(run|plan|generate|regenerate|repair|feedback|knowledge\/import|package))?$/);
  if (projectMatch) {
    const projectId = sanitizeProjectId(projectMatch[1]);
    const action = projectMatch[2] ?? "";
    if (request.method === "GET" && !action) {
      sendJson(response, 200, { project: await summarizeProject(projectId) });
      return;
    }
    if (request.method === "POST" && action === "run") {
      const payload = await readRequestJson(request);
      sendJson(response, 202, { job: await runProjectJob(projectId, Boolean(payload.mock)) });
      return;
    }
    if (request.method === "POST" && action === "plan") {
      const payload = await readRequestJson(request);
      sendJson(response, 202, { job: await runProjectJob(projectId, Boolean(payload.mock), { mode: "plan" }) });
      return;
    }
    if (request.method === "GET" && action === "plan") {
      const plan = await readProjectPlan(projectId);
      if (!plan) {
        sendError(response, 404, "Chưa có bản kế hoạch cho SKU này.", "PLAN_NOT_FOUND");
        return;
      }
      sendJson(response, 200, { plan });
      return;
    }
    if (request.method === "PUT" && action === "plan") {
      const payload = await readRequestJson(request);
      const edits = Array.isArray(payload.edits) ? payload.edits : [];
      try {
        const plan = await updateProjectPlan(projectId, edits);
        sendJson(response, 200, { plan });
      } catch (error) {
        sendError(response, error.code === "PLAN_NOT_FOUND" ? 404 : 400, error.message, error.code ?? "PLAN_UPDATE_FAILED");
      }
      return;
    }
    if (request.method === "POST" && action === "generate") {
      const payload = await readRequestJson(request);
      const plan = await readProjectPlan(projectId);
      if (!plan) {
        sendError(response, 409, "Chưa có bản kế hoạch. Hãy tạo kế hoạch trước khi tạo ảnh.", "PLAN_NOT_FOUND");
        return;
      }
      sendJson(response, 202, { job: await runProjectJob(projectId, Boolean(payload.mock), { mode: "generate" }) });
      return;
    }
    if (request.method === "POST" && action === "regenerate") {
      const payload = await readRequestJson(request);
      const imageIds = Array.isArray(payload.imageIds)
        ? payload.imageIds.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isInteger(id) && id > 0)
        : [];
      if (imageIds.length === 0) {
        sendError(response, 400, "Hãy chọn ít nhất một ảnh để tạo lại.", "MISSING_REGENERATE_IMAGES");
        return;
      }
      const plan = await readProjectPlan(projectId);
      if (!plan) {
        sendError(response, 409, "Chưa có bản kế hoạch để tạo lại ảnh.", "PLAN_NOT_FOUND");
        return;
      }
      // Inject the feedback into just those prompts, then partially regenerate them.
      await applyFeedbackToPlanPrompts(projectId, imageIds, payload.feedback);
      sendJson(response, 202, { job: await runProjectJob(projectId, Boolean(payload.mock), { mode: "generate", regenerateImageIds: imageIds }) });
      return;
    }
    if (request.method === "POST" && action === "repair") {
      const payload = await readRequestJson(request);
      const imageIds = Array.isArray(payload.imageIds)
        ? payload.imageIds.map((imageId) => Number.parseInt(imageId, 10)).filter((imageId) => Number.isInteger(imageId) && imageId > 0)
        : [];
      if (imageIds.length === 0) {
        sendError(response, 400, "Select at least one image to repair.", "MISSING_REPAIR_IMAGES");
        return;
      }
      const job = runRepairJob({
        projectId,
        imageIds,
        feedback: payload.feedback,
        mock: Boolean(payload.mock)
      });
      sendJson(response, 202, { job });
      return;
    }
    if (request.method === "POST" && action === "feedback") {
      const payload = await readRequestJson(request);
      const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
      const feedbackResult = await appendFeedbackKnowledge({
        projectId,
        imageIds,
        feedback: payload.feedback,
        rating: payload.rating ?? "liked"
      });
      await syncCatalogFromProject(projectId);
      sendJson(response, 200, { ...feedbackResult, project: await summarizeProject(projectId) });
      return;
    }
    if (request.method === "POST" && action === "knowledge/import") {
      const payload = await readRequestJson(request);
      const result = await importMarkdownExperience({
        projectId,
        files: Array.isArray(payload.files) ? payload.files : [],
        scope: payload.scope ?? "sku"
      });
      sendJson(response, 200, { ...result, project: await summarizeProject(projectId) });
      return;
    }
    if (request.method === "GET" && action === "package") {
      await servePackage(response, projectId);
      return;
    }
  }

  // List jobs so a reloaded browser can reconnect to work still running on the server.
  if (request.method === "GET" && url.pathname === "/api/jobs") {
    const onlyRunning = url.searchParams.get("status") === "running";
    const list = Array.from(jobs.values())
      .filter((job) => (onlyRunning ? job.status === "RUNNING" : true))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((job) => ({
        jobId: job.jobId,
        projectId: job.projectId,
        type: job.type ?? "RUN",
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
      }));
    sendJson(response, 200, { jobs: list });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      sendError(response, 404, "Job not found.", "JOB_NOT_FOUND");
      return;
    }
    sendJson(response, 200, { job, project: await summarizeProject(job.projectId) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/knowledge/import") {
    const payload = await readRequestJson(request);
    const result = await importExternalKnowledge({
      category: payload.category,
      sku: payload.sku,
      files: Array.isArray(payload.files) ? payload.files : [],
      scope: payload.scope ?? "category",
      sourceLabel: payload.sourceLabel ?? ""
    });
    sendJson(response, 200, result);
    return;
  }

  sendError(response, 404, "API route not found.", "NOT_FOUND");
}

const server = http.createServer((request, response) => {
  const url = parseRequestUrl(request);
  if (!url.pathname.startsWith("/api/")) {
    serveStatic(request, response, url);
    return;
  }
  routeApi(request, response, url)
    .catch((error) => {
      const statusCode = statusCodeForError(error);
      sendError(response, statusCode, error?.message ?? "Server error.", error?.code ?? "SERVER_ERROR");
    });
});

server.listen(port, () => {
  console.log(`SellifyX web is running at http://localhost:${port}`);
  // Print LAN URLs so teammates on the same network can open the app directly.
  const lanUrls = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => `http://${iface.address}:${port}`);
  if (lanUrls.length > 0) {
    console.log(`Cho người khác cùng mạng truy cập tại: ${lanUrls.join("  |  ")}`);
  }
});
