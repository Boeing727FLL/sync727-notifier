# Sync 727 Notifier

Push notification dispatcher for the [Sync 727](https://github.com/Boeing727FLL/sync727) team-management app (Boeing 727 FLL). Sends Firebase Cloud Messaging (FCM) pushes to app users.

This repo is **code only** — no data, no keys, no secrets.

## How it works

- GitHub Actions runs `src/index.js` every 15 minutes (`schedule`) and on demand (`workflow_dispatch`).
- Authentication to Google Cloud uses **Workload Identity Federation** (OIDC). The workflow mints a short-lived token for the dedicated service account `sync727-notifier@sync-727-1f91f.iam.gserviceaccount.com`. There is **no service-account JSON key**, anywhere.
- The Workload Identity pool accepts tokens **only** from this repository (`attribute.repository == Boeing727FLL/sync727-notifier`).
- The script reads pending events from Firestore, dedupes via the `_notifier_state` collection (so every push goes out exactly once), sends through FCM v1, and prunes dead tokens from `push_subscriptions`.
- `concurrency: group: notifier` prevents overlapping runs.

## What triggers a push

| Source (Firestore) | Event | Audience |
| --- | --- | --- |
| `notifications` | New mentor announcement | Role group matching `target` (members / parents / mentors / all), excluding the sender |
| `playlist_requests` | New pending add/delete song request | Admins |
| `sprint_tasks` | New task with assignees | The assignees |
| `sprint_tasks` | Task due today (07:30-12:00 IL) | The assignees |
| `parent_shifts` | Day before the shift, 19:00 IL | The assigned parent |
| `parent_shifts` | Shift day, 07:30-12:00 IL | The assigned parent |
| `attendance` | Member sets/changes status | Mentors |

Parent shifts with `parentId: "manual"` (mentor-entered, not linked to an app user) are never pushed — no name matching.

The very first run only sets the high-watermark, so historical documents never trigger a push storm.

## Manual run

Actions → Notify → Run workflow. Or:

```
gh workflow run notify.yml --repo Boeing727FLL/sync727-notifier
```
