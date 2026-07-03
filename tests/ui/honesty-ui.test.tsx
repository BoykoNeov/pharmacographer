import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadAllCompounds, parseCompound } from '../../src/data/loader.ts';
import { App } from '../../src/ui/App.tsx';
import { ProvenancePanel } from '../../src/ui/components/ProvenancePanel.tsx';
import { buildCurve, type DoseSchedule } from '../../src/ui/curve.ts';
import { baseRawCompound } from '../data/_fixtures.ts';

/**
 * The honesty UI (Phase 5) is the product, not chrome — so it gets a render
 * test, not just a compile. App defaults to the first seed compound on an IV
 * route, so the provenance panel and the standing assumptions must appear with
 * real sourced content and the measured/derived badges.
 */
describe('honesty UI (handoff §5, Phase 5)', () => {
  const html = renderToStaticMarkup(<App />);

  it('renders the provenance panel with a source citation', () => {
    expect(html).toContain('Where these numbers come from');
    expect(html).toContain('Sources');
    expect(html).toContain('FDA label'); // seed compounds are FDA-sourced
  });

  it('shows measured-vs-derived badges', () => {
    expect(html).toContain('Measured'); // half-life / Vd are read from the label
    // ke is computed from t½, grouped in as a derivation, not a measured row.
    expect(html).toContain('ke = ln2');
  });

  it('renders the standing model assumptions, framing 70 kg as illustrative', () => {
    expect(html).toContain('What this model assumes');
    expect(html).toContain('illustrative reference subject');
    expect(html).toContain('not</em> a patient weight');
  });
});

/**
 * The metabolite provenance rows are the honesty layer for the dashed metabolite
 * line — its formation fraction, own Vd, and own half-life must come clean too.
 * Driven with the real diazepam→nordiazepam pair, whose metabolite parameters
 * cite sources (IARC, CHEMM) that appear NOWHERE in the parent rows.
 */
describe('metabolite provenance rows (handoff §12)', () => {
  const diazepam = loadAllCompounds().find((c) => c.id === 'diazepam');
  const schedule: DoseSchedule = { amount: 10, count: 1, interval: 6, adHoc: [] };

  it('has the diazepam→nordiazepam fixture available', () => {
    expect(diazepam).toBeDefined();
  });

  const bolus = buildCurve({ compound: diazepam!, route: 'iv_bolus', schedule });
  const bolusHtml = renderToStaticMarkup(
    <ProvenancePanel
      compound={diazepam!}
      route="iv_bolus"
      derived={bolus.derived}
      metabolites={bolus.metabolites}
    />,
  );

  it('shows the metabolite name, active tag, and its own disposition rows', () => {
    // Key off the group class — the FDA parent source title also contains the
    // words "active metabolite", so a bare text match would be a false positive.
    expect(bolusHtml).toContain('prov__meta-group');
    expect(bolusHtml).toContain('Nordiazepam');
    expect(bolusHtml).toContain('— active metabolite</span>');
    expect(bolusHtml).toContain('Fraction formed');
  });

  it('surfaces the metabolite-only sources in the bibliography', () => {
    expect(bolusHtml).toContain('IARC'); // formation fraction source
    expect(bolusHtml).toContain('CHEMM'); // metabolite Vd source
  });

  it('drops the metabolite rows on a route that draws no metabolite line', () => {
    const infusion = buildCurve({ compound: diazepam!, route: 'iv_infusion', schedule });
    const infusionHtml = renderToStaticMarkup(
      <ProvenancePanel
        compound={diazepam!}
        route="iv_infusion"
        derived={infusion.derived}
        metabolites={infusion.metabolites}
      />,
    );
    expect(infusionHtml).not.toContain('prov__meta-group');
    expect(infusionHtml).not.toContain('Nordiazepam');
  });
});

/**
 * The panel's INACTIVE-metabolite wording branch ("— metabolite", no "active"
 * qualifier). No shipped compound has an inactive metabolite (nordiazepam is
 * active), so a synthetic fixture drives it. This covers the panel branch; the
 * chart legend's identical branch is covered by the shared `metaboliteTag`
 * helper's own unit test (Recharts renders empty under static markup).
 */
describe('metabolite provenance rows — inactive metabolite', () => {
  function inactiveMetaboliteCompound() {
    const raw = baseRawCompound();
    (raw.sources as Record<string, unknown>).metasrc = { type: 'test', title: 'Metabolite source' };
    raw.metabolites = [
      {
        id: 'inactivemeta',
        name: 'Inactivemetabolite',
        active: false,
        fractionFormed: { value: 50, unit: 'percent', derived: false, sourceRef: 'metasrc' },
        vd: { value: 0.5, unit: 'L/kg', derived: true, sourceRef: 'metasrc' },
        halfLife: { value: 8, unit: 'h', derived: false, sourceRef: 'ref' },
      },
    ];
    return parseCompound(raw);
  }

  const html = renderToStaticMarkup(
    <ProvenancePanel
      compound={inactiveMetaboliteCompound()}
      route="iv_bolus"
      derived={[]}
      metabolites={[{ id: 'inactivemeta', derived: [] }]}
    />,
  );

  it('renders the "— metabolite" tag with no "active" qualifier', () => {
    // Match the closing </span> like the active test — a bare text match could
    // catch an unrelated "metabolite". The whole point is the absence of "active".
    expect(html).toContain('Inactivemetabolite');
    expect(html).toContain('— metabolite</span>');
    expect(html).not.toContain('active metabolite');
  });
});
