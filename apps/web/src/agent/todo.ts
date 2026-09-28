export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Extract task checklist items from a `TodoWrite` (or similar task management) tool call.
 *
 * Like `planFromToolInput` in `agent/plan.ts`: a pure, defensive extractor that parses
 * known todo list shapes into structured items for visual checklist rendering.
 * Returns null if the tool is not a todo tool or does not contain structured todos.
 */
export function todosFromToolInput(name: string, input: Record<string, unknown>): TodoItem[] | null {
  if (name !== 'TodoWrite' && name !== 'Todo') return null;
  const rawTodos = input.todos ?? input.tasks;
  if (!Array.isArray(rawTodos)) return null;

  const items: TodoItem[] = [];
  for (const raw of rawTodos) {
    if (typeof raw === 'object' && raw !== null) {
      const rec = raw as Record<string, unknown>;
      const content =
        typeof rec.content === 'string'
          ? rec.content
          : typeof rec.text === 'string'
            ? rec.text
            : typeof rec.task === 'string'
              ? rec.task
              : typeof rec.title === 'string'
                ? rec.title
                : '';
      if (!content.trim()) continue;

      const statusRaw = typeof rec.status === 'string' ? rec.status.toLowerCase() : rec.completed ? 'completed' : 'pending';
      const status: TodoItem['status'] =
        statusRaw === 'completed' || statusRaw === 'done'
          ? 'completed'
          : statusRaw === 'in_progress' || statusRaw === 'running'
            ? 'in_progress'
            : 'pending';

      items.push({ content: content.trim(), status });
    }
  }

  return items.length > 0 ? items : null;
}
