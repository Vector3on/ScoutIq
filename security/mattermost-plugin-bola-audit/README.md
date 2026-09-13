# Mattermost first-party plugins — Broken Object-Level Authorization (BOLA/IDOR) source audit

Source-only authorization audit of the channel-scoped HTTP handlers across
Mattermost's first-party `mattermost-plugin-*` repositories, modelled on the
known ServiceNow / Confluence subscription-BOLA pattern and calibrated against
the correct implementation in `mattermost-plugin-jira`.

- **Method:** static source review only. No live testing against any
  third-party or hosted Mattermost server. Where impact needs runtime
  confirmation it is called out as *local repro* (a self-hosted instance the
  tester controls) — never live testing of someone else's server.
- **Reporting:** this document is engineering evidence. Any Bugcrowd submission
  must be **filed by the researcher in their own words**, and **each plugin must
  be confirmed in-scope on the Mattermost Bugcrowd program before submitting**
  (first-party ≠ automatically in scope; several of these plugins are
  experimental/community-maintained).
- All line references are pinned to the exact commit each repo was audited at
  (see the Coverage table); permalinks use those SHAs.

> Status: complete. All 38 first-party plugin repositories were assessed;
> findings F1–F4 are fully source-verified (including confirmation against the
> Mattermost server source that the plugin `CreatePost`/`UpdatePost` APIs do not
> enforce the caller's channel membership — see §1).

---

## 1. The authorization invariant (reference model)

A handler that mutates or reads a **channel-scoped resource** (a subscription,
webhook, per-channel notification/config, or the channel's content) where a
`channelID` or a resource/`subscriptionID` arrives **in the request** (URL path,
query string, or JSON body) is correct **only if**, before it acts, it:

1. **loads the resource's _stored_ channel** — for by-id operations it must read
   the channel from the persisted resource, **not** from the request — and
2. verifies the caller against *that* channel with **both**
   - **membership:** `Channel.GetMember(channelID, userID)` /
     `p.API.GetChannelMember(channelID, userID)`, **and**
   - an **appropriate permission:** `HasPermissionToChannel(userID, channelID, <Manage… / operation-appropriate permission>)`.

The canonical correct implementation is
[`mattermost-plugin-jira` `server/subscribe.go`](https://github.com/mattermost/mattermost-plugin-jira/blob/46be9efeec82254b6ee9397f6db4c5a8c5d2c32c/server/subscribe.go#L1431-L1463):
`httpChannelDeleteSubscription` loads the subscription by id, then checks
`hasPermissionToManageSubscription(subscription.ChannelID)` **and**
`Channel.GetMember(subscription.ChannelID, …)` against the **stored** channel;
`httpChannelEditSubscription`
([L1334](https://github.com/mattermost/mattermost-plugin-jira/blob/46be9efeec82254b6ee9397f6db4c5a8c5d2c32c/server/subscribe.go#L1334-L1379))
checks the **original** stored channel and, if the subscription is being moved,
re-checks the **target** channel too.

### Deviation templates (what we flag)

- **A — No check:** takes an id from the request and mutates/reads with no
  membership or permission check (ServiceNow `deleteSubscription`).
- **B — Attacker-supplied channel:** checks a permission against a `channelID`
  taken from the request body/query instead of the resource's stored channel
  (ServiceNow `editSubscription`).
- **C — Create guarded, delete/edit not.**
- **D — Wrong/weaker gate:** only "is authenticated", only a plugin-wide role,
  or the wrong channel/identity.

### Calibration — the named "known" plugins

- **ServiceNow** ([`server/plugin/api.go`](https://github.com/mattermost/mattermost-plugin-servicenow/blob/bdee27338a5154d2e9caf93b38bddcb32c2a42af/server/plugin/api.go#L342-L357)):
  at the audited HEAD, `deleteSubscription` still has **no** channel
  authorization (Template A), and
  [`editSubscription`](https://github.com/mattermost/mattermost-plugin-servicenow/blob/bdee27338a5154d2e9caf93b38bddcb32c2a42af/server/plugin/api.go#L359-L380)
  checks `HasPublicOrPrivateChannelPermissions(userID, *subscription.ChannelID)`
  where `ChannelID` is decoded from the **request body** (Template B). The
  security fix `bd58e0b` ("Fixed issue #172") added checks to
  create/list/edit/share but not delete. Treated here as the **reference
  vulnerable pattern** — confirm against existing disclosures before re-filing.
- **Confluence** ([HEAD](https://github.com/mattermost/mattermost-plugin-confluence/blob/aeb4448f0327bf7863377f561eba4de2e8657647/server/user.go#L514-L526)):
  **now correct.** Every subscription endpoint is keyed by the URL `channelID`
  and gated by `hasChannelAccess` = `GetChannelMember(channelID, userID)` plus,
  for edit, `canManageSubscription` = `HasPermissionToChannel(ManageChannelRoles)`
  or creator. Reads require membership too. Historical bug is patched.

### The 7-Question Gate (applied to every finding)

1. Is there a **router-registered HTTP handler** (not a slash command) acting on
   a channel-scoped resource?
2. Does a `channelID` / resource id come **from the request**?
3. Is the resource's **stored** channel loaded, or is the channel taken from the
   request?
4. Are **both** membership **and** an appropriate permission checked against that
   channel **before** the action?
5. If not, what is the **concrete cross-channel HTTP request** an attacker sends?
6. What does the attacker **gain across the channel boundary** (read/write/delete
   of what)?
7. Is it **reachable** (route registered, no compensating secret/auth) and at
   what **account level** (unauthenticated / any user / connected user)?

A finding is reported only if Q5–Q7 produce a concrete, reachable cross-boundary
exploit.

> **Runtime fact this audit relies on (verified in server source):** the plugin
> API `CreatePost` / `UpdatePost` run with integration authority and do **not**
> enforce the acting user's channel membership or permission —
> [`PluginAPI.CreatePost`](https://github.com/mattermost/mattermost/blob/597d9c429602d119552b4a7cc7c2b50ce41f895b/server/channels/app/plugin_api.go#L899-L918)
> → [`App.CreatePost`](https://github.com/mattermost/mattermost/blob/597d9c429602d119552b4a7cc7c2b50ce41f895b/server/channels/app/post.go#L172)
> performs no membership/permission check for `FromPlugin` posts. A plugin that
> forwards a request-supplied `channelID` into `CreatePost`/`UpdatePost` without
> its own check therefore posts/edits across the channel boundary. Also: plugin
> HTTP endpoints under `/plugins/<id>/…` are reachable **without a session**; the
> server sets the `Mattermost-User-Id` header only for authenticated requests, so
> an auth guard that forgets to `return` is effectively no guard.

---

## 2. Findings

### F1 — `agenda`: cross-channel meeting-config tampering + unauthenticated read/write  ·  Template A  ·  **primary in-class finding**

**Repo:** `mattermost-plugin-agenda` @ `0f5d7d10faf381a6ed56817a1cd69e8a24a1e579`

The per-channel **Meeting** configuration (posting `Schedule` + `HashtagFormat`)
is a channel-scoped resource stored in the plugin KV store **keyed by a
channelID taken from the request**, and there is **no** membership or permission
check anywhere in the plugin (`GetChannelMember` / `HasPermissionToChannel`
appear zero times in the repo).

- Struct + sink — [`server/meeting.go` L20-24, L55-66](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/meeting.go#L20-L66):
  `ChannelID` is `json:"channelId"`; `SaveMeeting` does
  `p.API.KVSet(meeting.ChannelID, …)`.
- Router — [`server/plugin.go` L42-52](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/plugin.go#L42-L52):
  `POST/GET /api/v1/settings` → `httpMeetingSettings`.
- **Auth guard falls through** — [`server/plugin.go` L74-88](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/plugin.go#L74-L88):
  `if mattermostUserID == "" { http.Error(w, "Not Authorized", 401) }` has **no
  `return`**, so execution continues into the method switch even with no session.
- **Write** — [`httpMeetingSaveSettings` L90-113](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/plugin.go#L90-L113):
  decodes the body into `Meeting` and calls `SaveMeeting` — the `mmUserID`
  argument is **never used**.
- **Read** — [`httpMeetingGetSettings` L115-130](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/plugin.go#L115-L130)
  (`?channelId=`) and [`httpMeetingDaysAutocomplete` L147-187](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/plugin.go#L147-L187)
  (`?channel_id=`, routed with **no** auth guard). For an unconfigured channel,
  `GetMeeting` calls `GetChannel` and returns `channel.Name` inside
  `HashtagFormat` ([`meeting.go` L38-48](https://github.com/mattermost/mattermost-plugin-agenda/blob/0f5d7d10faf381a6ed56817a1cd69e8a24a1e579/server/meeting.go#L38-L48)).

**7-Question Gate.** (1) yes — `httpMeetingSaveSettings`. (2) yes — `channelId`
in the JSON body. (3) taken from the request; no stored channel is consulted.
(4) neither membership nor permission is checked. (5) concrete request:

```
POST /plugins/com.mattermost.agenda/api/v1/settings
Content-Type: application/json

{"channelId":"<VICTIM_CHANNEL_B_ID>","schedule":[1],"hashtagFormat":"pwned-{{ Jan02 }}"}
```

(6) the attacker overwrites the agenda schedule/hashtag of **any** channel B they
are not a member of (private channels included), corrupting how that channel's
agenda items are queued/named; via the GET/autocomplete endpoints they can also
**read** any channel's schedule and disclose an unconfigured channel's `Name`.
(7) reachable, and because of the missing `return` it is reachable
**unauthenticated** (empty `Mattermost-User-Id`); the autocomplete read has no
auth guard at all. **Passes.**

**Fix.** Add, in every `/api/v1/settings` and autocomplete path, a
`GetChannelMember(channelID, userID)` **and**
`HasPermissionToChannel(userID, channelID, PermissionCreatePost)` (or a
`Manage…` permission) check against the request `channelID`, and add the missing
`return` after the 401.

---

### F2 — `circleci`: unauthenticated arbitrary-post defacement + cross-channel bot post  ·  Template A

**Repo:** `mattermost-plugin-circleci` @ `6861f52db5e64a660de392bd7a9ea343a4c945cf`

- Router — [`server/plugin/http.go` L30](https://github.com/mattermost/mattermost-plugin-circleci/blob/6861f52db5e64a660de392bd7a9ea343a4c945cf/server/plugin/http.go#L30):
  `POST …/job/approve` → `httpHandleApprove`.
- Handler — [`server/plugin/approve.go` L12-87](https://github.com/mattermost/mattermost-plugin-circleci/blob/6861f52db5e64a660de392bd7a9ea343a4c945cf/server/plugin/approve.go#L12-L87).
  The only guard, [`if circleciToken == "" { http.NotFound(w, r) }`](https://github.com/mattermost/mattermost-plugin-circleci/blob/6861f52db5e64a660de392bd7a9ea343a4c945cf/server/plugin/approve.go#L19-L21),
  has **no `return`**, so an unauthenticated / not-connected caller
  (`userID == ""`, `getUsername("") == "unknown user"`) proceeds. It then reads
  `requestData.PostId` and `requestData.ChannelId` from the request body and:
  - [`GetPost(requestData.PostId)` → mutates attachments → `UpdatePost`](https://github.com/mattermost/mattermost-plugin-circleci/blob/6861f52db5e64a660de392bd7a9ea343a4c945cf/server/plugin/approve.go#L31-L54)
    — defaces an **arbitrary post** by id (strips its actions, recolors, retitles
    "approved by unknown user");
  - [`responsePost{ChannelId: requestData.ChannelId}` → `createPost`](https://github.com/mattermost/mattermost-plugin-circleci/blob/6861f52db5e64a660de392bd7a9ea343a4c945cf/server/plugin/approve.go#L57-L86)
    (`createPost` = `p.API.CreatePost`, [`utils.go` L40](https://github.com/mattermost/mattermost-plugin-circleci/blob/6861f52db5e64a660de392bd7a9ea343a4c945cf/server/plugin/utils.go#L40))
    — injects a bot post into an **attacker-chosen** channel.

No membership, permission, or (because of the missing `return`) authentication
check is applied to either id.

**7-Question Gate.** Concrete request (no session required):

```
POST /plugins/com.github.mattermost.plugin-circleci/job/approve
Content-Type: application/json

{"post_id":"<ANY_POST_ID>","channel_id":"<VICTIM_CHANNEL_B_ID>","context":{"WorkflowID":"x"}}
```

Gain: deface any post in any channel and inject a CircleCI-bot message into a
channel B the attacker cannot access; reachable **unauthenticated**. **Passes.**
(Subscriptions themselves are slash-command managed and out of scope;
`httpHandleEnvOverwrite` shares the missing-auth shape but only touches the
caller's own ephemeral post + own CircleCI token, so it is not flagged.)

**Fix.** Require `Mattermost-User-Id` (with a `return`); derive the post/channel
from the trusted interactive-action context and verify
`GetChannelMember` + `HasPermissionToChannel` on the post's/channel's real
channel before `UpdatePost`/`CreatePost`.

---

### F3 — `giphy`: authenticated cross-channel post injection  ·  Template A

**Repo:** `mattermost-plugin-giphy` @ `f2581005bf3a1d654a0bb9642df6245765eb71a7`

- Router — [`server/post_action.go` L20-25](https://github.com/mattermost/mattermost-plugin-giphy/blob/f2581005bf3a1d654a0bb9642df6245765eb71a7/server/post_action.go#L20-L25):
  `POST /api/v1/send` → `handleSend` (no router-level auth middleware).
- [`decodePostActionRequest` L27-54](https://github.com/mattermost/mattermost-plugin-giphy/blob/f2581005bf3a1d654a0bb9642df6245765eb71a7/server/post_action.go#L27-L54)
  requires `Mattermost-User-Id` and safely sets `request.UserId` to the **header**
  user (no author spoofing) — but the target channel is
  `request.ChannelId` / `context["ChannelId"]`, i.e. **request-controlled**.
- [`handleSend` L101-121](https://github.com/mattermost/mattermost-plugin-giphy/blob/f2581005bf3a1d654a0bb9642df6245765eb71a7/server/post_action.go#L101-L121)
  builds `&model.Post{UserId: request.UserId, ChannelId: c.ChannelId}` and calls
  `p.API.CreatePost` with **no** `GetChannelMember` / `HasPermissionToChannel`
  check.

**7-Question Gate.** Any logged-in user sends:

```
POST /plugins/<giphy-id>/api/v1/send
Content-Type: application/json

{"user_id":"<self>","context":{"ChannelId":"<VICTIM_PRIVATE_CHANNEL_B>","Query":"x","EmbedURL":"https://…","LinkURL":"https://…","RootId":"","ParentId":""}}
```

Because plugin `CreatePost` does not enforce membership (verified in server
source, §1), this injects a real message authored by the attacker into a channel
B (private / other team) they are not a member of. Cross-channel write.
**Passes** (moderate: integrity/nuisance/phishing into channels the attacker
cannot otherwise reach).

**Fix.** Before `CreatePost`, check `GetChannelMember(c.ChannelId, request.UserId)`
and `HasPermissionToChannel(request.UserId, c.ChannelId, PermissionCreatePost)`.

---

## 3. Additional authorization issue (outside the channel-BOLA class)

### F4 — `solar-lottery`: HTTP command endpoint acts as a request-body user id  ·  Template D (identity/horizontal privesc)

**Repo:** `mattermost-plugin-solar-lottery` @ `b2156883c6060e4a34dccf6cf3e1bb07fb906442`

[`server/api/service.go` L37](https://github.com/mattermost/mattermost-plugin-solar-lottery/blob/b2156883c6060e4a34dccf6cf3e1bb07fb906442/server/api/service.go#L37)
registers `POST /api/v1/execute_command` →
[`executeCommand` L12-33](https://github.com/mattermost/mattermost-plugin-solar-lottery/blob/b2156883c6060e4a34dccf6cf3e1bb07fb906442/server/api/command.go#L12-L33).
The header `userID` is checked non-empty and then **discarded**; the command runs
as `s.sl.ActingAs(types.ID(args.UserId))` where `args` is
`CommandArgsFromJson(r.Body)` — i.e. the **effective actor is the body-supplied
`user_id`**
([`ActingAs` `sl/sl_service.go` L33](https://github.com/mattermost/mattermost-plugin-solar-lottery/blob/b2156883c6060e4a34dccf6cf3e1bb07fb906442/server/sl/sl_service.go#L33)),
and there is no admin/permission model in `sl`/`command`.

This is not channel BOLA; it is **user-object** authorization break: any
logged-in user can run solar-lottery operations (rotation join/leave,
qualify/disqualify, availability) **as any other user** by setting
`{"user_id":"<victim>", …}`. Included because it was found on the same HTTP
attack surface. **Caveat:** `solar-lottery` is experimental/abandoned — confirm
it is deployed and **in Bugcrowd scope** before considering a submission. (A
separate functional bug: [`command.go` L27](https://github.com/mattermost/mattermost-plugin-solar-lottery/blob/b2156883c6060e4a34dccf6cf3e1bb07fb906442/server/api/command.go#L27)
inverts the error check `if err == nil`.)

---

## 4. Lower-confidence / informational

- **`servicenow-virtual-agent`** @ `8b3fe8b3c517…` — [`handleSetDateTime` `server/plugin/api.go` L339-427](https://github.com/mattermost/mattermost-plugin-servicenow-virtual-agent/blob/8b3fe8b3c5172a38bac361899882cc97ea40c032/server/plugin/api.go#L339-L427):
  a connected user can `UpdatePost` a post whose id derives from the request
  `CallbackId`, with canned "You selected…" content and no channel check.
  Low impact (fixed content, connected caller). *POSSIBLE.*
- **`google-calendar`** @ `83dc9ffa…` — registers no HTTP handlers of its own; it
  imports the entire `mattermost-plugin-mscalendar` router. mscalendar **at HEAD**
  is clean (`createEvent` gates on `CanLinkEventToChannel` → `HasPermissionToChannel(CreatePost)`),
  but google-calendar **pins `mscalendar v1.6.1`**. Whether that tagged release
  already contains the channel-authorization checks could not be confirmed from a
  shallow clone — **verify against the `v1.6.1` source** before declaring the
  shipped artifact clean.

---

## 5. Coverage

All first-party `mattermost-plugin-*` repositories, at the audited commit.
`jira` is the reference model; `github`/`gitlab` were excluded as
researcher-verified clean.

| Plugin | Commit | Verdict |
|---|---|---|
| agenda | `0f5d7d10faf3` | **FLAG (F1)** — Template A, channel meeting-config tamper + unauth read/write |
| circleci | `6861f52db5e6` | **FLAG (F2)** — Template A, unauth post defacement + cross-channel bot post |
| giphy | `f2581005bf3a` | **FLAG (F3)** — Template A, authenticated cross-channel post injection |
| solar-lottery | `b2156883c606` | **FLAG (F4)** — Template D, acts as request-body user id (identity) |
| servicenow-virtual-agent | `8b3fe8b3c517` | Clean (class); POSSIBLE low — `set-date-time` post overwrite |
| google-calendar | `83dc9ffa0353` | Clean at source; verify pinned `mscalendar v1.6.1` |
| servicenow | `bdee27338a51` | Reference/known — delete no-check, edit body-channel (confirm novelty) |
| confluence | `aeb4448f0327` | Clean — patched (membership + manage on URL channel) |
| jira | `46be9efeec82` | Reference correct model (not audited) |
| github | `65082e9d6bce` | Excluded — researcher-verified clean |
| gitlab | `603b0d716092` | Excluded — researcher-verified clean |
| bitbucket | `6c3078e04fa7` | Clean — subs via slash command; no HTTP sub CRUD |
| zoom | `e244b6391ae9` | Clean — `GetChannelMember` + perms; `ManageSystem` for channel config; HMAC webhook |
| webex | `91ddef2aea48` | Clean — `GetChannelMember` on requested channel |
| jitsi | `7c00320049e3` | Clean — `GetChannelMember` on requested channel |
| skype4business | `32eb7cf27a44` | Clean — `GetChannelMember` before post |
| msteams-meetings | `dba66a9c8e14` | Clean — `GetChannelMember` + `CreatePost` |
| msteams | `d9ad4dd7030b` | Clean — link via command; admin endpoints `ManageSystem` |
| mscalendar | `a8aecdb6e245` | Clean — `CanLinkEventToChannel` → `CreatePost`; stored-post channel |
| calls | `89c2aa7e782f` | Clean — `HasPermissionToChannel`/`GetChannelMember` on `channel_id` |
| channel-export | `6c98b0b8f739` | Clean — `ReadChannel` on requested channel + export permission |
| aws-SNS | `9b567fa495c4` | Clean — shared-token gated; channel restricted to admin allowlist |
| jenkins | `78ec4c3ad4fb` | Clean — per-user Jenkins creds; no subscriptions |
| todo | `268f98f67fa8` | Clean — per-user todos keyed to requester |
| nps | `cf94c7a8fff1` | Clean — per-user, keyed to header user |
| user-survey | `408dbb597194` | Clean — global survey; admin-gated; self response |
| welcomebot | `a1eb260dd0a0` | Clean — sysadmin gate / self onboarding; command out of scope |
| autolink | `a36c481a634e` | Clean — admin-gated plugin-wide config |
| custom-attributes | `ddc108f41743` | Clean — per-user labels (minor by-design cross-user read) |
| wrangler | `b9d05ffd2789` | Clean — HTTP = settings/profile; post moves via command w/ checks |
| memes | `0b5f1b6bc12a` | Clean — image render only; posting via command |
| starter-template | `3296cf6fad80` | Clean — hello-world only |
| boards | `2f692a9e059f` | Clean — board-permission service loads the stored board; by-id ops reconcile `block.BoardID != boardID` before checking |
| playbooks | `884853f1e4d8` | Clean — permissions service loads run/action; `checkEditPermissions` + stored-channel reconciliation (`existingAction.ChannelID != channelID`) |
| apps | `b7f600064bd8` | Clean — channel subs require `ReadChannel` on `sub.ChannelID`; context expansion uses acting-user token; unsubscribe owner/sysadmin |
| ai | `200d2395a543` | Clean — `postAuthorizationRequired` gates `ReadChannel` on the **stored** `post.ChannelId`; stronger gates for autoreply/transcribe |
| metrics | `d087668f30ae` | Clean — all routes behind `ManageSystem` (`authorized` middleware) |
| legal-hold | `ea8a6bfa9a2e` | Clean — `ServeHTTP` gates every request on `ManageSystem` |

Redirect/duplicate repos folded in: `msteams-sync` → `msteams`;
`incident-management` / `incident-response` → `playbooks`.

---

## 6. Reproduction & boundary

- Reproduce on a **self-hosted, tester-owned** Mattermost instance with the
  target plugin installed (local repro). Do **not** test against any
  third-party/hosted server.
- F1/F2 are reachable without a session (`curl` the endpoint with no cookie);
  F3 needs any logged-in user's token; F4 needs any logged-in user's token.
- This document is evidence only. The **researcher files any report in their own
  words**, and confirms **per-plugin Bugcrowd scope** first.
