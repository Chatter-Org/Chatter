# Chatter

A self-hosted chat alternative to Discord. Text channels, voice, screen sharing and file sharing, all on hardware you control. The server is written in Rust and stores its data in MongoDB. Clients are a web app, an Android app and a desktop app.

![Chatter screenshot](Screenshot_20260211_110841-1.png)

## Features

**Chat**
- Rooms with channels, roles and per-channel permission overrides
- Direct messages, friend requests and message search
- Threads, pins, polls with timed results and forums
- Code snippets with syntax highlighting
- Custom emojis, GIF search and shareable message links
- Synced drafts and read state across devices
- E2E encrypted direct messages

**Voice and video**
- Voice channels, webcams and multi-stream screen sharing through a built-in SFU
- Stream clipping
- Per-room sound packs and entrance sounds
- Support for virtual webcam avatars (.vrm) with body and face tracking

**Server and moderation**
- Admin dashboard, audit log, rate limiting and per-channel slow mode
- Webhooks and server backups
- 2FA (TOTP), no email dependencies

**Misc**
- Collaborative whiteboard and Steam integration
- Themes and profile customization
- Push notifications and an installable PWA

## Hosting

Chatter runs as three containers: the Chatter server, MongoDB, and coturn (a TURN server that lets voice and screen sharing work through NAT).

### Requirements

- Docker with the Compose plugin
- A domain name with HTTPS in front of the server. Browsers only allow voice, screen sharing, push notifications and PWA install on secure origins.
- These ports reachable from the internet:

| Port | Protocol | Purpose |
|------|----------|---------|
| 443 | TCP | Your reverse proxy (HTTPS) |
| 8000 | UDP | Voice and video media, straight to the server |
| 3478 | TCP and UDP | TURN |
| 49152-49252 | UDP | TURN relay range |

### Setup

1. Clone the repository.

   ```bash
   git clone https://github.com/Chatter-Org/Chatter.git
   cd Chatter
   ```

2. Create a `.env` file in the project root.

   ```env
   JWT_SECRET=<output of: openssl rand -base64 48>
   TURN_USERNAME=chatter
   TURN_PASSWORD=<a strong password>
   ```

   The server refuses to start with the placeholder secret, and if `JWT_SECRET` is unset it generates a random one that ends every session on restart.

