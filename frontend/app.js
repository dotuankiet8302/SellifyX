const projectForm = document.querySelector("#projectForm");
const projectList = document.querySelector("#projectList");
const projectCount = document.querySelector("#projectCount");
const statusBox = document.querySelector("#statusBox");
const refreshButton = document.querySelector("#refreshButton");
const fileInput = document.querySelector("#images");
const fileSummary = document.querySelector("#fileSummary");
const newProjectButton = document.querySelector("#newProjectButton");
const saveOnlyButton = document.querySelector("#saveOnlyButton");
const existingImages = document.querySelector("#existingImages");
const pendingImages = document.querySelector("#pendingImages");
const imageCount = document.querySelector("#imageCount");
const generatedImages = document.querySelector("#generatedImages");
const repairFeedback = document.querySelector("#repairFeedback");
const repairButton = document.querySelector("#repairButton");
const saveFeedbackButton = document.querySelector("#saveFeedbackButton");
const feedbackRating = document.querySelector("#feedbackRating");
const generationMode = document.querySelector("#generationMode");
const chatLog = document.querySelector("#chatLog");
const progressLog = document.querySelector("#progressLog");
const activityOverlay = document.querySelector("#activityOverlay");
const activityModal = document.querySelector(".activity-modal");
const activityTitle = document.querySelector("#activityTitle");
const activitySubtitle = document.querySelector("#activitySubtitle");
const activityBadge = document.querySelector("#activityBadge");
const activitySteps = document.querySelector("#activitySteps");
const activityEvents = document.querySelector("#activityEvents");
const activityCloseButton = document.querySelector("#activityCloseButton");
const activityBackgroundButton = document.querySelector("#activityBackgroundButton");
const planOverlay = document.querySelector("#planOverlay");
const planTitle = document.querySelector("#planTitle");
const planSubtitle = document.querySelector("#planSubtitle");
const planBody = document.querySelector("#planBody");
const planCloseButton = document.querySelector("#planCloseButton");
const planSaveButton = document.querySelector("#planSaveButton");
const planGenerateButton = document.querySelector("#planGenerateButton");
const viewPlanButton = document.querySelector("#viewPlanButton");
const resultsOverlay = document.querySelector("#resultsOverlay");
const resultsBody = document.querySelector("#resultsBody");
const resultsCount = document.querySelector("#resultsCount");
const resultsFeedback = document.querySelector("#resultsFeedback");
const resultsCloseButton = document.querySelector("#resultsCloseButton");
const resultsRegenButton = document.querySelector("#resultsRegenButton");

// Expected steps of a full workflow run, in order. Used so the checklist can
// show upcoming steps as "pending" before the backend reaches them.
const RUN_STEP_PLAN = [
  { key: "startup", label: "Khởi động Creative Pipeline V2" },
  { key: "classify", label: "Phân loại ảnh tham chiếu" },
  { key: "dna", label: "Trích xuất Product DNA" },
  { key: "knowledge", label: "Nạp kiến thức thiết kế chung" },
  { key: "strategy", label: "Phân tích chiến lược thị trường (Philippines)" },
  { key: "layout", label: "Sinh concept sáng tạo" },
  { key: "concept-review", label: "Review độ đa dạng concept" },
  { key: "prompt", label: "Viết prompt cho từng ảnh" },
  { key: "review", label: "Review & tinh chỉnh prompt" },
  { key: "generate", label: "Tạo ảnh" },
  { key: "vision", label: "Kiểm tra hệ thống (text)" },
  { key: "export-images", label: "Xuất ảnh cuối" },
  { key: "workspace-sync", label: "Đồng bộ ảnh vào workspace" },
  { key: "qc", label: "QC Engine kiểm định" },
  { key: "retry-plan", label: "Lập kế hoạch retry" },
  { key: "export", label: "Đóng gói bản xuất" },
  { key: "catalog-sync", label: "Đồng bộ vào kho catalog" }
];

let activeJobId = "";
let pollTimer = null;
let editingSku = "";
let currentInputImages = [];
let currentGeneratedImages = [];
let pendingImageFiles = [];

function safeText(value) {
  return String(value ?? "").trim();
}

function describeRequest(method, path) {
  return `${String(method ?? "GET").toUpperCase()} ${path}`;
}

function summarizeStageFailure(project = {}) {
  const failedStages = Array.isArray(project.stages)
    ? project.stages.filter((stage) => stage.status === "FAIL")
    : [];
  if (failedStages.length === 0) {
    return "";
  }
  return failedStages
    .map((stage) => `${stage.stage}${stage.error ? ` - ${stage.error}` : ""}`)
    .join(" | ");
}

function summarizeJobFailure(job = {}, project = {}) {
  const parts = [];
  if (job.error) {
    parts.push(job.error);
  }
  const stageSummary = summarizeStageFailure(project);
  if (stageSummary) {
    parts.push(`Stage fail: ${stageSummary}`);
  }
  return parts.join(" || ") || "Job failed but no detailed reason was returned.";
}

