# Orbit UI redesign spec

## Phase 0 audit and baseline

Screens and current ownership:

| Screen / area | Existing implementation | Redesign scope |
|---|---|---|
| Sign-in, registration, key recovery | `App.tsx`, `auth.css` | Keep auth flow/routes and forms; compact the card and retain clear text CTAs. |
| App shell and conversation list | `AuthenticatedHome.tsx`, `ConversationSidebar.tsx`, `workspace.css` | Integrated workspace navigation, compact conversation list, and populated people view backed by existing conversations. |
| Chat, timeline, composer, shared-folder cards | `ConversationThread.tsx`, `chat.css`, `SharedFolderViewer.tsx` | Tighten timeline and toolbar actions; preserve all message, file, and folder flows. |
| Conversation details / theme picker | `WorkspaceDetails.tsx` | Open as a dedicated page from a conversation; compact sections and provide a clear return path. |
| Audio call | `AudioCallPanel.tsx` | Preserve call states and controls; align button geometry and icons. |
| Downloads | `DownloadsPage.tsx`, `downloadStore.ts` | Dedicated page backed by existing download history and live progress. |
| Preview, tree, folder share | `PreviewPane.tsx`, `SharedFolderViewer.tsx`, `SharedFolderComposer.tsx` | Keep existing dialogs and flows; standardize controls and layout. |
| Search, privacy, blocks | `OrbitDialogs.tsx` | Keep behaviors and labels; make settings denser and provide shared appearance preferences. |
| Presence / availability | `presenceStore.ts`, `PresenceIndicator.tsx` | Reuse live store data for dashboard and compact status chips. |
| Access requests | The dedicated inbox page is removed; encrypted requests remain part of the existing folder-sharing flow and API. |
| Notification center, People & Sharing | No corresponding complete screens | Omit; do not make placeholder features or sample data. |

Five existing themes are selected by `data-appearance` and currently override palettes, decoration and some component details in `auth.css`, `chat.css` and `workspace.css`. CSS is plain global CSS; there is no Tailwind theme mapping or component framework. The icon solution is the typed hand-built SVG `OrbitIcon`. App state is React state and refs; the browser stores device identity, messages, source handles and download journal in IndexedDB/Dexie. No chart library or icon package is installed.

Baseline observations from the checked-in real-looking screenshot files and source (not re-used as new test captures):

- The sidebar is about 270 px and the thread is capped at 1,000–1,120 px, leaving avoidable horizontal space on wide displays.
- The shell uses 20–52 px horizontal gutters; chat header is 76 px tall and message list has 22–30 px vertical padding. Theme styles add more padding, shadows, radii and ornamental backgrounds.
- Conversation rows are 61–67 px, so a 900 px screen fits around 10–12 after the brand, heading and profile areas.
- Many actions carry full text in the toolbar or row (call, details, attach, preview/open/download, pause/resume/cancel, edit/delete/reply/react, retry, privacy, account and request actions).
- Existing checked-in screenshots are static reference artwork and were not copied. The local browser had a signed-in dev session, but its screenshot bridge returned a narrow embedded viewport with black padding even when the page reported 1440×900; those invalid captures were discarded. No before/after screenshot matrix is checked in. Capture it with a browser workflow that saves the actual page viewport at the requested dimensions.

## Token plan

| Token group | Values |
|---|---|
| Spacing | 4 px base; `--space-1..6`: 4, 8, 12, 16, 20, 24 px. Layout uses 8–16 px; page gutters 12/16/20 px at phone/tablet/desktop. |
| Density | `--row-height`: 32 compact / 40 comfortable; conversation rows 56 px. `--card-pad`: 12 compact / 16 comfortable. Desktop default compact. |
| Geometry | Controls radius 6 px; cards 10 px; sheets 14 px. Controls 32/36/40 px (40+ on touch). |
| Typography | Meta 11/12 px; dense body 13 px; body 14 px; section 16 px; page 20 px; tabular numerals for counters and transfer data. |
| Color | Shared semantic tokens: surface-0..3, border-subtle/strong, text-1..3, accent/accent-fg, success, warning, danger, info and focus-ring. Map existing five palettes to these; status meaning must not change by theme. |
| Elevation | Border-first; at most three shadow levels. Theme decoration stays behind content and does not change layout. |

## Action Registry

The registry is the one source of semantic action labels and icon names. Icons are distinct; primary/confirmation actions retain text. Existing button inventory is consolidated here; descriptive/status text and settings controls are not converted to ambiguous icon-only controls.

