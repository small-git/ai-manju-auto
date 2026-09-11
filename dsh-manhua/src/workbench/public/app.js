const state = {
  storyId: "",
  board: null,
  keys: null,
  writing: null,
};

const MODS = {
  keys: { title: "密钥管理", desc: "密钥、中转站、模型与连通测试" },
  writing: { title: "文案工作室", desc: "主线/小说续写 · 反转 · 写回剧本 · 拆下一集" },
  stories: { title: "故事管理", desc: "故事集、智能拆剧、画风" },
  sheets: { title: "定妆管理", desc: "角色定妆生成与审批" },
  props: { title: "道具管理", desc: "道具/线索资产与公网地址" },
  stills: { title: "分镜管理", desc: "镜头卡预览 · 动作/运镜/对白细节 · 九宫格" },
  plan: { title: "计划预审", desc: "逐镜路径、自动衔接、提示词预览" },
  videos: { title: "成片管理", desc: "齐套门闸、跳过已有、流水线" },
  canvas: { title: "画布编排", desc: "镜头卡一览（账本仍是故事剧本）" },
  export: { title: "出片 / 交付", desc: "拼接成章、配音字幕、剪映草稿、压缩包" },
};

const PROVIDERS = [
  { id: "autodl", label: "AutoDL 成片", placeholder: "在此粘贴 Token" },
  { id: "openai", label: "OpenAI 定妆/文案/配音", placeholder: "在此粘贴密钥" },
  { id: "gemini", label: "Gemini 分镜静帧", placeholder: "在此粘贴密钥" },
];

const PROVIDER_LABELS = { autodl: "AutoDL", openai: "OpenAI", gemini: "Gemini" };
const STYLE_LABELS = {
  live_action: "真人写实",
  manhua_ink: "水墨漫剧",
  manhua_cel: "赛璐璐漫剧",
  anime_otaku_night: "二次元夜景",
};

const PLAN_LABELS = {
  video_ref: "多图参考成片",
  bridge: "首尾帧衔接",
  grid: "九宫格选格",
  lipsync: "对口型",
};

function styleLabel(id) {
  return STYLE_LABELS[id] || id;
}

function planLabel(id) {
  return PLAN_LABELS[id] || id || "—";
}

function $(id) {
  return document.getElementById(id);
}

function log(msg) {
  const el = $("log");
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + el.textContent;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({ ok: false, error: "响应不是 JSON" }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function requireStory() {
  if (!state.storyId || !state.board) throw new Error("请先在左侧选择并进入故事集");
  return state.storyId;
}

function showMod(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.mod === name));
  document.querySelectorAll(".mod").forEach((m) => m.classList.toggle("active", m.id === `mod-${name}`));
  $("mod-title").textContent = MODS[name].title;
  $("mod-desc").textContent = MODS[name].desc;
}

function pill(label, on) {
  return `<span class="pill ${on ? "on" : "off"}">${label}${on ? " ✓" : " ×"}</span>`;
}

function renderSummary() {
  const s = state.board?.summary;
  const keys = Object.fromEntries((state.keys?.keys || []).map((k) => [k.provider, k]));
  $("summary").innerHTML = [
    pill("AutoDL", !!keys.autodl?.configured),
    pill("OpenAI", !!keys.openai?.configured),
    pill("Gemini", !!keys.gemini?.configured),
    pill("故事", !!state.board),
    s ? pill(`定妆 ${s.sheets_ready}/${s.characters}`, s.sheets_ready === s.characters) : "",
    s ? pill(`齐套 ${s.gate_ready}/${s.shots}`, s.gate_ready === s.shots) : "",
    s ? pill(`成片 ${s.videos_ready}/${s.shots}`, s.videos_ready === s.shots) : "",
    s ? pill("出片", !!s.export_ready) : "",
  ].join("");
  $("top-story").textContent = state.board
    ? `${state.board.story_id} · ${state.board.title || ""}`
    : "未选择故事集";
}

function fillStyleSelects() {
  const locks = state.board?.style_locks || Object.keys(STYLE_LABELS);
  const opts =
    locks.map((s) => `<option value="${s}">${styleLabel(s)}</option>`).join("") ||
    `<option value="live_action">${styleLabel("live_action")}</option>`;
  ["expand-style", "story-style-lock", "writing-style"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = opts;
    if (state.board?.style_lock && [...el.options].some((o) => o.value === state.board.style_lock)) {
      el.value = state.board.style_lock;
    } else if (prev && [...el.options].some((o) => o.value === prev)) {
      el.value = prev;
    }
  });
}

function writingStoryId() {
  return ($("writing-story-id").value || state.storyId || $("global-story").value || "").trim();
}

