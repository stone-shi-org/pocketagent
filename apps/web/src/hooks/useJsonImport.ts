import { useRef, type ChangeEvent } from 'react';
import type { PocketAgentExportEnvelope, PocketAgentExportKind } from '@pocketagent/protocol';
import { importFromJsonFile } from '../agent/json-transfer.js';

interface UseJsonImportOptions<T> {
  /** If provided, rejects files whose envelope kind does not match this with a clear error. */
  expectedKind?: PocketAgentExportKind;
  onSuccess: (result: { envelope: PocketAgentExportEnvelope; data: T }) => void | Promise<void>;
  onError: (error: string) => void;
}

/**
 * Hook providing a hidden file input and a trigger function to import and validate
 * a PocketAgent JSON export file.
 */
export function useJsonImport<T = unknown>({
  expectedKind,
  onSuccess,
  onError,
}: UseJsonImportOptions<T>) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const trigger = (): void => {
    inputRef.current?.click();
  };

  const onChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await importFromJsonFile<T>(file, expectedKind);
      if (!res.ok) {
        onError(res.error);
      } else {
        await onSuccess({ envelope: res.envelope, data: res.data });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  return {
    trigger,
    fileInputProps: {
      ref: inputRef,
      type: 'file' as const,
      accept: '.json,application/json',
      style: { display: 'none' as const },
      onChange,
    },
  };
}