| Action ID | Current locations / labels | Icon | Treatment |
|---|---|---|---|
| `newChat` | Sidebar “Find someone”, search results | `userPlus` | Primary icon + label |
| `search` | User search, loaded-message search | `search` | Icon-only trigger; input keeps label |
| `sendFile` | Attach menu “Send file” | `paperclip` | Icon + menu label |
| `shareFolder` | Folder composer / attach menu | `folderUp` | Primary icon + label |
| `sendMessage` | Composer “Send” | `send` | Icon-only, labelled |
| `call` | Header “Start audio call” | `phone` | Icon-only, labelled |
| `acceptCall` | Incoming call | `phoneCheck` | Icon-only, labelled |
| `declineCall` | Incoming call “Decline” | `phoneX` | Icon-only, labelled |
| `acceptFile` | Incoming file offer | `check` | Icon-only, labelled |
| `declineFile` | Incoming file offer | `fileX` | Icon-only, labelled |
| `endCall` | Active call “End” | `phoneOff` | Icon-only, labelled |
| `mute` | Call “Mute/Unmute microphone” | `microphoneOff` | Icon-only toggle |
| `attach` | Composer “Attach” | `upload` | Icon-only menu trigger |
| `openFolder` | Shared folder “Open” | `folderOpen` | Icon-only |
| `preview` | File “Preview” | `eye` | Icon-only |
| `download` | File “Download” | `download` | Icon-only |
| `pauseTransfer` | Download “Pause” | `pause` | Icon-only toggle |
| `resumeTransfer` | Download “Resume” | `play` | Icon-only toggle |
| `cancelTransfer` | Download “Cancel” | `cancelCircle` | Icon-only |
| `retry` | Thread / list “Retry” | `retry` | Icon-only except recovery error CTA |
| `editMessage` | Message “Edit” | `edit` | Icon-only |
| `deleteMessage` | Message “Delete” | `trash` | Icon-only; text confirmation |
| `reply` | Message “Reply” | `reply` | Icon-only |
| `react` | Message “React with heart” | `smilePlus` | Icon-only |
| `copyFingerprint` | Account/details “Copy fingerprint” | `copy` | Icon-only |
| `openSettings` | Account/details “Settings” | `settings` | Icon-only |
| `signOut` | Account “Sign out” | `logOut` | Menu icon + text |
| `blockContact` | Header “Block contact” | `userX` | Icon-only; text confirmation |
| `unblockContact` | Settings / blocked banner | `userCheck` | Icon + text in settings |
| `notifyShare` | Share “Notify me when available” | `bellPlus` | Icon-only toggle |
| `requestAccess` | “Ask to open / share again” | `hand` | Icon-only; text in dialog |
| `allowDownloads` | Share permission | `downloadCloud` | Text in permission control |
| `pauseSharing` | Owner share availability | `pauseCircle` | Icon-only toggle; text confirmation |
| `resumeSharing` | Owner share availability | `playCircle` | Icon-only toggle |
| `stopSharing` | Owner share card | `linkOff` | Icon-only; text confirmation |
| `stopTransfer` | Owner transfer row | `square` | Icon-only; text confirmation |
| `toggleInspector` | Header “Details” | `panelRight` | Icon-only toggle |
| `toggleNavigation` | Sidebar collapse | `panelLeft` | Icon-only toggle |
| `switchTheme` | Workspace theme choices | `palette` | Text choices in settings |
| `toggleDensity` | New local appearance setting | `rows3` | Text choices in settings |
| `more` | Context actions | `ellipsis` | Icon-only; menu items use icon + text |
| `close` | Dialog/sheet close | `close` | Icon-only |
| `clearHistory` | Downloads history | `archive` | Icon-only; text confirmation |

## Layout map and components

```text
Desktop (>=1024): [56 rail] [280-320 list/context] [flex main] [320-360 inspector]
Top: [global search / Ctrl+K] [connection] [activity] [notifications if present] [theme] [profile]
Phone (<640): [full-screen page] + [bottom tabs: Dashboard / Chats / Shared* / Activity* / More]
*Shown only when backed by a real feature.
```

```text
Dashboard: greeting + primary actions
[Live activity (real downloads)] [People (real presence)] [Shared folders (loaded records)]
[Needs attention (real errors/permission state)] [Recent conversations] [Privacy / device status]
Only render cards with underlying source data; every zero state is useful and truthful.

Chat: compact list | header + grouped message timeline + pinned composer | details page
Requests: pending incoming requests | encrypted optional note | open chat / mark handled / decline
Settings: subsection rail | labelled settings rows with helper text | no nested cards
Sign-in: existing split layout on desktop; compact, full-width form on phone
People: existing conversation contacts, online state and local previews; no suggested or mock users
Activity: current DownloadsPage data, extended only when corresponding data exists
Shared/tree: existing tree and preview with icon actions; no invented pages.
```

Components: `ActionRegistry`, `IconButton` (required label, focus tooltip, state), `OrbitIcon`, `StatusChip`, `ActionMenu`, `Dashboard`, `PeoplePage`, `DashboardCard`, `CompactConversationRow`, `ConversationThread`, `WorkspaceDetails`, `DownloadsPage`, `OrbitDialogs`, and shared button/input/progress primitives. Keep existing routes, event listeners, request callbacks and crypto untouched.

Density rules: 12–16 px cards, 12 px card gaps, 8 px section gaps, 4–8 px inline gaps, 40 px default rows / 32 compact rows, 56 px conversation rows, no desktop thread max-width cap, 44 px top bar, 36 px md controls and 40 px+ phone hit areas. Only a small local preference is added for density and label mode. Existing five palettes remain; no new dependencies.

## Page-by-page plan

1. Tokens, icon additions, `ActionRegistry`, labelled `IconButton`, status chips, density and label-mode preferences.
2. App rail/top bar and local Dashboard view backed by existing conversations, presence/availability, selected loaded shares and download store. Never seed widgets with sample values.
3. Compact conversation list, people view, and chat layout; preserve message actions, file/folder actions, call actions, dialogs and details page.
4. Dedicated Downloads page and existing shared-folder tree/preview controls.
5. Settings appearance controls, sign-in spacing and theme-specific contrast/motion polish.
6. Add registry/density and helper tests; run checks and measure what can be measured. Capture the requested real before/after screenshot matrix when a browser workflow can save the true viewport without padding or cropping.
7. Access requests use the existing server records and events; the separate inbox page is intentionally not exposed in the workspace.

Visual-only boundary: do not modify API calls, event names, message semantics, WebRTC, crypto, schemas, or persistence models. Do not invent contacts, notification center data, command-palette search over shared files, or other non-existent capability.