function setStatus(message) {
  statusBox.textContent = message;
}

function setProgress(lines) {
  progressLog.innerHTML = lines.length === 0
    ? "Chưa có job nào đang chạy."
    : lines.map((line) => `<div class="${line.level ?? ""}">${line.text}</div>`).join("");
}

function explainError(error) {
  const message = safeText(error?.message) || "Request failed.";
  if (/category|danh mục/i.test(message)) {
    return "Không chạy được vì thiếu Danh mục. Danh mục là bắt buộc để lưu vào kho sản phẩm và kho kiến thức.";
  }
  if (/sku|project id/i.test(message)) {
    return "Không chạy được vì thiếu SKU hoặc SKU không hợp lệ. SKU chỉ nên dùng chữ, số, dấu gạch ngang hoặc gạch dưới.";
  }
  if (/image|ảnh/i.test(message)) {
    return "Không chạy được vì chưa có ảnh sản phẩm. Hãy thêm ít nhất một ảnh tham chiếu.";
  }
  if (/failed to fetch|networkerror|network request failed|khong goi duoc/i.test(message)) {
    return "Khong goi duoc API tu trinh duyet nay. Hay kiem tra lai link truy cap, ket noi LAN hoac firewall.";
  }
  return message;
}

function addMessage(role, message) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `<strong>${role === "user" ? "Bạn" : "SellifyX"}</strong><p>${message}</p>`;
  chatLog.append(article);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function badgeClass(status) {
  if (status === "COMPLETED" || status === "EXPORTED" || status === "CREATED") {
    return "ok";
  }
  if (status === "FAILED" || status === "BLOCKED") {
    return "fail";
  }
  if (status === "RUNNING") {
    return "run";
  }
  return "";
}

async function api(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {})
      }
    });
  } catch (error) {
    throw new Error(`${describeRequest(method, path)} khong goi duoc. ${safeText(error?.message) || "Failed to fetch."}`);
  }

  const contentType = safeText(response.headers.get("content-type")).toLowerCase();
  let data = {};
  try {
    if (contentType.includes("application/json")) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = text ? { rawText: text } : {};
    }
  } catch (error) {
    throw new Error(`${describeRequest(method, path)} tra ve phan hoi khong hop le. ${safeText(error?.message) || "Invalid response body."}`);
  }

  if (!response.ok) {
    throw new Error(
      `${describeRequest(method, path)} that bai (${response.status}). ${safeText(data?.error?.message) || safeText(data?.rawText) || "Request failed."}`
    );
  }
  return data;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function collectFiles(files) {
  return Promise.all(files.map(async (file) => ({
    name: file.name,
    dataUrl: await readFileAsDataUrl(file)
  })));
}

function productFieldElements() {
  return Array.from(document.querySelectorAll("[data-product-field]"));
}

function fieldValue(input) {
  if (input.type === "checkbox") {
    return input.checked ? input.value : "NO";
  }
  return input.value.trim();
}

function setFieldValue(input, value) {
  if (input.type === "checkbox") {
    input.checked = String(value ?? "").toUpperCase() === "YES";
  } else {
    input.value = value ?? "";
  }
}

function collectProductFields() {
  return Object.fromEntries(productFieldElements().map((input) => [input.dataset.productField, fieldValue(input)]));
}

function fillProductFields(productFields = {}) {
  for (const input of productFieldElements()) {
    setFieldValue(input, productFields[input.dataset.productField]);
  }
}

function clearForm() {
  editingSku = "";
  currentInputImages = [];
  currentGeneratedImages = [];
  pendingImageFiles = [];
  projectForm.reset();
  repairFeedback.value = "";
  viewPlanButton.hidden = true;
  for (const input of productFieldElements()) {
    input.disabled = false;
  }
  renderImages();
  renderGeneratedImages();
  setStatus("Đang ở chế độ tạo SKU mới.");
}

function renderImages() {
  imageCount.textContent = `${currentInputImages.length + pendingImageFiles.length} ảnh`;
  fileSummary.textContent = pendingImageFiles.length > 0
    ? `${pendingImageFiles.length} ảnh mới đang chờ lưu`
    : "Chưa có ảnh mới";

  existingImages.innerHTML = currentInputImages.length === 0
    ? "<p class=\"muted compact\">Chưa có ảnh đã lưu.</p>"
    : currentInputImages.map((image) => `
      <article class="image-item">
        <img src="${image.url}" alt="${image.filename}">
        <div>
          <strong>${image.filename}</strong>
          <small>${Math.round(image.size / 1024)} KB</small>
        </div>
        <button class="danger-button" data-delete-image="${image.filename}" type="button">Xóa</button>
      </article>
    `).join("");

  pendingImages.innerHTML = pendingImageFiles.length === 0
    ? ""
    : pendingImageFiles.map((file, index) => `
      <article class="pending-image">
        <span>${file.name}</span>
        <button class="icon-button small" data-remove-pending="${index}" type="button" title="Bỏ ảnh này" aria-label="Bỏ ảnh này">×</button>
      </article>
    `).join("");
}

