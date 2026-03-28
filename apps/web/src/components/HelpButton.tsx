import { Link } from 'react-router-dom';

interface HelpButtonProps {
  section: string;
}

export function HelpButton({ section }: HelpButtonProps) {
  return (
    <Link to={`/features#${section}`} className="help-btn" title="Help">?</Link>
  );
}
