import type { ArchiveBucket } from '@kingside/shared';

export type BucketValue = ArchiveBucket | 'all';

interface BucketSelectProps {
  value: BucketValue;
  onChange: (value: BucketValue) => void;
}

/**
 * Select: Masters / Lichess 2000+ / All.
 * `all` means no bucket filter is sent to the backend.
 */
export function BucketSelect({ value, onChange }: BucketSelectProps) {
  return (
    <select
      className="bucket-select"
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as BucketValue)}
      aria-label="Database bucket"
    >
      <option value="master">Masters</option>
      <option value="user">Lichess 2000+</option>
      <option value="all">All</option>
    </select>
  );
}