function renderWriting(doc, activeDraft) {
  state.writing = doc;
  if (!doc) return;
  $("writing-story-id").value = doc.story_id || writingStoryId();
  if (doc.title) $("writing-title").value = doc.title;
  $("writing-logline").value = doc.logline || "";
  $("writing-source").value = doc.source_text || "";
  const draft = activeDraft || (doc.drafts || [])[doc.drafts.length - 1] || null;
  if (draft) {
    $("writing-draft").textContent = draft.content;
    $("writing-draft-meta").textContent = `${draft.kind} · ${draft.id} · ${draft.content.length} 字`;
  } else {
    $("writing-draft").textContent = "生成后续写/反转内容会出现在这里";
    $("writing-draft-meta").textContent = "—";
  }
  const kindLabel = { seed: "导入", continue: "续写", twist: "反转", revise: "改写" };
  $("writing-history").innerHTML =
    (doc.drafts || [])
      .slice()
      .reverse()
      .map(
        (d) => `<tr>
        <td>${(d.created_at || "").replace("T", " ").slice(0, 19)}</td>
        <td>${kindLabel[d.kind] || d.kind}</td>
        <td>${escapeHtml((d.instruction || "—").slice(0, 40))}</td>
        <td>${(d.content || "").length}</td>
        <td><button class="btn ghost small" data-writing-preview="${d.id}">查看</button>
            <button class="btn small" data-writing-use="${d.id}">采用</button></td>
      </tr>`,
      )
      .join("") || `<tr><td colspan="5" class="muted">暂无草稿</td></tr>`;

  $("writing-history").querySelectorAll("[data-writing-preview]").forEach((btn) => {
    btn.onclick = () => {
      const d = (doc.drafts || []).find((x) => x.id === btn.dataset.writingPreview);
      if (!d) return;
      $("writing-draft").textContent = d.content;
      $("writing-draft-meta").textContent = `${d.kind} · ${d.id} · ${d.content.length} 字`;
      state.writing = { ...doc, active_draft_id: d.id };
    };
  });
  $("writing-history").querySelectorAll("[data-writing-use]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        const data = await api("/api/writing/adopt", {
          method: "POST",
          body: JSON.stringify({ story_id: writingStoryId(), draft_id: btn.dataset.writingUse, mode: "replace" }),
        });
        renderWriting(data.writing, data.writing?.drafts?.find((d) => d.id === data.writing.active_draft_id));
        log("已采用草稿为正文");
      } catch (e) {
        log(e.message);
      }
    };
  });
}

async function loadWriting() {
  const id = writingStoryId();
  if (!id) throw new Error("请填写故事 ID，或先进入故事");
  $("writing-story-id").value = id;
  const data = await api(`/api/writing/${encodeURIComponent(id)}`);
  renderWriting(data.writing, data.active_draft);
  return data;
}

function renderKeyCards() {
  const status = state.keys || { keys: [], settings: {} };
  const map = Object.fromEntries((status.keys || []).map((k) => [k.provider, k]));
  const settings = status.settings || {};
  const baseByProvider = {
    autodl: settings.autodlBaseUrl || "https://autodl.art",
    openai: settings.openaiBaseUrl || "https://api.openai.com/v1",
    gemini: settings.geminiBaseUrl || "https://generativelanguage.googleapis.com/v1beta",
  };
  $("keyCards").innerHTML = PROVIDERS.map((p) => {
    const row = map[p.id] || { configured: false, source: null };
    const on = !!row.configured;
    const endpoint = baseByProvider[p.id] || "";
    return `<div class="card key-card" data-provider="${p.id}">
      <h3>${p.label}</h3>
      <div class="status"><span class="dot ${on ? "on" : "off"}"></span>${on ? `已配置（${row.source}）` : "未配置"}</div>
      <div class="endpoint" title="${endpoint}">${endpoint}</div>
      <div class="probe-line muted" data-role="probe">尚未测试</div>
      <div class="form-row"><label>密钥</label><input type="password" data-role="value" placeholder="${p.placeholder}" autocomplete="off" /></div>
      <div class="actions">
        <button type="button" class="btn" data-role="save">保存</button>
        <button type="button" class="btn ghost" data-role="probe">测试连通</button>
        <button type="button" class="btn danger" data-role="clear">清除</button>
      </div>
    </div>`;
  }).join("");

  $("keyCards").querySelectorAll(".key-card").forEach((card) => {
    const provider = card.dataset.provider;
    card.querySelector('[data-role="save"]').onclick = async () => {
      const value = card.querySelector('[data-role="value"]').value.trim();
      if (!value) return log("请输入密钥");
      await api("/api/keys", { method: "POST", body: JSON.stringify({ provider, value }) });
      card.querySelector('[data-role="value"]').value = "";
      log(`已保存 ${PROVIDER_LABELS[provider] || provider}`);
      await refreshKeys();
    };
    card.querySelector('[data-role="clear"]').onclick = async () => {
      await api(`/api/keys/${provider}`, { method: "DELETE" });
      log(`已清除 ${PROVIDER_LABELS[provider] || provider}`);
      await refreshKeys();
    };
    card.querySelector('button[data-role="probe"]').onclick = () => probeOne(provider, card);
  });

  const setVal = (id, v) => {
    const el = $(id);
    if (el) el.value = v || "";
  };
  setVal("setting-autodl-url", settings.autodlBaseUrl || "https://autodl.art");
  setVal("setting-openai-url", settings.openaiBaseUrl || "https://api.openai.com/v1");
  setVal("setting-gemini-url", settings.geminiBaseUrl || "https://generativelanguage.googleapis.com/v1beta");
  setVal("setting-openai-image-model", settings.openaiImageModel || "gpt-image-1");
  setVal("setting-openai-chat-model", settings.openaiChatModel || "gpt-4o-mini");
  setVal("setting-gemini-image-model", settings.geminiImageModel || "gemini-3.1-flash-image");
  setVal("setting-video-workflow", settings.videoWorkflowId || "minimax_h3_lightx2v_v5");
  setVal("setting-resolution", settings.defaultResolution || "768p横");
  setVal("setting-cdn", settings.publicAssetBaseUrl || "");
  $("video-resolution").placeholder = settings.defaultResolution || "768p横";
  const prov = state.board?.providers || {};
  if (prov.sheet) $("provider-sheet").value = prov.sheet;
  if (prov.still) $("provider-still").value = prov.still;
  renderSummary();
}

