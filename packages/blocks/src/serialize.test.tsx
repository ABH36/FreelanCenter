import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Footer, FloatingActions, Header, registry, renderSections, serialize } from './index';
import { allDefaultSections, baseConfig, ctxFor, normalizeHtml, parsed } from './test-helpers';

const same = (node: React.ReactNode) =>
  expect(normalizeHtml(serialize(node))).toBe(normalizeHtml(renderToStaticMarkup(<>{node}</>)));

describe('serialize == react-dom/server (so route handlers do not need react-dom/server)', () => {
  const cfg = parsed(baseConfig(allDefaultSections()));
  const assetUrl = (id: string, w: number) => `https://assets.example.test/${id}-${w}.webp`;

  for (const [name, overrides] of [
    ['no assets, no lead endpoint', {}],
    ['assets and a lead endpoint', { assetUrl, leadForm: { action: '/api/leads' } }],
    [
      'preview mode with a badge',
      { mode: 'preview' as const, platformBadge: { label: 'Built with X', href: 'https://x.test' } },
    ],
  ] as const) {
    it(`every block variant and the chrome render identically: ${name}`, () => {
      const ctx = ctxFor(cfg, overrides);
      const { nodes } = renderSections(cfg.pages[0]?.sections ?? [], ctx);
      expect(nodes.length).toBe(registry.list().reduce((n, d) => n + d.variants.length, 0));
      for (const n of nodes) same(n.node);
      same(<Header ctx={ctx} currentPath="/" />);
      same(<Header ctx={ctx} currentPath="/" variant="centered" />);
      same(<Footer ctx={ctx} />);
      same(<Footer ctx={ctx} variant="columns" />);
      same(<FloatingActions ctx={ctx} />);
    });
  }

  it('Hindi text and hostile-looking (but schema-valid) text serialise identically', () => {
    const hi = parsed(
      baseConfig(allDefaultSections(), {
        business: { ...baseConfig().business, language: 'hi', name: `Tom & "Jerry" it's नमस्ते` },
      }),
    );
    const ctx = ctxFor(hi);
    for (const n of renderSections(hi.pages[0]?.sections ?? [], ctx).nodes) same(n.node);
    same(<Header ctx={ctx} currentPath="/" />);
  });
});

describe('serialize refuses anything outside its allow-list', () => {
  it('rejects script, iframe and unknown tags', () => {
    for (const tag of [
      'script',
      'iframe',
      'object',
      'embed',
      'style',
      'link',
      'meta',
      'base',
      'svg-foreign',
    ]) {
      expect(
        () =>
          serialize(
            <>
              {
                {
                  $$typeof: Symbol.for('react.transitional.element'),
                  type: tag,
                  key: null,
                  props: {},
                  _owner: null,
                  _store: {},
                } as never
              }
            </>,
          ),
        tag,
      ).toThrow();
    }
  });
  it('rejects event handlers, style, dangerouslySetInnerHTML, unknown attributes and non-scalar values', () => {
    expect(() => serialize(<div onClick={() => 1} />)).toThrow(/not allowed/);
    expect(() => serialize(<div style={{ color: 'red' }} />)).toThrow(/not allowed/);
    expect(() =>
      serialize(<div {...({ dangerouslySetInnerHTML: { __html: '<b>x</b>' } } as object)} />),
    ).toThrow(/not allowed/);
    expect(() => serialize(<div {...({ onerror: 'x' } as object)} />)).toThrow(/not allowed/);
    expect(() => serialize(<div {...({ href: { a: 1 } } as object)} />)).toThrow();
    expect(() => serialize(<a href="x" {...({ srcdoc: 'x' } as object)} />)).toThrow(/not allowed/);
  });
  it('escapes text and attribute values, drops false/null attributes, and handles void tags', () => {
    expect(serialize(<p title={undefined}>{`<b>&"'`}</p>)).toBe('<p>&lt;b&gt;&amp;"\'</p>');
    expect(
      serialize(
        <a href={'x" onmouseover="y'} rel="noopener">
          z
        </a>,
      ),
    ).toBe('<a href="x&quot; onmouseover=&quot;y" rel="noopener">z</a>');
    expect(serialize(<img src="a.png" alt="" />)).toBe('<img src="a.png" alt="">');
    expect(serialize(<input required type="text" />)).toBe('<input required="" type="text">');
    expect(
      serialize(
        <div>
          {false}
          {null}
          {0}
          {'x'}
        </div>,
      ),
    ).toBe('<div>0x</div>');
  });
  it('refuses a void element with children and runaway nesting', () => {
    expect(() => serialize(<img {...({ children: 'x' } as object)} />)).toThrow();
    let node: React.ReactNode = 'x';
    for (let i = 0; i < 120; i++) node = <div>{node}</div>;
    expect(() => serialize(node)).toThrow(/deeply/);
  });
});
