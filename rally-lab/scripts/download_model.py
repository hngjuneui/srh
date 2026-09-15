"""Download the official MediaPipe pose task (no custom badminton training)."""
import hashlib
import urllib.request
from pathlib import Path

URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
target = Path(__file__).resolve().parent.parent / "models/pose_landmarker_lite.task"
target.parent.mkdir(exist_ok=True)
if not target.exists():
    temp = target.with_suffix(".download")
    urllib.request.urlretrieve(URL, temp)
    if temp.stat().st_size < 1_000_000:
        raise RuntimeError("Downloaded model is unexpectedly small")
    temp.replace(target)
print("Model ready:", target.name, "sha256:", hashlib.sha256(target.read_bytes()).hexdigest())
