export function OrbitMark() {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="4" fill="currentColor" />
    <ellipse cx="24" cy="24" rx="18" ry="8" transform="rotate(-34 24 24)" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="38.5" cy="14" r="2.5" fill="currentColor" />
  </svg>;
}

export function initials(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?';
}