function renderGeneratedImages() {
  if (!editingSku) {
    generatedImages.innerHTML = "<p class=\"muted compact\">Chọn một SKU để xem ảnh đã generate.</p>";
    return;
  }
  if (currentGeneratedImages.length === 0) {
    generatedImages.innerHTML = "<p class=\"muted compact\">SKU này chưa có ảnh generate.</p>";
    return;
  }
  generatedImages.innerHTML = currentGeneratedImages.map((image) => `
    <label class="generated-item">
      <input type="checkbox" data-generated-image="${image.imageId ?? ""}" ${image.imageId ? "" : "disabled"}>
      <img src="${image.url}" alt="${image.filename}">
      <span>
        <strong>${image.filename}</strong>
        <small class="badge ${badgeClass(image.status)}">${image.status}</small>
      </span>
    </label>
  `).join("");
}

function selectedGeneratedImageIds() {
  return Array.from(document.querySelectorAll("[data-generated-image]:checked"))
    .map((input) => Number.parseInt(input.dataset.generatedImage, 10))
    .filter((imageId) => Number.isInteger(imageId) && imageId > 0);
}

function useMockMode() {
  return generationMode.value === "mock";
}

function generationModeLabel() {
  return useMockMode() ? "Mock test" : "AI thật";
}

function renderProjects(projects) {
  projectCount.textContent = String(projects.length);
  if (projects.length === 0) {
    projectList.innerHTML = "<p class=\"muted\">Chưa có sản phẩm nào.</p>";
    return;
  }

  projectList.innerHTML = projects.map((project) => {
    const downloadButton = project.hasPackage
      ? `<a class="secondary-button" href="/api/projects/${encodeURIComponent(project.projectId)}/package">Tải ZIP</a>`
      : "";
    return `
      <article class="project-row">
        <div>
          <p class="project-title">${project.sku}</p>
          <div class="project-meta">
            <span>${project.category || "NO_CATEGORY"}</span>
            <span class="badge ${badgeClass(project.status)}">${project.status}</span>
            <span>${project.inputImageCount ?? 0} ảnh input</span>
            <span>${project.generatedImages?.length ?? 0} ảnh generate</span>
          </div>
        </div>
        <div class="row-actions">
          <button class="secondary-button" data-edit="${project.projectId}" type="button">Mở</button>
          <button class="secondary-button" data-run="${project.projectId}" type="button">Chạy</button>
          ${downloadButton}
        </div>
      </article>
    `;
  }).join("");
}

async function loadProjects() {
  const { projects } = await api("/api/projects");
  renderProjects(projects);
}

async function loadProjectInput(projectId, { silent = false } = {}) {
  const { input, project } = await api(`/api/projects/${encodeURIComponent(projectId)}/input`);
  editingSku = input.sku;
  fillProductFields(input.productFields);
  document.querySelector("#sku").disabled = true;
  currentInputImages = input.images;
  currentGeneratedImages = project.generatedImages ?? [];
  pendingImageFiles = [];
  fileInput.value = "";
  repairFeedback.value = "";
  viewPlanButton.hidden = !project.hasPlan;
  renderImages();
  renderGeneratedImages();
  if (!silent) {
    addMessage("assistant", `Đã mở SKU <strong>${input.sku}</strong>. Bạn có thể thêm/xóa ảnh tham chiếu, lưu feedback hoặc chọn ảnh để sửa riêng.`);
  }
  setStatus(`Đã tải dữ liệu SKU ${input.sku}.`);
}

function renderJobProgress(job, project) {
  const lines = [];
  for (const event of job.events ?? []) {
    lines.push({
      level: event.level === "error" ? "fail" : "",
      text: `${new Date(event.timestamp).toLocaleTimeString()} - ${event.message}`
    });
  }
  for (const stage of project.stages ?? []) {
    const effectiveStatus = stage.finished_at ? stage.status : "RUNNING";
    const icon = effectiveStatus === "PASS" ? "✓" : effectiveStatus === "FAIL" ? "✕" : "•";
    lines.push({
      level: effectiveStatus === "FAIL" ? "fail" : effectiveStatus === "PASS" ? "ok" : "",
      text: `${icon} ${stage.stage}: ${effectiveStatus}${stage.error ? ` - ${stage.error}` : ""}`
    });
  }
  if (job.error) {
    lines.push({ level: "fail", text: `Lỗi: ${job.error}` });
  }
  const failedStageSummary = summarizeStageFailure(project);
  if (failedStageSummary) {
    lines.push({ level: "fail", text: `Stage fail: ${failedStageSummary}` });
  }
  setProgress(lines);
}

function computeActivitySteps(job) {
  const reported = new Map((job.steps ?? []).map((step) => [step.key, step]));
  // Only a full one-shot run follows the fixed 15-step plan. Plan/generate/repair
  // jobs have a variable, shorter set of steps, so render them as they happen.
  if (job.type && job.type !== "RUN") {
    return (job.steps ?? []).map((step) => ({ label: step.label, status: step.status }));
  }
  return RUN_STEP_PLAN.map((planStep) => {
    const actual = reported.get(planStep.key);
    return {
      label: actual?.label ?? planStep.label,
      status: actual?.status ?? "pending"
    };
  });
}

