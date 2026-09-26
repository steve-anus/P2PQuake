# p2pquake wire specification

Version: protocol 0.1 (major 0, minor 1)
Status: normative. This document is the single source of truth for every
byte that crosses either boundary. Implementations (C driver in `src/driver/`,
Node qn-peer in `src/peer/`) follow this file; to change the wire, edit this
file first and update the conformance vectors in the same commit.
Any mismatch between code and this file is a bug in the code.

All integers are little-endian unless stated otherwise.

---

## 1. The two planes

```
 machine 1                                          machine 2
 ┌───────────┐ PLANE A ┌─────────┐ PLANE B ┌─────────┐ PLANE A ┌───────────┐
 │quakespasm │◄───────►│ qn-peer │◄───────►│ qn-peer │◄───────►│quakespasm │
 │  engine   │  UDS §2 │  (Node) │ Noise §3│  (Node) │  UDS §2 │  engine   │
 └───────────┘         └─────────┘         └─────────┘         └───────────┘

Each plane is its own link, and the Plane B hop crosses the network between
two machines. qn-peer is where the planes meet: bytes arriving on Plane B are
verified (§3.2, §3.5) before any of them is ever placed on Plane A, and
nothing from Plane B reaches an engine except through its own local qn-peer.
There is no path around that junction.
```

* **Plane A** carries engine↔qn-peer traffic only. The engine parses ONLY
  Plane A bytes and only from qn-peer, which has already verified Plane B.
* **Plane B** carries peer↔peer traffic over the transport library's
  authenticated (Noise) streams. Every Plane B message is additionally
  signed by the sender's long-term Ed25519 key (§5).
* Nothing is ever sent on Plane A without §4 token authentication first;
  nothing on Plane B is trusted before the signature and identity checks of
  §5 pass. A failure of either kind closes the connection; there is no
  resynchronisation and no partial acceptance.

---

## 2. Plane A — local frame

Transport: one Unix-domain `SOCK_STREAM` socket owned by the engine
(listening), mode `0600`, path `$XDG_RUNTIME_DIR/p2pquake/engine.sock`
(fallback `~/.p2pquake/engine.sock`). One qn-peer instance per match.

### 2.1 Frame layout

```
offset  size  field
0       4     magic        u32 = 0x514E4631  ("QNF1" as bytes Q N F 1)
4       2     version      u16 = (major << 8) | minor      — this spec: 0x0001
6       2     type         u16 (§2.3)
8       4     seq          u32 (§3.2 rules)
12      2     payload_len  u16, 0..2048
14      n     payload      payload_len bytes
14+n    4     crc32        u32 — IEEE (poly 0xEDB88320, init 0xFFFFFFFF,
                            final xor 0xFFFFFFFF) over bytes [0, 14+n)
```

Maximum frame size: 2066 bytes. Rules:

* `magic` mismatch → close. A stream is never re-scanned for a new magic
  (that is the anti-pattern this spec exists to kill).
* `version` major mismatch, or `version` value `0` → close. Unknown *minor*
  is accepted at the frame layer; type-layer rules (§3) still apply.
* `payload_len > 2048` → close.
* `crc32` mismatch → close.
* Reading: collect exactly the computed frame length from the stream. A
  short read at EOF is tolerated only between frames (clean close), never
  inside one.

### 2.2 Plane A sequence numbers

Independent per direction, starting at 1 after authentication and
increasing strictly by at least 1 per frame, wrapping forbidden (closing
the connection before overflow is compliant). Duplicate, decreasing, or
zero seq → close.

### 2.3 Frame types (Plane A)

