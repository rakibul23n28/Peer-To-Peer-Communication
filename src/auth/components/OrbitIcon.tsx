import type { ReactNode } from 'react';

export type OrbitIconName =
  | 'archive'
  | 'alert'
  | 'audio'
  | 'back'
  | 'check'
  | 'checkDouble'
  | 'close'
  | 'cancelCircle'
  | 'chat'
  | 'collapse'
  | 'copy'
  | 'code'
  | 'download'
  | 'edit'
  | 'expand'
  | 'file'
  | 'folderOpen'
  | 'folderUp'
  | 'grid'
  | 'heart'
  | 'image'
  | 'eye'
  | 'hand'
  | 'lock'
  | 'link'
  | 'list'
  | 'logout'
  | 'moon'
  | 'microphone'
  | 'microphoneOff'
  | 'more'
  | 'panelLeft'
  | 'panelRight'
  | 'palette'
  | 'pause'
  | 'pauseCircle'
  | 'paperclip'
  | 'phone'
  | 'phoneCheck'
  | 'phoneOff'
  | 'phoneX'
  | 'play'
  | 'playCircle'
  | 'plus'
  | 'retry'
  | 'reply'
  | 'search'
  | 'send'
  | 'settings'
  | 'shield'
  | 'smilePlus'
  | 'spark'
  | 'stop'
  | 'tree'
  | 'upload'
  | 'userCheck'
  | 'userPlus'
  | 'userX'
  | 'bellPlus'
  | 'downloadCloud'
  | 'linkOff'
  | 'rows'
  | 'loading'
  | 'fileX'
  | 'video'
  | 'water'
  | 'sun'
  | 'trash'
  | 'user';

const paths: Record<OrbitIconName, ReactNode> = {
  archive: <><path d="M3 4h18v4H3z" /><path d="M5 8v12h14V8M10 12h4" /><path d="m9 4 1 4m4-4-1 4" /></>,
  alert: <><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
  audio: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  back: <path d="m15 18-6-6 6-6M9 12h11" />,
  check: <path d="m5 12 4 4L19 6" />,
  checkDouble: <><path d="m2 12 4 4L16 6" /><path d="m9 12 4 4 9-10" /></>,
  close: <path d="m18 6-12 12M6 6l12 12" />,
  cancelCircle: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
  chat: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></>,
  collapse: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 10l-2 2 2 2" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  code: <><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-2-12-4 16" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></>,
  expand: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M13 10l2 2-2 2" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>,
  folderOpen: <><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2H5l-2 9V6Z" /><path d="M3 19h15a2 2 0 0 0 2-2l1-7H5l-2 9Z" /></>,
  folderUp: <><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v4" /><path d="M3 19h9M3 10h18" /><path d="m16 18 3-3 3 3m-3-3v7" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  hand: <><path d="M8 11V5a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8a8 8 0 0 1-8 8h-1a8 8 0 0 1-6-3l-3-4a2 2 0 0 1 3-3l3 3" /></>,
  lock: <><rect x="4" y="11" width="16" height="11" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  link: <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="6" r="3" /><circle cx="17" cy="18" r="3" /><path d="m9.6 10.5 4.8-3M9.6 13.5l4.8 3" /></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
  moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />,
  microphone: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" /></>,
  microphoneOff: <><path d="m2 2 20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.8-1M5 10a7 7 0 0 0 12 4.9M12 17v5m-4 0h8" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  panelLeft: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16m5-11 3 3-3 3" /></>,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16m-5-11-3 3 3 3" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1.2a2 2 0 0 0 1.5-3.3 1.7 1.7 0 0 1 1.3-2.8H18a3 3 0 0 0 3-3c0-5-4-9-9-9Z" /><path d="M7.5 10h.01M10 6.5h.01M15 7h.01M17 11h.01" /></>,
  pause: <><path d="M8 5h3v14H8zM15 5h3v14h-3z" /></>,
  pauseCircle: <><circle cx="12" cy="12" r="9" /><path d="M9 8v8m6-8v8" /></>,
  paperclip: <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  phone: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.8 2.1Z" /></>,
  phoneCheck: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7" /><path d="m15 4 2 2 4-4" /></>,
  phoneOff: <><path d="m2 2 20 20M6.5 6.5l1.3-.1a2 2 0 0 1 1.3 1.2c.2.6.4 1.1.7 1.6l-2 2.1m3.3 3.3a16 16 0 0 0 2.9 1.8l1.2-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7A2 2 0 0 1 22 17v2.9a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-3.7-3.1" /></>,
  phoneX: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 11.2 19a19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6" /><path d="m16 4 5 5m0-5-5 5" /></>,
  play: <path d="m8 5 12 7-12 7V5Z" />,
  playCircle: <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4V8Z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  reply: <><path d="m9 17-5-5 5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></>,
  retry: <><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 0 2 5" /></>,
  rows: <><path d="M9 6h12M9 12h12M9 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1 0 1.8Z" transform="translate(-1 -2)" /></>,
  shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  smilePlus: <><circle cx="10" cy="12" r="8" /><path d="M7 14s1 2 3 2 3-2 3-2m-6-5h.01M13 9h.01M19 3v6m-3-3h6" /></>,
  spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 14 1.1 2.9L23 18l-2.9 1.1L19 22l-1.1-2.9L15 18l2.9-1.1L19 14Z" /></>,
  stop: <><rect x="5" y="5" width="14" height="14" rx="2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
  trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" /></>,
  tree: <><path d="M12 22v-7" /><path d="M7 15c-2.2 0-3.5-1.5-3.5-3.3 0-1.7 1.1-2.9 2.8-3.2C6 5.5 8.5 3 12 3s6 2.5 6.7 5.5c1.7.3 2.8 1.5 2.8 3.2 0 1.8-1.3 3.3-3.5 3.3H7Z" /><path d="M9 22h6" /></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M4 16v4h16v-4" /></>,
  userCheck: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0m1-8 2 2 4-4" /></>,
  userPlus: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0m4-12v6m-3-3h6" /></>,
  userX: <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0m2-11 5 5m0-5-5 5" /></>,
  bellPlus: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h15" /><path d="M10 21h4m4-9h6m-3-3v6" /></>,
  downloadCloud: <><path d="M8 18a5 5 0 1 1 .6-10A7 7 0 0 1 22 11a4 4 0 0 1-1 7h-3" /><path d="m8 15 4 4 4-4m-4 4v-9" /></>,
  linkOff: <><path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l3-3a4 4 0 0 1 6 0m5-2 2-2a4 4 0 0 1 6 6l-3 3a4 4 0 0 1-6 0" /><path d="m2 2 20 20" /></>,
  video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-3v10l-4-3" /></>,
  water: <path d="M12 22a7 7 0 0 0 7-7c0-4-7-13-7-13S5 11 5 15a7 7 0 0 0 7 7Z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M5 21a7 7 0 0 1 14 0" /></>,
  loading: <><path d="M20 12a8 8 0 0 1-8 8" /><path d="M4 12a8 8 0 0 1 8-8" /></>,
  fileX: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6m-9 4 4 4m0-4-4 4" /></>,
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
