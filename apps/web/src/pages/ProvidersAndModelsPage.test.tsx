import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlannerModel, PlannerProvider } from '@pocketagent/protocol';
import type { ApiClient } from '../api/client.js';
import {
  computeModelSuggestions,
  ModelLabelEditor,
  PlannerModelRow,
  PlannerProviderSection,
  ProvidersAndModelsPage,
} from './ProvidersAndModelsPage.js';

const sampleProvider: PlannerProvider = {
  id: 'prov-1',
  label: 'OpenRouter',
  kind: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  hasApiKey: true,
  keyUnreadable: false,
  allowUnattended: false,
  sortOrder: 0,
  createdAt: 1_000,
  lastTestedAt: null,
  lastError: null,
};

const sampleModel: PlannerModel = {
  id: 'mod-1',
  providerId: 'prov-1',
  modelId: 'anthropic/claude-sonnet-4-6',
  label: 'Claude Sonnet 4.6',
  supportsEffort: true,
  defaultEffort: null,
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  promptCaching: true,
  inputPricePerMTok: 3,
  outputPricePerMTok: 15,
  cacheReadPricePerMTok: 0.3,
  cacheWritePricePerMTok: 3.75,
  supportsImages: true,
  supportsPdf: true,
  sortOrder: 0,
  createdAt: 1_000,
};

describe('ProvidersAndModelsPage (PA-132, PA-148, PA-152)', () => {
  it('renders LLM providers, Embeddings, TTS / STT, and Gemini Live sections under one settings page', () => {
    const html = renderToStaticMarkup(
      <ProvidersAndModelsPage onApiError={vi.fn()} onBack={vi.fn()} />,
    );

    expect(html).toContain('<h2>Providers and Models</h2>');
    expect(html).toContain('<h3>Pocket Agent Providers</h3>');
    expect(html).toContain('<h3>Embeddings</h3>');
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

  it('renders a compact one-line model row by default and expands details with Save/Cancel when editing (PA-152)', () => {
    const compactHtml = renderToStaticMarkup(
      <PlannerModelRow
        model={sampleModel}
        busy={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(compactHtml).toContain('Claude Sonnet 4.6');
    expect(compactHtml).toContain('(anthropic/claude-sonnet-4-6)');
    expect(compactHtml).toContain('aria-label="Edit Claude Sonnet 4.6"');
    expect(compactHtml).not.toContain('planner-model-detail');
    expect(compactHtml).not.toContain('per 1M tokens');
    expect(compactHtml).not.toContain('>Save<');
    expect(compactHtml).not.toContain('>Cancel<');

    const editingHtml = renderToStaticMarkup(
      <PlannerModelRow
        model={sampleModel}
        busy={false}
        initialEditing={true}
        onSave={vi.fn()}
        onTest={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(editingHtml).toContain('planner-model-detail');
    expect(editingHtml).toContain('aria-label="Model name for anthropic/claude-sonnet-4-6"');
    expect(editingHtml).toContain('value="200000"');
    expect(editingHtml).toContain('value="16384"');
    expect(editingHtml).toContain('per 1M tokens');
    expect(editingHtml).toContain('>Save<');
    expect(editingHtml).toContain('>Cancel<');
  });

  it('supports collapsing both the provider section and its models section (PA-152)', () => {
    const stubApi = {} as ApiClient;
    const baseProps = {
      api: stubApi,
      provider: sampleProvider,
      hasLocalAgyAuth: false,
      models: [sampleModel],
      busy: false,
      testingAll: false,
      testResults: {},
      onSaveProvider: vi.fn(),
      onReload: vi.fn(async () => {}),
      onDeleteProvider: vi.fn(),
      onExportProvider: vi.fn(),
      onDiscoverModels: vi.fn(async () => ({ modelIds: [] })),
      onAddModel: vi.fn(),
      onSetModelLimit: vi.fn(),
      onRemoveModel: vi.fn(),
      onDeleteAllModels: vi.fn(),
      onTestModel: vi.fn(),
      onTestAllModels: vi.fn(),
      onApiError: vi.fn(),
      onError: vi.fn(),
    };

    const expandedHtml = renderToStaticMarkup(<PlannerProviderSection {...baseProps} />);
    expect(expandedHtml).toContain('aria-label="Collapse provider OpenRouter"');
    expect(expandedHtml).toContain('aria-label="Collapse models for OpenRouter"');
    expect(expandedHtml).toContain('Claude Sonnet 4.6');

    const modelsCollapsedHtml = renderToStaticMarkup(
      <PlannerProviderSection {...baseProps} initialModelsExpanded={false} />,
    );
    expect(modelsCollapsedHtml).toContain('aria-label="Expand models for OpenRouter"');
    expect(modelsCollapsedHtml).toContain('>Base URL<');
    expect(modelsCollapsedHtml).toContain('/v1/chat/completions');
    expect(modelsCollapsedHtml).toContain('/v1/messages');
    expect(modelsCollapsedHtml).not.toContain('Claude Sonnet 4.6');

    const providerCollapsedHtml = renderToStaticMarkup(
      <PlannerProviderSection {...baseProps} initialExpanded={false} />,
    );
    expect(providerCollapsedHtml).toContain('aria-label="Expand provider OpenRouter"');
    expect(providerCollapsedHtml).toContain('1 model · Endpoint configured · API key set');
    expect(providerCollapsedHtml).not.toContain('>Base URL<');
    expect(providerCollapsedHtml).not.toContain('Claude Sonnet 4.6');
  });
});
