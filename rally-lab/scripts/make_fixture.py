"""Synthetic no-person video for integration checks; not badminton evaluation data."""
from pathlib import Path
import cv2
import numpy as np

target = Path(__file__).resolve().parent.parent / "test-results/input.mp4"
target.parent.mkdir(exist_ok=True)
writer = cv2.VideoWriter(str(target), cv2.VideoWriter_fourcc(*"mp4v"), 12, (320,180))
if not writer.isOpened():
    raise RuntimeError("Could not create fixture")
for i in range(36):
    frame = np.zeros((180,320,3),np.uint8)
    cv2.rectangle(frame, (20+i,60), (70+i,120), (80,160,90), -1)
    writer.write(frame)
writer.release()
