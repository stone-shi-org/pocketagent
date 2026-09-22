import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { PushToTalkRecorder, VoiceCaptureError, type RecordedUtterance } from '../audio/capture.js';
import { Icon } from './Icon.js';

interface Props {
  /** Fires once with the buffered utterance ready to transcribe. */
  onRecorded: (utterance: RecordedUtterance) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

type RecordingState = 'idle' | 'starting' | 'recording';

/** Threshold in ms to differentiate between a tap/click and a hold. */
const HOLD_THRESHOLD_MS = 350;

/**
 * Mic button (PA-20 Phase 1): supports both hold-to-record (release to stop)
 * and tap-to-record (tap to start, tap to stop). Hands the buffered utterance
 * to the caller (`PromptBox`), which transcribes it and submits the result
 * through the same send path typed text already uses.
 */
export function MicButton({ onRecorded, onError, disabled = false }: Props): JSX.Element {
  const [recording, setRecording] = useState(false);
  const stateRef = useRef<RecordingState>('idle');
  const pointerDownAtRef = useRef<number>(0);
  const recorderRef = useRef<PushToTalkRecorder | null>(null);

  // Belt and suspenders: a component unmount mid-hold (navigating away) must
  // not leave a live microphone stream behind.
  useEffect(
    () => () => {
      void recorderRef.current?.stop();
    },
    [],
  );

  function reportError(err: unknown, fallback: string): void {
    onError(err instanceof VoiceCaptureError ? err.message : fallback);
  }

  async function stopAndEmit(): Promise<void> {
    const recorder = recorderRef.current;
    stateRef.current = 'idle';
    setRecording(false);
    recorderRef.current = null;
    if (!recorder) return;
    try {
      const utterance = await recorder.stop();
      onRecorded(utterance);
    } catch (err) {
      reportError(err, 'Could not finish recording.');
    }
  }

  async function begin(event: PointerEvent<HTMLButtonElement>): Promise<void> {
    if (disabled) return;

    // If already recording (from a tap), a second click/tap stops and sends.
    if (stateRef.current === 'recording') {
      await stopAndEmit();
      return;
    }

    if (stateRef.current !== 'idle') return;
    stateRef.current = 'starting';
    pointerDownAtRef.current = performance.now();
    event.currentTarget.setPointerCapture(event.pointerId);

    const recorder = new PushToTalkRecorder();
    try {
      await recorder.start();
    } catch (err) {
      stateRef.current = 'idle';
      reportError(err, 'Could not start recording.');
      return;
    }
    recorderRef.current = recorder;

    if ((stateRef.current as RecordingState) === 'idle') {
      // Released while start() was in flight after a long hold.
      await stopAndEmit();
      return;
    }

    stateRef.current = 'recording';
    setRecording(true);
  }

  async function end(): Promise<void> {
    if (stateRef.current === 'idle') return;

    const heldMs = performance.now() - pointerDownAtRef.current;
    if (heldMs < HOLD_THRESHOLD_MS) {
      // Tap detected — keep recording active so user can speak hands-free,
      // then tap again to stop and submit.
      return;
    }

    // Held down >= HOLD_THRESHOLD_MS — standard push-to-talk release.
    if (stateRef.current === 'starting') {
      stateRef.current = 'idle';
      return;
    }

    await stopAndEmit();
  }

  return (
    <button
      type="button"
      className={recording ? 'mic-btn recording' : 'mic-btn'}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={recording ? 'Recording — tap or release to send' : 'Hold or tap to record a voice prompt'}
      onPointerDown={(e) => void begin(e)}
      onPointerUp={() => void end()}
      onPointerCancel={() => void end()}
    >
      <Icon name="mic" size={19} />
    </button>
  );
}
