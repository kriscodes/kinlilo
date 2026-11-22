# Kinlilo

Private family location sharing and location history for iPhone and the web.

Kinlilo (pronounced **kin-LEE-lo**) starts with two things: seeing consenting family members' latest reported positions and browsing their location history. It is a personal alternative to the location features used in Life360, with its own name and implementation.

## Local review

This workspace implements email and password accounts, private circles, and invitation redemption. On web and iOS you can create an account, sign in, create a circle, view its members, and join another circle with an invitation code. Owners can create codes that expire after 24 hours and can be redeemed once. Members can leave circles they joined. Anyone with a valid code can redeem it while signed in, so share codes directly with the intended recipient.

The web and native apps use the same Express API and PostgreSQL database. Better Auth manages credentials and revocable sessions. The web uses an HTTP-only cookie. The Expo client stores its session cookie in SecureStore. Invitation codes are stored as hashes. Circle access is checked against current membership, and membership alone does not enable location sharing.

Location capture, histories, per-member visibility rules, verification email, and account recovery are future work. Use synthetic accounts and a local database for this review.

### Start the web app

Requirements are Node 22 and pnpm 11. Start PostgreSQL on loopback through Docker or use an existing local PostgreSQL instance with a dedicated database.

```sh
pnpm install
docker compose up -d --wait db
cp .env.example .env
openssl rand -hex 32
```

Set `BETTER_AUTH_SECRET` in `.env` to the generated value. If you're using a different local database, update `DATABASE_URL` there. Then run:

```sh
pnpm db:migrate
pnpm dev
```

Open [Kinlilo on this Mac](http://127.0.0.1:4310). Create two synthetic accounts in separate browser profiles or sign out between them. Create a circle as the first account, copy its invitation code, then join as the second account.

### Start the iOS app

Keep the API running. On an iOS simulator the app uses `http://127.0.0.1:4311` by default. Run `pnpm --filter @kinlilo/mobile ios` for a local development build. A physical phone needs a reachable development API URL in `apps/mobile/.env`, a LAN-facing API bind, and a signed native build. The simulator setup does not require an App Store Connect app record.

### Check the workspace

```sh
pnpm typecheck
pnpm build
```

For the PostgreSQL integration test, create a separate loopback database called `kinlilo_test`, migrate it and run the suite. With the example Docker settings:

```sh
docker compose exec db createdb -U kinlilo kinlilo_test
DATABASE_URL=postgresql://kinlilo:kinlilo@127.0.0.1:54399/kinlilo_test pnpm db:migrate
pnpm test:integration
```

Override `KINLILO_TEST_DATABASE_URL` for different local credentials. Tests use synthetic users and a dedicated test database.

## Workspace layout

- `apps/web` is the Next.js app, using the pale lilac design with plum primary buttons.
- `apps/mobile` is the React Native app using Expo.
- `apps/api` is the shared Express API. Drizzle handles circle persistence, and Better Auth handles identity and sessions.
- `packages/contracts` contains shared request validation, response types, and the circle API client.

## Location roadmap

The mobile app will collect opted-in background locations and upload them to the shared API. The web and mobile apps will show time-stamped positions and trip and stop history. The first native location milestone will test locked phones, poor connectivity, and battery use on real iPhones. Family or circle administration will not override a member’s consent.

## Costs and iOS distribution

Replacing Life360 still requires evaluating Apple membership, hosting, database/backups, map tiles, and identity costs. Apple lists Developer Program membership at US$99/year; TestFlight builds expire after 90 days. Free personal provisioning is useful for development but requires frequent renewal. No paid services have been purchased for this project.

[Apple Developer Program](https://developer.apple.com/programs/) · [TestFlight build statuses](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses/)

## Name check

On November 20, 2026, public US Apple software-catalog and Google Play checks found no matching Kinlilo app listing; the public GitHub name search also found no repository before this one was created. **The app name is not yet reserved in App Store Connect.** Public search cannot rule out unpublished reservations. No domain or trademark registration has been performed.
