# Xpress Shift Board

Shift scheduling board for Xpress Parking Services: staff set their own weekly
availability, a schedule builder assigns people to Tony's/Dudley's fixed daily
shifts plus one-off church lots and private events, and a manager view shows
who's available across the whole team.

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000 — anyone on your network can reach it at
`http://<your-computer's-IP>:3000` if you want coworkers to use it from their
own phones/computers without deploying it anywhere.

## How it's built

- `server/` — a small Express server. All data (employees, availability,
  shifts) lives in `data/db.json`, a plain JSON file written on every change.
  No database setup required.
- `public/` — the frontend: one HTML page, one CSS file, one JS file that
  renders the whole UI and talks to the server over `fetch`.
- `shared/constants.js` — the roster, church lots, and Tony's/Dudley's fixed
  shift templates, shared by both server and browser.

Staff sign up with their own name/email/phone/password (passwords are hashed
with bcrypt, never stored in plain text). The Schedule and Availability tabs
are open to anyone with the link, same as the original design — there's no
manager-only lock, just like the file this was built from.

## Notes / things to revisit

- `data/db.json` is the entire database. Back it up before making big
  changes, and don't commit it (it's already gitignored).
- Sessions are cookie-based and stored in memory, so restarting the server
  logs everyone out. That's fine for a small internal tool; if this grows,
  swap in a persistent session store.
- There's no HTTPS here — fine on localhost or a trusted local network, but
  if you ever expose this to the public internet, put it behind a reverse
  proxy with TLS first (passwords go over the wire on login/signup).
