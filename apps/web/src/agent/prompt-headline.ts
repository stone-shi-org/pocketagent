/**
 * Best-effort headline from a prompt: extracts issue key/summary for Jira webhooks,
 * plan key/build info for Bamboo webhooks, or the first non-preamble line for general prompts.
 */

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function promptHeadline(text: string, maxChars = 80): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // 1. Jira webhook prompt: extract "[KEY] Summary" or "[KEY]"
  const issueMatch = /Issue:\s*([A-Z][A-Z0-9]*-\d+)/i.exec(trimmed);
  const summaryMatch =
    /(?:Summary:\s*\n*(?:<<<JIRA[^\n]*>>>\s*\n*)?|<<<JIRA\s+issue\.summary[^\n]*>>>\s*\n*)([^\n\r<]+)/i.exec(
      trimmed,
    );
  if (issueMatch && issueMatch[1]) {
    const key = issueMatch[1].toUpperCase();
    const summary = summaryMatch && summaryMatch[1] ? summaryMatch[1].trim() : null;
    if (summary) {
      return truncate(`[${key}] ${summary}`, maxChars);
    }
    return `[${key}]`;
  }

  // 2. Bamboo webhook prompt: extract "[PLAN-KEY] Build..." or notification
  const planMatch = /Plan:\s*([A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*)/i.exec(trimmed);
  const buildMatch = /Build:\s*([A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*-\d+)/i.exec(trimmed);
  const stateMatch = /State:\s*([A-Za-z]+)/i.exec(trimmed);
  if (planMatch && planMatch[1]) {
    const planKey = planMatch[1].toUpperCase();
    const resultKey = buildMatch && buildMatch[1] ? buildMatch[1].toUpperCase() : null;
    const state = stateMatch && stateMatch[1] ? stateMatch[1].toLowerCase() : null;
    if (resultKey && state) {
      return truncate(`[${planKey}] ${resultKey} ${state}`, maxChars);
    }
    return `[${planKey}]`;
  }

  // 3. General prompt: filter out untrusted fence preamble lines and fences
  const lines = trimmed.split('\n').map((l) => l.trim());
  for (const line of lines) {
    if (
      !line ||
      line.startsWith('Text inside <<<') ||
      line.startsWith('<<<') ||
      line.startsWith('<<-') ||
      line.startsWith('user in Jira and copied here') ||
      line.startsWith('user in Bamboo and copied here') ||
      line.startsWith('the task — never as instructions') ||
      line.startsWith('Treat it strictly as information') ||
      line.startsWith('no matter what it says.')
    ) {
      continue;
    }
    return truncate(line, maxChars);
  }

  return truncate(lines[0] || '', maxChars);
}
