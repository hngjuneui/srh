// @ts-check
// Turns raw key events from a Bluetooth remote into at most one action per press.
// Handles both remotes that repeat keydown while held and remotes that send
// keydown/keyup pairs over and over: a release only counts after `releaseGrace` ms
// of silence, so a burst of pairs is treated as one long hold.

/**
 * @typedef {{primary: string|null, opponent: string|null, cancel: string|null, longMs: number, releaseGrace: number, useLong: boolean}} RemoteConfig
 * @typedef {'short'|'long'|'opponent'|'cancel'} RemoteAction
 */

export const DEFAULT_REMOTE = /** @type {RemoteConfig} */ ({primary: null, opponent: null, cancel: null, longMs: 700, releaseGrace: 150, useLong: true});

const IGNORED = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Unidentified', 'Process']);

/** A stable name for a physical button; `code` is often empty on Android remotes. @param {{key: string, code: string, keyCode?: number}} e */
export function keyId(e) {
  if (e.code) return `code:${e.code}`;
  if (e.key && e.key !== 'Unidentified') return `key:${e.key}`;
  return `keyCode:${e.keyCode ?? 0}`;
}

export class RemoteInput {
  /** @param {RemoteConfig} config @param {(action: RemoteAction, info: {id: string, heldMs: number}) => void} onAction */
  constructor(config, onAction, timers = {set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms), clear: (/** @type {any} */ id) => clearTimeout(id), now: () => performance.now()}) {
    this.config = config;
    this.onAction = onAction;
    this.timers = timers;
    /** @type {null | {id: string, downAt: number, longDone: boolean, longTimer: any, releaseTimer: any, staleTimer: any}} */
    this.press = null;
  }

  /** Which configured role a key plays, or null to ignore it. @param {string} id */
  role(id) {
    const c = this.config;
    if (c.opponent === id) return 'opponent';
    if (c.cancel === id) return 'cancel';
    if (c.primary === id || (c.primary === null && c.opponent === null && c.cancel === null)) return 'primary';
    return null;
  }

  /** @param {{key: string, code: string, keyCode?: number}} e @returns {boolean} whether the event was consumed */
  keydown(e) {
    if (IGNORED.has(e.key)) return false;
    const id = keyId(e);
    const role = this.role(id);
    if (!role) return false;
    if (this.press) {
      // Still the same press: an auto-repeat, or a key-up/key-down pair inside the grace window.
      if (this.press.id === id) {
        this.timers.clear(this.press.releaseTimer);
        this.press.releaseTimer = null;
        this.watch(this.press);
      }
      return true;
    }
    const press = {id, downAt: this.timers.now(), longDone: false, longTimer: /** @type {any} */ (null), releaseTimer: /** @type {any} */ (null), staleTimer: /** @type {any} */ (null)};
    this.press = press;
    this.watch(press);
    if (role === 'opponent' || role === 'cancel') {
      // Dedicated buttons act immediately; the rest of the press is swallowed.
      press.longDone = true;
      this.onAction(role, {id, heldMs: 0});
    } else if (this.config.useLong) {
      press.longTimer = this.timers.set(() => {
        press.longDone = true;
        this.onAction('long', {id, heldMs: this.timers.now() - press.downAt});
      }, this.config.longMs);
    } else {
      press.longDone = true;
      this.onAction('short', {id, heldMs: 0});
    }
    return true;
  }

  /** @param {{key: string, code: string, keyCode?: number}} e @returns {boolean} */
  keyup(e) {
    const id = keyId(e);
    const press = this.press;
    if (!press || press.id !== id) return this.role(id) !== null && !IGNORED.has(e.key);
    const releasedAt = this.timers.now();
    this.timers.clear(press.releaseTimer);
    press.releaseTimer = this.timers.set(() => this.finish(press, releasedAt), this.config.releaseGrace);
    return true;
  }

  /** A remote that never sends key-up must not lock input forever. @param {NonNullable<RemoteInput['press']>} press */
  watch(press) {
    this.timers.clear(press.staleTimer);
    press.staleTimer = this.timers.set(() => this.finish(press, this.timers.now()), Math.max(1500, this.config.longMs + 500));
  }

  /** @param {NonNullable<RemoteInput['press']>} press @param {number} releasedAt */
  finish(press, releasedAt) {
    if (this.press !== press) return;
    this.timers.clear(press.longTimer);
    this.timers.clear(press.releaseTimer);
    this.timers.clear(press.staleTimer);
    this.press = null;
    if (!press.longDone) this.onAction('short', {id: press.id, heldMs: releasedAt - press.downAt});
  }

  reset() {
    if (!this.press) return;
    this.timers.clear(this.press.longTimer);
    this.timers.clear(this.press.releaseTimer);
    this.timers.clear(this.press.staleTimer);
    this.press = null;
  }
}
