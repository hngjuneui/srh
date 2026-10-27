// @ts-check
// Front camera + MediaPipe Pose Landmarker (lite). Everything is served from ./vendor so it works offline,
// and nothing here is downloaded until AI pose scoring is switched on.
// Detection runs `fps` times a second (12 by default): enough for gestures held for a second, and it keeps tablets cool.

const BASE = new URL('./vendor/mediapipe/', import.meta.url).href;

export class PoseCamera {
  /** @param {HTMLVideoElement} video @param {(people: {x: number, y: number, visibility?: number}[][], now: number) => void} onPeople */
  constructor(video, onPeople) {
    this.video = video;
    this.onPeople = onPeople;
    /** @type {any} */ this.landmarker = null;
    /** @type {MediaStream|null} */ this.stream = null;
    this.running = false;
    this.lastRun = 0;
    this.frameMs = 1000 / 12;
    this.raf = 0;
  }

  /** Loads the model (once) and starts the camera. Throws with a Korean message the caller can show. */
  async start() {
    if (this.running) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 30}}});
    } catch (e) {
      const denied = /** @type {any} */ (e)?.name === 'NotAllowedError';
      throw new Error(denied ? '카메라 권한이 거부되었습니다. 브라우저 주소창의 사이트 설정에서 카메라를 허용하세요.' : '카메라를 켤 수 없습니다.');
    }
    this.video.srcObject = this.stream;
    this.video.muted = true; this.video.playsInline = true;
    await this.video.play().catch(() => {});
    if (!this.landmarker) {
      try { this.landmarker = await load('GPU'); } catch { this.landmarker = await load('CPU'); }
    }
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    if (now - this.lastRun < this.frameMs - 4 || this.video.readyState < 2) return;
    this.lastRun = now;
    try {
      const result = this.landmarker.detectForVideo(this.video, now);
      this.onPeople(result.landmarks ?? [], now);
    } catch { /* a dropped frame is fine */ }
  }
}

/** @param {'GPU'|'CPU'} delegate */
async function load(delegate) {
  const {FilesetResolver, PoseLandmarker} = await import(BASE + 'vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks(BASE + 'wasm');
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {modelAssetPath: BASE + 'pose_landmarker_lite.task', delegate},
    runningMode: 'VIDEO', numPoses: 2,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
}