| type   | dir          | payload                                   |
|--------|--------------|-------------------------------------------|
| 0x0001 AUTH     | peer→engine | 32-byte token (§4)                        |
| 0x0002 PING     | both        | u32 nonce                                 |
| 0x0003 PONG     | both        | u32 nonce (echo)                          |
| 0x0010 HOST_UP  | engine→peer | TLV: 0x01 map name (≤16), 0x02 hostname (≤20), 0x03 max players u8 |
| 0x0011 HOST_DOWN| engine→peer | (empty)                                |
| 0x0012 HOST_READY| peer→engine| TLV: 0x01 join code (10 bytes, §5.1); sent exactly once when the host lane opens its room (§4.1) |
| 0x0020 JOIN_OPEN| engine→peer | 10-byte join code (§5.1)                  |
| 0x0021 JOIN_CLOSE| engine→peer| (empty)                                  |
| 0x0022 JOIN_PIN | engine→peer | TLV: 0x01 host pubkey (32) — the invite's pinned host key (§4.1) |
| 0x0023 JOIN_NO  | peer→engine | u8 cause (§6.2); the joiner's daemon relays a refusal or a stale-code lookup miss before hanging up clean |
| 0x0030 PEER_UP  | peer→engine | TLV: 0x01 pubkey (32), 0x02 name (≤20 sanitized) |
| 0x0031 PEER_DOWN| peer→engine | TLV: 0x01 pubkey (32), 0x03 cause u8 (§6.3)|
| 0x0040 SV_DATA  | both        | TLV: 0x01 peer pubkey (32) — the target player on the engine->peer leg, the origin on the peer-delivered leg; 0x02 body (opaque bytes for the engine's server-message parse) |
| 0x0041 CL_DATA  | peer→engine | TLV: 0x01 from pubkey (32), 0x02 body (opaque bytes for the engine's client-message parse, host side) |
| 0x0050 STUFFTEXT| peer→engine | printable ASCII line ≤512, NUL-terminated; engine-side allowlist enforced independently (§6.4) |
| 0x0060 CLIENT_CMD| engine→peer| TLV: 0x01 body (usercmd bytes from the local client) |
| 0x0061 RELIABLE | engine→peer | TLV: 0x01 text (≤256)                     |
| 0x0070 LOBBY_WATCH | engine→peer | (empty); the viewer lane starts collecting the public lobby adverts (§3.6) and pushes change snapshots |
| 0x0071 LOBBY_UNWATCH| engine→peer| (empty); collection stops, the daemon drops the view |
| 0x0072 LOBBY_LIST  | peer→engine | repeated TLV 0x01 advert (each ≤1200 B, already §3.6-verified by the daemon); at most 64, newest epoch first |
| 0x0073 LOBBY_ANNOUNCE| engine→peer | TLV: 0x01 map name (≤16), 0x02 room title (≤20 printable), 0x03 max players u8, 0x04 mode u8 (0=coop, 1=deathmatch); the host daemon completes and signs the advert (§3.6) |
| 0x0074 LOBBY_WITHDRAW| engine→peer | (empty); listing withdrawn — visibility turned off, room teardown, or map load failure |
| 0x00FF FATAL    | peer→engine | u8 cause (§6.3); engine tears down the match |

Unknown type value → that frame is dropped and counted; more than 10
dropped-in-a-row → close (a version or code mismatch is spiralling).

SV_DATA direction is contextual: the host engine sends it peer-ward to feed
the relay of server output (Plane B RELAY, §3.4a); the client engine receives
it peer-delivered. On the engine->peer leg the 0x01 tag names the **target**
player: the host engine stamps it from the datagram socket's bound peer key
(the key the daemon announced for that session), and the daemon delivers the
RELAY envelope to that one bound session alone. Server output is never
broadcast to the whole room — the datagram layer acknowledges every DATA
chunk the moment it arrives, so a chunk delivered to the wrong player would
drain a stranger's reliable window. On the peer-delivered leg the 0x01 tag
names the **origin**; the daemon fills it from the §3.5 connection binding —
never from relayed payload text — and the engine only ever parses bytes its
own local daemon placed on Plane A.

### 2.4 TLV encoding (Plane A payloads and Plane B payloads alike)

```
2  tag    u16
2  len    u16
    len   value bytes
```

* Tags `0x0001..0x7FFF` are assigned by this file. Tags `0x8000..0xFFFF` are
  experimental: receivers on the same protocol major **must** skip unknown
  tags without error (copy forward-compat). An *expected* tag that is
  missing, duplicated, or whose `len` violates the type table above →
  reject the message (Plane B) or frame (Plane A): close the connection.
* Tags appear in ascending order; out-of-order duplicates are rejected.

---

## 3. Plane B — remote envelope

Transport: a hyperswarm/hyperdht Noise connection (already authenticated as
a peer keypair); this envelope rides the stream with **no framing of its
own between envelopes except §3.1** — the stream is message-packed tight.

### 3.1 Envelope layout

```
0  2   magic        u16 = 0x514E ("QN")
2  1   major        u8   — 0
3  1   minor        u8   — 1
4  2   type         u16 (§3.4)
6  16  match_id     bytes 0..15 of sha256(join code) (§5.1)
22 4   seq          u32 (§3.3)
26 2   payload_len  u16, 0..1200
28 n   payload      TLV fields (§2.4)
28+n 64 signature   Ed25519 over §3.2
```

A leading u16 `total_len = 28 + n + 64` prefix delimits each envelope on
the stream; `total_len` outside `28+0+64 .. 28+1200+64` → close.
Any parse, identity, or signature failure → close the connection (no
partial trust survives a failed message).

### 3.2 Signature rule

`signature` is a valid Ed25519 signature by the sender's long-term public
key on the exact bytes:

```
sha256( "QNW0" || magic..payload inclusive, i.e. envelope bytes [0, 28+n) )
```

Verify the signature **before** reading any payload field for a trust
decision. Names, ids, and addresses inside payloads are display hints only;
identity is only ever the §3.5 key binding (see Landmine: self-declared
`from` fields).

### 3.3 Sequence numbers (Plane B)

One counter per (connection, sending long-term key), starting at 1 after
binding, strictly increasing, wrap forbidden. A received seq ≤ the highest
already seen → drop and count (replay); > 100 counted drops → close.
A received seq that skips **more than 64 messages** ahead of the highest
already seen → close (gap spiral).

### 3.4 Wire types

| type    | dir            | required TLV tags                                        |
|---------|----------------|----------------------------------------------------------|
| 0x0001 KEY_BIND  | both directions   | 0x01 pubkey u8*32; 0x02 noise_binding: signature by pubkey over `sha256("QNWB" || min(ourNoise,theirNoise) || max(ourNoise,theirNoise))` — the two noise keys of this connection in ascending byte order, so both endpoints compute the same value (channel binding)  |
| 0x0010 JOIN      | client→host    | 0x01 pubkey 32; 0x02 proof 16 (§5.1); 0x03 name 1..20 printable; 0x04 ver major u8; 0x05 ver minor u8; 0x06 manifest 32; 0x07 gamedir 1..32 printable; 0x0A build_id 1..64 printable (§3.4a); 0x0B platform 1..32 printable (§3.4a); 0x0C binary_sha 32 (§3.4a, info-only) |
| 0x0011 JOIN_OK   | host→client    | 0x01 roster_hash 32; 0x02 map 1..16; 0x03 your_client_slot u8 (unique among the current roster; the host must not reuse a live slot); 0x06 manifest 32; 0x07 gamedir 1..32 printable; 0x09 host_pubkey 32 (§3.4a); 0x0A build_id 1..64 printable (§3.4a); 0x0B platform 1..32 printable (§3.4a); 0x0C binary_sha 32 (§3.4a, info-only)   |
| 0x0012 JOIN_NO   | host→client    | 0x01 cause u8 (§6.2)                                           |
| 0x0020 ROSTER    | host→all       | 0x01 pubkeys: count u8 then count×32; 0x02 min_major u8; 0x03 min_minor u8; 0x04 epoch u64 LE strictly increasing; 0x05 host_pubkey 32 (§3.4a) |
| 0x0030 RELAY     | both           | 0x01 origin pubkey 32 — the engine-side sender: the host key or a member of the current signed ROSTER (§3.4a); 0x02 body ≤1100 (opaque engine-plane message body, host↔client legs) |
| 0x0040 CHAT      | both           | 0x01 text 1..256 printable                                     |
| 0x0050 BYE       | both           | (empty)                                                      |
| 0x00FF PING      | both           | 0x01 nonce u32                                               |
| 0x0100 PONG      | both           | 0x01 nonce u32                                               |

**§3.4a Asset & build identity (join lane).** JOIN carries the complete
identity of the software a peer actually runs:

* `manifest` = SHA-256 over the bytes of the `gamedata.sha256` manifest the
  peer's gamedata is verified against;
* `gamedir` = the active game directory (`id1` by default);
* `build_id` = the source-level build identifier embedded in the engine
  image at compile time as a magic-framed marker: the exact bytes
  `QNBID:<id>\0`, where `<id>` is 1..64 characters from `[A-Za-z0-9._+-]`
  (the source commit plus a digest over the ordered engine patch series;
  an implementation may append a provenance suffix from the same charset,
  and comparison is byte equality over the whole `<id>`).
  The engine spawns qn-peer (§4), so the pairing is the parent process:
  qn-peer reads the parent's *running image* through an open descriptor
  (`/proc/<ppid>/exe`, hash-by-fd — the descriptor, not the path, is the
  identity), locates the marker inside the bytes read, and derives
  `binary_sha` = SHA-256 over those same bytes. A parent image without a
  valid marker fails closed locally: the daemon does not join at all.

The identity fields come in two classes.

* **Comparable** — the host computes `manifest`, `gamedir`, and `build_id`
  locally and requires byte equality with the JOIN claims; any mismatch
  → JOIN_NO cause 7 (`ASSET_MISMATCH`). Stop, not continue.
* **Info-only** — `platform` and `binary_sha` are recorded and logged per
  bound key and are **never** a refusal cause. Peers may run identical
  source on different platforms and toolchains; a Linux host and a Windows
  client at the same `build_id` must be able to play together. The host
  logs each member's `binary_sha`; divergence among members is a
  diagnostic, not a policy.

Claims are interpreted only after the §3.2 signature verifies, and
comparable equality is checked against the host's own computed values — a
claimed identity is never trusted. These fields exist because pak hashes
alone do not prove what the engine loaded (loose files and the game dir
resolve ahead of paks): the identity pins the manifest, the directory, and
the source build. The lane is an accident tripwire and a casual-tamper
deterrent, not tamper-proofism: anyone who can compile the source can
embed any `build_id`. Enforcement of remote behaviour is the host's
validation of every byte it accepts (§3.4b, §5.2), and every claim rides
under the claimant's long-term key, so misbehaviour is attributable.

ROSTER `epoch` is a strictly increasing little-endian u64 the host re-signs
with every roster mutation. A client keeps the highest (epoch, roster) pair
seen; a ROSTER at or below the stored epoch is a protocol violation →
close, never merge. A client's (epoch, roster) state is keyed by
(host key, match_id) and persists across reconnections for the life of
the match; the host seeds its counter from persisted state and never
restarts it at zero on a reused topic. This defeats stale or duplicate
announcers on a reused join-code topic and unauthorized roster edits.

RELAY trust (§3.4a): the host is the only RELAY source for clients. A
client accepts RELAY only on the connection bound to the host key pinned
by its invite, and RELAY on any other connection is a protocol violation
→ close. A host accepts client RELAY only with origin equal to that
connection's bound key. In every accepted RELAY the origin tag must be
the host key or a member of the current signed ROSTER — anything else
closes. The engine attributes a gameplay sender from the host-assigned
slot (JOIN_OK `your_client_slot`), never from this tag; the host, as sim
authority, is what the signature on the envelope authenticates.

Host key pinning (the invite). An invitation carries a join code and the
host's long-term public key. The code admits members; the pinned key names
who the client accepts as host. Every host-signed message (JOIN_OK, ROSTER,
RELAY) must satisfy three-way equality: the `host_pubkey` claim it carries,
the key the connection bound to at KEY_BIND, and the pinned key — all three
equal, or the client closes that connection and warns the player the invite
may have been forwarded or tampered with. JOIN_OK also carries the host's
own `manifest`, `gamedir`, and `build_id` (tags 0x06/0x07/0x0A as defined
above): the client verifies byte equality against the values it computes
from its own install before entering the match — the host→client direction
of the asset lane, same rule, same verdict (`game files or engine build
differ from the host`). The host's `platform` and `binary_sha`
(0x0B/0x0C) arrive on the same message and are logged only: they never
end a join. A client that joins by code alone, without a pinned key
(an explicit open-invite choice), still gets the membership check but not
the host identity check: the player is warned that host impersonation by a
code holder is not detectable on that lane.

**§3.4b Unknown-plane-B discipline.** Unknown Plane B envelopes (same major): an unknown type code, or a TLV
tag outside the type's required set and outside the experimental range
0x8000..0xFFFF, fails that envelope — drop and count it; more than 10
consecutive counted envelopes → close, mirroring Plane A. Experimental
tags (0x8000..0xFFFF) are skipped silently.

The noise keys in KEY_BIND are the two transport keys of this connection
(`remotePublicKey` plus the signer's own node key, both from the transport
library); ordering them ascending makes the binding value identical at both
endpoints. The binding proves the sender controls a long-term key that its
owner vouches for on this exact transport identity. The binding is per
connection: after a KEY_BIND
verifies, every further envelope's §3.2 signature must come from that same
public key; a KEY_BIND is accepted at most once per connection and must be
the first envelope, or the connection closes.

### 3.5 Versioning guards (normative)

These four rules are the compatibility contract; each has a conformance
test (see the test suite names in parentheses):

* **(a) Host-enforced minimum.** A host's ROSTER carries `min_major` /
  `min_minor`. A client whose announced version (JOIN tags 0x04/0x05) is
  below it receives JOIN_NO with cause `VERSION_TOO_OLD` and the console
  string "update p2pquake". Enforcement happens at qn-peer, before any
  socket reaches the engine. (test: minimum-version refusal)
* **(b) Unknown minor fields are skipped.** Same-major receivers skip
  unknown TLV tags (§2.4) rather than rejecting. Field *removal*, *retype*,
  or *reordering of required tags* is forbidden within a minor bump.
  (test: unknown-minor field skipping)
* **(c) Breaking changes bump major** on both planes independently
  (Plane A `version` field, Plane B `major` byte); a mismatch is refusal,
  which forces a manual update (there is no auto-updater).
  (test: old-major refusal)
* **(d) Engine protocol number.** qn-patches that validate bytes only must
  not alter the netquake protocol number; any patch that changes *emitted*
  bytes gates on it.

### 3.6 Public lobby advert (normative)

While hosting with visibility=public the host daemon stores its advert in
the fixed public topic `"qn-lobby-v1"` (the wire generation lives in the
topic name; renaming it is world-breaking). The advert is a self-contained
signed artifact — not a Plane B envelope, rides no connection, and is
never verified by the engine: collection and every §3.6 check are daemon
work; the engine sees only bytes its own daemon already validated.

The canonical signed bytes are the ascending TLV serialization (§2.4) of
exactly the required tags:

| tag | field | form |
|---|---|---|
| 0x01 | map name | ≤16; pool-validated spelling only — never free text into an engine command |
| 0x02 | room title | ≤20 printable, the same sanitizer as the daemon `--name` |
| 0x03 | max players | u8, 2..8 |
| 0x04 | mode | u8: 0=coop, 1=deathmatch |
| 0x05 | join code | 10 bytes (§5.1); carried openly — visibility below |
| 0x06 | host pubkey | 32 bytes (§5.2) |
| 0x07 | host version | u16 major, u16 minor (LE) |
| 0x08 | min peer version | u16 major, u16 minor (LE); joiners below it get VERSION_TOO_OLD per §3.5(a) |
| 0x09 | epoch | u64 LE, strictly increasing per host key; persisted, never reset to zero on a reused topic (ROSTER precedent) |
| 0x0A | ttl | u16 seconds, fixed 120 |

The signature follows §3.2 discipline with its own domain magic so signed
bytes never replay across artifact kinds:

    signature = Ed25519(host key, sha256("QNLA" || canonical bytes))

appended after the canonical bytes, never itself covered.

A collecting daemon verifies in strict order — size first, so a hostile
store entry cannot cost parse work past the cap:

1. whole advert ≤1200 B;
2. required tags present, ascending, every cap honored;
3. signature valid under the 0x06 key over the canonical bytes;
4. epoch strictly greater than the stored epoch for that host key — a tie
   or regression is dropped, never merged; the store is (epoch, advert);
5. freshness: first-seen starts a ttl budget; expiry drops the advert, a
   re-announce at a new epoch refreshes it.

Any failure → drop silently. A malformed advert never reaches the view,
never prints toward the engine console, never counts in a displayed
total. Collection dedupes by host key (newest epoch wins) and caps at 64
live adverts (overflow evicts the lowest epoch); a host re-announces at
most 1/s. Snapshots ride LOBBY_LIST on change and at least every 30 s
while watched. A snapshot is one or more consecutive LOBBY_LIST frames:
each frame carries as many adverts as fit its 2048-byte payload cap, and
the snapshot ends with one empty-payload LOBBY_LIST; the engine swaps the
whole view only on that terminator, so a partial snapshot never shows.

Visibility of the join code: a listed room is joinable by strangers by
definition, so the code inside a public advert is addressing data, not
secrecy — code secrecy protects private rooms only. Public join keeps
every other gate unchanged: signature, version floors (§3.5),
asset/manifest identity, JOIN_NO causes (§6.2), join rate limits.

---

## 4. Plane A authentication

1. The engine generates 32 fresh CSPRNG bytes once per spawn.
2. The engine writes those bytes — raw, no framing — to the qn-peer child's
   **stdin** as the very first thing it does after spawning. The token is
   never placed in argv, the environment, logs, console output, or any file.
3. qn-peer reads 32 bytes from stdin, connects to the socket, and sends
   type `AUTH` with exactly those bytes as the first frame. AUTH is the sole
   pre-authentication frame and carries seq = 1; per-direction sequence
   numbers increase strictly and never restart, so the next peer→engine
   frame carries seq = 2.
4. The engine compares with a constant-time equality. Any other first
   frame, any mismatch, or timeout 5 s → close; qn-peer then exits.
5. Until AUTH passes, the engine accepts no other frame. After AUTH passes,
   AUTH is never accepted again.

The qn-peer must exit when its Plane A socket closes (no orphans); the
engine reaps it and on respawn repeats the whole handshake. A daemon that
exits with status 0 has ended the session by choice: the engine must not
respawn it for the remainder of that engine run. Respawn (up to the cap
above) is reserved for abnormal endings -- crash, signal, or watchdog kill.
The respawn budget counts every daemon start attempted during the run,
including starts that die before authentication.

### 4.1 Lane establishment (normative)

* **HOST_UP opens the host lane.** The daemon generates the join code
  (§5.1), announces its topic, and answers with exactly one `HOST_READY`
  carrying the 10-byte code: the engine renders it at its join-code display
  surface, and nowhere else (code-printing rule, §5.1). A second HOST_UP
  before HOST_DOWN, or HOST_READY already sent, is a protocol violation →
  FATAL cause 2. HOST_DOWN withdraws the announcement and drops the room; a
  later HOST_UP opens a fresh room with a fresh code — Plane A sequence
  numbers never restart (§2.2).
* **JOIN_OPEN opens the client lane**, optionally preceded by `JOIN_PIN`.
  With a pinned key present the lane is *pinned*: the Plane B connection
  whose §3.5 binding equals the pinned key is the host lane, and any
  host-signed message failing the §3.4a three-way equality ends the join.
  Without a preceding JOIN_PIN the lane is the explicit **open-invite** mode:
  the first peer to complete KEY_BIND is treated as host, and the player is
  warned with a fixed console line that host impersonation is not detectable
  on this lane. JOIN_PIN after JOIN_OPEN, a second JOIN_PIN, or a JOIN_PIN
  whose payload is not exactly one 32-byte tag → close.
* The two lanes are mutually exclusive per process: the second lane's opener
  frame → FATAL cause 2.

---

## 5. Rooms, identity, crypto parameters

### 5.1 Join code → room

* `join_code` = 10 random bytes from a CSPRNG.
* Display form: exactly 16 characters of Crockford base32 (no I, L, O, U;
  decoding is case-insensitive), hyphen-grouped 4-4-4-4, e.g. `7FX2-...`.
* `topic` (the DHT lookup key hyperswarm announces/looks up) =
  `sha256(join_code)`, 32 bytes.
* `match_id` = `topic[0..15]`.
* `membership_key` = HKDF-SHA256(ikm = `join_code`, salt = `"p2pquake-room"`,
  info = `"membership"`, 32 bytes).
* `proof` (sent in JOIN tag 0x02) = first 16 bytes of
  `HMAC-SHA256(membership_key, our_longterm_pubkey)`.
  A peer that cannot present the proof cannot join, and the firewall hook
  rejects such a peer **before** the connection is accepted. Proving
  membership never reveals the join code.

### 5.2 Long-term identity

Each qn-peer owns one Ed25519 keypair, generated on first run at
`~/.p2pquake/` (dir `0700`, key file `0600`). Display names are payload
fields, sanitised to printable ASCII ≤20 bytes, and carry zero trust
(§3.2). Identity decisions use only (Noise verified transport key ∧ §3.2
signature ∧ §3.4 KEY_BIND binding).

### 5.3 Cryptographic primitives (Node built-ins only)

Ed25519 sign/verify; SHA-256; HKDF-SHA256; HMAC-SHA256; CSPRNG. No new
dependencies are introduced by this spec.

---

## 6. Limits, causes, timeouts (normative)

### 6.1 Limits

| item | cap |
|---|---|
| Plane A frame payload | 2048 bytes |
| Plane B envelope payload | 1200 bytes |
| RELAY body | 1100 bytes |
| engine DATA payload (p2p landriver) | 1092 bytes — after the 8-byte datagram header this is exactly one relay body |
| name field | 20 bytes printable ASCII |
| chat text | 256 bytes printable |
| map name | 16 bytes |
| peers per match | 8 (+1 host) |
| seq drop counter → close | 100 |
| public lobby advert (§3.6, whole) | 1200 bytes |
| collected adverts per viewer | 64 (newest epoch wins) |
| host re-announce cadence | 1/s |
| advert TTL | 120 s, fixed |
| seq gap → close | > 64 |
| Plane A drop-storm → close | 10 consecutive malformed/dropped |
| envelopes per second per Plane B connection (all types, metered pre-decode) | 2000 (burst 400; excess → close) |
| control messages per second per Plane B connection (all types except RELAY, metered post-decode) | 200 (burst 50; excess → close) |
| RELAY game-data messages per second per Plane B connection (metered post-decode) | 1200 (burst 300; excess → close) |
| connections unbound (pre-KEY_BIND) per match | 4 (excess → close) |
| messages/s on an unbound connection | 10 (burst 5; excess → close) |

A datagram that exceeds one of these caps is dropped by the peer that sees
it, never fragmented around the cap: an oversized unreliable message simply
does not arrive.

Plane B per-connection metering is three-tier: the outer bucket bounds
decode work on every envelope (pre-decode). After decode, RELAY — the
game-data plane (server frames and usercmds) — pays a dedicated game
bucket, and every other type pays the control bucket before dispatch.
Replayed envelopes (seq window) count against the outer bucket only. The
game bucket is sized for an honest listen server — up to two envelopes per
client per render tick at supported listen-server tick rates (physics
breaks above 72 fps; the 1000 fps clamp is not honest-playable) — while
still bounding a joined insider's RELAY flood well below the all-envelope
cap.

### 6.2 JOIN_NO causes

| value | cause | player-visible string |
|---|---|---|
| 1 | VERSION_TOO_OLD | update p2pquake |
| 2 | BAD_PROOF | wrong or stale join code |
| 3 | MATCH_FULL | match is full |
| 4 | MATCH_CLOSED | match no longer accepting |
| 5 | DUP_IDENTITY | already playing |
| 6 | RATE_LIMITED | slow down and retry |
| 7 | ASSET_MISMATCH | game files or engine build differ from the host |

### 6.3 FATAL / PEER_DOWN causes (shared)

| value | cause |
|---|---|
| 0 | peer left (PEER_DOWN only: a normal departure, no fault implied) |
| 1 | token auth failed (engine tears down peer; respawn allowed) |
| 2 | frame malformed storm |
| 3 | engine socket closed (peer exits) |
| 4 | transport down — all peers lost |
| 5 | signature failure (connection closed) |
| 6 | replay storm (connection closed) |

### 6.4 STUFFTEXT (engine side, restated here for completeness)

The engine executes only the handshake-phrase allowlist from a remote-sourced
STUFFTEXT frame; anything else is dropped and logged without execution.
The allowlist is derived from the engine source and the shipped gamedata's
string table, never guessed. Enforcement lives in the engine's parser, not
qn-peer. It is a required gate: remote-sourced STUFFTEXT may not be
dispatched to the console until this allowlist exists and is asserted by
its own test; the first driver build that wires that dispatch is
incomplete without it.

### 6.5 Timeouts

| event | timeout |
|---|---|
| AUTH after qn-peer connect | 5 s |
| KEY_BIND after transport connection | 5 s |
| JOIN after KEY_BIND | 10 s |
| ROSTER refresh (client side; else match is stale) | 30 s |
| Plane B PING interval / dead peer | 2 s / 6 s |
| Plane A PING interval / dead peer | 2 s / 30 s |

---

## 7. Conformance vectors

Both implementations must reproduce every byte below from the stated inputs
and reject the REJECT rows with a close (no partial handling). Vectors are
produced by `tools/gen-vectors.cjs` from pinned test keypairs and are
regenerated + diffed on any spec change.

Generated by `tools/gen-vectors.cjs` (fixed test seeds; rerun and diff — output
is deterministic). Key material and derivation:

```
join_code (raw hex): 653658be599701dc8f4e   (topic = sha256(join_code), match_id = topic[0..16))
pubkeys(raw hex):
  A: 0ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b93
  B: 319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec1137264
# (legacy heading kept for diff stability):
```

### 7.1 Plane A frames (`QN…` magic per §2.1)

```
F-V1	ACCEPT	31464e51010001000100000020000a9a403dff2bd3b363d33901f735649f21fe3394aaafc17afd221e523ebd6e104a46bca2
F-V2	ACCEPT	31464e5101002000010000000a00653658be599701dc8f4eb7779fd3
F-V3	ACCEPT	31464e5101004000030000002c00010020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b9302000400626f64797c72eeda
F-V4	REJECT	31464e51010001000100000020000a9a403dff2bd3b363d33901f735649f21fe3394aaafc17afd221e523ebd6e104a46bc5d
F-V5	REJECT	31464e5101ff2000010000000a00653658be599701dc8f4eb7779fd3
F-V6	ACCEPT	31464e5101001200020000000e0001000a00653658be599701dc8f4ec8912e04
F-V7	ACCEPT	31464e5101002200010000002400010020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b933655498f
```

### 7.2 Plane B envelopes (§3.1)

```
E-V1	ACCEPT	c4004e51000201001e28ac898b13e4800cb7a0802d5166c7010000006800010020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b930200400095141758f0ca577bddcb9d4e9f796c968dec4e984c6a3d95407e31f78935056b58dedd32a246c15274b06d35b67e0729a4c12f8f3bae683b1699fb4181915a01fa7a42d0c1db0162dd136569a246e4cc894838c299f4f5ef75d4fedee601cdba9d5203455d6dacf08560776ffbda17d068a0e6c7d2fdaf82ba8e9e44a8d96a0f
E-V2	ACCEPT	22014e51000210001e28ac898b13e4800cb7a0802d5166c701000000c60001002000319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec1137264020010009f830d48648ecdf283e74fa8f37c326503000300626f6204000100000500010002060020008e849ad83e480e776e1d3577ec7719c42bcc5a24b8860ff604c1b44e01525902070003006964310a0018006265656630312e70303132333435363738396162636465660b0009006c696e75782d7836340c002000f208ac8045898cc8bee0795c9618f90d83ddb46d67b0641ba1ba6c0e1b04afdb23810100aad9400882885c776a9d5f07cddd17fd2adb1223ce8bcde4c14283acd42be30968d5754dc26590a5c6b99e901c9fa98b782fd5f7fb428ef29a8cc817809d05e601
E-V3	ACCEPT	61004e51000212001e28ac898b13e4800cb7a0802d5166c701000000050001000100016cde6ba1cc7a0dfad7873585ec39ed5ca2d53f3fa04744a8a382dd612210bd319ba7e80b8f84ee157a3f2c48b63394ff5cec5090852960f8d4dad6704f77030d
E-V4	ACCEPT	bb004e51000220001e28ac898b13e4800cb7a0802d5166c7020000005f000100210001319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec113726402000100000300010002040008000700000000000000050020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b93523030a2fee1ea63a0d8ef2d23090ea2b7ac117c0a46279c2d3d97fb09ed94bf46e9887dc4671c9d238e4a1a375b8746544f4174a3315d916ae85164fbc6c108
E-V5	ACCEPT	88004e51000230001e28ac898b13e4800cb7a0802d5166c7030000002c0001002000319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec113726402000400626f64799239b5c6aef99318331768a315f0820e3a6ae617d4be0e23242d26c25d57b79fb98ff2c09e700d055987d62c235c0b63ec02bfc67c0c9574236440ba998b8b05
E-V6	ACCEPT	62004e51000240001e28ac898b13e4800cb7a0802d5166c70300000006000100020067671a60343940e8520b1e7be21330a009454fe7efbc376d397dd02e0a6b8d1e3eab45a9c02686ec01f7ed9fb7a58d699c1fd0bd48ad832aa490b3d788cf311ebf0f
E-V7	ACCEPT	62004e51000240001e28ac898b13e4800cb7a0802d5166c70300000006000100020067671a60343940e8520b1e7be21330a009454fe7efbc376d397dd02e0a6b8d1e3eab45a9c02686ec01f7ed9fb7a58d699c1fd0bd48ad832aa490b3d788cf311ebf0f
E-V8	REJECT	62004e51010240001e28ac898b13e4800cb7a0802d5166c70400000006000100020067678d2b00d87f86d6903a937a74eb2dfc43ebd64cd55f15b217fc73eca2bbf37a2e1af88e1108dcfa9b94b7474e39b882aa94dcf4684066dc76bb0c4259dd585a04
E-V9	REJECT	62004e51000240001e28ac898b13e4800cb7a0802d5166c70300000006000100020098671a60343940e8520b1e7be21330a009454fe7efbc376d397dd02e0a6b8d1e3eab45a9c02686ec01f7ed9fb7a58d699c1fd0bd48ad832aa490b3d788cf311ebf0f
E-V10	ACCEPT	29014e51000211001e28ac898b13e4800cb7a0802d5166c705000000cd0001002000d4f94fed1e26c11f383d540dad417939d5641ff3c5965abacbc6f84b824068ae0200040065316d310300010001060020008e849ad83e480e776e1d3577ec7719c42bcc5a24b8860ff604c1b44e0152590207000300696431090020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b930a0018006265656630312e70303132333435363738396162636465660b0009006c696e75782d7836340c002000f208ac8045898cc8bee0795c9618f90d83ddb46d67b0641ba1ba6c0e1b04afdb6db3030341ef763aa777220c91f6a571748040ecc933677520c392eea7d233bfa712d5e8ea475a2732af3d6aac305f0762304f36b500f1f617cb9fd67516bc09
E-V11	REJECT	29014e51000211001e28ac898b13e4800cb7a0802d5166c705000000cd0001002000d4f94fed1e26c11f383d540dad417939d5641ff3c5965abacbc6f84b824068ae0200040065316d310300010001060020008e849ad83e480e776e1d3577ec7719c42bcc5a24b8860ff604c1b44e0152590207000300696431090020000ee993f331332f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b930a0018006265656630312e70303132333435363738396162636465660b0009006c696e75782d7836340c002000f208ac8045898cc8bee0795c9618f90d83ddb46d67b0641ba1ba6c0e1b04afdb6db3030341ef763aa777220c91f6a571748040ecc933677520c392eea7d233bfa712d5e8ea475a2732af3d6aac305f0762304f36b500f1f617cb9fd67516bc09
```

`ACCEPT` vectors must decode and verify; `REJECT` vectors must fail as noted
(E-V7 is byte-identical to E-V6 and must trip the §3.3 replay rule when
delivered twice; E-V8 carries major=1; E-V9 has a corrupted payload value).
`tools/gen-vectors.cjs` asserts exactly these expectations on every run.

---

## 8. Error-handling doctrine (normative summary)

1. Parsers are linear in input size; no rescans.
2. Verify before read: signature, then CRC, then required tags — a buffer
   that fails verification is never interpreted.
3. Malformed input on either plane is terminal (close), except same-major
   unknown TLVs (skip, §2.4/§3.5b) and unknown Plane A type values (drop +
   count, close at 10).
4. No network byte ever reaches the engine's message parsers without
   qn-peer verification; no engine command ever reaches the console without
   the allowlist check.
5. Every crash found by fuzzing becomes a regression test in `src/tests/`
   alongside its fix.
