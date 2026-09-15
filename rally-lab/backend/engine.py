"""Observable experimental CV, temporal events, and replayable scoring. No trained referee."""
from __future__ import annotations

import math
import atexit
import os
import threading
from collections import deque
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / "data/matplotlib"))
POSE_LOCK = threading.Lock()
DETECTOR = None
MODEL_ERROR = None
DEFAULTS = {
    "landing": True, "last_hit": False, "pickup": True,
    "fusion": "consensus", "threshold": 0.6, "gesture": True,
    "hold_seconds": 1.2, "correction_window": 15, "idle_seconds": 2.5,
    "hand": "right", "near_team": "A", "court": [], "target": 21,
}


def close_detector():
    global DETECTOR
    with POSE_LOCK:
        if DETECTOR is not None:
            DETECTOR.close()
            DETECTOR = None


atexit.register(close_detector)


def detect_poses(bgr):
    global DETECTOR, MODEL_ERROR
    with POSE_LOCK:
        if DETECTOR is None and MODEL_ERROR is None:
            try:
                import mediapipe as mp
                model = ROOT / "models/pose_landmarker_lite.task"
                if not model.exists():
                    raise FileNotFoundError("실행 전 setup.ps1로 포즈 모델을 설치하세요.")
                DETECTOR = mp.tasks.vision.PoseLandmarker.create_from_options(
                    mp.tasks.vision.PoseLandmarkerOptions(
                        base_options=mp.tasks.BaseOptions(model_asset_buffer=model.read_bytes()),
                        running_mode=mp.tasks.vision.RunningMode.IMAGE, num_poses=4,
                        min_pose_detection_confidence=0.45, min_pose_presence_confidence=0.45,
                    ))
            except Exception as exc:
                MODEL_ERROR = str(exc)
        if DETECTOR is None:
            return []
        import mediapipe as mp
        result = DETECTOR.detect(mp.Image(image_format=mp.ImageFormat.SRGB,
                                         data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
        return [[[round(p.x, 4), round(p.y, 4), round(p.visibility, 3)] for p in pose]
                for pose in result.pose_landmarks]


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def visible(pose, ids, threshold=0.55):
    return len(pose) == 33 and all(pose[i][2] >= threshold for i in ids)


def cross_pose(p):
    """Two forearms intersect ABOVE elbows, with visible shoulders/elbows/wrists."""
    if not visible(p, [11, 12, 13, 14, 15, 16], 0.65):
        return False
    a, b, c, d = p[13], p[15], p[14], p[16]
    def orient(p1, p2, p3):
        return (p2[0]-p1[0])*(p3[1]-p1[1])-(p2[1]-p1[1])*(p3[0]-p1[0])
    shoulder_width = dist(p[11], p[12])
    return (shoulder_width > .035 and orient(a, b, c)*orient(a, b, d) < 0
            and orient(c, d, a)*orient(c, d, b) < 0
            and b[1] < a[1] and d[1] < c[1]
            and max(b[1], d[1]) < (p[11][1]+p[12][1])/2+.07
            and dist(b, d) > shoulder_width*.22)


class ScoreBook:
    def __init__(self, events=None, target=21):
        self.events = events or []
        self.target = target

    def state(self):
        points, games, completed = {"A": 0, "B": 0}, {"A": 0, "B": 0}, []
        server = None
        for event in self.events:
            if games["A"] == 2 or games["B"] == 2:
                break
            winner = event["winner"]
            points[winner] += 1
            server = winner
            other = "B" if winner == "A" else "A"
            if (points[winner] >= self.target and points[winner]-points[other] >= 2
                    or points[winner] >= self.target+9):
                completed.append(dict(points))
                games[winner] += 1
                points = {"A": 0, "B": 0}
        return {"points": points, "games": games, "completed": completed,
                "server": server, "match_over": max(games.values()) >= 2,
                "events": self.events[-30:], "total_events": len(self.events)}

    def add(self, winner, timestamp, source="manual", evidence=None):
        if winner not in ("A", "B") or self.state()["match_over"]:
            return False
        self.events.append({"id": len(self.events)+1, "winner": winner, "time": timestamp,
                            "source": source, "corrected": False, "evidence": evidence or []})
        return True

    def flip(self, timestamp, window=None):
        if not self.events:
            return False
        e = self.events[-1]
        if window is not None and (e["corrected"] or not 0 <= timestamp-e["time"] <= window):
            return False
        e["original_winner"] = e.get("original_winner", e["winner"])
        e["winner"] = "B" if e["winner"] == "A" else "A"
        e["corrected"] = True
        return True


def combine_votes(votes, settings):
    enabled = [v for v in votes if settings.get(v["algorithm"])]
    if not enabled:
        return None
    total = {team: sum(v["strength"] for v in enabled if v["winner"] == team) for team in "AB"}
    winner = max(total, key=total.get)
    opposing = total["B" if winner == "A" else "A"]
    supporting = [v for v in enabled if v["winner"] == winner]
    # Strength is a heuristic score, NOT a calibrated probability. Disagreement abstains.
    if opposing > 0 or total[winner] == 0:
        return None
    if settings["fusion"] == "consensus" and len({v["family"] for v in supporting}) < 2:
        return None
    strength = min(.8, max(v["strength"] for v in supporting)+.08*(len(supporting)-1))
    return {"winner": winner, "strength": round(strength, 2), "votes": supporting} if strength >= settings["threshold"] else None


class Engine:
    def __init__(self, settings=None, events=None):
        self.settings = {**DEFAULTS, **(settings or {})}
        self.book = ScoreBook(events, self.settings["target"])
        self.prev_gray = None
        self.prev_time = None
        self.tracks = {}
        self.next_id = 1
        self.rally_start = None
        self.last_action = None
        self.active_since = None
        self.stroke_count = 0
        self.last_hitter = None
        self.shuttle = deque(maxlen=40)
        self.clips = []
        self.strokes = []
        self.last_result = {}
        self.pending = None
        self.x_since = {}
        self.x_latched = False
        self.frame_count = 0
        self.previous_mode = None

    def team_at(self, x, y):
        court = self.settings.get("court")
        if len(court) != 4:
            return None
        matrix = cv2.getPerspectiveTransform(np.float32(court), np.float32([[0, 1], [1, 1], [1, 0], [0, 0]]))
        q = cv2.perspectiveTransform(np.float32([[[x, y]]]), matrix)[0][0]
        if not (0 <= q[0] <= 1 and 0 <= q[1] <= 1):
            return None
        near = self.settings["near_team"]
        return near if q[1] >= .5 else ("B" if near == "A" else "A")

    def process(self, frame, t, mode="analysis", poses=None):
        self.frame_count += 1
        # A gap breaks gesture continuity and rally evidence, never bridges missing video.
        gap = (self.prev_time is not None and (t-self.prev_time > 1.0 or t <= self.prev_time)
               or self.previous_mode is not None and mode != self.previous_mode)
        self.previous_mode = mode
        if gap:
            self.x_since.clear()
            self.tracks.clear()
            self.prev_gray = None
            self.rally_start = self.active_since = self.last_action = None
            self.last_hitter = None
            self.stroke_count = 0
            self.shuttle.clear()
        dt = max(.03, t-(self.prev_time or t-.15))
        self.prev_time = t
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (480, 270))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(gray, self.prev_gray) if self.prev_gray is not None else np.zeros_like(gray)
        motion = float(np.mean(diff > 24))
        self.prev_gray = gray
        poses = detect_poses(frame) if poses is None else poses
        people, new_tracks, used = [], {}, set()
        action = False
        pickup_teams = []
        guidance = []
        feedback = []
        any_x = False
        x_progress = 0
        for p in poses:
            if not visible(p, [11, 12, 23, 24], .45):
                continue
            center = [(p[23][0]+p[24][0])/2, (p[23][1]+p[24][1])/2]
            matches = [(dist(center, v["center"]), key) for key, v in self.tracks.items() if key not in used]
            match = min(matches, default=(1, -1))
            ident = match[1] if match[0] < .18 else self.next_id
            if ident == self.next_id:
                self.next_id += 1
            used.add(ident)
            prev = self.tracks.get(ident)
            left = self.settings["hand"] == "left"
            shoulder, elbow, wrist, other_wrist = (11, 13, 15, 16) if left else (12, 14, 16, 15)
            wrist_ok = visible(p, [shoulder, elbow, wrist])
            speed = dist(p[wrist], prev["pose"][wrist])/dt if prev and wrist_ok and visible(prev["pose"], [wrist]) else 0
            raised = wrist_ok and p[wrist][1] < p[shoulder][1]-.045
            x = cross_pose(p)
            any_x |= x
            bent = visible(p, [15, 16, 25, 26]) and min(p[15][1], p[16][1]) > min(p[25][1], p[26][1])-.04
            is_action = not x and not bent and wrist_ok and speed > .38 and (raised or speed > .9)
            action |= is_action
            foot = [(p[27][0]+p[28][0])/2, max(p[27][1], p[28][1])]
            team = self.team_at(*foot) if visible(p, [27, 28], .45) else None
            if bent and team:
                pickup_teams.append(team)
            last_stroke = prev["last_stroke"] if prev else -99
            phase = "스윙 후보" if is_action else "준비 후보" if raised else "대기"
            if mode == "analysis" and prev and raised and is_action and t-last_stroke > 1.0:
                last_stroke = t
                item = {"time": round(t, 2), "player": ident, "title": "오버헤드 스윙 후보",
                        "note": "클리어 연습 모드의 관찰입니다. 셔틀·라켓 타점은 미확인입니다.",
                        "wrist_above_shoulder": round((p[shoulder][1]-p[wrist][1]), 3),
                        "preparation_seen": bool(prev.get("prepared")),
                        "contact": "측정 불가 — 라켓·셔틀 전용 모델 필요"}
                self.strokes.append(item)
                self.strokes = self.strokes[-200:]
            if is_action and t-(prev.get("hit_time", -99) if prev else -99) > .45:
                self.stroke_count += 1
                if team:
                    self.last_hitter = {"team": team, "time": t}
                hit_time = t
            else:
                hit_time = prev.get("hit_time", -99) if prev else -99
            if x and not gap:
                start = self.x_since.setdefault(ident, t)
                x_progress = max(x_progress, min(1, (t-start)/self.settings["hold_seconds"]))
            else:
                self.x_since.pop(ident, None)
            body_h = max(p[27][1], p[28][1])-p[0][1]
            if body_h < .25:
                guidance.append("선수가 너무 작습니다. 클리어 분석은 한 명이 화면 높이의 1/2 정도를 차지하도록 촬영하세요.")
            if not visible(p, [0, 15, 16, 27, 28]) or min(p[0][1], p[15][1], p[16][1]) < .03 or max(p[27][1], p[28][1]) > .97:
                guidance.append("머리 위 라켓 공간과 양발이 모두 보이도록 구도를 넓혀주세요.")
            if mode == "analysis" and raised:
                feedback.append("준비부터 스윙까지 관찰 중 · 타점의 앞뒤 위치와 그립은 현재 측정할 수 없습니다.")
            new_tracks[ident] = {"center": center, "pose": p, "last_stroke": last_stroke,
                                 "prepared": raised or (prev and prev.get("prepared") and t-last_stroke < 1.5),
                                 "hit_time": hit_time}
            people.append({"id": ident, "pose": p, "team": team, "phase": phase, "x": x})
        self.tracks = new_tracks
        self.x_since = {key: value for key, value in self.x_since.items() if key in new_tracks}
        if not any_x:
            self.x_latched = False

        # White small moving components: candidate only. Exclude visible people.
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        white = cv2.inRange(hsv, (0, 0, 190), (179, 90, 255))
        mask = cv2.bitwise_and(white, np.uint8(diff > 18)*255)
        for person in people:
            pts = [q for q in person["pose"] if q[2] > .5]
            x1, x2 = int(min(q[0] for q in pts)*480)-5, int(max(q[0] for q in pts)*480)+5
            y1, y2 = int(min(q[1] for q in pts)*270)-5, int(max(q[1] for q in pts)*270)+5
            cv2.rectangle(mask, (max(0,x1),max(0,y1)), (min(479,x2),min(269,y2)), 0, -1)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = []
        for c in contours:
            area = cv2.contourArea(c)
            x, y, cw, ch = cv2.boundingRect(c)
            if 1 <= area <= 60 and cw <= 22 and ch <= 22:
                candidates.append(((x+cw/2)/480, (y+ch/2)/270))
        candidate = None
        if candidates and len(candidates) <= 12:
            if self.shuttle and t-self.shuttle[-1][0] < .6:
                near = min(candidates, key=lambda q: dist(q, self.shuttle[-1][1:]))
                if dist(near, self.shuttle[-1][1:]) < .4:
                    candidate = near
            elif len(candidates) == 1:
                candidate = candidates[0]
        if candidate:
            self.shuttle.append((t, *candidate))

        if action and motion > .003:
            self.last_action = t
            self.active_since = self.active_since if self.active_since is not None else t
            if self.rally_start is None and self.stroke_count >= 2 and t-self.active_since >= .5:
                self.rally_start = max(0, self.active_since-.8)
                self.pending = None
        if self.active_since is not None and self.rally_start is None and self.last_action is not None and t-self.last_action > 2:
            self.active_since = None
            self.stroke_count = 0
        ended = False
        votes = []
        notice = None
        if self.rally_start is not None and self.last_action is not None and t-self.last_action >= self.settings["idle_seconds"]:
            start, end = self.rally_start, self.last_action+.8
            self.clips.append({"start": round(start,2), "end": round(end,2), "selected": True,
                               "label": "랠리 후보", "reason": "반복된 팔 움직임 후 정지 · 자동 구간은 검토가 필요합니다."})
            self.clips = self.clips[-300:]
            if self.shuttle and len(self.shuttle) >= 3:
                tail = list(self.shuttle)[-3:]
                if 0 <= self.last_action-tail[-1][0] <= 1 and tail[-1][2] > tail[0][2]+.025:
                    ground_team = self.team_at(tail[-1][1], tail[-1][2])
                    if ground_team:
                        votes.append({"algorithm": "landing", "winner": "B" if ground_team == "A" else "A",
                                      "strength": .58, "family": "shuttle", "reason": "흰 물체의 하강·소실 위치 가설 (바닥 접촉 미확인)"})
            if self.last_hitter and 0 <= t-self.last_hitter["time"] < 6:
                votes.append({"algorithm": "last_hit", "winner": self.last_hitter["team"], "strength": .38,
                              "family": "pose", "reason": "마지막 스윙 팀 가설 (아웃·네트 실수 구분 불가)"})
            if len(set(pickup_teams)) == 1:
                votes.append({"algorithm": "pickup", "winner": "B" if pickup_teams[0] == "A" else "A",
                              "strength": .32, "family": "pose", "reason": "줍는 팀의 반대편 가설 (득점 근거로는 약함)"})
            self.pending = {"time": t, "votes": votes, "decision": combine_votes(votes, self.settings)}
            if mode == "score" and self.pending["decision"]:
                decision = self.pending["decision"]
                self.book.add(decision["winner"], t, "experimental", decision["votes"])
                notice = f'{decision["winner"]}팀 시험 자동 득점 · 잘못되면 양팔 X'
            elif mode == "score":
                notice = "판정 보류 · 근거 부족 또는 알고리즘 불일치"
            self.rally_start = self.active_since = None
            self.stroke_count = 0
            self.last_hitter = None
            self.shuttle.clear()
            ended = True
        playing = self.rally_start is not None or (self.last_action is not None and t-self.last_action < 1.2)
        if mode == "score" and self.settings["gesture"] and x_progress >= 1 and not playing and not self.x_latched:
            self.x_latched = True
            if self.book.flip(t, self.settings["correction_window"]):
                notice = "양팔 X 확인 · 직전 득점 팀을 바꿨습니다"
        if not people:
            guidance.append("인물이 검출되지 않았습니다. 카메라 밝기와 전신이 보이는지 확인하세요.")
        if len(self.settings["court"]) != 4 and mode == "score":
            guidance.append("코트의 네 모서리를 지정해야 A/B 팀 위치를 연결할 수 있습니다.")
        status = "랠리 진행" if playing else "준비 / 휴식"
        self.last_result = {"time": round(t,3), "frame_count": self.frame_count, "people": people,
                            "shuttle": list(candidate) if candidate else None, "motion": round(motion,4),
                            "status": status, "clips": self.clips, "strokes": self.strokes[-20:],
                            "score": self.book.state(), "pending": self.pending,
                            "guidance": list(dict.fromkeys(guidance)), "feedback": list(dict.fromkeys(feedback)),
                            "gesture_progress": round(x_progress,2), "notice": notice,
                            "model_error": MODEL_ERROR, "rally_ended": ended, "gap": gap}
        return self.last_result

    def finish(self, duration):
        if self.rally_start is not None and self.last_action is not None:
            self.clips.append({"start": round(self.rally_start,2), "end": round(min(duration,self.last_action+.8),2),
                               "selected": True, "label": "마지막 랠리 후보", "reason": "영상 종료로 구간 마감"})
            self.rally_start = None
        # Merge overlapping windows; keep source timestamps for review/export.
        merged = []
        for clip in sorted(self.clips, key=lambda x:x["start"]):
            clip = {**clip, "end": min(duration, clip["end"])}
            if merged and clip["start"] <= merged[-1]["end"]:
                merged[-1]["end"] = max(merged[-1]["end"], clip["end"])
            elif clip["end"] > clip["start"]:
                merged.append(clip)
        self.clips = merged
        return merged
