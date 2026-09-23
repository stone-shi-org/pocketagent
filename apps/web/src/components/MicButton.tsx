import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent } from 'react';
import { PushToTalkRecorder, VoiceCaptureError, type RecordedUtterance } from '../audio/capture.js';
import { Icon } from './Icon.js';

export interface MicButtonProps {
  /** Fires once with the buffered utterance ready to transcribe. */
  onRecorded: (utterance: RecordedUtterance) => void;
  onError: (message: string) => void;
  /** Reports when recording state changes so the prompt box can adapt its UI (PA-82). */
  onRecordingChange?: (recording: boolean) => void;
  /** Real-time RMS audio level stream during recording (PA-82). */
  onLevel?: (level: number) => void;
  /** Notifies whether the active pointer is hovering over the discard button. */
  onOverDiscardChange?: (over: boolean) => void;
  disabled?: boolean;
  /** Specific microphone device ID (PA-94). */
  deviceId?: string;
  /** Context menu handler (e.g. right-click to open mic picker) (PA-94). */
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface MicButtonHandle {
  /** Cancels recording immediately, discarding buffered audio. */
  cancel: () => Promise<void>;
  /** Finishes recording and emits the buffered utterance for transcription. */
  stop: () => Promise<void>;
}

type RecordingState = 'idle' | 'starting' | 'recording';

/** Threshold in ms to differentiate between a tap/click and a hold. */
const HOLD_THRESHOLD_MS = 350;

/**
 * Mic button (PA-20 Phase 1, enhanced in PA-82): supports both hold-to-record
 * (release to stop) and tap-to-record (tap to start, second click to stop).
 * Hands the buffered utterance to the caller (`PromptBox`), which transcribes
 * it and either populates the prompt box (default) or sends directly.
 */
export const MicButton = forwardRef<MicButtonHandle, MicButtonProps>(function MicButton(
  {
    onRecorded,
    onError,
    onRecordingChange,
    onLevel,
    onOverDiscardChange,
    disabled = false,
    deviceId,
    onContextMenu,
  }: MicButtonProps,
  ref,
): JSX.Element {
  const [recording, setRecording] = useState(false);
  const stateRef = useRef<RecordingState>('idle');
  const pointerDownAtRef = useRef<number>(0);
  const recorderRef = useRef<PushToTalkRecorder | null>(null);

  // Belt and suspenders: a component unmount mid-hold (navigating away) must
  // not leave a live microphone stream behind.
  useEffect(
    () => () => {
      void recorderRef.current?.cancel();
    },
    [],
  );

  function reportError(err: unknown, fallback: string): void {
    onError(err instanceof VoiceCaptureError ? err.message : fallback);
  }

  async function cancelRecording(): Promise<void> {
    const recorder = recorderRef.current;
    stateRef.current = 'idle';
    setRecording(false);
    onRecordingChange?.(false);
    onLevel?.(0);
    onOverDiscardChange?.(false);
    recorderRef.current = null;
    if (!recorder) return;
    try {
      await recorder.cancel();
    } catch {
      // Best effort teardown
    }
  }

  async function stopAndEmit(): Promise<void> {
    const recorder = recorderRef.current;
    stateRef.current = 'idle';
    setRecording(false);
    onRecordingChange?.(false);
    onLevel?.(0);
    onOverDiscardChange?.(false);
    recorderRef.current = null;
    if (!recorder) return;
    try {
      const utterance = await recorder.stop();
      onRecorded(utterance);
    } catch (err) {
      reportError(err, 'Could not finish recording.');
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      cancel: cancelRecording,
      stop: stopAndEmit,
    }),
    [],
  );

  async function begin(event: PointerEvent<HTMLButtonElement>): Promise<void> {
    if (disabled || event.button !== 0) return;

    // If already recording (from a tap), a second click/tap stops and sends.
    if (stateRef.current === 'recording') {
      await stopAndEmit();
      return;
    }

    if (stateRef.current !== 'idle') return;
    stateRef.current = 'starting';
    pointerDownAtRef.current = performance.now();
    event.currentTarget.setPointerCapture(event.pointerId);

    const recorder = new PushToTalkRecorder({ onLevel, deviceId });
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
    onRecordingChange?.(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>): void {
    if (stateRef.current === 'idle') return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const overDiscard = Boolean(target?.closest('.voice-discard-btn'));
    onOverDiscardChange?.(overDiscard);
  }

  async function end(event: PointerEvent<HTMLButtonElement>): Promise<void> {
    if (stateRef.current === 'idle') return;

    // Check if pointer was released over the discard/stop button
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target?.closest('.voice-discard-btn')) {
      await cancelRecording();
      return;
    }

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

  async function handlePointerCancel(): Promise<void> {
    if (stateRef.current === 'idle') return;
    await cancelRecording();
  }

  return (
    <button
      type="button"
      className={recording ? 'mic-btn recording' : 'mic-btn'}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={recording ? 'Recording — tap or release to finish' : 'Hold or tap to record a voice prompt'}
      onPointerDown={(e) => void begin(e)}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => void end(e)}
      onPointerCancel={() => void handlePointerCancel()}
      onContextMenu={onContextMenu}
    >
      <Icon name="mic" size={19} />
    </button>
  );
});
