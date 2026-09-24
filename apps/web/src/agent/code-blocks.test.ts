import { describe, expect, it, vi } from 'vitest';
import { enhanceCodeBlocks, handleCodeBlockClick } from './code-blocks.js';

describe('code-blocks helper', () => {
  it('safely handles null container', () => {
    expect(() => enhanceCodeBlocks(null)).not.toThrow();
  });

  it('safely handles click with non-matching target', () => {
    const fakeEvent = {
      target: {
        closest: () => null,
      },
    } as unknown as MouseEvent;
    expect(() => handleCodeBlockClick(fakeEvent)).not.toThrow();
  });

  it('enhances pre elements and extracts language', () => {
    // Construct lightweight mock DOM
    const createdElements: { tagName: string; className: string; innerHTML?: string; textContent?: string }[] = [];
    const mockDocument = {
      createElement: (tagName: string) => {
        const el: any = {
          tagName,
          className: '',
          innerHTML: '',
          textContent: '',
          children: [],
          attributes: {},
          setAttribute: (name: string, val: string) => {
            el.attributes[name] = val;
          },
          getAttribute: (name: string) => el.attributes[name],
          appendChild: (child: any) => {
            el.children.push(child);
            child.parentElement = el;
          },
          classList: {
            contains: (cls: string) => el.className.split(' ').includes(cls),
            add: (cls: string) => {
              el.className = `${el.className} ${cls}`.trim();
            },
          },
        };
        createdElements.push(el);
        return el;
      },
    };

    vi.stubGlobal('document', mockDocument);

    try {
      const codeNode: any = {
        className: 'language-typescript',
        textContent: 'const a = 1;',
      };
      const preNode: any = {
        parentElement: null,
        parentNode: {
          insertBefore: vi.fn(),
        },
        querySelector: (sel: string) => (sel === 'code' ? codeNode : null),
      };
      const container: any = {
        querySelectorAll: (sel: string) => (sel === 'pre' ? [preNode] : []),
      };

      enhanceCodeBlocks(container);

      expect(preNode.parentNode.insertBefore).toHaveBeenCalled();
      const wrapper = createdElements.find((e) => e.className === 'code-block-container');
      expect(wrapper).toBeDefined();
      const langSpan = createdElements.find((e) => e.className === 'code-block-lang');
      expect(langSpan?.textContent).toBe('typescript');
      const copyBtn = createdElements.find((e) => e.className === 'code-copy-btn');
      expect(copyBtn).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('defaults language to code when no language class is specified', () => {
    const createdElements: any[] = [];
    const mockDocument = {
      createElement: (tagName: string) => {
        const el: any = {
          tagName,
          className: '',
          children: [],
          attributes: {},
          setAttribute: vi.fn(),
          appendChild: vi.fn(),
          classList: {
            contains: () => false,
          },
        };
        createdElements.push(el);
        return el;
      },
    };

    vi.stubGlobal('document', mockDocument);

    try {
      const preNode: any = {
        parentElement: null,
        parentNode: { insertBefore: vi.fn() },
        querySelector: () => null,
      };
      const container: any = {
        querySelectorAll: () => [preNode],
      };

      enhanceCodeBlocks(container);
      const langSpan = createdElements.find((e) => e.className === 'code-block-lang');
      expect(langSpan?.textContent).toBe('code');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
