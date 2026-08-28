<!--
  See CONTRIBUTING.md for what each of these means.
  Delete the sections that do not apply to your change.
-->

## What this changes

<!-- One or two sentences. For a compound: which one, which routes, and why it is
     worth teaching. -->

## Sources

<!-- Each source you actually opened, with its URL and access date, and which
     parameters came from which. Never a citation you did not open. -->

## Screens run (before writing JSON)

- [ ] `F·D/V` ceiling test — ceiling vs reported Cmax:
- [ ] Other screens that applied (input-type, Tmax-vs-window, first-pass timing,
      metabolite AUC-ratio, molar→mass `fm`, phenotype-/age-anchoring,
      rate-limiting-step):
- [ ] Checked the rejection log in `docs/DATA_GUIDE.md` for this compound

## Magnitude check

<!-- CI cannot do this one. Give the numbers: engine peak vs reported Cmax, or
     Css = R0/CL for a zero-order input, plus ke = CL/Vd against a reported time
     to steady state. -->

## Checks

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npx prettier --check <the files you touched>` (not repo-wide — see
      CONTRIBUTING.md)
- [ ] Launched the app (`npm run build && npm run preview`) — required if this
      touches route-, phenotype- or copy-keyed UI

## Honesty layer

- [ ] Every `sourceRef` resolves to a `sources` key or a recognised sentinel
- [ ] `derived: true` on every computed value
- [ ] Curator reasoning in `notes`, including judgement calls and any model-shape
      approximation
- [ ] Nothing manufactured that no source reports (merged bands, blended
      phenotypes, an invented split of a lumped parameter)

## Bright line

- [ ] Takes no individual patient data and returns no dose or clinical decision
- [ ] Copy offers illustrative populations to look at, never "select your genotype"
