import type { ReactNode } from 'react';

export type OrbitIconName =
  | 'back'
  | 'close'
  | 'file'
  | 'link'
  | 'paperclip'
  | 'plus'
  | 'search'
  | 'send'
  | 'shield'
  | 'spark';

const paths: Record<OrbitIconName, ReactNode> = {
  back: <path d="m15 18-6-6 6-6M9 12h11" />,
  close: <path d="m18 6-12 12M6 6l12 12" />,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>,
  link: <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="6" r="3" /><circle cx="17" cy="18" r="3" /><path d="m9.6 10.5 4.8-3M9.6 13.5l4.8 3" /></>,
  paperclip: <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 14 1.1 2.9L23 18l-2.9 1.1L19 22l-1.1-2.9L15 18l2.9-1.1L19 14Z" /></>,
};

export function OrbitIcon({ name, size = 18 }: { name: OrbitIconName; size?: number }) {
  return <svg
    aria-hidden="true"
    focusable="false"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >{paths[name]}</svg>;
}
