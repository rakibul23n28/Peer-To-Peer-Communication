export function OrbitMark() {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M24 39c-7-8-10-15-9-21 1-7 7-11 13-9 7 2 10 10 6 17-2 5-6 9-10 13Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="2" />
    <path d="M24 37c-1-9 1-16 7-22M23 27l-7-6m8 10 9-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="33" cy="10" r="3" fill="currentColor" />
  </svg>;
}

export function initials(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?';
}