async function probeOne(provider, card) {
  const line = card?.querySelector('[data-role="probe"]');
  const btn = card?.querySelector('button[data-role="probe"]');
  if (line) {
    line.className = "probe-line muted";
    line.textContent = "测试中…";
  }
  if (btn) btn.disabled = true;
  try {
    const data = await api("/api/keys/probe", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    const ok = !!data.reachable;
    if (line) {
      line.className = `probe-line ${ok ? "ok" : "bad"}`;
      line.textContent = `${data.message}${data.latency_ms != null ? ` · ${data.latency_ms}ms` : ""}`;
      if (data.detail && !ok) line.title = data.detail;
    }
    log(`${provider}: ${data.message}${data.detail && !ok ? ` — ${data.detail}` : ""}`);
    return data;
  } catch (e) {
    if (line) {
      line.className = "probe-line bad";
      line.textContent = e.message;
    }
    log(`${provider} 测试失败：${e.message}`);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveAllSettings() {
  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      autodl_base_url: $("setting-autodl-url").value.trim(),
      openai_base_url: $("setting-openai-url").value.trim(),
      gemini_base_url: $("setting-gemini-url").value.trim(),
      openai_image_model: $("setting-openai-image-model").value.trim(),
      openai_chat_model: $("setting-openai-chat-model").value.trim(),
      gemini_image_model: $("setting-gemini-image-model").value.trim(),
      video_workflow_id: $("setting-video-workflow").value.trim(),
      default_resolution: $("setting-resolution").value.trim() || "768p横",
      public_asset_base_url: $("setting-cdn").value.trim(),
    }),
  });
  await refreshKeys();
}

function renderStories(list) {
  $("stories-tbody").innerHTML = (list || [])
    .map(
      (s) => `<tr>
      <td>${s.story_id}</td>
      <td>${s.title || "-"}</td>
      <td>${s.chapter_id || "-"}</td>
      <td>${s.characters ?? "-"}</td>
      <td>${s.props ?? "-"}</td>
      <td>${s.shots ?? "-"}</td>
      <td><button class="btn small" data-enter="${s.story_id}">进入</button></td>
    </tr>`,
    )
    .join("");
  $("stories-tbody").querySelectorAll("[data-enter]").forEach((btn) => {
    btn.onclick = () => enterStory(btn.dataset.enter);
  });
  const sel = $("global-story");
  sel.innerHTML = (list || [])
    .map((s) => {
      const title = s.title ? `${s.title}` : s.story_id;
      return `<option value="${s.story_id}">${title}${s.title ? `（${s.story_id}）` : ""}</option>`;
    })
    .join("");
  if (state.storyId) sel.value = state.storyId;
}

