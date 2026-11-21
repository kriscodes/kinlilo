# Kinlilo

Private family location sharing and location history for iPhone and the web.

Kinlilo (pronounced **kin-LEE-lo**) starts with two things: seeing consenting family members' latest reported positions and browsing their location history. It is a personal alternative to the location features used in Life360, with its own name and implementation.

## Project status

**Planning only.** This repository intentionally contains only this README. There is no application scaffold, database migration, API implementation, or deployed service yet.

- [Project home, designs, tasks, and continuity notes in Notion](https://app.notion.com/p/41fe9784880681de935ec1dc76fa3e18)
- [GitHub repository](https://github.com/kriscodes/kinlilo)

## First release

- Invite family members into a private circle.
- Let each member explicitly enable, pause, and resume their own sharing.
- Show latest reported positions with capture time, freshness, and accuracy.
- Browse a member's retained history by date, with visible gaps where data is missing.
- Queue a phone's own location samples while offline and upload safely on reconnect.
- Manage devices, leave a circle, and delete location history or an account.

Initial proposal: retain 30 days of history, with a configurable policy. Background location is best effort: iOS controls execution, and a force-quit app may stop reporting. A stale location must never be presented as a current fix. This is not an emergency-response service.

## Technology

The core follows the existing CareIQ/maliro stack.

| Area | Proposed choice |
| --- | --- |
| Monorepo | pnpm workspaces, TypeScript |
| Web | Next.js and React |
| Mobile | React Native, Expo development builds, Expo Router |
| Shared API | Node.js and Express, REST/JSON under `/v1` |
| Database | PostgreSQL, Drizzle ORM, `pg` |
| Contracts | Zod schemas, OpenAPI, shared typed API client |
| Identity | Clerk initially proposed; confirm cost and native integration |
| Location capture | Expo Location and TaskManager |
| Offline storage | SQLCipher-enabled Expo SQLite; keychain storage via SecureStore |
| Maps | Apple Maps through react-native-maps on iOS; MapLibre with licensed tiles on web |
| Client data | TanStack Query; shared domain utilities and design tokens |
| Validation | API/PostgreSQL integration tests, Playwright, native component tests, real iPhones |
| iOS delivery | Xcode, CocoaPods, EAS CLI; TestFlight for the family beta |

Package versions will be selected and pinned together when the app is scaffolded. PostGIS is optional for future geofences and spatial queries; Redis and a message broker are not required for the first family deployment.

## Architecture

```text
iPhone background location
  -> encrypted local outbox
  -> HTTPS batches
  -> shared Express API
  -> PostgreSQL history + latest location

Next.js web -------> same API
React Native UI ---> same API
Maintenance job ---> retention and cleanup
```

The mobile app collects location. The web app views locations and manages the circle. Both clients use the same API contracts and authorization rules; neither accesses PostgreSQL directly. Begin with foreground polling for map updates.

The API derives the member identity from authentication, validates circle membership and sharing consent on every request, deduplicates sample IDs, and prevents late uploads from moving the latest location backward.

## Planned monorepo layout

The following directories are a plan only; they have not been created.

```text
apps/
  web/                 # Next.js
  mobile/              # React Native + Expo
  api/                 # Express + Node.js
packages/
  contracts/           # Zod and API types
  api-client/          # shared client and query keys
  db/                  # Drizzle schema and migrations; server only
  domain/              # freshness, history, permissions, formatting
  design-tokens/       # shared tokens with platform adapters
  config/              # shared tooling configuration
```

Detailed schema, endpoints, frontend components, privacy behavior, deployment plans, decisions, and continuity notes are maintained in the Notion project.

## Privacy and data ownership

Sharing starts disabled. Family administration does not override a person's consent. Proposed v1 behavior: pausing hides that member's latest position and history from peers after server confirmation, while retaining their own history. Offline pause stops local collection immediately and shows the remote change as pending. Resume shares permitted retained history again, but current position waits for a fresh sample. Removal, device revocation, and deletion invalidate outstanding upload sessions. New members cannot see history from before they joined.

Location data uses TLS in transit and protected storage; the proposed server can read it, so this is not end-to-end encryption. Exact coordinates and tokens must stay out of logs and analytics. Retention, backup expiry, and deletion behavior must be tested before a family pilot.

## First engineering milestone

Validate capture and delivery on two physical iPhones before broad UI implementation: locked/background operation, permission changes, force quit, reboot, poor connectivity, duplicate uploads, credential access while locked, and battery use. Expo Go is insufficient for background-location validation; use a development build.

[Expo location documentation](https://docs.expo.dev/versions/latest/sdk/location/)

## Costs and iOS distribution

Replacing Life360 still requires evaluating Apple membership, hosting, database/backups, map tiles, and identity costs. Apple lists Developer Program membership at US$99/year; TestFlight builds expire after 90 days. Free personal provisioning is useful for development but requires frequent renewal. No paid services have been purchased for this project.

[Apple Developer Program](https://developer.apple.com/programs/) · [TestFlight build statuses](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses/)

## Name check

On November 20, 2026, public US Apple software-catalog and Google Play checks found no matching Kinlilo app listing; the public GitHub name search also found no repository before this one was created. **The app name is not yet reserved in App Store Connect.** Public search cannot rule out unpublished reservations. No domain or trademark registration has been performed.

## Working agreement

Keep this repository README-only until implementation is explicitly started. Record decisions, open questions, toolchain state, and the next concrete action in the Notion continuity notes. Do not store credentials or real family location data in Git.
