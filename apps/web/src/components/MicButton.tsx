import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { PushToTalkRecorder, VoiceCaptureError, type RecordedUtterance } from '../audio/capture.js';
import { Icon } from './Icon.js';

interface Props {
  /** Fires once, on release, with the buffered utterance ready to transcribe. */
  onRecorded: (utterance: RecordedUtterance) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

type RecordingState = 'idle' | 'starting' | 'recording';

/**
 * Push-to-talk mic button (PA-20 Phase 1): hold to record, release to stop
 * and hand the buffered utterance to the caller (`PromptBox`), which
 * transcribes it and submits the result through the same send path typed
 * text already uses.
 *
 * Pointer Events, not separate mouse/touch listeners, with pointer capture
 * on press — a hold-and-drag off the button on a touchscreen still reliably
 * delivers `pointerup` to this element, which mouse/touch listeners alone do
 * not guarantee.
 *
 * `getUserMedia` (inside `PushToTalkRecorder.start()`) is async and can pause
 * on a permission prompt, so a very quick tap can release *before* recording
 * has actually started — `stopRequested` remembers that and stops
 * immediately once `start()` resolves, rather than leaving the mic open with
 * nothing left listening for the release that already happened.
 */
export function MicButton({ onRecorded, onError, disabled = false }: Props): JSX.Element {
  const [recording, setRecording] = useState(false);
  const stateRef = useRef<RecordingState>('idle');
  const stopRequestedRef = useRef(false);
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

  async function begin(event: PointerEvent<HTMLButtonElement>): Promise<void> {
    if (disabled || stateRef.current !== 'idle') return;
    stateRef.current = 'starting';
    stopRequestedRef.current = false;
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

    if (stopRequestedRef.current) {
      // Released while the permission prompt/start-up was still in flight.
      stateRef.current = 'idle';
      recorderRef.current = null;
      try {
        onRecorded(await recorder.stop());
      } catch (err) {
        reportError(err, 'Could not finish recording.');
      }
      return;
    }

    stateRef.current = 'recording';
    setRecording(true);
  }

  async function end(): Promise<void> {
    if (stateRef.current === 'starting') {
      stopRequestedRef.current = true;
      return;
    }
    if (stateRef.current !== 'recording') return;
    stateRef.current = 'idle';
    setRecording(false);

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    try {
      onRecorded(await recorder.stop());
    } catch (err) {
      reportError(err, 'Could not finish recording.');
    }
  }

  return (
    <button
      type="button"
      className={recording ? 'mic-btn recording' : 'mic-btn'}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={recording ? 'Recording — release to send' : 'Hold to record a voice prompt'}
      onPointerDown={(e) => void begin(e)}
      onPointerUp={() => void end()}
      onPointerCancel={() => void end()}
    >
      <Icon name="mic" size={19} />
    </button>
  );
}