function renderSheets() {
  const rows = state.board?.characters || [];
  $("sheets-tbody").innerHTML = rows
    .map(
      (c) => `<tr>
      <td><strong>${c.id}</strong><div class="muted">${c.name || ""}</div></td>
      <td><span class="tag ${c.sheet_ready ? "ok" : "bad"}">${c.sheet_ready ? "已定妆" : "未定妆"}</span></td>
      <td><span class="tag ${c.sheet_is_public ? "ok" : "bad"}">${c.sheet_is_public ? "公网" : "非公网"}</span></td>
      <td><span class="tag ${c.approved ? "ok" : "bad"}">${c.approved ? "已批准" : "待批"}</span></td>
      <td class="path">${c.sheet_url || c.local_path || "-"}</td>
      <td class="actions-cell">
        <button class="btn small" data-sheet="${c.id}">${c.sheet_ready ? "重跑" : "生成"}</button>
        <button class="btn ghost small" data-approve-ch="${c.id}" data-val="${c.approved ? "0" : "1"}">${c.approved ? "驳回" : "批准"}</button>
      </td>
    </tr>`,
    )
    .join("") || `<tr><td colspan="6" class="muted">请先进入故事集</td></tr>`;
  $("sheets-tbody").querySelectorAll("[data-sheet]").forEach((btn) => {
    btn.onclick = async () => {
      const story_id = requireStory();
      btn.disabled = true;
      try {
        const data = await api("/api/sheet", {
          method: "POST",
          body: JSON.stringify({ story_id, character_id: btn.dataset.sheet }),
        });
        state.board = data.board;
        renderAllBoard();
        log(`定妆完成：${btn.dataset.sheet}`);
      } catch (e) {
        log(e.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
  $("sheets-tbody").querySelectorAll("[data-approve-ch]").forEach((btn) => {
    btn.onclick = async () => {
      const story_id = requireStory();
      const data = await api("/api/approve", {
        method: "POST",
        body: JSON.stringify({
          story_id,
          kind: "character",
          id: btn.dataset.approveCh,
          approved: btn.dataset.val === "1",
        }),
      });
      state.board = data.board;
      renderAllBoard();
      log(`定妆审批：${btn.dataset.approveCh}`);
    };
  });
}

function renderProps() {
  const rows = state.board?.props || [];
  $("props-tbody").innerHTML = rows
    .map(
      (p) => `<tr>
      <td><strong>${p.id}</strong><div class="muted">${p.name}</div></td>
      <td class="muted">${(p.clue_lock || "").slice(0, 60)}</td>
      <td><span class="tag ${p.sheet_is_public ? "ok" : "bad"}">${p.sheet_is_public ? "公网" : "无"}</span></td>
      <td>
        <input data-prop-url="${p.id}" placeholder="https://..." value="${p.sheet_url || ""}" style="width:220px" />
        <button class="btn small" data-prop-save="${p.id}">保存</button>
      </td>
    </tr>`,
    )
    .join("") || `<tr><td colspan="4" class="muted">当前故事无 props（可在 story.json 添加）</td></tr>`;
  $("props-tbody").querySelectorAll("[data-prop-save]").forEach((btn) => {
    btn.onclick = async () => {
      const story_id = requireStory();
      const url = $("props-tbody").querySelector(`[data-prop-url="${btn.dataset.propSave}"]`).value.trim();
      const data = await api("/api/prop", {
        method: "POST",
        body: JSON.stringify({ story_id, prop_id: btn.dataset.propSave, sheet_url: url }),
      });
      state.board = data.board;
      renderAllBoard();
      log(`道具地址已写回：${btn.dataset.propSave}`);
    };
  });
}

function versionSelect(shot, kind) {
  const versions = shot.versions?.[kind === "still" ? "still_versions" : "video_versions"] || [];
  const selected = shot.versions?.[kind === "still" ? "selected_still" : "selected_video"];
  if (!versions.length) return `<span class="muted">无版本</span>`;
  return `<div class="select-wrap compact"><select data-ver-kind="${kind}" data-ver-shot="${shot.shot_id}">
    ${versions.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`).join("")}
  </select></div>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStills() {
  const rows = state.board?.shots || [];
  const hero = $("still-hero");
  const board = $("stills-board");
  if (!hero || !board) return;

  const ready = rows.filter((s) => s.still_ready).length;
  const approved = rows.filter((s) => s.still_approved).length;
  const gated = rows.filter((s) => s.gate_ready).length;
  hero.innerHTML = `
    <div class="stat"><strong>${rows.length}</strong><span>本章镜头</span></div>
    <div class="stat gold"><strong>${ready}/${rows.length || 0}</strong><span>已有静帧预览</span></div>
    <div class="stat mag"><strong>${approved}/${rows.length || 0}</strong><span>已批准 · 齐套 ${gated}</span></div>
  `;

  if (!rows.length) {
    board.innerHTML = `<div class="empty-still">请先进入故事集</div>`;
    return;
  }

  board.innerHTML = rows
    .map((s) => {
      const cam = s.camera || {};
      const preview = s.still_preview || s.grid_preview || "";
      const thumb = preview
        ? `<img src="${escapeHtml(preview)}" alt="${escapeHtml(s.shot_id)}" loading="lazy" />`
        : `<div class="placeholder">NO STILL</div>`;
      return `<article class="still-card ${s.still_ready ? "ready" : "blocked"}" data-shot="${escapeHtml(s.shot_id)}">
        <div class="still-thumb">
          <div class="badge-row">
            <span class="tag ${s.still_ready ? "ok" : "bad"}">${s.still_ready ? "有静帧" : "缺静帧"}</span>
            <span class="tag ${s.still_is_public ? "ok" : "bad"}">${s.still_is_public ? "公网" : "本地/无"}</span>
            <span class="tag ${s.still_approved ? "ok" : "bad"}">${s.still_approved ? "已批准" : "待批"}</span>
            <span class="tag">${escapeHtml(planLabel(s.plan_path || "video_ref"))}</span>
          </div>
          ${thumb}
          <div class="shot-id">${escapeHtml(s.shot_id)} · ${s.duration || 5}s</div>
        </div>
        <div class="still-body">
          <p class="action">${escapeHtml(s.action || "（无动作描述）")}</p>
          <div class="meta-grid">
            <div class="meta-chip"><label>景别</label><b>${escapeHtml(cam.shot_size || "—")}</b></div>
            <div class="meta-chip"><label>机位</label><b>${escapeHtml(cam.angle || "—")}</b></div>
            <div class="meta-chip"><label>运镜</label><b>${escapeHtml(cam.move || "—")}</b></div>
            <div class="meta-chip"><label>情绪</label><b>${escapeHtml(s.emotion || "—")}</b></div>
            <div class="meta-chip"><label>角色</label><b>${escapeHtml((s.character_ids || []).join(", ") || "—")}</b></div>
            <div class="meta-chip"><label>道具</label><b>${escapeHtml((s.prop_ids || []).join(", ") || "—")}</b></div>
            <div class="meta-chip wide"><label>环境</label><b>${escapeHtml(s.environment_id || "—")}${s.bridge_from ? ` · 衔接←${escapeHtml(s.bridge_from)}` : ""}</b></div>
            <div class="meta-chip wide"><label>版本</label><b>${versionSelect(s, "still")}</b></div>
          </div>
          ${s.dialogue ? `<p class="dialogue-line">「${escapeHtml(s.dialogue)}」</p>` : ""}
          <div class="still-toolbar">
            <button class="btn small" data-still="${escapeHtml(s.shot_id)}">生成静帧</button>
            <button class="btn ghost small" data-grid="${escapeHtml(s.shot_id)}">九宫格</button>
            <input class="cell-input" data-cell-input="${escapeHtml(s.shot_id)}" type="number" min="1" max="9" placeholder="格" />
            <button class="btn ghost small" data-cell="${escapeHtml(s.shot_id)}">裁切选格</button>
            <button class="btn ghost small" data-approve-still="${escapeHtml(s.shot_id)}" data-val="${s.still_approved ? "0" : "1"}">${s.still_approved ? "驳回" : "批准"}</button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  board.querySelectorAll("[data-still]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const data = await api("/api/still", {
          method: "POST",
          body: JSON.stringify({ story_id: requireStory(), shot_id: btn.dataset.still }),
        });
        state.board = data.board;
        renderAllBoard();
        log(`分镜完成：${btn.dataset.still}`);
      } catch (e) {
        log(e.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
  board.querySelectorAll("[data-grid]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const data = await api("/api/still", {
          method: "POST",
          body: JSON.stringify({ story_id: requireStory(), shot_id: btn.dataset.grid, as_grid: true }),
        });
        state.board = data.board;
        renderAllBoard();
        log(`九宫格完成：${btn.dataset.grid}`);
      } catch (e) {
        log(e.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
  board.querySelectorAll("[data-cell]").forEach((btn) => {
    btn.onclick = async () => {
      const cell = Number(board.querySelector(`[data-cell-input="${btn.dataset.cell}"]`).value);
      const data = await api("/api/grid-cell", {
        method: "POST",
        body: JSON.stringify({ story_id: requireStory(), shot_id: btn.dataset.cell, cell }),
      });
      state.board = data.board;
      renderAllBoard();
      log(`已裁切第 ${cell} 格：${btn.dataset.cell}`);
    };
  });
  board.querySelectorAll("[data-approve-still]").forEach((btn) => {
    btn.onclick = async () => {
      const data = await api("/api/approve", {
        method: "POST",
        body: JSON.stringify({
          story_id: requireStory(),
          kind: "still",
          id: btn.dataset.approveStill,
          approved: btn.dataset.val === "1",
        }),
      });
      state.board = data.board;
      renderAllBoard();
    };
  });
  bindVersionSelects("stills-board");
}

function bindVersionSelects(containerId) {
  const root = $(containerId);
  if (!root) return;
  root.querySelectorAll("select[data-ver-shot]").forEach((sel) => {
    sel.onchange = async () => {
      const data = await api("/api/select-version", {
        method: "POST",
        body: JSON.stringify({
          story_id: requireStory(),
          shot_id: sel.dataset.verShot,
          kind: sel.dataset.verKind,
          version: sel.value,
        }),
      });
      state.board = data.board;
      renderAllBoard();
      log(`已选用 ${sel.dataset.verKind} ${sel.value}`);
    };
  });
}

function renderPlan() {
  const rows = state.board?.shots || [];
  $("plan-tbody").innerHTML = rows
    .map(
      (s) => `<tr>
      <td>${s.shot_id}</td>
      <td><span class="tag ${s.gate_ready ? "ok" : "bad"}">${s.gate_ready ? "齐" : "缺"}</span></td>
      <td>
        <div class="select-wrap compact">
          <select data-plan="${s.shot_id}">
            ${["video_ref", "bridge", "grid", "lipsync"]
              .map((p) => `<option value="${p}" ${s.plan_path === p ? "selected" : ""}>${planLabel(p)}</option>`)
              .join("")}
          </select>
        </div>
      </td>
      <td><input data-bridge="${s.shot_id}" value="${s.bridge_from || ""}" style="width:140px" /></td>
      <td><input type="checkbox" data-lip="${s.shot_id}" ${s.needs_lipsync ? "checked" : ""} /></td>
      <td><button class="btn ghost small" data-preview="${s.shot_id}">预览</button>
          <button class="btn small" data-plan-save="${s.shot_id}">保存</button></td>
    </tr>`,
    )
    .join("") || `<tr><td colspan="6" class="muted">请先进入故事集</td></tr>`;

  $("plan-tbody").querySelectorAll("[data-plan-save]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.planSave;
      const data = await api("/api/plan", {
        method: "POST",
        body: JSON.stringify({
          story_id: requireStory(),
          shot_id: id,
          plan_path: $("plan-tbody").querySelector(`[data-plan="${id}"]`).value,
          bridge_from: $("plan-tbody").querySelector(`[data-bridge="${id}"]`).value.trim() || null,
          needs_lipsync: $("plan-tbody").querySelector(`[data-lip="${id}"]`).checked,
        }),
      });
      state.board = data.board;
      renderAllBoard();
      log(`计划已保存：${id}`);
    };
  });
  $("plan-tbody").querySelectorAll("[data-preview]").forEach((btn) => {
    btn.onclick = async () => {
      const data = await api("/api/prompt-preview", {
        method: "POST",
        body: JSON.stringify({ story_id: requireStory(), shot_id: btn.dataset.preview }),
      });
      $("prompt-preview").textContent = JSON.stringify(data, null, 2);
    };
  });
}

function renderVideos() {
  const rows = state.board?.shots || [];
  $("videos-tbody").innerHTML = rows
    .map(
      (s) => `<tr>
      <td>${s.shot_id}</td>
      <td>${planLabel(s.plan_path)}</td>
      <td title="${(s.gate_issues || []).map((i) => i.message).join("\n")}"><span class="tag ${s.gate_ready ? "ok" : "bad"}">${s.gate_ready ? "可跑" : "拦截"}</span></td>
      <td><span class="tag ${s.video_ready ? "ok" : "bad"}">${s.video_ready ? "已成片" : "未成片"}</span></td>
      <td>${versionSelect(s, "video")}</td>
      <td class="actions-cell">
        <button class="btn small" data-video="${s.shot_id}" ${s.gate_ready ? "" : "disabled"} title="${s.gate_ready ? "" : "齐套未通过"}">${s.video_ready ? "跳过/重跑" : "生成"}</button>
        <button class="btn ghost small" data-force="${s.shot_id}" ${s.gate_ready ? "" : "disabled"}>强制</button>
        ${s.dialogue ? `<button class="btn ghost small" data-tts="${s.shot_id}">配音</button>` : ""}
      </td>
    </tr>`,
    )
    .join("") || `<tr><td colspan="6" class="muted">请先进入故事集</td></tr>`;

  $("videos-tbody").querySelectorAll("[data-video]").forEach((btn) => {
    btn.onclick = () => runVideo(btn.dataset.video, false, btn);
  });
  $("videos-tbody").querySelectorAll("[data-force]").forEach((btn) => {
    btn.onclick = () => runVideo(btn.dataset.force, true, btn);
  });
  $("videos-tbody").querySelectorAll("[data-tts]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api("/api/tts", {
          method: "POST",
          body: JSON.stringify({ story_id: requireStory(), shot_id: btn.dataset.tts }),
        });
        log(`配音完成：${btn.dataset.tts}`);
      } catch (e) {
        log(e.message);
      }
    };
  });
  bindVersionSelects("videos-tbody");
}

async function runVideo(shotId, force, btn) {
  btn.disabled = true;
  try {
    const data = await api("/api/video", {
      method: "POST",
      body: JSON.stringify({
        story_id: requireStory(),
        shot_id: shotId,
        resolution: $("video-resolution").value.trim() || undefined,
        force,
      }),
    });
    state.board = data.board;
    renderAllBoard();
    log(data.skipped ? `已跳过：${shotId}` : `成片完成：${shotId}`);
  } catch (e) {
    log(e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderCanvas() {
  const rows = state.board?.shots || [];
  $("canvas-board").innerHTML = rows
    .map(
      (s) => `<article class="shot-card ${s.gate_ready ? "ready" : "blocked"}">
      <header>${s.shot_id}</header>
      <div class="meta">${planLabel(s.plan_path)} · ${s.duration}s</div>
      <p>${(s.action || "").slice(0, 80)}</p>
      <footer>
        <span class="tag ${s.still_ready ? "ok" : "bad"}">静帧</span>
        <span class="tag ${s.video_ready ? "ok" : "bad"}">成片</span>
        <span class="tag ${s.gate_ready ? "ok" : "bad"}">齐套</span>
      </footer>
    </article>`,
    )
    .join("") || `<p class="muted">请先进入故事集</p>`;
}

function renderExport() {
  const board = state.board;
  if (!board) {
    $("export-status").textContent = "请先进入故事集";
    $("export-checklist").innerHTML = "";
    return;
  }
  const missing = board.export.missing_shots || [];
  const bits = [];
  if (board.export.ready) bits.push("成章已有");
  if (board.export.dub_file) bits.push("配音成片已有");
  if (board.export.srt) bits.push("SRT 已有");
  $("export-status").textContent = missing.length
    ? `还差 ${missing.length} 个镜头成片。`
    : bits.length
      ? `${bits.join(" · ")}。成章：${board.export.file || "-"}`
      : "镜头成片已齐，可以出片；再点「补配音+字幕」。";
  $("export-checklist").innerHTML = (board.shots || [])
    .map(
      (s) =>
        `<li class="${s.video_ready ? "ok" : "bad"}">${s.shot_id} ${s.video_ready ? "✓" : "×"} · ${planLabel(s.plan_path)}${s.dialogue ? " · 有对白" : ""}</li>`,
    )
    .join("");
}

function renderAllBoard() {
  $("story-detail").textContent = state.board
    ? JSON.stringify(
        {
          story_id: state.board.story_id,
          chapter_id: state.board.chapter_id,
          title: state.board.title,
          style_lock: state.board.style_lock,
          logline: state.board.logline,
          summary: state.board.summary,
          environments: state.board.environments,
          providers: state.board.providers,
        },
        null,
        2,
      )
    : "请先进入一个故事集";
  fillStyleSelects();
  renderSheets();
  renderProps();
  renderStills();
  renderPlan();
  renderVideos();
  renderCanvas();
  renderExport();
  renderSummary();
  if (state.storyId && $("writing-story-id")) {
    $("writing-story-id").value = state.storyId;
  }
}

async function refreshKeys() {
  state.keys = await api("/api/keys");
  renderKeyCards();
}

async function refreshStories() {
  const data = await api("/api/stories");
  renderStories(data.stories || []);
}

async function enterStory(storyId, opts = {}) {
  const id = (storyId || $("global-story").value || "").trim();
  if (!id) return log("请选择故事集");
  state.board = await api(`/api/board/${encodeURIComponent(id)}`);
  state.storyId = id;
  $("global-story").value = id;
  if ($("writing-story-id")) $("writing-story-id").value = id;
  renderAllBoard();
  try {
    await loadWriting();
  } catch {
    /* writing optional */
  }
  log(`已进入故事集：${id}`);
  if (!opts.keepMod) showMod(opts.mod || "stories");
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.onclick = () => {
    showMod(btn.dataset.mod);
    if (btn.dataset.mod === "writing") {
      if (state.storyId && !$("writing-story-id").value) $("writing-story-id").value = state.storyId;
      loadWriting().catch(() => {});
    }
  };
});

$("btn-bind-story").onclick = () => enterStory();
$("btn-refresh-keys").onclick = () => refreshKeys().then(() => log("密钥状态已刷新")).catch((e) => log(e.message));
$("btn-refresh-stories").onclick = () => refreshStories().then(() => log("故事列表已刷新")).catch((e) => log(e.message));
["sheets", "props", "stills", "plan", "videos", "canvas", "export"].forEach((name) => {
  const btn = $(`btn-refresh-${name}`);
  if (btn) btn.onclick = () => enterStory(state.storyId, { keepMod: true }).catch((e) => log(e.message));
});

$("btn-save-settings").onclick = async () => {
  try {
    await saveAllSettings();
    log("参数 / 地址 / 模型已保存");
  } catch (e) {
    log(e.message);
  }
};
$("btn-save-api-urls").onclick = $("btn-save-settings").onclick;
$("btn-save-models").onclick = async () => {
  try {
    await saveAllSettings();
    log("模型已保存");
  } catch (e) {
    log(e.message);
  }
};
$("btn-probe-all").onclick = async () => {
  const cards = [...$("keyCards").querySelectorAll(".key-card")];
  for (const card of cards) {
    await probeOne(card.dataset.provider, card);
  }
};

$("btn-save-providers").onclick = async () => {
  try {
    await api("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        sheet: $("provider-sheet").value,
        still: $("provider-still").value,
      }),
    });
    log("服务商已切换");
  } catch (e) {
    log(e.message);
  }
};

$("btn-set-style").onclick = async () => {
  try {
    const data = await api("/api/style-lock", {
      method: "POST",
      body: JSON.stringify({ story_id: requireStory(), style_lock: $("story-style-lock").value }),
    });
    state.board = data.board;
    renderAllBoard();
    log(`画风已切换：${styleLabel(data.style_lock)}`);
  } catch (e) {
    log(e.message);
  }
};

$("btn-expand-story").onclick = async () => {
  try {
    const data = await api("/api/expand-story", {
      method: "POST",
      body: JSON.stringify({
        story_id: $("expand-id").value.trim(),
        title: $("expand-title").value.trim() || undefined,
        style_lock: $("expand-style").value,
        logline: $("expand-logline").value.trim(),
        synopsis: $("expand-synopsis").value.trim(),
      }),
    });
    log(`拆剧完成：${data.story_id}（${data.shots} 镜）`);
    await refreshStories();
  } catch (e) {
    log(e.message);
  }
};

$("btn-writing-load").onclick = () => loadWriting().then(() => log("文案账本已加载")).catch((e) => log(e.message));
$("btn-writing-refresh").onclick = $("btn-writing-load").onclick;

$("btn-writing-save").onclick = async () => {
  try {
    const data = await api("/api/writing/seed", {
      method: "POST",
      body: JSON.stringify({
        story_id: writingStoryId(),
        source_text: $("writing-source").value,
        title: $("writing-title").value.trim() || undefined,
        logline: $("writing-logline").value.trim() || undefined,
      }),
    });
    renderWriting(data.writing, data.draft);
    log("正文已保存到文案账本");
  } catch (e) {
    log(e.message);
  }
};

async function writingGenerate(kind) {
  const id = writingStoryId();
  if (!id) return log("请填写故事 ID");
  // persist current editor text first if non-empty
  if ($("writing-source").value.trim()) {
    await api("/api/writing/seed", {
      method: "POST",
      body: JSON.stringify({
        story_id: id,
        source_text: $("writing-source").value,
        title: $("writing-title").value.trim() || undefined,
        logline: $("writing-logline").value.trim() || undefined,
      }),
    });
  }
  const data = await api("/api/writing/generate", {
    method: "POST",
    body: JSON.stringify({
      story_id: id,
      kind,
      instruction: $("writing-instruction").value.trim() || undefined,
    }),
  });
  renderWriting(data.writing, data.draft);
  log(data.note || `${kind} 完成`);
}

$("btn-writing-continue").onclick = () => writingGenerate("continue").catch((e) => log(e.message));
$("btn-writing-twist").onclick = () => writingGenerate("twist").catch((e) => log(e.message));
$("btn-writing-revise").onclick = () => writingGenerate("revise").catch((e) => log(e.message));

$("btn-writing-adopt").onclick = async () => {
  try {
    const data = await api("/api/writing/adopt", {
      method: "POST",
      body: JSON.stringify({
        story_id: writingStoryId(),
        draft_id: state.writing?.active_draft_id || undefined,
        mode: "replace",
      }),
    });
    renderWriting(data.writing, data.writing?.drafts?.find((d) => d.id === data.writing.active_draft_id));
    log("已采用为正文（覆盖）");
  } catch (e) {
    log(e.message);
  }
};

$("btn-writing-adopt-append").onclick = async () => {
  try {
    const data = await api("/api/writing/adopt", {
      method: "POST",
      body: JSON.stringify({
        story_id: writingStoryId(),
        draft_id: state.writing?.active_draft_id || undefined,
        mode: "append",
      }),
    });
    renderWriting(data.writing, data.writing?.drafts?.find((d) => d.id === data.writing.active_draft_id));
    log("已追加到正文");
  } catch (e) {
    log(e.message);
  }
};

$("btn-writing-apply").onclick = async () => {
  try {
    const data = await api("/api/writing/apply-synopsis", {
      method: "POST",
      body: JSON.stringify({
        story_id: writingStoryId(),
        draft_id: state.writing?.active_draft_id || undefined,
      }),
    });
    if (data.board) {
      state.board = data.board;
      state.storyId = data.story_id;
      renderAllBoard();
    }
    $("writing-downstream").textContent = JSON.stringify(data, null, 2);
    log(data.note || "已写回剧情梗概");
  } catch (e) {
    log(e.message);
  }
};

$("btn-writing-expand").onclick = async () => {
  try {
    const data = await api("/api/writing/expand-episode", {
      method: "POST",
      body: JSON.stringify({
        story_id: writingStoryId(),
        draft_id: state.writing?.active_draft_id || undefined,
        instruction: $("writing-instruction").value.trim() || undefined,
        create_if_missing: true,
        title: $("writing-title").value.trim() || undefined,
        style_lock: $("writing-style").value || undefined,
      }),
    });
    if (data.board) {
      state.board = data.board;
      state.storyId = data.story_id;
      $("global-story").value = data.story_id;
      renderAllBoard();
    }
    await refreshStories();
    $("writing-downstream").textContent = JSON.stringify(
      { story_id: data.story_id, shots: data.shots, shots_added: data.shots_added, created: data.created, note: data.note },
      null,
      2,
    );
    log(data.note || `拆镜完成：${data.shots} 镜`);
  } catch (e) {
    log(e.message);
  }
};

$("btn-auto-bridge").onclick = async () => {
  try {
    const data = await api("/api/auto-bridge", {
      method: "POST",
      body: JSON.stringify({ story_id: requireStory() }),
    });
    state.board = data.board;
    renderAllBoard();
    log(`自动衔接：${(data.updated || []).join(", ") || "无变更"}`);
  } catch (e) {
    log(e.message);
  }
};

$("btn-pipeline").onclick = async () => {
  try {
    $("btn-pipeline").disabled = true;
    const data = await api("/api/pipeline", {
      method: "POST",
      body: JSON.stringify({ story_id: requireStory(), force: false }),
    });
    state.board = data.board;
    renderAllBoard();
    log(`流水线完成：${data.count} 步`);
  } catch (e) {
    log(e.message);
  } finally {
    $("btn-pipeline").disabled = false;
  }
};

$("btn-export").onclick = async () => {
  try {
    $("btn-export").disabled = true;
    $("export-result").textContent = "出片中…";
    const data = await api("/api/export", { method: "POST", body: JSON.stringify({ story_id: requireStory() }) });
    $("export-result").textContent = JSON.stringify(data, null, 2);
    state.board = await api(`/api/board/${encodeURIComponent(requireStory())}`);
    renderAllBoard();
    log(`出片完成：${data.export_file}`);
  } catch (e) {
    $("export-result").textContent = e.message;
    log(e.message);
  } finally {
    $("btn-export").disabled = false;
  }
};

$("btn-timeline").onclick = async () => {
  try {
    const data = await api("/api/timeline", { method: "POST", body: JSON.stringify({ story_id: requireStory() }) });
    $("export-result").textContent = JSON.stringify(data, null, 2);
    state.board = await api(`/api/board/${encodeURIComponent(requireStory())}`);
    renderAllBoard();
    log(`时间线：${data.timeline_file}；字幕：${data.srt_file}`);
  } catch (e) {
    log(e.message);
  }
};

$("btn-deliver").onclick = async () => {
  try {
    $("btn-deliver").disabled = true;
    $("export-result").textContent = "正在补配音与字幕（含 TTS）…";
    const data = await api("/api/chapter-deliver", {
      method: "POST",
      body: JSON.stringify({ story_id: requireStory(), jianying: true }),
    });
    $("export-result").textContent = JSON.stringify(data, null, 2);
    state.board = await api(`/api/board/${encodeURIComponent(requireStory())}`);
    renderAllBoard();
    log(`交付完成：配音=${data.dub_file || "无"}；字幕=${data.srt_file || "无"}`);
  } catch (e) {
    $("export-result").textContent = e.message;
    log(e.message);
  } finally {
    $("btn-deliver").disabled = false;
  }
};

$("btn-jianying").onclick = async () => {
  try {
    $("btn-jianying").disabled = true;
    $("export-result").textContent = "正在导出剪映草稿…";
    const data = await api("/api/jianying", {
      method: "POST",
      body: JSON.stringify({ story_id: requireStory() }),
    });
    $("export-result").textContent = JSON.stringify(data, null, 2);
    log(`剪映草稿：${data.draft_path || data.note}`);
  } catch (e) {
    $("export-result").textContent = e.message;
    log(e.message);
  } finally {
    $("btn-jianying").disabled = false;
  }
};

$("btn-zip-export").onclick = async () => {
  try {
    const data = await api("/api/zip-export", { method: "POST", body: JSON.stringify({ story_id: requireStory() }) });
    $("export-result").textContent = JSON.stringify(data, null, 2);
    log(`工程包：${data.zip_path}`);
  } catch (e) {
    log(e.message);
  }
};

$("btn-zip-import").onclick = async () => {
  try {
    const data = await api("/api/zip-import", {
      method: "POST",
      body: JSON.stringify({ zip_path: $("zip-import-path").value.trim() }),
    });
    $("export-result").textContent = JSON.stringify(data, null, 2);
    await refreshStories();
    if (data.story_id) await enterStory(data.story_id);
    log(`导入：${data.story_id}`);
  } catch (e) {
    log(e.message);
  }
};

$("btn-clear-log").onclick = () => {
  $("log").textContent = "";
};

(async function boot() {
  try {
    await refreshKeys();
    await refreshStories();
    const first = $("global-story").value;
    if (first) await enterStory(first);
    log("工作台就绪：文案 / 定妆 / 分镜 / 成片 / 出片");
  } catch (e) {
    log(`启动失败：${e.message}`);
  }
})();
