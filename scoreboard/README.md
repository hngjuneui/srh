# Rally Scoreboard

Standalone tablet-first badminton scoreboard, separate from rally-lab.

## Use
Tap or swipe down on a team's score to add one. Swipe up cancels that team's last point in the current game. Undo cancels the last point. Side swap preserves team identity.

Remote settings can learn a browser-visible keyboard key. Short release scores for the selected team; holding for 700 ms scores once for the other team. Repeated keydown events are suppressed. Blur cancels a pending press. Volume/home buttons intercepted by the OS cannot be read by this web app. Test keydown AND keyup on the actual remote before match use.

## Storage
Events are saved locally and synchronized to a Cloudflare SQLite Durable Object. A random 256-bit vault code is the bearer credential: anyone with it can read/write that vault. Copy it from Settings > storage and enter it on another device. Do not publish the code. Lost codes cannot be recovered after local browser storage is cleared. JSON export is available.
Concurrent edits are detected by revisions. Conflicts preserve both versions through an explicit recovery action.

## Develop / deploy
Node.js 22 or later.
npm install
npm test
npm run dev
npm run deploy

Cloudflare Workers Builds: repository hngjuneui/srh, root scoreboard, build npm test, deploy npx wrangler deploy.
Worker name: rally-scoreboard. SQLite Durable Object migration is included; no separately provisioned database required.

## Verification
Automated tests cover scoring, deuce/cap, match progression, undo, remote repeats/cancel, request validation, revision conflicts and idempotent retries.
Hardware remote compatibility and iOS wake/fullscreen behavior require physical-device testing.
