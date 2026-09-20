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
| 0x0030 PEER_UP  | peer→engine | TLV: 0x01 pubkey (32), 0x02 name (≤20 sanitized) |
| 0x0031 PEER_DOWN| peer→engine | TLV: 0x01 pubkey (32), 0x03 cause u8 (§6.3)|
| 0x0040 SV_DATA  | both        | TLV: 0x01 from pubkey (32), 0x02 body (opaque bytes for the engine's server-message parse) |
| 0x0041 CL_DATA  | peer→engine | TLV: 0x01 from pubkey (32), 0x02 body (opaque bytes for the engine's client-message parse, host side) |
| 0x0050 STUFFTEXT| peer→engine | printable ASCII line ≤512, NUL-terminated; engine-side allowlist enforced independently (§6.4) |
| 0x0060 CLIENT_CMD| engine→peer| TLV: 0x01 body (usercmd bytes from the local client) |
| 0x0061 RELIABLE | engine→peer | TLV: 0x01 text (≤256)                     |
| 0x00FF FATAL    | peer→engine | u8 cause (§6.3); engine tears down the match |

Unknown type value → that frame is dropped and counted; more than 10
dropped-in-a-row → close (a version or code mismatch is spiralling).

SV_DATA direction is contextual: the host engine sends it peer-ward to feed
the relay of server output (Plane B RELAY, §3.4a); the client engine receives
it peer-delivered. The `from` tag on any peer-delivered frame is filled by
the daemon from the §3.5 connection binding — never from relayed payload
text — and the engine only ever parses bytes its own local daemon placed on
Plane A.

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
| 0x0010 JOIN      | client→host    | 0x01 pubkey 32; 0x02 proof 16 (§5.1); 0x03 name 1..20 printable; 0x04 ver major u8; 0x05 ver minor u8; 0x06 manifest 32; 0x07 gamedir 1..32 printable; 0x08 engine_id 32 (§3.4a) |
| 0x0011 JOIN_OK   | host→client    | 0x01 roster_hash 32; 0x02 map 1..16; 0x03 your_client_slot u8 (unique among the current roster; the host must not reuse a live slot); 0x06 manifest 32; 0x07 gamedir 1..32 printable; 0x08 engine_id 32; 0x09 host_pubkey 32 (§3.4a)   |
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
* `engine_id` = SHA-256 over the bytes of the engine image this qn-peer is
  paired with. The engine spawns qn-peer (§4), so the pairing is the parent
  process: qn-peer opens `/proc/<ppid>/exe` and hashes the bytes read through
  that open descriptor (hash-by-fd — the descriptor, not the path, is the
  identity). A mismatch against the bytes at JOIN time is ASSET_MISMATCH —
  stop, not continue (closes the hash-then-swap window).

The host computes all three locally and requires byte equality with the
JOIN claims; any mismatch → JOIN_NO cause 7 (`ASSET_MISMATCH`). Claims are
interpreted only after the §3.2 signature verifies, and equality is checked
against the host's own computed values — a claimed identity is never
trusted. These fields exist because pak hashes alone do not prove what the
engine loaded (loose files and the game dir resolve ahead of paks): the
identity pins the manifest, the directory, and the exact engine bytes.

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
own `manifest`, `gamedir`, and `engine_id` (tags 0x06/0x07/0x08 as defined
above): the client verifies byte equality against the values it computes
from its own install before entering the match — the host→client direction
of the asset lane, same rule, same verdict (`game files or engine differ
from the host`). A client that joins by code alone, without a pinned key
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
engine reaps it and on respawn repeats the whole handshake.

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
| name field | 20 bytes printable ASCII |
| chat text | 256 bytes printable |
| map name | 16 bytes |
| peers per match | 8 (+1 host) |
| seq drop counter → close | 100 |
| seq gap → close | > 64 |
| Plane A drop-storm → close | 10 consecutive malformed/dropped |
| messages per second per Plane B connection | 200 (burst 50 queue; excess → close) |
| connections unbound (pre-KEY_BIND) per match | 4 (excess → close) |
| messages/s on an unbound connection | 10 (burst 5; excess → close) |

### 6.2 JOIN_NO causes

| value | cause | player-visible string |
|---|---|---|
| 1 | VERSION_TOO_OLD | update p2pquake |
| 2 | BAD_PROOF | wrong or stale join code |
| 3 | MATCH_FULL | match is full |
| 4 | MATCH_CLOSED | match no longer accepting |
| 5 | DUP_IDENTITY | already playing |
| 6 | RATE_LIMITED | slow down and retry |
| 7 | ASSET_MISMATCH | game files or engine differ from the host |

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
| Plane A PING interval / dead peer | 2 s / 6 s |

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
E-V1	ACCEPT	c4004e51000101001e28ac898b13e4800cb7a0802d5166c7010000006800010020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b930200400095141758f0ca577bddcb9d4e9f796c968dec4e984c6a3d95407e31f78935056b58dedd32a246c15274b06d35b67e0729a4c12f8f3bae683b1699fb4181915a011b892a307fa545fbe35e65d1b89c1394bc7fc95fd4566c87780ed8e939b148ac33facdd7861f5dbb38aff83ca58621cb0a70b7e44b81ed7b1869f545f6931c03
E-V2	ACCEPT	f9004e51000110001e28ac898b13e4800cb7a0802d5166c7010000009d0001002000319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec1137264020010009f830d48648ecdf283e74fa8f37c326503000300626f6204000100000500010001060020008e849ad83e480e776e1d3577ec7719c42bcc5a24b8860ff604c1b44e015259020700030069643108002000f208ac8045898cc8bee0795c9618f90d83ddb46d67b0641ba1ba6c0e1b04afdb23810100aa0a176c7cbaa626546d76c8ef9e766c7d64a505710a0392db502ca6347233fa52db7ced72f0de5c54b8027e097c7ace45233c92c87cd74e6704b31863c95ba00f
E-V3	ACCEPT	61004e51000112001e28ac898b13e4800cb7a0802d5166c701000000050001000100017afb6d45940edf35effcede79462859bd3671600fb1f46b03c1c23ab26e3b9171eae61d04bd9318519680d0d8667f62f72b344365d7aecea2e2b09eff5ded30e
E-V4	ACCEPT	bb004e51000120001e28ac898b13e4800cb7a0802d5166c7020000005f000100210001319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec113726402000100000300010001040008000700000000000000050020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b9393f7d96d52036a4cf052e47b230b86c0a88db435b5cf0fede9b8b4242054067459148b55543c7cddc258693b218dd6adc75d0f899e1b9b629bbf3aa4b9cc5206
E-V5	ACCEPT	88004e51000130001e28ac898b13e4800cb7a0802d5166c7030000002c0001002000319abc8df3e8b181a7fdb59d2a4a3b53e0bc9a793b1833c6b73bf17ec113726402000400626f64790bd37d1ea624a6fbb2b7cc3ac9cc414851156febde2d3fc1e2a02d1bb9ad58ee2ca2223abac575d195309f6234db8117025c0a412067165d68f31d5f2780a70b
E-V6	ACCEPT	62004e51000140001e28ac898b13e4800cb7a0802d5166c7030000000600010002006767cb5d6f8d51604340199c3641f74493a938eff5ad57810101cc0c397287d8666df461f78c638650e22a9c2c1133e4d75b20b1ebc422f6852993c05e90fa7c760b
E-V7	ACCEPT	62004e51000140001e28ac898b13e4800cb7a0802d5166c7030000000600010002006767cb5d6f8d51604340199c3641f74493a938eff5ad57810101cc0c397287d8666df461f78c638650e22a9c2c1133e4d75b20b1ebc422f6852993c05e90fa7c760b
E-V8	REJECT	62004e51010140001e28ac898b13e4800cb7a0802d5166c70400000006000100020067678279856a177e8112670df97a4755f2bc952137c698eafeb052e0a070ec3d4e49c3b4152fb4f684cdc9c090b5e937205cce79e06a945b203133e875889ca4aa0e
E-V9	REJECT	62004e51000140001e28ac898b13e4800cb7a0802d5166c7030000000600010002009867cb5d6f8d51604340199c3641f74493a938eff5ad57810101cc0c397287d8666df461f78c638650e22a9c2c1133e4d75b20b1ebc422f6852993c05e90fa7c760b
E-V10	ACCEPT	00014e51000111001e28ac898b13e4800cb7a0802d5166c705000000a40001002000d4f94fed1e26c11f383d540dad417939d5641ff3c5965abacbc6f84b824068ae0200040065316d310300010001060020008e849ad83e480e776e1d3577ec7719c42bcc5a24b8860ff604c1b44e015259020700030069643108002000f208ac8045898cc8bee0795c9618f90d83ddb46d67b0641ba1ba6c0e1b04afdb090020000ee993f331cc2f34e50fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b93737f2df4552c7c5bdc5beb4a1e1ca508bc10a17d160b82cb4b3fc9ed097dd2f65affb2e78a5593ab89a9f0f08519b31a673ea93a0bdc7dd9622309072181f70d
E-V11	REJECT	00014e51000111001e28ac898b13e4800cb7a0802d5166c705000000a40001002000d4f94fed1e26c11f383d540dad417939d5641ff3c5965abacbc6f84b824068ae0200040065316d310300010001060020008e849ad83e480e776e1d3577ec7719c42bcc5a24b8860ff604c1b44e015259020700030069643108002000f208ac8045898cc8bee0795c9618f90d83ddb46d67b0641ba1ba6c0e1b04afdb090020000ee993f331cc2f341a0fd5d92b7e02b25c6407be7a49d6382a45d94f12a03b93737f2df4552c7c5bdc5beb4a1e1ca508bc10a17d160b82cb4b3fc9ed097dd2f65affb2e78a5593ab89a9f0f08519b31a673ea93a0bdc7dd9622309072181f70d
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
