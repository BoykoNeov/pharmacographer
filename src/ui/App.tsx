import { DisclaimerBanner } from './components/DisclaimerBanner.tsx';

export function App() {
  return (
    <>
      <DisclaimerBanner />
      <div className="app">
        <header className="app__header">
          <h1>Pharmacographer</h1>
          <p className="app__tagline">
            An honest, interactive pharmacokinetics curve plotter — for learning, not for patients.
          </p>
        </header>
        <main>
          <div className="placeholder">
            <p>
              Phase&nbsp;0 scaffold. The concentration-vs-time chart, compound picker, dosing
              controls, variability slider, and provenance panel arrive in later phases (see{' '}
              <code>PHARMACOGRAPHER_HANDOFF.md</code> §13).
            </p>
          </div>
        </main>
      </div>
    </>
  );
}