function stepIcon(status) {
  if (status === "done") {
    return "✓";
  }
  if (status === "fail") {
    return "✕";
  }
  return "";
}

function openActivity(job, { title, subtitle } = {}) {
  activityTitle.textContent = title ?? "Đang xử lý…";
  activitySubtitle.textContent = subtitle ?? "SellifyX đang chạy pipeline.";
  activityModal.classList.remove("is-done", "is-failed");
  activityBadge.className = "badge run";
  activityBadge.textContent = "RUNNING";
  activityCloseButton.disabled = true;
  activitySteps.innerHTML = "";
  activityEvents.innerHTML = "";
  activityOverlay.hidden = false;
  renderActivity(job, "RUNNING");
}

function closeActivity() {
  activityOverlay.hidden = true;
}

function renderActivity(job, effectiveStatus) {
  if (activityOverlay.hidden) {
    return;
  }
  const steps = computeActivitySteps(job);
  activitySteps.innerHTML = steps
    .map((step) => `
      <div class="activity-step ${step.status}">
        <span class="activity-step-icon">${stepIcon(step.status)}</span>
        <span>${step.label}</span>
      </div>
    `)
    .join("");

  const wasNearBottom = activityEvents.scrollHeight - activityEvents.scrollTop - activityEvents.clientHeight < 40;
  activityEvents.innerHTML = (job.events ?? [])
    .map((event) => {
      const level = event.level === "error" ? "fail" : "";
      const time = new Date(event.timestamp).toLocaleTimeString();
      return `<div class="${level}">${time} — ${event.message}</div>`;
    })
    .join("");
  if (wasNearBottom) {
    activityEvents.scrollTop = activityEvents.scrollHeight;
  }

  const done = effectiveStatus === "COMPLETED";
  const failed = effectiveStatus === "FAILED";
  activityModal.classList.toggle("is-done", done);
  activityModal.classList.toggle("is-failed", failed);
  if (done || failed) {
    activityBadge.className = `badge ${failed ? "fail" : "ok"}`;
    activityBadge.textContent = effectiveStatus;
    activityTitle.textContent = failed ? "Job thất bại" : "Hoàn tất";
    activitySubtitle.textContent = failed
      ? "Xem nhật ký chi tiết bên dưới để biết lý do."
      : "Tất cả các bước đã xong. Bạn có thể đóng cửa sổ này.";
    activityCloseButton.disabled = false;
  }
}

function startJob(job, { title, subtitle } = {}) {
  activeJobId = job.jobId;
  openActivity(job, { title, subtitle });
  clearInterval(pollTimer);
  pollTimer = setInterval(pollJob, 2000);
  return pollJob();
}

