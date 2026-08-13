import { describe, expect, it } from 'vitest';
import type { SlashCommandInfo } from '@pocketagent/protocol';
import { filterSlashCommands, slashFragment } from './PromptBox.js';

describe('slashFragment', () => {
  it('matches a bare slash at the start of the box', () => {
    expect(slashFragment('/')).toBe('');
  });

  it('matches a slash followed by a partial command name', () => {
    expect(slashFragment('/comp')).toBe('comp');
  });

  it('stops matching once a space is typed', () => {
    // The command name is settled at that point; what follows is an argument.
    expect(slashFragment('/compact focus')).toBeNull();
  });

  it('does not trigger on a slash that is not the first character', () => {
    expect(slashFragment('see /docs')).toBeNull();
  });

  it('does not trigger on empty or slash-less text', () => {
    expect(slashFragment('')).toBeNull();
    expect(slashFragment('hello')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  const commands: SlashCommandInfo[] = [
    { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
    { name: 'compact', description: 'Compact context', argumentHint: '<focus>', aliases: [] },
    { name: 'clear', description: 'Clear the conversation', argumentHint: '', aliases: [] },
  ];

  it('matches by command name prefix, case-insensitively', () => {
    expect(filterSlashCommands(commands, 'comp')).toEqual([commands[1]]);
    expect(filterSlashCommands(commands, 'COMP')).toEqual([commands[1]]);
  });

  it('matches by alias prefix too', () => {
    expect(filterSlashCommands(commands, 'cost')).toEqual([commands[0]]);
  });

  it('returns every command for an empty fragment (bare "/")', () => {
    expect(filterSlashCommands(commands, '')).toEqual(commands);
  });

  it('returns nothing when no name or alias matches', () => {
    expect(filterSlashCommands(commands, 'zzz')).toEqual([]);
  });

  it('caps the result count', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd${i}`,
      description: '',
      argumentHint: '',
      aliases: [],
    }));
    expect(filterSlashCommands(many, 'cmd', 3)).toHaveLength(3);
  });
});
