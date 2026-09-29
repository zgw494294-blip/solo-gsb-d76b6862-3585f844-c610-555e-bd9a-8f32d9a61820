/* 舞台提示执行台前端逻辑。
 * 所有变更请求都携带当前页面看到的 state.version；
 * 服务端返回 409 时说明版本过期，用响应里的最新状态刷新页面。
 */

let state = null;          // 最近一次从服务端拿到的状态
let editingId = null;      // 正在内联编辑的提示编号（此时暂停重绘，避免打断输入）
let inflight = false;      // 确认请求进行中（防重复点击）
let renderedPhase = null;  // 上次渲染的阶段，用于只在进入 setup 时重建表单

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

/* ---------- 网络 ---------- */

async function post(path, body) {
  let res, data;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) {
    toast("网络错误，请稍后再试");
    return null;
  }
  if (res.status === 409) {
    // 版本过期 / 状态冲突：以服务端最新状态为准
    if (data.state) {
      state = data.state;
      editingId = null;
      render();
    }
    toast(data.detail || "页面数据已过期，已刷新为最新状态");
    return null;
  }
  if (!res.ok) {
    toast(data.detail || "操作失败");
    return null;
  }
  if (data.state) state = data.state;
  return data;
}

async function fetchState() {
  try {
    const res = await fetch("/api/state");
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* ---------- 渲染 ---------- */

const PHASE_LABEL = { setup: "开场准备", running: "演出进行中", done: "已完成" };

function render() {
  if (!state) return;
  const badge = $("phase-badge");
  badge.textContent = PHASE_LABEL[state.phase] || "";
  badge.className = "badge " + state.phase;

  if (state.phase === "setup") {
    $("setup-section").classList.remove("hidden");
    $("show-section").classList.add("hidden");
    if (renderedPhase !== "setup") buildSetupForm(); // 只在进入时重建，避免清掉输入
  } else {
    $("setup-section").classList.add("hidden");
    $("show-section").classList.remove("hidden");
    renderShow();
  }
  renderedPhase = state.phase;
}

function renderShow() {
  // 完成横幅
  $("done-banner").classList.toggle("hidden", state.phase !== "done");

  // 当前提示
  const cur = state.current;
  if (cur) {
    $("current-card").innerHTML = `
      <div class="card">
        <div class="label">当前待发提示</div>
        <div class="cue-id"># ${esc(cur.cue_id)}</div>
        <div class="cue-content">${esc(cur.content)}</div>
        <button id="confirm-btn" class="primary" ${inflight ? "disabled" : ""}>
          ${inflight ? "发出中…" : "确认发出"}
        </button>
      </div>`;
    $("confirm-btn").addEventListener("click", confirmCurrent);
  } else {
    $("current-card").innerHTML = `<div class="card empty">没有待发出的提示</div>`;
  }

  // 下一条
  const nxt = state.next;
  $("next-card").innerHTML = nxt
    ? `<div class="card next">
         <div class="label">下一条</div>
         <div class="cue-id"># ${esc(nxt.cue_id)}</div>
         <div class="cue-content">${esc(nxt.content)}</div>
       </div>`
    : "";

  // 待发队列（可编辑 / 重排）
  const pendingEl = $("pending-list");
  if (state.pending.length === 0) {
    pendingEl.innerHTML = `<li class="empty-tip">（空）</li>`;
  } else {
    pendingEl.innerHTML = state.pending
      .map((c, i) => {
        const cls =
          i === 0 ? "is-current" : i === 1 ? "is-next" : "";
        if (c.cue_id === editingId) {
          return `<li class="${cls}">
            <div class="line1"><span class="cid"># ${esc(c.cue_id)}</span></div>
            <div class="edit-row">
              <input id="edit-input" value="${esc(c.content)}" maxlength="500">
              <button class="small primary" data-act="save" data-id="${esc(c.cue_id)}">保存</button>
              <button class="small" data-act="cancel">取消</button>
            </div>
          </li>`;
        }
        return `<li class="${cls}">
          <div class="line1">
            <span class="cid"># ${esc(c.cue_id)}</span>
            <span class="ctext">${esc(c.content)}</span>
            <span class="ops">
              <button class="small" data-act="up" data-id="${esc(c.cue_id)}" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="small" data-act="down" data-id="${esc(c.cue_id)}" ${i === state.pending.length - 1 ? "disabled" : ""}>↓</button>
              <button class="small" data-act="edit" data-id="${esc(c.cue_id)}">编辑</button>
            </span>
          </div>
        </li>`;
      })
      .join("");
  }

  // 已发记录（保持发出时的内容，不可改）
  const issuedEl = $("issued-list");
  if (state.issued.length === 0) {
    issuedEl.innerHTML = `<li class="empty-tip">（暂无）</li>`;
  } else {
    issuedEl.innerHTML = state.issued
      .map(
        (c) => `<li>
          <div class="line1">
            <span class="cid"># ${esc(c.cue_id)}</span>
            <span class="ctext">${esc(c.content)}</span>
            <span class="time">${new Date(c.issued_at * 1000).toLocaleTimeString()}</span>
          </div>
        </li>`
      )
      .join("");
  }
}

/* ---------- 录入表单 ---------- */

function buildSetupForm() {
  $("cue-rows").innerHTML = "";
  addRow();
  addRow();
}

function addRow() {
  const rows = $("cue-rows");
  if (rows.children.length >= 12) {
    toast("最多 12 条提示");
    return;
  }
  const div = document.createElement("div");
  div.className = "cue-row";
  div.innerHTML = `
    <span class="seq">${rows.children.length + 1}.</span>
    <input class="input-id" placeholder="编号（唯一）" maxlength="40">
    <input class="input-content" placeholder="提示内容（必填）" maxlength="500">
    <button type="button" class="small" data-act="remove">删除</button>`;
  div.querySelector('[data-act="remove"]').addEventListener("click", () => {
    if ($("cue-rows").children.length <= 2) {
      toast("至少保留 2 条提示");
      return;
    }
    div.remove();
    renumber();
  });
  rows.appendChild(div);
}

function renumber() {
  [...$("cue-rows").children].forEach((row, i) => {
    row.querySelector(".seq").textContent = `${i + 1}.`;
  });
}

async function startShow() {
  const rows = [...$("cue-rows").children];
  const cues = rows.map((row) => ({
    cue_id: row.querySelector(".input-id").value.trim(),
    content: row.querySelector(".input-content").value.trim(),
  }));
  if (cues.length < 2 || cues.length > 12) {
    toast("提示数量须在 2～12 条之间");
    return;
  }
  if (cues.some((c) => !c.cue_id)) return toast("每条提示都需要填写编号");
  if (new Set(cues.map((c) => c.cue_id)).size !== cues.length)
    return toast("编号必须唯一，存在重复编号");
  if (cues.some((c) => !c.content)) return toast("提示内容不能为空");

  const data = await post("/api/setup", { cues });
  if (data) {
    editingId = null;
    render();
    toast("演出开始，祝顺利！");
  }
}

/* ---------- 演出操作 ---------- */

async function confirmCurrent() {
  if (inflight || !state || state.phase !== "running") return;
  inflight = true; // 防重复点击；服务端版本校验兜底，绝不跳提示
  render();
  const data = await post("/api/confirm", { version: state.version });
  inflight = false;
  editingId = null;
  render();
}

async function saveEdit(cueId) {
  const content = $("edit-input").value.trim();
  if (!content) return toast("提示内容不能为空");
  const data = await post("/api/edit", {
    version: state.version,
    cue_id: cueId,
    content,
  });
  if (data) {
    editingId = null;
    render();
  }
}

async function move(cueId, dir) {
  const ids = state.pending.map((c) => c.cue_id);
  const i = ids.indexOf(cueId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const data = await post("/api/reorder", {
    version: state.version,
    order: ids,
  });
  if (data) render();
}

async function resetShow() {
  if (!confirm("确定要清空当前全部提示与进度，重新录入吗？")) return;
  const data = await post("/api/reset", { version: state.version });
  if (data) {
    editingId = null;
    renderedPhase = null;
    render();
  }
}

/* ---------- 提示条 ---------- */

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3000);
}

/* ---------- 事件绑定 ---------- */

$("add-row").addEventListener("click", addRow);
$("start-show").addEventListener("click", startShow);
$("reset-show").addEventListener("click", resetShow);

// 待发队列的按钮统一走事件委托
$("pending-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === "edit") {
    editingId = id;
    render();
    $("edit-input").focus();
  } else if (act === "cancel") {
    editingId = null;
    render();
  } else if (act === "save") {
    saveEdit(id);
  } else if (act === "up") {
    move(id, -1);
  } else if (act === "down") {
    move(id, 1);
  }
});

// 编辑框内回车保存
$("pending-list").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "edit-input" && editingId) {
    saveEdit(editingId);
  }
});

/* ---------- 启动与轮询 ---------- */

(async function init() {
  state = await fetchState();
  render();
  // 定时同步：刷新/多标签页场景下保持页面为最新；
  // 正在编辑时只更新数据不重绘，避免打断输入。
  setInterval(async () => {
    const fresh = await fetchState();
    if (!fresh) return;
    const changed = !state || fresh.version !== state.version;
    state = fresh;
    if (changed && !editingId) render();
  }, 2500);
})();