activityCloseButton.addEventListener("click", closeActivity);
activityBackgroundButton.addEventListener("click", closeActivity);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function renderPlan(plan) {
  const images = plan.images ?? [];
  const dna = plan.productDna?.identity ?? {};
  const dnaRows = [
    ["Danh mục", dna.category],
    ["Hình khối", dna.shape],
    ["Chất liệu", dna.material],
    ["Màu sắc", dna.color],
    ["Bộ phận", Array.isArray(dna.functional_parts) ? dna.functional_parts.join(", ") : dna.functional_parts]
  ].filter(([, value]) => value);
  const dnaBlock = dnaRows.length === 0 ? "" : `
    <section class="plan-dna">
      <h3>Product DNA — AI nhận diện sản phẩm</h3>
      <dl class="plan-dna-grid">
        ${dnaRows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
    </section>`;

  const cr = plan.conceptReview;
  const pr = plan.promptReview;
  const reviewBlock = (!cr && !pr) ? "" : `
    <section class="plan-review">
      <h3>Đánh giá của AI</h3>
      ${cr ? `
        <div class="review-row">
          <span class="review-badge ${cr.status === "REWRITTEN" ? "warn" : "ok"}">Concept review · ${escapeHtml(cr.status ?? "—")}</span>
          ${cr.diversity_score != null ? `<span class="review-score">Độ đa dạng: ${cr.diversity_score}</span>` : ""}
        </div>
        ${(cr.issues && cr.issues.length) ? `<ul class="review-issues">${cr.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : `<p class="muted compact">Không phát hiện concept trùng.</p>`}
      ` : ""}
      ${pr ? `
        <div class="review-row">
          <span class="review-badge ${pr.status === "PASS" ? "ok" : "warn"}">Prompt review · ${escapeHtml(pr.status ?? "—")}</span>
          ${pr.rewrittenCount ? `<span class="review-score">Đã viết lại: ${pr.rewrittenCount} prompt</span>` : ""}
        </div>
      ` : ""}
    </section>`;

  // 1) Overview of the whole set, first to last.
  const overview = `
    <section class="plan-overview">
      <h3>Layout tổng — ${images.length} ảnh</h3>
      <ol class="plan-overview-list">
        ${images.map((im) => `
          <li><button type="button" class="ov-item" data-goto="${im.imageId}">
            <span class="ov-num">#${im.imageId}</span>
            <span class="ov-role">${escapeHtml(im.role)}</span>
            <span class="ov-main">${escapeHtml(im.mainText || "(chưa có text chính)")}</span>
          </button></li>`).join("")}
      </ol>
    </section>`;

  // 2) Editable detail per image: main text, sub text, prompt (+ layout reference).
  const details = images.map((im) => {
    const refRows = [
      ["Concept", im.concept],
      ["Bố cục", im.composition],
      ["Góc máy", im.camera],
      ["Nền", im.background],
      ["Ánh sáng", im.lighting],
      ["Điểm nhấn", im.focal]
    ].filter(([, value]) => value);
    return `
      <article class="plan-edit" id="plan-img-${im.imageId}" data-image-id="${im.imageId}">
        <div class="plan-edit-head"><span class="badge">#${im.imageId} · ${escapeHtml(im.role)}</span></div>
        <label class="edit-field"><span>Text chính (hiển thị trên ảnh)</span>
          <input class="edit-main" type="text" value="${escapeAttr(im.mainText)}" placeholder="VD: Keeps Drinks Cold Longer"></label>
        <label class="edit-field"><span>Text phụ</span>
          <input class="edit-sub" type="text" value="${escapeAttr(im.subText)}" placeholder="Câu benefit ngắn"></label>
        ${refRows.length ? `<details class="plan-ref"><summary>Chi tiết layout (tham khảo)</summary>
          <dl class="plan-card-grid">${refRows.map(([l, v]) => `<div><dt>${l}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl></details>` : ""}
        <label class="edit-field"><span>Prompt đầy đủ</span>
          <textarea class="edit-prompt" rows="6" spellcheck="false">${escapeHtml(im.promptText)}</textarea></label>
      </article>`;
  }).join("");

  planBody.innerHTML = `
    ${dnaBlock}
    ${reviewBlock}
    ${overview}
    <p class="plan-count">Sửa trực tiếp <b>text chính / text phụ / prompt</b> của từng ảnh bên dưới. Nếu 2 concept trùng, sửa 1 cái cho khác đi. Xong bấm <b>Lưu chỉnh sửa</b> rồi <b>Tạo ảnh</b>.</p>
    <div class="plan-details">${details}</div>`;
}

function collectPlanEdits() {
  return Array.from(planBody.querySelectorAll(".plan-edit")).map((el) => ({
    imageId: Number(el.dataset.imageId),
    mainText: el.querySelector(".edit-main")?.value ?? "",
    subText: el.querySelector(".edit-sub")?.value ?? "",
    promptText: el.querySelector(".edit-prompt")?.value ?? ""
  }));
}

async function savePlanEdits(sku) {
  const { plan } = await api(`/api/projects/${encodeURIComponent(sku)}/plan`, {
    method: "PUT",
    body: JSON.stringify({ edits: collectPlanEdits() })
  });
  return plan;
}

async function openPlanPreview(sku, { subtitle } = {}) {
  try {
    const { plan } = await api(`/api/projects/${encodeURIComponent(sku)}/plan`);
    planTitle.textContent = `Kế hoạch: ${sku}`;
    planSubtitle.textContent = subtitle ?? "Xem lại & chỉnh sửa layout / prompt trước khi tạo ảnh.";
    planGenerateButton.textContent = `Tạo ảnh (${plan.images?.length ?? 0})`;
    planGenerateButton.dataset.sku = sku;
    planSaveButton.dataset.sku = sku;
    renderPlan(plan);
    planBody.scrollTop = 0;
    planOverlay.hidden = false;
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    addMessage("assistant", message);
  }
}

function closePlanPreview() {
  planOverlay.hidden = true;
}

// Overview → jump to a specific image's editable detail.
planBody.addEventListener("click", (event) => {
  const goto = event.target.closest("[data-goto]");
  if (!goto) {
    return;
  }
  const target = document.getElementById(`plan-img-${goto.dataset.goto}`);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
  }
});

planSaveButton.addEventListener("click", async () => {
  const sku = planSaveButton.dataset.sku;
  if (!sku) {
    return;
  }
  planSaveButton.disabled = true;
  const original = planSaveButton.textContent;
  planSaveButton.textContent = "Đang lưu...";
  try {
    await savePlanEdits(sku);
    setStatus("Đã lưu chỉnh sửa kế hoạch.");
    planSaveButton.textContent = "Đã lưu ✓";
    setTimeout(() => { planSaveButton.textContent = original; }, 1500);
  } catch (error) {
    setStatus(explainError(error));
    planSaveButton.textContent = original;
  } finally {
    planSaveButton.disabled = false;
  }
});

planCloseButton.addEventListener("click", closePlanPreview);

