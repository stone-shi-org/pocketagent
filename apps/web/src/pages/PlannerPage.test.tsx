import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeModelSuggestions, ModelLabelEditor } from './PlannerPage.js';

describe('PlannerPage model label & typeahead (PA-129)', () => {
  describe('ModelLabelEditor', () => {
    it('renders the model label and an inline edit button by default', () => {
      const html = renderToStaticMarkup(
        <ModelLabelEditor
          label="Fast Mini"
          modelId="gpt-4o-mini"
          disabled={false}
          onSave={vi.fn()}
        />,
      );

      expect(html).toContain('<span>Fast Mini</span>');
      expect(html).toContain('class="planner-model-label-edit"');
      expect(html).toContain('aria-label="Edit label for Fast Mini"');
      expect(html).not.toContain('planner-model-label-input');
    });

    it('renders an auto-focused text input when in editing mode', () => {
      const html = renderToStaticMarkup(
        <ModelLabelEditor
          label="Fast Mini"
          modelId="gpt-4o-mini"
          disabled={false}
          initialEditing={true}
          onSave={vi.fn()}
        />,
      );

      expect(html).toContain('class="planner-model-label-input"');
      expect(html).toContain('aria-label="Edit label for gpt-4o-mini"');
      expect(html).toContain('value="Fast Mini"');
      expect(html).not.toContain('planner-model-label-edit');
    });
  });

  describe('computeModelSuggestions', () => {
    const discovered = ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gemini-2.5-pro'];

    it('matches discovered models case-insensitively and excludes configured ones', () => {
      const configured = new Set(['gpt-4o']);
      const matches = computeModelSuggestions(discovered, configured, 'GPT', true);
      expect(matches).toEqual(['gpt-4o-mini']);
    });

    it('returns empty when typed input is blank', () => {
      const configured = new Set<string>();
      expect(computeModelSuggestions(discovered, configured, '   ', true)).toEqual([]);
    });

    it('hides suggestions when suggestionsOpen is false after selecting a suggestion', () => {
      const configured = new Set<string>();
      expect(computeModelSuggestions(discovered, configured, 'gpt-4o-mini', false)).toEqual([]);
    });

    it('caps suggestions at 12 results', () => {
      const many = Array.from({ length: 20 }, (_, i) => `model-${i}`);
      const matches = computeModelSuggestions(many, new Set(), 'model', true);
      expect(matches).toHaveLength(12);
    });
  });
});
