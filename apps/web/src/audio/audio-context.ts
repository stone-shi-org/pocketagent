/**
 * Shared Web Audio context management and iOS Safari autoplay unlocking (PA-54).
 *
 * Mobile Safari requires user gestures (pointerdown, touchstart, click) to transition
 * an AudioContext to the 'running' state. Furthermore, AudioContext playback initiated
 * asynchronously outside a gesture (e.g., when server TTS audio arrives minutes after
 * a prompt was submitted) will remain suspended unless the context was previously
 * unlocked and kept active.
 */

let sharedPlaybackContext: AudioContext | null = null;
let isUnlocked = false;

/**
 * Returns the shared AudioContext for audio playback (TTS, Gemini Live, etc.).
 * Recreates the context if closed or missing.
 */
export function getSharedAudioContext(): AudioContext {
  if (typeof AudioContext === 'undefined') {
    throw new Error('AudioContext is not supported in this environment.');
  }
  if (
    !sharedPlaybackContext ||
    sharedPlaybackContext.state === 'closed' ||
    (typeof AudioContext !== 'undefined' && sharedPlaybackContext.constructor !== AudioContext)
  ) {
    sharedPlaybackContext = new AudioContext();
    isUnlocked = false;
  }
  return sharedPlaybackContext;
}

/**
 * Unlocks the given AudioContext (or the shared one) within a user gesture.
 * If suspended, calls resume() and plays a 1-sample silent buffer to ensure Mobile Safari's
 * audio engine marks the context as user-activated for future asynchronous playback.
 */
export async function unlockAudioContext(ctx?: AudioContext): Promise<boolean> {
  let context: AudioContext;
  try {
    context = ctx ?? getSharedAudioContext();
  } catch {
    return false;
  }

  if (context.state === 'running' && isUnlocked) {
    return true;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }
    // Playing a tiny silent buffer is the canonical iOS Web Audio unlock trigger.
    const buffer = context.createBuffer(1, 1, 22050);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);
    isUnlocked = true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Attaches passive gesture listeners to the window so any touch, pointer,
 * or key event unlocks and keeps the shared playback AudioContext running.
 */
let registeredListenerCount = 0;
let removeGlobalListeners: (() => void) | null = null;

export function registerAudioUnlockListeners(): () => void {
  if (typeof window === 'undefined') return () => {};

  registeredListenerCount++;
  if (registeredListenerCount === 1) {
    const events = ['pointerdown', 'touchstart', 'keydown'] as const;
    const onGesture = () => {
      try {
        const ctx = getSharedAudioContext();
        if (ctx.state === 'suspended' || !isUnlocked) {
          void unlockAudioContext(ctx);
        }
      } catch {
        // AudioContext unavailable
      }
    };

    for (const ev of events) {
      window.addEventListener(ev, onGesture, { capture: true, passive: true });
    }

    removeGlobalListeners = () => {
      for (const ev of events) {
        window.removeEventListener(ev, onGesture, { capture: true });
      }
    };
  }

  return () => {
    registeredListenerCount = Math.max(0, registeredListenerCount - 1);
    if (registeredListenerCount === 0 && removeGlobalListeners) {
      removeGlobalListeners();
      removeGlobalListeners = null;
    }
  };
}

/**
 * Resets the shared playback AudioContext. Primarily for testing.
 */
export function resetSharedAudioContext(): void {
  if (sharedPlaybackContext && sharedPlaybackContext.state !== 'closed') {
    void sharedPlaybackContext.close().catch(() => {});
  }
  sharedPlaybackContext = null;
  isUnlocked = false;
}