planGenerateButton.addEventListener("click", async () => {
  const sku = planGenerateButton.dataset.sku;
  if (!sku) {
    return;
  }
  planGenerateButton.disabled = true;
  try {
    // Auto-save any pending edits so images are generated from what the user sees.
    await savePlanEdits(sku);
    const { job } = await api(`/api/projects/${encodeURIComponent(sku)}/generate`, {
      method: "POST",
      body: JSON.stringify({ mock: useMockMode() })
    });
    closePlanPreview();
    addMessage("user", `Tạo ảnh từ kế hoạch cho SKU ${sku}`);
    await startJob(job, {
      title: `Đang tạo ảnh: ${sku}`,
      subtitle: `Chế độ ${generationModeLabel()} — tạo ảnh theo đúng kế hoạch đã duyệt.`
    });
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    addMessage("assistant", message);
  } finally {
    planGenerateButton.disabled = false;
  }
});

viewPlanButton.addEventListener("click", () => {
  if (editingSku) {
    openPlanPreview(editingSku);
  }
});

// ---- Post-generation review: show the images, let the user pick + regenerate ----
function renderResults(images) {
  const withId = images.filter((image) => image.imageId);
  resultsCount.textContent = `${withId.length} ảnh`;
  resultsBody.innerHTML = withId.length === 0
    ? "<p class=\"muted compact\">Chưa có ảnh nào.</p>"
    : `<div class="results-grid">${withId.map((image) => `
        <label class="result-item">
          <input type="checkbox" data-result-image="${image.imageId}">
          <img src="${image.url}" alt="${escapeHtml(image.filename)}" loading="lazy">
          <span class="result-tag">#${image.imageId}</span>
        </label>`).join("")}</div>`;
}

async function openResultsReview(sku, { silent = false } = {}) {
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(sku)}`);
    const images = project.generatedImages ?? [];
    if (images.length === 0) {
      if (!silent) setStatus("SKU này chưa có ảnh generate.");
      return;
    }
    document.querySelector("#resultsTitle").textContent = `Ảnh đã tạo: ${sku}`;
    resultsRegenButton.dataset.sku = sku;
    resultsFeedback.value = "";
    renderResults(images);
    resultsBody.scrollTop = 0;
    resultsOverlay.hidden = false;
  } catch (error) {
    setStatus(explainError(error));
  }
}

function closeResultsReview() {
  resultsOverlay.hidden = true;
}

resultsCloseButton.addEventListener("click", closeResultsReview);

resultsRegenButton.addEventListener("click", async () => {
  const sku = resultsRegenButton.dataset.sku;
  if (!sku) {
    return;
  }
  const imageIds = Array.from(resultsBody.querySelectorAll("[data-result-image]:checked"))
    .map((el) => Number.parseInt(el.dataset.resultImage, 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (imageIds.length === 0) {
    setStatus("Hãy chọn ít nhất một ảnh để tạo lại.");
    return;
  }
  resultsRegenButton.disabled = true;
  try {
    const { job } = await api(`/api/projects/${encodeURIComponent(sku)}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ imageIds, feedback: resultsFeedback.value.trim(), mock: useMockMode() })
    });
    closeResultsReview();
    addMessage("user", `Tạo lại ảnh ${imageIds.join(", ")}${resultsFeedback.value.trim() ? `: ${resultsFeedback.value.trim()}` : ""}`);
    await startJob(job, {
      title: `Đang tạo lại ảnh: ${sku}`,
      subtitle: `Tạo lại ${imageIds.length} ảnh đã chọn theo góp ý.`
    });
  } catch (error) {
    setStatus(explainError(error));
    addMessage("assistant", explainError(error));
  } finally {
    resultsRegenButton.disabled = false;
  }
});

async function pollJob() {
  if (!activeJobId) {
    return;
  }
  try {
    const { job, project } = await api(`/api/jobs/${encodeURIComponent(activeJobId)}`);
    const effectiveStatus = job.status === "RUNNING" && (project.status === "FAILED" || project.status === "COMPLETED")
      ? project.status
      : job.status;
    renderJobProgress(job, project);
    const stageLines = project.stages.map((stage) => {
      const icon = stage.status === "PASS" ? "✓" : stage.status === "FAIL" ? "✕" : "•";
      return `${icon} ${stage.stage}${stage.error ? ` - ${stage.error}` : ""}`;
    }).join("\n");
    renderActivity(job, effectiveStatus);
    const failureSummary = effectiveStatus === "FAILED" ? summarizeJobFailure(job, project) : "";
    setStatus([
      `Job: ${effectiveStatus}`,
      `SKU: ${job.projectId}`,
      job.type ? `Type: ${job.type}` : "",
      job.imageIds ? `Images: ${job.imageIds.join(", ")}` : "",
      failureSummary ? `Failure detail: ${failureSummary}` : "",
      stageLines
    ].filter(Boolean).join("\n"));
    await loadProjects();
    if (editingSku === job.projectId) {
      await loadProjectInput(job.projectId, { silent: true });
    }
    if (effectiveStatus !== "RUNNING") {
      clearInterval(pollTimer);
      pollTimer = null;
      activeJobId = "";
      addMessage(
        "assistant",
        effectiveStatus === "FAILED"
          ? `Job FAILED cho SKU <strong>${job.projectId}</strong>. ${failureSummary}`
          : `Job ${effectiveStatus}: ${job.projectId}`
      );
      // When a plan finishes, jump straight into the preview so the user can
      // review layout + prompts before generating images.
      if (effectiveStatus === "COMPLETED" && job.type === "PLAN") {
        closeActivity();
        await openPlanPreview(job.projectId, { subtitle: "Kế hoạch đã sẵn sàng. Xem kỹ rồi bấm \"Tạo ảnh\"." });
      }
      // When images finish, open the review so the user can inspect + regenerate.
      if (effectiveStatus === "COMPLETED" && (job.type === "GENERATE" || job.type === "RUN")) {
        closeActivity();
        await openResultsReview(job.projectId, { silent: true });
      }
    }
  } catch (error) {
    const message = explainError(error);
    clearInterval(pollTimer);
    pollTimer = null;
    setStatus(message);
    setProgress([{ level: "fail", text: message }]);
    addMessage("assistant", message);
  }
}

