"""舞台提示执行台 —— FastAPI + SQLite 后端。

核心机制：
- 全局版本号（meta 表），每次变更（录入/确认/编辑/重排/重置）都 +1。
- 确认与编辑请求必须携带页面当时看到的版本号；不一致则 409 并返回最新状态，
  同一版本的两个并发操作只有一个能生效（全局锁 + 版本比对保证）。
- 确认时把数据库里“那一刻”的内容快照为已发内容，已发记录此后不可变。
- 全部数据落 SQLite，刷新页面、重启服务均不丢失顺序与进度。
"""

import os
import sqlite3
import threading
import time

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("CUE_DB", os.path.join(BASE_DIR, "cues.db"))

MIN_CUES = 2
MAX_CUES = 12

_lock = threading.Lock()
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA journal_mode=WAL")
conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cues (
        cue_id         TEXT PRIMARY KEY,      -- 用户录入的唯一编号
        content        TEXT NOT NULL,         -- 当前（可改写的）内容
        position       INTEGER NOT NULL,      -- 待发队列中的顺序
        status         TEXT NOT NULL DEFAULT 'pending',  -- pending | issued
        issued_content TEXT,                  -- 发出那一刻的内容快照
        issued_seq     INTEGER,               -- 发出顺序
        issued_at      REAL                   -- 发出时间（epoch 秒）
    );
    INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');
    """
)
conn.commit()

app = FastAPI(title="舞台提示执行台")


# ---------- 状态读取 ----------

def _version() -> int:
    row = conn.execute("SELECT value FROM meta WHERE key='version'").fetchone()
    return int(row["value"])


def _bump() -> None:
    conn.execute(
        "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) "
        "WHERE key='version'"
    )


def _state() -> dict:
    rows = conn.execute("SELECT * FROM cues ORDER BY position").fetchall()
    pending = [
        {"cue_id": r["cue_id"], "content": r["content"]}
        for r in rows
        if r["status"] == "pending"
    ]
    issued_rows = sorted(
        (r for r in rows if r["status"] == "issued"),
        key=lambda r: r["issued_seq"],
    )
    issued = [
        {
            "cue_id": r["cue_id"],
            "content": r["issued_content"],
            "issued_at": r["issued_at"],
        }
        for r in issued_rows
    ]
    if not rows:
        phase = "setup"
    elif pending:
        phase = "running"
    else:
        phase = "done"
    return {
        "version": _version(),
        "phase": phase,
        "current": pending[0] if pending else None,
        "next": pending[1] if len(pending) > 1 else None,
        "pending": pending,
        "issued": issued,
    }


def _conflict(detail: str) -> JSONResponse:
    """409：请求基于过期版本，随响应带回最新状态供页面刷新。"""
    return JSONResponse(
        status_code=409, content={"detail": detail, "state": _state()}
    )


def _bad(detail: str) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": detail})


# ---------- 请求模型 ----------

class CueIn(BaseModel):
    cue_id: str
    content: str


class SetupIn(BaseModel):
    cues: list[CueIn]


class VersionedIn(BaseModel):
    version: int


class EditIn(BaseModel):
    version: int
    cue_id: str
    content: str


class ReorderIn(BaseModel):
    version: int
    order: list[str]


# ---------- 接口 ----------

@app.get("/api/state")
def get_state():
    with _lock:
        return _state()


@app.post("/api/setup")
def setup(body: SetupIn):
    cues = [(c.cue_id.strip(), c.content.strip()) for c in body.cues]
    if not (MIN_CUES <= len(cues) <= MAX_CUES):
        return _bad(f"提示数量须在 {MIN_CUES}～{MAX_CUES} 条之间")
    ids = [cid for cid, _ in cues]
    if any(not cid for cid in ids):
        return _bad("每条提示都需要填写编号")
    if len(set(ids)) != len(ids):
        return _bad("编号必须唯一，存在重复编号")
    if any(not content for _, content in cues):
        return _bad("提示内容不能为空")
    with _lock:
        conn.execute("DELETE FROM cues")
        conn.executemany(
            "INSERT INTO cues (cue_id, content, position) VALUES (?, ?, ?)",
            [(cid, content, pos) for pos, (cid, content) in enumerate(cues)],
        )
        _bump()
        conn.commit()
        return {"ok": True, "state": _state()}


@app.post("/api/confirm")
def confirm(body: VersionedIn):
    """确认发出当前提示：把此刻的内容记为已发并推进一条。"""
    with _lock:
        st = _state()
        if st["phase"] != "running":
            return _conflict("当前没有待发出的提示")
        if body.version != st["version"]:
            # 重复点击 / 编辑已胜出 / 他人已操作 —— 拒绝并回最新状态
            return _conflict("版本已过期，已刷新为最新状态")
        cur = st["current"]
        # 在锁内读取数据库里此刻的内容作为已发快照
        row = conn.execute(
            "SELECT content FROM cues WHERE cue_id = ?", (cur["cue_id"],)
        ).fetchone()
        seq = conn.execute(
            "SELECT COALESCE(MAX(issued_seq), 0) + 1 AS s FROM cues"
        ).fetchone()["s"]
        conn.execute(
            "UPDATE cues SET status='issued', issued_content=?, "
            "issued_seq=?, issued_at=? WHERE cue_id=?",
            (row["content"], seq, time.time(), cur["cue_id"]),
        )
        _bump()
        conn.commit()
        return {"ok": True, "state": _state()}


@app.post("/api/edit")
def edit(body: EditIn):
    """改写一条尚未发出的提示内容。"""
    content = body.content.strip()
    if not content:
        return _bad("提示内容不能为空")
    with _lock:
        st = _state()
        if body.version != st["version"]:
            return _conflict("版本已过期，已刷新为最新状态")
        row = conn.execute(
            "SELECT status FROM cues WHERE cue_id = ?", (body.cue_id,)
        ).fetchone()
        if row is None:
            return _bad("提示不存在")
        if row["status"] != "pending":
            return _conflict("该提示已发出，已发记录不可修改")
        conn.execute(
            "UPDATE cues SET content=? WHERE cue_id=?", (content, body.cue_id)
        )
        _bump()
        conn.commit()
        return {"ok": True, "state": _state()}


@app.post("/api/reorder")
def reorder(body: ReorderIn):
    """重排尚未发出的提示；order 必须恰好是当前待发编号集合。"""
    with _lock:
        st = _state()
        if body.version != st["version"]:
            return _conflict("版本已过期，已刷新为最新状态")
        pending_ids = [c["cue_id"] for c in st["pending"]]
        if len(body.order) != len(pending_ids) or sorted(body.order) != sorted(pending_ids):
            return _conflict("待发队列已变化，已刷新为最新状态")
        conn.executemany(
            "UPDATE cues SET position=? WHERE cue_id=?",
            [(pos, cid) for pos, cid in enumerate(body.order)],
        )
        _bump()
        conn.commit()
        return {"ok": True, "state": _state()}


@app.post("/api/reset")
def reset(body: VersionedIn):
    """清空进度，回到录入阶段。"""
    with _lock:
        st = _state()
        if body.version != st["version"]:
            return _conflict("版本已过期，已刷新为最新状态")
        conn.execute("DELETE FROM cues")
        _bump()
        conn.commit()
        return {"ok": True, "state": _state()}


# ---------- 静态页面 ----------

@app.get("/")
def index():
    return FileResponse(os.path.join(BASE_DIR, "static", "index.html"))


app.mount(
    "/static",
    StaticFiles(directory=os.path.join(BASE_DIR, "static")),
    name="static",
)
