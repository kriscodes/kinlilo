# Kinlilo

Private family location sharing and location history for iPhone and the web.

Kinlilo (pronounced **kin-LEE-lo**) starts with two things: seeing consenting family members' latest reported positions and browsing their location history. It is a personal alternative to the location features used in Life360, with its own name and implementation.

## Local review

This workspace implements email and password accounts, private circles, and invitation redemption. On web and iOS you can create an account, sign in, create a circle, view its members, and join another circle with an invitation code. Owners can create codes that expire after 24 hours and can be redeemed once. Members can leave circles they joined. Anyone with a valid code can redeem it while signed in, so share codes directly with the intended recipient.

The web and native apps use the same Express API and PostgreSQL database. Better Auth manages credentials and revocable sessions. The web uses an HTTP-only cookie. The Expo client stores its session cookie in SecureStore. Invitation codes are stored as hashes. Circle access is checked against current membership, and membership alone does not enable location sharing.

The iOS app can opt into location capture and sync an encrypted outbox to the API. Web and iOS show the selected circle’s last reported locations and date-filtered history. Verification email and account recovery are future work. Use synthetic accounts and a local database for this review.

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

### Try the iOS location outbox

Rebuild the native app to get SQLCipher. If an iOS project was generated before SQLCipher was enabled, run `pnpm --filter @kinlilo/mobile exec expo prebuild --platform ios --clean` to replace the generated directory before building. Configure an HTTPS API URL for sharing on a physical phone. Loopback HTTP works for local simulator tests.

Sign in, open a circle, and select **Start location sharing**. Allow location access **Always** in iOS Settings. This iPhone can share to one circle at a time. Background callbacks save fixes in the encrypted queue. Bring Kinlilo to the foreground with its signed-in session to sync them. The queue retains up to 10,000 fixes from the last 48 hours.

**Pause location sharing** stops local capture and discards queued fixes. **Pause pending** remains visible while the server is unreachable. Reopen Kinlilo with the same signed-in account and a connection to confirm the pause.

### View last reported locations

Open a circle on web or iOS. The map and member list update while the circle is open in the foreground. Each fix includes its capture time and reported accuracy. After a pause or a device change, a new fix is required before a marker can appear again. Rebuild the iOS app to include Apple Maps support.

The web basemap uses bundled [Natural Earth land geometry](https://www.naturalearthdata.com/about/terms-of-use/). For street detail, set `NEXT_PUBLIC_KINLILO_MAP_STYLE_URL` in the root `.env` to an approved HTTPS MapLibre style and rebuild the web app. A configured tile provider receives viewport-based map requests from the browser.

### View location history

Open a circle, choose **History**, then select a member and a date in your local time zone. The map and timeline show reported fixes, their capture times and accuracy, and gaps between reports. Use the earlier and later controls to browse dates with many reports.

You can see your own retained history while sharing is paused. Other members’ history is available while they share with the circle, starting when you joined. The API serves up to 30 days of history by default. Set `KINLILO_LOCATION_RETENTION_DAYS` to change that window.

### Run the iOS location test

Use a native iOS build with the harness explicitly enabled. The test screen works independently of sign-in and the API. From a checkout with no generated `apps/mobile/ios` directory, run:

```sh
EXPO_PUBLIC_KINLILO_LOCATION_HARNESS=1 pnpm --filter @kinlilo/mobile ios
```

If you already generated an iOS project, regenerate it with `EXPO_PUBLIC_KINLILO_LOCATION_HARNESS=1 pnpm --filter @kinlilo/mobile exec expo prebuild --platform ios --clean`. This replaces the generated iOS directory. For an offline physical-device trial, use the same flag with `pnpm --filter @kinlilo/mobile ios --device --configuration Release` to embed the JavaScript bundle. Regenerate the native project without the flag before making an ordinary build.

Select **Open iOS location test**, request **When In Use** then **Always**, and select **Start test**. If iOS keeps the permission at While Using, open iOS Settings and select Always there. Walk with the phone, then try it backgrounded or locked. Reopen the test to see the callback count and the latest probe results. **Share diagnostic report** exports up to 1,000 queued callbacks with capture and callback times, app state, and results from two synthetic Keychain items. Test records stay on the phone until shared explicitly. The harness stores no coordinates and sends no uploads. Select **Stop test** to end capture, then **Clear diagnostics** when you want to discard the report.

### Check the workspace

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
```

Run `pnpm format` to apply the workspace formatting rules. On macOS with Xcode and CocoaPods, run `pnpm build:ios:smoke` from a checkout without a generated `apps/mobile/ios` directory. It builds an unsigned Simulator release and verifies the bundled JavaScript, SQLCipher, and iOS background location configuration. GitHub Actions runs these checks and the PostgreSQL integration suite.

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

The first physical-device trial will test locked phones, poor connectivity, and battery use. Family or circle administration will not override a member’s consent.

## Costs and iOS distribution

Replacing Life360 still requires evaluating Apple membership, hosting, database/backups, map tiles, and identity costs. Apple lists Developer Program membership at US$99/year; TestFlight builds expire after 90 days. Free personal provisioning is useful for development but requires frequent renewal. No paid services have been purchased for this project.

[Apple Developer Program](https://developer.apple.com/programs/) · [TestFlight build statuses](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses/)

## Name check

On November 20, 2026, public US Apple software-catalog and Google Play checks found no matching Kinlilo app listing; the public GitHub name search also found no repository before this one was created. **The app name is not yet reserved in App Store Connect.** Public search cannot rule out unpublished reservations. No domain or trademark registration has been performed.
