import { describe, expect, it } from 'vitest';
import { todosFromToolInput } from './todo.js';

describe('todosFromToolInput', () => {
  it('returns null for unrelated tools', () => {
    expect(todosFromToolInput('Bash', { command: 'ls' })).toBeNull();
    expect(todosFromToolInput('ExitPlanMode', { plan: 'my plan' })).toBeNull();
  });

  it('returns null if todos is missing or not an array', () => {
    expect(todosFromToolInput('TodoWrite', {})).toBeNull();
    expect(todosFromToolInput('TodoWrite', { todos: 'not an array' })).toBeNull();
    expect(todosFromToolInput('TodoWrite', { todos: [] })).toBeNull();
  });

  it('extracts structured todos with status', () => {
    const input = {
      todos: [
        { content: 'Write tests', status: 'completed' },
        { content: 'Implement checklist', status: 'in_progress' },
        { content: 'Deploy to prod', status: 'pending' },
      ],
    };
    expect(todosFromToolInput('TodoWrite', input)).toEqual([
      { content: 'Write tests', status: 'completed' },
      { content: 'Implement checklist', status: 'in_progress' },
      { content: 'Deploy to prod', status: 'pending' },
    ]);
  });

  it('handles task/done fallbacks', () => {
    const input = {
      tasks: [
        { task: 'Clean desk', completed: true },
        { text: 'Review PR', completed: false },
      ],
    };
    expect(todosFromToolInput('Todo', input)).toEqual([
      { content: 'Clean desk', status: 'completed' },
      { content: 'Review PR', status: 'pending' },
    ]);
  });
});
