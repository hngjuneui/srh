// @ts-check
// Score call-outs in Korean, read by the device's own voice (Web Speech API). The server's score comes first.
//   full:  every number as it is            11 : 7 → "십일 대 칠"
//   short: the 10s drop their "십"         11 : 7 → "일, 칠"   10 → "영"   20 and up stay as they are

const DIGIT = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

/** Sino-Korean reading of 0..99. @param {number} n */
export function koreanNumber(n) {
  if (n < 10) return DIGIT[n];
  const tens = Math.floor(n / 10), ones = n % 10;
  return `${tens === 1 ? '' : DIGIT[tens]}십${ones ? DIGIT[ones] : ''}`;
}

/** @param {number} n @param {'full'|'short'} mode */
function say(n, mode) {
  return mode === 'short' && n >= 10 && n < 20 ? DIGIT[n - 10] : koreanNumber(n);
}

/** What to say for a score, the serving side first. @param {number} server @param {number} receiver @param {'full'|'short'} mode */
export function scoreCall(server, receiver, mode) {
  return mode === 'short' ? `${say(server, mode)}, ${say(receiver, mode)}` : `${say(server, mode)} 대 ${say(receiver, mode)}`;
}

/** @type {SpeechSynthesisVoice|null} */ let koVoice = null;
function pickVoice() {
  const voices = globalThis.speechSynthesis?.getVoices() ?? [];
  koVoice = voices.find(v => v.lang === 'ko-KR') ?? voices.find(v => v.lang?.startsWith('ko')) ?? null;
}
globalThis.speechSynthesis?.addEventListener?.('voiceschanged', pickVoice);

/** Says `text` now, cutting off anything still being said so the board never lags behind the game. @param {string} text */
export function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth) return false;
  if (!koVoice) pickVoice();
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR'; u.rate = 1.05;
  if (koVoice) u.voice = koVoice;
  synth.speak(u);
  return true;
}
