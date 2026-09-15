from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import secrets
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field, ConfigDict

from backend import engine as cv_engine
from backend.engine import DEFAULTS, Engine

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("RALLY_DATA", str(ROOT / "data")))
DATA.mkdir(parents=True, exist_ok=True)
code_file = DATA / "access-code.txt"
if not code_file.exists():
    code_file.write_text(str(secrets.randbelow(90000000)+10000000), encoding="utf-8")
ACCESS_CODE = os.environ.get("RALLY_ACCESS_CODE", code_file.read_text().strip())
print(f"\nRALLY LAB · PC pairing code: {ACCESS_CODE}\nOpen http://127.0.0.1:8765\n", flush=True)
AUTHS = set()
ATTEMPTS = {}
SESSIONS = {}
JOBS = {}
POOL = ThreadPoolExecutor(max_workers=1)
VIDEO_POOL = ThreadPoolExecutor(max_workers=1)
EXPORT_POOL = ThreadPoolExecutor(max_workers=1)
UPLOAD_LOCK = threading.Lock()
MAX_UPLOAD = 512*1024*1024
app = FastAPI(title="Rally Lab", docs_url=None, redoc_url=None)


@app.middleware("http")
async def guard_api(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path not in ("/api/login", "/api/health"):
        if request.cookies.get("rally_auth") not in AUTHS:
            return JSONResponse({"detail": "PC 연결 코드를 입력하세요."}, status_code=401)
    try:
        if int(request.headers.get("content-length", "0")) > MAX_UPLOAD+1024*1024:
            return JSONResponse({"detail": "영상은 512 MB 이하여야 합니다."}, status_code=413)
    except ValueError:
        return JSONResponse({"detail": "잘못된 요청 길이입니다."}, status_code=400)
    return await call_next(request)


class Options(BaseModel):
    model_config = ConfigDict(extra="forbid")
    landing: bool = True
    last_hit: bool = False
    pickup: bool = True
    fusion: str = Field(default="consensus", pattern="^(consensus|single)$")
    threshold: float = Field(default=.6, ge=.3, le=.9)
    gesture: bool = True
    hold_seconds: float = Field(default=1.2, ge=.8, le=3)
    correction_window: int = Field(default=15, ge=5, le=30)
    idle_seconds: float = Field(default=2.5, ge=1.5, le=6)
    hand: str = Field(default="right", pattern="^(right|left)$")
    near_team: str = Field(default="A", pattern="^[AB]$")
    court: list[list[float]] = Field(default_factory=list, max_length=4)
    target: int = Field(default=21, ge=5, le=30)

    def checked(self):
        value = self.model_dump()
        if self.court:
            if len(self.court) != 4 or any(len(p) != 2 or any(not 0 <= q <= 1 for q in p) for p in self.court):
                raise HTTPException(422, "코트 모서리 4개가 필요합니다.")
            contour = np.float32(self.court)
            if not cv2.isContourConvex(contour) or abs(cv2.contourArea(contour)) < .015:
                raise HTTPException(422, "코트 네 점을 둘레 순서로 지정하세요. 교차하거나 너무 좁습니다.")
        return value


class ClipList(BaseModel):
    clips: list[dict] = Field(max_length=200)


def auth(request):
    if request.cookies.get("rally_auth") not in AUTHS:
        raise HTTPException(401, "PC 연결 코드를 입력하세요.")


def session(sid):
    if sid not in SESSIONS:
        raise HTTPException(404, "경기를 찾을 수 없습니다.")
    return SESSIONS[sid]


def save(sid):
    s = SESSIONS[sid]
    payload = {"settings": s["engine"].settings, "events": s["engine"].book.events, "names": s["names"]}
    path = DATA / f"session-{sid}.json"
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def new_session(sid=None, settings=None, events=None, names=None):
    sid = sid or uuid.uuid4().hex
    latest = max((e["time"] for e in events or []), default=0)
    SESSIONS[sid] = {"engine": Engine(settings, events), "origin": time.monotonic()-latest-31,
                     "names": names or {"A": "TEAM A", "B": "TEAM B"}, "latest_jpeg": None,
                     "producer": False, "lock": asyncio.Lock(), "updated": 0}
    return sid


for saved in DATA.glob("session-*.json"):
    try:
        obj = json.loads(saved.read_text(encoding="utf-8"))
        new_session(saved.stem[8:], obj["settings"], obj["events"], obj["names"])
    except (ValueError, KeyError):
        pass


@app.get("/api/health")
def health():
    return {"ok": True, "model_installed": (ROOT / "models/pose_landmarker_lite.task").exists(),
            "model_loaded": cv_engine.DETECTOR is not None, "model_error": cv_engine.MODEL_ERROR,
            "transport": "sampled-frames", "trained_shuttle_model": False}


@app.post("/api/login")
async def login(request: Request):
    ip, now = request.client.host, time.monotonic()
    recent = [t for t in ATTEMPTS.get(ip, []) if now-t < 60]
    if len(recent) >= 8:
        raise HTTPException(429, "잠시 후 다시 시도하세요.")
    if int(request.headers.get("content-length", "0")) > 2048:
        raise HTTPException(413)
    body = await request.json()
    if not secrets.compare_digest(str(body.get("code", "")), ACCESS_CODE):
        ATTEMPTS[ip] = recent+[now]
        raise HTTPException(401, "연결 코드가 일치하지 않습니다.")
    token = secrets.token_urlsafe(32)
    AUTHS.add(token)
    response = JSONResponse({"ok": True})
    # Same-site cookie; configure trusted proxy when terminating HTTPS externally.
    response.set_cookie("rally_auth", token, httponly=True, samesite="strict",
                        secure=request.url.scheme == "https", max_age=86400)
    return response


@app.get("/api/sessions")
def list_sessions(request: Request):
    auth(request)
    return [{"id": k, "names": v["names"], "score": v["engine"].book.state()} for k,v in SESSIONS.items()]


@app.post("/api/sessions")
def create_session(request: Request):
    auth(request)
    sid = new_session()
    save(sid)
    return {"id": sid}


@app.get("/api/sessions/{sid}")
def get_session(sid: str, request: Request):
    auth(request)
    s = session(sid)
    return {"id": sid, "names": s["names"], "settings": s["engine"].settings,
            "score": s["engine"].book.state(), "result": s["engine"].last_result,
            "streaming": s["producer"], "age": time.monotonic()-s["updated"] if s["updated"] else None}


@app.put("/api/sessions/{sid}/settings")
async def settings(sid: str, value: Options, request: Request):
    auth(request)
    s = session(sid)
    checked = value.checked()
    async with s["lock"]:
        if s["engine"].book.events and checked["target"] != s["engine"].book.target:
            raise HTTPException(409, "득점이 있는 경기에서는 목표 점수를 바꿀 수 없습니다.")
        s["engine"].settings = checked
        s["engine"].book.target = checked["target"]
        save(sid)
    return checked


@app.put("/api/sessions/{sid}/names")
async def names(sid: str, request: Request):
    auth(request)
    s = session(sid)
    body = await request.json()
    async with s["lock"]:
        s["names"] = {k: str(body.get(k, k))[:24] for k in "AB"}
        save(sid)
    return s["names"]


@app.post("/api/sessions/{sid}/score/{action}")
async def score(sid: str, action: str, request: Request):
    auth(request)
    s = session(sid)
    async with s["lock"]:
        book = s["engine"].book
        t = time.monotonic()-s["origin"]
        if action in ("A", "B"):
            if not book.add(action, t):
                raise HTTPException(409, "경기가 종료되었습니다. 새 경기를 시작하세요.")
        elif action == "flip":
            if not book.flip(t):
                raise HTTPException(409, "수정할 득점이 없습니다.")
        elif action == "undo":
            if book.events:
                book.events.pop()
        else:
            raise HTTPException(422)
        save(sid)
        return book.state()


@app.get("/api/sessions/{sid}/preview.jpg")
def preview(sid: str, request: Request):
    auth(request)
    s = session(sid)
    if not s["latest_jpeg"]:
        raise HTTPException(404)
    return Response(s["latest_jpeg"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.websocket("/ws/{sid}")
async def stream(ws: WebSocket, sid: str):
    if ws.cookies.get("rally_auth") not in AUTHS or sid not in SESSIONS:
        await ws.close(code=4401)
        return
    # Block foreign-site websocket use of an authenticated cookie.
    origin = ws.headers.get("origin", "")
    from urllib.parse import urlparse
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=4403)
        return
    s = SESSIONS[sid]
    if s["producer"]:
        await ws.close(code=4409)
        return
    await ws.accept()
    s["producer"] = True
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 2_000_000:
                await ws.close(code=1009)
                break
            msg = json.loads(raw)
            seq = int(msg.get("seq", 0))
            if msg.get("mode") not in ("analysis", "score"):
                raise ValueError("mode")
            jpg = base64.b64decode(msg["jpeg"], validate=True)
            with Image.open(io.BytesIO(jpg)) as probe:
                if probe.width*probe.height > 3_000_000 or probe.format != "JPEG":
                    raise ValueError("frame size or format")
            frame = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("invalid image")
            async with s["lock"]:
                started = time.monotonic()
                t = started-s["origin"]
                result = await asyncio.get_running_loop().run_in_executor(POOL, s["engine"].process, frame, t, msg["mode"])
                result = {**result, "seq": seq, "processing_ms": round((time.monotonic()-started)*1000),
                          "received_bytes": len(jpg), "source_time": msg.get("source_time")}
                s["latest_jpeg"] = jpg
                s["updated"] = time.monotonic()
                if result["notice"]:
                    save(sid)
            await ws.send_json(result)
    except (WebSocketDisconnect, RuntimeError):
        pass
    except (ValueError, KeyError, TypeError) as exc:
        try:
            await ws.send_json({"error": "잘못된 프레임 형식: "+str(exc)[:100]})
            await ws.close(code=1003)
        except RuntimeError:
            pass
    finally:
        s["producer"] = False


def analyse_video(job, path, options):
    cap = None
    try:
        with UPLOAD_LOCK:
            job["status"] = "preparing"
            cap = cv2.VideoCapture(str(path))
            fps = cap.get(cv2.CAP_PROP_FPS)
            total = cap.get(cv2.CAP_PROP_FRAME_COUNT)
            if not cap.isOpened() or fps <= 0 or total <= 0 or total/fps > 7200:
                raise ValueError("지원하지 않는 영상 또는 2시간을 넘는 영상입니다.")
            duration = total/fps
            job.update(duration=duration, source_fps=fps)
            cap.release()
            # Normalize codec and orientation for browser replay (phone HEVC/MOV and MPEG-4
            # may decode in OpenCV while failing in Chrome). Preserve the uploaded original.
            import imageio_ffmpeg
            normalized = DATA / (job["id"]+"-playback.mp4")
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-i", str(path),
                            "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1280,iw)':-2",
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
                            "-c:a", "aac", "-movflags", "+faststart", str(normalized)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=1800)
            job.update(path=str(normalized), preview_ready=True, status="analyzing")
            cap = cv2.VideoCapture(str(normalized))
            fps, total = cap.get(cv2.CAP_PROP_FPS), cap.get(cv2.CAP_PROP_FRAME_COUNT)
            if fps <= 0 or total <= 0:
                raise ValueError("재생본을 디코딩하지 못했습니다.")
            duration = total/fps
            job["duration"] = duration
            engine = Engine(options)
            step = max(1, round(fps/8))
            index = 0
            while True:
                if not cap.grab():
                    break
                if index % step == 0:
                    ok, frame = cap.retrieve()
                    if not ok:
                        raise ValueError("영상 프레임 디코딩 실패")
                    height, width = frame.shape[:2]
                    if width > 1280:
                        frame = cv2.resize(frame, (1280, int(height*1280/width)))
                    result = engine.process(frame, index/fps, "analysis")
                    job.update(progress=round(index/total*100,1), result=result)
                index += 1
            clips = engine.finish(duration)
            job.update(status="done", progress=100, clips=clips, strokes=engine.strokes,
                       model_error=cv_engine.MODEL_ERROR,
                       summary="준비·줍기 제외는 동작 기반 후보입니다. 구간을 확인하고 내보내세요.")
    except Exception as exc:
        job.update(status="error", error=str(exc))
    finally:
        if cap is not None:
            cap.release()


@app.post("/api/videos")
async def upload(request: Request, file: UploadFile = File(...), sid: str = ""):
    auth(request)
    s = session(sid)
    if sum(j["status"] in ("queued", "preparing", "analyzing") for j in JOBS.values()) >= 3:
        raise HTTPException(429, "분석 대기열이 찼습니다. 기존 분석이 끝나면 다시 시도하세요.")
    ext = Path(file.filename or "video.mp4").suffix.lower()
    if ext not in (".mp4", ".mov", ".webm", ".m4v", ".avi"):
        raise HTTPException(415, "MP4, MOV, WebM 영상을 선택하세요.")
    ident = uuid.uuid4().hex
    path = DATA / (ident+ext)
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await file.read(1024*1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "테스트 버전은 영상당 최대 512 MB입니다.")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    job = {"id": ident, "status": "queued", "progress": 0, "name": file.filename,
           "bytes": size, "path": str(path), "clips": [], "strokes": []}
    JOBS[ident] = job
    VIDEO_POOL.submit(analyse_video, job, path, dict(s["engine"].settings))
    return {"id": ident}


def job_for(ident):
    if ident not in JOBS:
        raise HTTPException(404, "영상 작업을 찾을 수 없습니다. 서버 재시작 후에는 다시 업로드하세요.")
    return JOBS[ident]


@app.get("/api/videos/{ident}")
def job_status(ident: str, request: Request):
    auth(request)
    return {k:v for k,v in job_for(ident).items() if k not in ("path", "export_path")}


@app.get("/api/videos/{ident}/source")
def video_source(ident: str, request: Request):
    auth(request)
    job = job_for(ident)
    if not job.get("preview_ready"):
        raise HTTPException(409, "브라우저용 재생본을 준비하고 있습니다.")
    return FileResponse(job["path"], headers={"Cache-Control": "no-store"})


@app.put("/api/videos/{ident}/clips")
def edit_clips(ident: str, value: ClipList, request: Request):
    auth(request)
    job = job_for(ident)
    if job["status"] != "done" or job.get("export_status") == "exporting":
        raise HTTPException(409, "분석 또는 내보내기가 끝날 때까지 기다려주세요.")
    clips = []
    for clip in value.clips:
        try:
            start, end = float(clip["start"]), float(clip["end"])
            if not 0 <= start < end <= job["duration"]+.01:
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise HTTPException(422, "구간 시작·종료 시간이 잘못되었습니다.")
        clips.append({"start": start, "end": end, "selected": bool(clip.get("selected", True)),
                      "label": "검토한 구간", "reason": "사용자 수정"})
    job["clips"] = sorted(clips, key=lambda c:c["start"])
    job["export_status"] = None
    return job["clips"]


def export_video(job, clips):
    try:
        import imageio_ffmpeg
        binary = imageio_ffmpeg.get_ffmpeg_exe()
        output = DATA / (job["id"]+"-highlights.mp4")
        # Single source decode, video-only highlights. Audio is explicitly omitted in this prototype.
        filters = []
        for i,c in enumerate(clips):
            filters.append(f"[0:v]trim=start={c['start']:.3f}:end={c['end']:.3f},setpts=PTS-STARTPTS[v{i}]")
        labels = "".join(f"[v{i}]" for i in range(len(clips)))
        filters.append(f"{labels}concat=n={len(clips)}:v=1:a=0[out]")
        subprocess.run([binary, "-y", "-i", job["path"], "-filter_complex", ";".join(filters),
                        "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=1800)
        job.update(export_status="done", export_path=str(output))
    except Exception as exc:
        job.update(export_status="error", export_error=str(exc)[:500])


@app.post("/api/videos/{ident}/export")
def start_export(ident: str, request: Request):
    auth(request)
    job = job_for(ident)
    if job["status"] != "done" or job.get("export_status") == "exporting":
        raise HTTPException(409, "분석 또는 내보내기가 진행 중입니다.")
    clips = [dict(c) for c in job["clips"] if c.get("selected", True)]
    if not clips or len(clips) > 50:
        raise HTTPException(422, "내보낼 구간을 1~50개 선택하세요.")
    job["export_status"] = "exporting"
    EXPORT_POOL.submit(export_video, job, clips)
    return {"status": "exporting"}


@app.get("/api/videos/{ident}/export")
def get_export(ident: str, request: Request):
    auth(request)
    job = job_for(ident)
    if job.get("export_status") != "done":
        raise HTTPException(409, "내보내기가 아직 완료되지 않았습니다.")
    return FileResponse(job["export_path"], filename="rally-highlights.mp4")


app.mount("/", StaticFiles(directory=ROOT/"web", html=True), name="web")
