/**
 * Persistent, non-dismissible disclaimer (handoff §11).
 *
 * This banner is intentionally NOT a one-time dismissible toast: epistemic and
 * legal honesty is the product, so the "educational only / not medical advice"
 * notice must remain visible at all times. Do not add a close button.
 */
export function DisclaimerBanner() {
  return (
    <div className="disclaimer-banner" role="note" aria-label="Disclaimer">
      <strong>Educational use only — not medical advice.</strong> Curves are illustrative models,
      not patient predictions. Not for clinical use or treatment decisions. Data may be inaccurate
      or incomplete; the authors accept no responsibility for any use.
    </div>
  );
}
