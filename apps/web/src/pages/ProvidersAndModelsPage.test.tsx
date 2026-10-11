import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeModelSuggestions,
  ModelLabelEditor,
  ProvidersAndModelsPage,
} from './ProvidersAndModelsPage.js';

describe('ProvidersAndModelsPage (PA-132)', () => {
  it('renders LLM endpoint, Models, TTS / STT, and Gemini Live sections under one settings page', () => {
    const html = renderToStaticMarkup(
      <ProvidersAndModelsPage onApiError={vi.fn()} onBack={vi.fn()} />,
    );

    expect(html).toContain('<h2>Providers and Models</h2>');
    expect(html).toContain('<h3>LLM endpoint</h3>');
    expect(html).toContain('<h3>Models</h3>');
    expect(html).toContain('<h3>TTS / STT</h3>');
    expect(html).toContain('<h3>Gemini Live</h3>');
  });

  it('exposes ModelLabelEditor and computeModelSuggestions', () => {
    const html = renderToStaticMarkup(
      <ModelLabelEditor
        label="Sonnet"
        modelId="claude-3-5-sonnet"
        disabled={false}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain('<span>Sonnet</span>');
    expect(
      computeModelSuggestions(['gpt-4o', 'gpt-4o-mini'], new Set(['gpt-4o']), 'gpt', true),
    ).toEqual(['gpt-4o-mini']);
  });
});