3. Edit `turnserver.conf`. Set the same credentials as in `.env`, and set `external-ip` (see [TURN setup](#turn-setup)).

   ```conf
   user=chatter:<the same password>
   external-ip=203.0.113.1
   ```

4. Edit `docker-compose.yml` and uncomment or set:
   - `WEBRTC_IP`: your server's public IPv4 address. Without it every call is relayed through TURN and takes noticeably longer to connect.
   - `SERVER_URL`: your public `https://` URL.
   - `TURN_PUBLIC_URL`: the TURN address clients should use, such as `turn:yourdomain.com:3478`. Only needed if it differs from `TURN_URL`.

   By default the web port is bound to `127.0.0.1:8067`, so it is only reachable through a reverse proxy on the same host.

5. Start it.

   ```bash
   docker compose up -d
   ```

6. Put a reverse proxy in front of port `8067` and open your domain. The first account to register becomes the server admin.

To update, pull the latest changes and run `docker compose up -d --build`. Data lives in the `mongo_data` and `uploads` volumes.

### Reverse proxy

Any proxy that terminates TLS and forwards WebSockets works (Caddy, Nginx, Traefik). Point it at the `chatter` container's port `8000`, which the compose file maps to `127.0.0.1:8067` on the host. A set of Traefik labels is included as comments in `docker-compose.yml`. With Caddy the whole config is:

```
yourdomain.com {
    reverse_proxy 127.0.0.1:8067
}
```

The UDP media port (`8000/udp`) does not go through the proxy. It is published directly by the compose file.

### TURN setup

Most calls connect directly over `8000/udp`. TURN is the fallback for users behind strict firewalls or symmetric NAT, so it needs to work even if you rarely see it used.

`external-ip` in `turnserver.conf` is the address coturn advertises to clients.

- **Public IP on the machine itself:** `external-ip=203.0.113.1`
- **Behind NAT (home server, or a VPS with a private LAN address):** use `PUBLIC_IP/LAN_IP`, for example `external-ip=203.0.113.1/192.168.1.100`, and forward the ports above on your router.

`TURN_URL` (the address the Chatter container uses to reach coturn) can stay at its default. Coturn runs with `network_mode: host`, so it binds directly to the machine's interfaces.

To check that TURN works, enter your TURN URL and credentials in [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) and gather candidates. You should see at least one `relay` candidate. If you only get `host` or `srflx`, the TURN server is not reachable from outside.

`turnserver.conf` blocks TCP relays and relaying to private address ranges, since every signed-in user receives the TURN credentials. The range `172.16.0.0/12` is allowed because Docker puts the Chatter container there. If you run Chatter outside Docker on a `192.168.x.x` address, remove that range's `denied-peer-ip` line or relayed calls cannot reach it.

## Configuration

Set these under `environment:` in `docker-compose.yml` or in `.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Signs login tokens. At least 16 characters. |
| `MONGODB_URI` | No | MongoDB connection string. Defaults to `mongodb://localhost:27017`; the compose file points it at the `mongodb` container. |
| `SERVER_URL` | Recommended | Public `https://` URL of the instance. Used by Steam login and Web Push. |
| `WEBRTC_IP` | Recommended | Public IPv4 for direct media connections. |
| `WEBRTC_UDP_PORT` | No | Media UDP port, default `8000`. Must match the published port in the compose file. |
| `TURN_URL` | No | TURN address as seen from the Chatter container. |
| `TURN_PUBLIC_URL` | No | TURN address sent to clients. Falls back to `TURN_URL`. |
| `TURN_USERNAME`, `TURN_PASSWORD` | With TURN | Must match `turnserver.conf`. |
| `KLIPY_API_KEY` | No | Enables GIF search. |
| `STEAM_API_KEY` | No | Enables Steam integration. Needs `SERVER_URL`. |
| `VAPID_SUBJECT` | No | Contact for push services, such as `mailto:you@example.com`. Defaults to `SERVER_URL` when that is https. |
| `VAPID_PRIVATE_KEY` | No | Web Push signing key. Generated and stored on first boot if unset. |

## Capacity

Estimated limits for a single instance. These are calculated from the stream bitrates and packet rates, not measured, so treat them as rough ceilings. Text chat is light by comparison; the cost is in voice and video.

| Link | Cores | RAM | Voice, 12 seats full | Viewers of 1080p30 shares | Viewers of 1080p60 shares | Call with every cam on |
|------|-------|-----|----------------------|---------------------------|---------------------------|------------------------|
| 100 Mbps | 1 | 1 GB | 60 | 10 | 6 | 21 |
| 250 Mbps | 2 | 4 GB | 186 | 25 | 16 | 35 |
| 1 Gbps | 4 | 8 GB | 373 | 100 | 66 | 61 |
| 1 Gbps | 8 | 16 GB | 746 | 100 | 66 | 71 |
| 10 Gbps | 16 | 32 GB | 1,493 | 497 | 331 | 128 |

- **Link** is upload speed, since the server sends one copy of a stream to each listener or viewer.
- **Voice** is the number of people in a call when 12 are talking at once. The server forwards only the 12 loudest speakers to each listener, so this is the worst case. Calls where fewer people talk fit more.
- **Viewers** is the total across the server and can be split any way: one stream with 100 viewers or ten streams with ten each. Defaults are 8 Mbps for 1080p30 and 12 Mbps for 1080p60.
- **Every cam on** is one call where everyone has a camera and a microphone on and sees a grid of low-quality tiles.
- Screen shares dominate the cost. One 1080p30 viewer uses as much bandwidth as about 16 voice listeners with all 12 seats full.
- Assumptions: 80% of the link is usable, about 40,000 forwarded packets per second per core, and 4 MB of memory per participant. File uploads, video conversion and MongoDB share the same hardware and are not counted.

## Admin dashboard

The first registered user is promoted to server admin and gets a Server Dashboard button in the sidebar. From there you can see server stats, disable or delete users and reset their passwords, and view or delete rooms.

## Known limitations

- Screen share audio is not supported in browsers. The desktop app is intended to cover this.
- Voice and screen sharing do not work over plain HTTP.

## Development

You need Rust (the toolchain is pinned in `rust-toolchain.toml`), Node.js, MongoDB and ffmpeg.

```bash
# Server, serving the built client at http://localhost:8000
cd client && npm install && npm run build && cd ..
cargo run

# Client dev server at http://localhost:5173, proxying the API to :8000
cd client && npm run dev
```

`./scripts/rust-ci.sh` runs the Rust checks and tests. Tests create and drop their own `chatter_test_*` databases, so point `MONGODB_URI` at a scratch MongoDB. Shared client code lives in `packages/core`, the Android app in `mobile/`, and design notes for each area in `docs/design/`. See [AGENTS.md](AGENTS.md) for a short orientation to the layout.

## Credits

Stream start sound (`external/stream-start.wav`): ["ui sound 9.wav"](https://freesound.org/people/nezuai/sounds/582608/) by [nezuai](https://freesound.org/people/nezuai/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Converted to 16-bit PCM.

## License

GPL-3.0. See [LICENSE](LICENSE).
