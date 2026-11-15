# Đại Dương Bé Xíu — Fish Eat Fish

A browser based multiplayer fish survival game. The Node.js server owns movement, food collection, player collisions, profile currency, skin purchases, match history, and leaderboard writes. The app has Home, Play, Characters, Shop, Ranking, and Profile screens. It runs in guest mode out of the box; Firebase Authentication and Firestore are optional integrations.

## Run locally

```sh
npm install
npm start
```

Open <http://localhost:3000>. Guests can play immediately. Their scores are stored in `server/data/leaderboard.json` when a run ends.

## Enable Firebase accounts and Firestore leaderboard

1. Create a Firebase project, enable **Authentication → Email/Password** and **Google**, and create a Firestore database.
2. Register a Web app in Firebase and copy its config into `FIREBASE_WEB_CONFIG` as a single-line JSON value.
3. Create a service account with Firestore access. For local development, store its JSON in a private file outside version control and point `FIREBASE_SERVICE_ACCOUNT` to that file. For a cloud host, add the complete JSON to the secret environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. Copy `.env.example` to `.env`, add the web config and one service-account option, then restart the server. Keep service-account JSON private; never commit it.

The browser gets only the Firebase Web config. When a service-account option is configured, the server verifies Firebase ID tokens and writes leaderboard rows to Firestore with Admin SDK privileges. Without it, the server logs that it is using the local JSON fallback. Firestore writes do not rely on client-supplied scores.

The `users` and `leaderboard` documents store player name, best and total scores, games, XP, level, coins, equipped and unlocked skins, weekly score, and recent matches. Each completed match is also written to `scores` and `matches`. The server awards coins from the server-calculated match score and validates skin purchases. Available skins are `default`, `sunset`, `mint`, and `berry`.

The weekly ranking resets its score bucket on Monday (UTC). The friends tab currently shows an account prompt; friend connections are not implemented yet. Coin packs and real-money payments are not part of this build.

## Controls

- Move the mouse, touch the ocean, or use the on-screen joystick to steer.
- Collect glowing food to grow.
- Larger players can eat smaller players.
- Use the leaderboard panel to view the top server scores.

## Main files

- `public/index.html`, `public/style.css`, `public/game.js`: responsive game UI and Canvas renderer.
- `server/index.js`: Express static server, Socket.IO simulation, auth token verification, and leaderboard persistence.
