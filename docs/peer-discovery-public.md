# Public peer discovery: threat analysis and proposal

## Status

Orbit does not provide a public resource directory. This document proposes a separately opted-in design only; it does not authorize implementation or public exposure. The current Step 4 work is limited to a user's existing, unblocked conversation partners.

## Threats

A searchable global directory can expose a person's availability, interests, and behavior over time. Even a listing containing no file names can enable scraping, targeted harassment, unwanted contact, and inference about sensitive activities from titles and tags. If a listing is linked to an encrypted folder manifest, it could also create a path from public discovery to private file metadata or unauthorized transfer attempts. Public discovery increases abuse and moderation demands and creates incentives to publish misleading, unlawful, or harmful material.

The server must never index or receive encrypted folder manifests, file names, paths, contents, transfer details, or search queries. Public listings must not grant access to encrypted shares or bypass the existing per-conversation authorization checks.

## Proposed opt-in model

- Publishing is a distinct, explicit action. A user writes a separate public listing title (at most 80 characters) and chooses at most five tags. These fields are unrelated to and never derived from encrypted manifests.
- Each listing has a visibility setting: `off`, `contacts`, or `public`. `off` is the default. Changing visibility requires a clear confirmation that the selected audience can see the listing.
- Listings appear only while the owner is online, presence-visible, and the associated share is currently available. Going offline, appearing offline, pausing the share, revoking it, or losing availability immediately removes the listing from results.
- A listing is descriptive only. Browsers cannot open a tree, preview, or download from a public listing. A requester must send a connection request, and the owner must explicitly accept it. Only then may a normal one-to-one conversation and the existing share authorization flow be used.
- Search should be rate-limited, paginated, abuse-monitored, and protected against bulk enumeration. Do not expose online state or availability for arbitrary user IDs outside result responses.

## Safety and operations required before enabling

Before any public mode is enabled, Orbit needs user reporting and blocking, abuse triage, a documented takedown channel, appeal handling, and a moderation process with trained responders and response-time targets. Reports must identify the listing and account without collecting file names or transfer information. Moderators need a way to hide a listing and suspend repeat abusers; enforcement should not require access to private manifests.

Store only listing text, user-selected tags, visibility, owner/listing identifiers, and creation/update timestamps required for operation. Do not retain search queries or viewer histories. Remove listings immediately when disabled or when their eligibility ends; define a short, documented retention period for moderation reports and deletion requests. Audit access to moderation tools, limit staff access, and publish transparency metrics that cannot identify reporters.

## Enablement gate

Public mode must remain disabled until a separate product/security review approves the abuse controls, data retention, moderation staffing, rate limits, and user-facing disclosure. Any future implementation must be behind a server-side `PEER_DISCOVERY_PUBLIC` flag that defaults to false. A reserved discoverability setting must remain hidden and ignored while the flag is off. No public listing endpoint or directory is included in this step.