async function saveInput({ runNow }) {
  const fields = collectProductFields();
  if (!fields.sku) {
    throw new Error("SKU là bắt buộc.");
  }

  const images = await collectFiles(pendingImageFiles);
  const hasExistingImages = currentInputImages.length > 0;
  if (!hasExistingImages && images.length === 0) {
    throw new Error("Cần thêm ít nhất một ảnh sản phẩm.");
  }

  const payload = {
    sku: fields.sku,
    category: fields.category,
    productFields: fields,
    images,
    runNow,
    mock: useMockMode()
  };

  const path = editingSku
    ? `/api/projects/${encodeURIComponent(editingSku)}/input`
    : "/api/projects";
  const method = editingSku ? "PUT" : "POST";
  const result = await api(path, {
    method,
    body: JSON.stringify(payload)
  });

  editingSku = result.input.sku;
  fillProductFields(result.input.productFields);
  document.querySelector("#sku").disabled = true;
  currentInputImages = result.input.images;
  currentGeneratedImages = result.project.generatedImages ?? [];
  pendingImageFiles = [];
  fileInput.value = "";
  viewPlanButton.hidden = !result.project.hasPlan;
  renderImages();
  renderGeneratedImages();
  await loadProjects();

  if (result.job) {
    await startJob(result.job, {
      title: `Đang chạy workflow: ${result.input.sku}`,
      subtitle: `Chế độ ${generationModeLabel()} — theo dõi từng bước bên dưới.`
    });
  }
  return result;
}

fileInput.addEventListener("change", () => {
  pendingImageFiles.push(...Array.from(fileInput.files));
  fileInput.value = "";
  renderImages();
});

pendingImages.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-pending]");
  if (!button) {
    return;
  }
  pendingImageFiles.splice(Number.parseInt(button.dataset.removePending, 10), 1);
  renderImages();
});

