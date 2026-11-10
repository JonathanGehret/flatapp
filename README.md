# Flatapp

A shared chore planner for flats. Everyone sees what is due, whose turn it is,
and who has been doing how much.

- **Recurring chores** on any rhythm: every N days, weeks or months.
- **Turns**: everyone rotates, only some people rotate, one fixed person, or
  "whoever gets to it". The turn moves on when a chore is done.
- **To-do view** per person, grouped into overdue, today, next 7 days, later.
- **Pass on** a turn, **undo** a mistake, or log a chore for someone else.
- **Points**: quick chores earn 1 point, medium 2, big 3.
- **Monthly prize**: the flat writes down a reward ("dinner cooked by the
  others"); whoever has the most points at the end of the month wins it. The
  winner is announced in the app and past winners are kept.
- **No accounts**: a flat is shared with an invite link or code.
- **Installable** on iPhone and Android as a PWA; opens offline with the last
  known state.

## Stack

| Part     | Choice                                              |
| -------- | --------------------------------------------------- |
| Server   | Rust, [axum](https://github.com/tokio-rs/axum), SQLite (bundled) |
| Client   | PWA in plain HTML/CSS/JS, no build step             |
| Delivery | One binary with the web app embedded                |

## Run it

```sh
cargo run --release
# open http://localhost:8080
```

Configuration is two environment variables:

| Variable        | Default      | Meaning                    |
| --------------- | ------------ | -------------------------- |
| `PORT`          | `8080`       | Port to listen on          |
| `DATABASE_PATH` | `flatapp.db` | Where the SQLite file lives |

In debug builds (`cargo run`) the files in `web/` are read from disk on every
request, so frontend changes show up on reload.

## Host it for your flat

Flatmates need to reach the server from their phones, and installing as an app
requires HTTPS. Any of these work:

- **A small VPS or a Raspberry Pi** behind a reverse proxy such as Caddy, which
  gets a certificate automatically:
  ```
  chores.example.com {
      reverse_proxy localhost:8080
  }
  ```
- **Render**: the included `render.yaml` blueprint builds the `Dockerfile` and
  attaches a persistent disk for the database. In Render choose New → Blueprint
  and pick this repository.
- **Another container host** (Fly.io, Railway, ...) using the `Dockerfile`.
  Mount a persistent volume at `/data`; the database lives there.

The host must keep a disk between restarts. Without one, the database is wiped
on every deploy.

  ```sh
  docker build -t flatapp .
  docker run -p 8080:8080 -v flatapp-data:/data flatapp
  ```

Back up the single SQLite file to back up everything.

## Using it

1. One person opens the site, creates the flat and picks starter chores.
2. They share the invite link from the **Flat** tab.
3. Everyone else opens the link, enters their name, and adds the app to their
   home screen (iPhone: Safari → Share → Add to Home Screen; Android: browser
   menu → Install app).

Anyone with the invite code can view and edit the flat, so treat it like the
flat's Wi-Fi password.

## How scheduling works

- Completing a chore sets the next due date to *the day it was done* plus the
  interval, so a late chore does not immediately come due again.
- Whoever marks a chore done gets the points, even if it was not their turn.
  The turn then moves to the next person in the rotation.
- Chores set to "everyone takes turns" pick up new flatmates automatically.
  When someone leaves, their turns pass to the next person.

## Development

```sh
cargo test    # scheduling rules
cargo run     # dev server on :8080
```

```
src/main.rs      server start-up, embedded static files
src/api.rs       database schema and JSON API
src/schedule.rs  due-date and rotation rules
web/             the PWA (app.js, style.css, sw.js, manifest)
```
