import { describe, it, expect } from 'vitest';
import tokensCss from '../web/tokens.css?raw';
import indexHtml from '../web/index.html?raw';
import apiSource from '../web/lib/api.ts?raw';

// 规格 §10.5 的十二个取值，前端所有颜色都必须引用这些令牌，不得在组件里硬编码别的主题色。
const SPEC_COLORS = [
  '#0d1117', // bg
  '#161b22', // panel
  '#21262d', // panel-2
  '#30363d', // border
  '#c9d1d9', // text
  '#8b949e', // muted
  '#f0f6fc', // bright
  '#58a6ff', // accent
  '#3fb950', // ok
  '#d29922', // warn
  '#f85149', // danger
  '#238636', // primary
];

describe('design tokens', () => {
  it('defines all twelve colors from spec §10.5', () => {
    const css = tokensCss.toLowerCase();
    for (const value of SPEC_COLORS) {
      expect(css, `missing token ${value}`).toContain(value);
    }
  });

  it('keeps the compact type scale: 12px body, 28px table row', () => {
    const css = tokensCss.toLowerCase();
    expect(css).toContain('--fs-body: 12px');
    expect(css).toContain('--row: 28px');
  });
});

describe('dark theme only', () => {
  it('has no white background or light-theme residue in index.html', () => {
    const html = indexHtml.toLowerCase();
    // 半吊子深色主题的典型残留：内联白底、white 关键字、浅色 color-scheme。
    expect(html).not.toMatch(/background\s*:\s*#f{3,6}\b/);
    expect(html).not.toMatch(/background\s*:\s*white\b/);
    expect(html).not.toMatch(/color-scheme\s*:\s*light\b/);
    expect(html).toContain('color-scheme');
    expect(html).toMatch(/content=["']dark["']/);
  });
});

describe('api client', () => {
  it('routes every request through the /api/ prefix', () => {
    expect(apiSource).toContain('/api/');
  });

  it('throws on non-2xx responses with the status in the error', () => {
    expect(apiSource).toMatch(/res\.ok/);
    expect(apiSource).toMatch(/res\.status/);
  });
});
