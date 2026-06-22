/**
 * Compound selector (handoff §9, §13 Phase 4).
 *
 * A plain dropdown over the validated, alphabetically-sorted compound set. The
 * picker is presentational: it reports the chosen id upward; App owns the state
 * and resets the route to the new compound's default (a compound switch can
 * invalidate the current route).
 */

import { displayName, type Compound } from '../../data/schema.ts';

interface CompoundPickerProps {
  compounds: Compound[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function CompoundPicker({ compounds, selectedId, onSelect }: CompoundPickerProps) {
  return (
    <label className="control">
      <span className="control__label">Compound</span>
      <select
        className="control__input"
        value={selectedId}
        onChange={(event) => onSelect(event.target.value)}
      >
        {compounds.map((compound) => (
          <option key={compound.id} value={compound.id}>
            {displayName(compound)}
          </option>
        ))}
      </select>
    </label>
  );
}
