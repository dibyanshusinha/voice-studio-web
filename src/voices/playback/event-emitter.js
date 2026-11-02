/** Small playback-event utility that avoids coupling the audio player to React or DOM EventTarget. */
// Modified for Voice Studio. Third-party MIT notice: /licenses/audio-components-MIT.txt
export class EventEmitter {
  /** Creates an independent subscription registry for each playback object. */
  constructor() {
    this.events = {};
  }
  /** Registers playback-event consumers, optionally removing them after their first notification. */
  addEventListener(event, listener, options = {}) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    const wrappedListener = {
      callback: listener,
      once: options.once || false
    };
    this.events[event].push(wrappedListener);
  }
  /** Unsubscribes a consumer so discarded UI or playback objects no longer receive notifications. */
  removeEventListener(event, listener) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(wrappedListener => wrappedListener.callback !== listener);
  }
  /** Notifies listeners and removes one-shot subscriptions after delivery. */
  dispatchEvent(event) {
    const eventName = event.type;
    if (!this.events[eventName]) return;
    this.events[eventName] = this.events[eventName].filter(wrappedListener => {
      wrappedListener.callback.call(this, event);
      return !wrappedListener.once;
    });
  }
  /** Packages playback metrics as a small event object before notifying subscribers. */
  emit(eventName, data) {
    const event = new CustomEvent(eventName, {
      detail: data
    });
    this.dispatchEvent(event);
  }
}
export class CustomEvent {
  /** Stores playback event details without depending on browser-only CustomEvent constructors. */
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
  }
  /** Tracks cancellation only for events that explicitly support it. */
  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }
}