existingImages.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-image]");
  if (!button || !editingSku) {
    return;
  }
  const filename = button.dataset.deleteImage;
  setStatus(`Đang xóa ảnh ${filename}...`);
  const { input, project } = await api(
    `/api/projects/${encodeURIComponent(editingSku)}/input/images/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  currentInputImages = input.images;
  currentGeneratedImages = project.generatedImages ?? currentGeneratedImages;
  renderImages();
  renderGeneratedImages();
  await loadProjects();
  setStatus(`Đã xóa ảnh ${filename}.`);
});

refreshButton.addEventListener("click", async () => {
  setStatus("Đang tải lại danh sách sản phẩm...");
  await loadProjects();
  setStatus("Đã cập nhật danh sách sản phẩm.");
});

newProjectButton.addEventListener("click", clearForm);

saveOnlyButton.addEventListener("click", async () => {
  saveOnlyButton.disabled = true;
  try {
    setStatus("Đang lưu dữ liệu sản phẩm...");
    const result = await saveInput({ runNow: false });
    addMessage("user", `Lưu dữ liệu SKU ${result.input.sku}`);
    addMessage("assistant", "Đã lưu dữ liệu sản phẩm và đồng bộ vào kho category/SKU.");
    setStatus(`Đã lưu dữ liệu cho ${result.input.sku}.`);
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    addMessage("assistant", message);
  } finally {
    saveOnlyButton.disabled = false;
  }
});

projectList.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    await loadProjectInput(editButton.dataset.edit);
    return;
  }

  const runButton = event.target.closest("[data-run]");
  if (!runButton) {
    return;
  }
  const sku = runButton.dataset.run;
  try {
    addMessage("assistant", `Da nhan lenh chay workflow cho SKU ${sku}. He thong dang khoi dong job va se cap nhat tien trinh o khung log.`);
    setProgress([{ text: `Dang gui lenh chay workflow cho ${sku}...` }]);
    const { job } = await api(`/api/projects/${encodeURIComponent(sku)}/run`, {
      method: "POST",
      body: JSON.stringify({ mock: useMockMode() })
    });
    addMessage("user", `Chạy workflow cho SKU ${sku} bằng ${generationModeLabel()}`);
    setStatus(`Đã bắt đầu job cho ${sku}.`);
    await startJob(job, {
      title: `Đang chạy workflow: ${sku}`,
      subtitle: `Chế độ ${generationModeLabel()} — theo dõi từng bước bên dưới.`
    });
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    setProgress([{ level: "fail", text: message }]);
    addMessage("assistant", message);
  }
});

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = projectForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  try {
    setStatus("Đang lưu dữ liệu và lập kế hoạch...");
    addMessage("assistant", "Đã nhận lệnh lưu và tạo kế hoạch. Hệ thống dựng layout + prompt để bạn xem trước (chưa tạo ảnh).");
    setProgress([{ text: "Đang lưu dữ liệu và lập kế hoạch..." }]);
    const result = await saveInput({ runNow: false });
    addMessage("user", `Lập kế hoạch cho SKU ${result.input.sku}`);
    const { job } = await api(`/api/projects/${encodeURIComponent(result.input.sku)}/plan`, {
      method: "POST",
      body: JSON.stringify({ mock: useMockMode() })
    });
    await startJob(job, {
      title: `Đang lập kế hoạch: ${result.input.sku}`,
      subtitle: "Dựng Product DNA, layout và prompt — chưa tạo ảnh."
    });
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    addMessage("assistant", message);
  } finally {
    submitButton.disabled = false;
  }
});

saveFeedbackButton.addEventListener("click", async () => {
  if (!editingSku) {
    setStatus("Hãy chọn một SKU trước.");
    return;
  }
  const feedback = repairFeedback.value.trim();
  if (!feedback) {
    setStatus("Hãy nhập feedback trước khi lưu.");
    return;
  }
  const imageIds = selectedGeneratedImageIds();
  try {
    const result = await api(`/api/projects/${encodeURIComponent(editingSku)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ imageIds, feedback, rating: feedbackRating.value })
    });
    currentGeneratedImages = result.project?.generatedImages ?? currentGeneratedImages;
    renderGeneratedImages();
    addMessage("user", feedback);
    addMessage(
      "assistant",
      result.learning?.summary
        ? `Đã lưu góp ý và chắt lọc knowledge: ${result.learning.summary}`
        : "Đã lưu góp ý vào thư mục knowledge của SKU này để hệ thống học lại sau."
    );
    setStatus("Đã lưu feedback và cập nhật knowledge.");
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    setProgress([{ level: "fail", text: message }]);
    addMessage("assistant", message);
  }
});

repairButton.addEventListener("click", async () => {
  if (!editingSku) {
    setStatus("Hãy chọn một SKU trước.");
    return;
  }
  const imageIds = selectedGeneratedImageIds();
  if (imageIds.length === 0) {
    setStatus("Hãy chọn ít nhất một ảnh generate để sửa.");
    return;
  }
  const feedback = repairFeedback.value.trim();
  try {
    const { job } = await api(`/api/projects/${encodeURIComponent(editingSku)}/repair`, {
      method: "POST",
      body: JSON.stringify({ imageIds, feedback, mock: useMockMode() })
    });
    addMessage("user", `Sửa ảnh ${imageIds.join(", ")}: ${feedback || "không có mô tả thêm"}`);
    setStatus(`Đã bắt đầu sửa ảnh ${imageIds.join(", ")}.`);
    await startJob(job, {
      title: `Đang sửa ảnh: ${editingSku}`,
      subtitle: `Tạo lại ảnh ${imageIds.join(", ")} — theo dõi tiến trình bên dưới.`
    });
  } catch (error) {
    const message = explainError(error);
    setStatus(message);
    setProgress([{ level: "fail", text: message }]);
    addMessage("assistant", message);
  }
});

// If a job is still running on the server (e.g. the browser was closed and
// reopened, or another teammate started it), reconnect and show its progress.
async function reconnectRunningJob() {
  if (activeJobId) {
    return;
  }
  try {
    const { jobs } = await api("/api/jobs?status=running");
    if (!jobs || jobs.length === 0) {
      return;
    }
    const running = jobs[0];
    const { job } = await api(`/api/jobs/${encodeURIComponent(running.jobId)}`);
    const titleByType = {
      PLAN: "Đang lập kế hoạch",
      GENERATE: "Đang tạo ảnh",
      REPAIR: "Đang sửa ảnh",
      RUN: "Đang chạy workflow"
    };
    await startJob(job, {
      title: `${titleByType[job.type] ?? "Đang chạy"}: ${job.projectId}`,
      subtitle: "Đã kết nối lại job đang chạy trên server."
    });
  } catch {
    /* no running job or server unreachable — ignore */
  }
}

renderImages();
renderGeneratedImages();
loadProjects().catch((error) => setStatus(error.message));
reconnectRunningJob();
