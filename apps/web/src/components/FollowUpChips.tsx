/**
 * Suggested next questions, generated from the question/answer pair that
 * just finished. Clickable chips that feed directly into the composer.
 */
export function FollowUpChips({
  suggestions,
  onPick,
  disabled,
}: {
  suggestions: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
}): JSX.Element | null {
  if (suggestions.length === 0) return null;

  return (
    <div className="followup-chips" role="group" aria-label="Follow-up suggestions">
      {suggestions.map((prompt) => (
        <button
          key={prompt}
          type="button"
          disabled={disabled}
          onClick={() => onPick(prompt)}
          className="followup-chip"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}
