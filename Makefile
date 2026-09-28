# p2pquake top-level checks. Extra-info flags always on; warnings get fixed at
# the cause, never silenced. Targets marked NOT-READY are honest gates: they
# fail loudly until their real checks exist.

QS_DIR   := src/vendor/quakespasm
DRIVER_SRC := $(wildcard src/driver/*.c)
TEST_SRC   := $(filter-out tests/fake-engine.c,$(wildcard tests/*.c))
CC ?= gcc
# explicit NODE= > repo-local bin/node/bin/node (tools/setup-nodejs.sh) > PATH
NODE ?= $(firstword $(wildcard $(CURDIR)/bin/node/bin/node) $(shell command -v node 2>/dev/null))
NODE_TEST_SRC := $(wildcard tests/*.test.cjs)

QN_CFLAGS := -std=c11 -g -Og -Wall -Wextra -Wpedantic -Wshadow -Wconversion
QN_CFLAGS += -ffile-prefix-map=$(HOME)=.

# Source-level build identity (spec §3.4a): release version plus a digest
# over the wire-critical source closure. The linux and windows branches are
# separate distributions; identity follows the wire bytes, not the commit,
# so both platforms play at the same release. The engine embeds it as the
# magic-framed marker the daemon proves from the parent image; changing any
# wire-critical file changes it. QN_COMMIT remains the pre-release fallback.
# Platform-local translation files (*_win.*) are excluded: they only ever
# pair one machine's own engine with its own daemon, shipped together from
# one build. The closure is what crosses the wire between machines.
QN_COMMIT := $(shell git rev-parse --short=9 HEAD 2>/dev/null || echo src-nogit)
QN_DIRTY := $(if $(shell git status --porcelain --untracked-files=no 2>/dev/null | head -n1),-dirty,)
QN_VERSION := $(strip $(shell cat VERSION 2>/dev/null))
QN_WIRE := $(filter-out src/driver/qn_buildid.h %_win.c %_win.h, \
  $(sort $(wildcard qn-patches/*.patch) $(wildcard src/driver/qn_*.[ch]) \
         $(wildcard src/peer/qn*.cjs) $(wildcard src/protocol/*.md) \
         src/vendor/quakespasm/Quake/net_qn.c))
QN_WS := $(shell cat $(QN_WIRE) 2>/dev/null | sha256sum | cut -c1-16)
QN_BUILD_ID ?= $(if $(QN_VERSION),$(QN_VERSION),$(QN_COMMIT))p$(QN_WS)$(QN_DIRTY)

# Windows cross-build: toolchain (llvm-mingw + SDL2 mingw devel + mpg123
# static) laid out under WINBUILD by windows/winbuild.sh; point WINBUILD at
# a shared install to reuse across checkouts. Extra-info flags always on.
WINBUILD ?= $(CURDIR)/winbuild
WIN_CC   := $(WINBUILD)/llvm-mingw/bin/x86_64-w64-mingw32-gcc

win64: src/driver/qn_buildid.h
	$(MAKE) -C $(QS_DIR)/Quake -f Makefile.w64 clean
	$(MAKE) -C $(QS_DIR)/Quake -f Makefile.w64 DEBUG=0 USE_SDL2=1 MP3LIB=mpg123 \
	  USE_CODEC_FLAC=0 USE_CODEC_VORBIS=0 USE_CODEC_OPUS=0 USE_CODEC_XMP=0 \
	  USE_CODEC_UMX=0 \
	  SDL_CONFIG=$(WINBUILD)/SDL2-2.32.4/x86_64-w64-mingw32/bin/sdl2-config \
	  WIN_MPG_CFLAGS=-I$(WINBUILD)/mpg123-out/include \
	  "LDFLAGS=-m64 -mwindows -static -L$(WINBUILD)/mpg123-out/lib" \
	  CC="$(WIN_CC) -ffile-prefix-map=$(HOME)=." \
	  WINDRES=$(WINBUILD)/llvm-mingw/bin/x86_64-w64-mingw32-windres \
	  STRIP=$(WINBUILD)/llvm-mingw/bin/x86_64-w64-mingw32-strip
	@python3 -c "import sys; d=open('$(QS_DIR)/Quake/quakespasm.exe','rb').read(2); sys.exit(0 if d==b'MZ' else 1)" && echo "win64: PE image linked" || (echo "win64: NOT a PE" && false)

.PHONY: print-buildid
print-buildid:
	@echo $(QN_BUILD_ID)

.PHONY: print-wire
print-wire:
	@echo $(QN_WIRE)

src/driver/qn_buildid.h: FORCE
	@printf '#define QN_BUILD_ID "%s"\n' '$(QN_BUILD_ID)' > $@.new
	@if cmp -s $@.new $@ 2>/dev/null; then rm -f $@.new; else mv $@.new $@; fi
FORCE:

.PHONY: all win64 engine engine-verify peer check asan ubsan tsan fuzz fuzz-smoke fuzz-node fuzz-loopback vectors-verify e2e loopback loopback-fatal twoplayer resident-rejoin race-rejoin bootstrap-node relay relayauto smoke-dht clean fake-engine lobby-browser visibility discovery loopback-public hostile

all: engine peer

# USE_SDL2=1 is mandatory: the upstream Makefile defaults to SDL-1.2
# (Quakespasm.txt "make USE_SDL2=1 to compile against SDL2").
# MP3LIB=mpg123: the vendored engine defaults to libmad (Quake/Makefile:26)
# which is not installed here; the mpg123 backend uses the system library.
# Both build cleanly; flip this back if libmad ever becomes the preference.
engine: src/driver/qn_buildid.h
	$(MAKE) -C $(QS_DIR)/Quake DEBUG=$(DEBUG) USE_SDL2=1 MP3LIB=mpg123 \
	  "CC=$(CC) -ffile-prefix-map=$(HOME)=."

# Check for the qn-patches/README claim: the vendored tree must equal the
# pinned upstream bytes plus the ordered patch series, byte for byte.
engine-verify: src/driver/qn_buildid.h
	@CACHE=$${QN_ENGINE_CACHE:-$${XDG_CACHE_HOME:-$$HOME/.cache}/p2pquake/qs-engine}; \
	[ -d "$$CACHE/.git" ] || { echo "engine-verify: NOT-READY — no engine cache at $$CACHE"; exit 1; }; \
	R=$$(pwd); W=$$(mktemp -d); trap 'rm -rf "$$W"' EXIT; \
	Q="$$W/src/vendor/quakespasm"; mkdir -p "$$Q"; \
	(cd "$$Q" && git -C "$$CACHE" archive "$$(sed -n 2p "$$R/ENGINE.upstream")" \
	  | tar -x --exclude=MacOSX --exclude=Windows --exclude=Linux) \
	  || { echo "engine-verify: FAIL — cannot stage pristine tree"; exit 1; }; \
	ln -s "$$R/src/driver" "$$W/src/driver"; \
	for p in qn-patches/*.patch; do \
	  (cd "$$Q" && patch -p1 -s -i "$$R/$$p") \
	    || { echo "engine-verify: FAIL — $$p does not apply to the pin"; exit 1; }; \
	done; \
	diff -r -q -x '*.o' -x '*.d' -x quakespasm -x quakespasm.exe -x build-w64 "$$Q" src/vendor/quakespasm \
	  && $(MAKE) --no-print-directory -s -C "$$Q/Quake" quakespasm \
	       USE_SDL2=1 MP3LIB=mpg123 "CC=$(CC) -ffile-prefix-map=$(HOME)=." \
	  && echo "ENGINE-VERIFY OK: tree == pin + qn-patches series (applies, diffs, builds)"

peer:
	npm ci --ignore-scripts

fake-engine: src/driver/qn_buildid.h
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) -Isrc/driver tests/fake-engine.c -o bin/fake-engine

e2e: fake-engine
	$(NODE) tests/e2e-room.cjs

loopback: engine
	$(NODE) tests/qn_loopback.cjs

# Real two-player run over the DHT testnet: two live engines, the classic
# changelevel reconnect cycle, crash-style rejoin and stale-code refusal.
# honest-failure battery: one loopback run per daemon refuse cause,
# each asserting the engine's exact fixed player-facing string.
# Lobby browser end to end: the host run proves the public announce edge
# and honest row rendering (own room marked); the client run proves
# snapshot intake and that the listed row's own bytes -- never a typed
# string -- drive the dial through the datagram layer.
loopback-public: engine
	@QN_PUBLIC_BROWSER=1 $(NODE) tests/qn_loopback.cjs

hostile: engine
	@$(NODE) tests/qn_hostile.cjs

loopback-fatal: engine
	@for c in 0 1 2 3 4 5 6 255; do \
	  echo "loopback-fatal cause $$c:"; \
	  QN_FATAL=1 QN_FATAL_CAUSE=$$c $(NODE) tests/qn_loopback.cjs || exit 1; \
	done
	@for c in 1 2 3 4 5 6 7; do \
	  echo "loopback-refuse cause $$c:"; \
	  QN_REFUSE=$$c $(NODE) tests/qn_loopback.cjs || exit 1; \
	done
	@echo "loopback-badname:"
	@QN_BADNAME=1 $(NODE) tests/qn_loopback.cjs || exit 1
	@echo "loopback-hostmax:"
	@QN_HOST16=1 QN_HOST_MAXP=16 $(NODE) tests/qn_loopback.cjs || exit 1
	@echo "maplist:"
	@$(NODE) tests/qn_maplist.cjs || exit 1
	@echo "hostname-save:"
	@QN_HOSTNAME=1 $(NODE) tests/qn_twoplayer.cjs || exit 1
	@echo "listenhost:"
	@QN_LISTENHOST=1 $(NODE) tests/qn_twoplayer.cjs || exit 1

twoplayer: engine
	$(NODE) tests/qn_twoplayer.cjs

resident-rejoin: engine
	QN_LANVARIANT=resident $(NODE) tests/qn_twoplayer.cjs

race-rejoin: engine
	QN_LANVARIANT=race $(NODE) tests/qn_twoplayer.cjs

bootstrap-node: fake-engine
	$(NODE) tests/qn_bootstrapnode.cjs

lobby-browser: engine
	$(NODE) tests/qn_lobbybrowser.cjs

visibility: engine
	$(NODE) tests/qn_visibility.cjs

discovery: fake-engine
	$(NODE) tests/qn_discovery.cjs

relay: engine
	QN_RELAY=1 $(NODE) tests/qn_twoplayer.cjs
	@echo "twoplayer-coop-advance:"
	QN_COOP=1 $(NODE) tests/qn_twoplayer.cjs

# Automatic relay fallback: direct dials to match peers are failed once
# with hyperswarm's punch-error trigger code (test patch below); the lane
# asserts the join survives by redialing through the named relay. The
# launcher is generated per run because the engine copies (not execs-in-
# place) the -qn-peer file, so relative paths from $0 cannot resolve.
relayauto: engine
	@mkdir -p bin
	@printf '#!/bin/sh\nexec node --require "%s/src/peer/qn-relayauto-patch.cjs" "%s/src/peer/qn-peer.cjs" "$$@"\n' "$(CURDIR)" "$(CURDIR)" > bin/relayauto-launch.sh
	@chmod +x bin/relayauto-launch.sh
	QN_RELAY=auto QN_PEER=$(CURDIR)/bin/relayauto-launch.sh $(NODE) tests/qn_twoplayer.cjs

# Fuzz target 3: hostile engine-plane bytes through the real driver path,
# with the parsers under ASan+UBSan. Forces both rebuilds (the vendored
# make cannot see the CC change); the leak gate proves the sanitised
# binary carries no home path, with -ffile-prefix-map doing the work.
fuzz-loopback: src/driver/qn_buildid.h
	@mkdir -p bin
	$(MAKE) --no-print-directory -C $(QS_DIR)/Quake DEBUG=1 USE_SDL2=1 MP3LIB=mpg123 \
	  "CC=$(CC) -fsanitize=address,undefined -static-libasan -static-libubsan -fno-omit-frame-pointer -ffile-prefix-map=$(HOME)=." -B
	cp $(QS_DIR)/Quake/quakespasm bin/quakespasm-asan
	@if strings bin/quakespasm-asan | grep -F -m1 -- "$(HOME)"; then \
	  echo "fuzz-loopback: LEAK — home path present in sanitised binary"; exit 1; \
	fi
	$(MAKE) --no-print-directory engine -B
	QN_ENGINE=bin/quakespasm-asan QN_FUZZ=1 $(NODE) tests/qn_loopback.cjs

smoke-dht:
	$(NODE) tests/smoke-dht.cjs

check:
	@if [ -z "$(DRIVER_SRC)" ] || [ -z "$(TEST_SRC)" ]; then \
	  echo "check: NOT-READY — no driver/test sources yet (spec comes first)"; exit 1; \
	fi
	@tools/clean-lanes.sh
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_tests -fsanitize=address,undefined
	./bin/qn_tests
	$(MAKE) --no-print-directory fake-engine
	$(if $(NODE_TEST_SRC),$(NODE) --test $(NODE_TEST_SRC),)
	$(MAKE) --no-print-directory e2e
	$(MAKE) --no-print-directory loopback
	$(MAKE) --no-print-directory loopback-fatal
	$(MAKE) --no-print-directory loopback-public
	$(MAKE) --no-print-directory twoplayer
	$(MAKE) --no-print-directory resident-rejoin
	$(MAKE) --no-print-directory relay
	$(MAKE) --no-print-directory lobby-browser
	$(MAKE) --no-print-directory visibility
	$(MAKE) --no-print-directory discovery
	$(MAKE) --no-print-directory hostile

asan:
	@if [ -z "$(DRIVER_SRC)" ] || [ -z "$(TEST_SRC)" ]; then echo "asan: NOT-READY — no driver/test sources"; exit 1; fi
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) -fsanitize=address -fno-omit-frame-pointer $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_asan
	./bin/qn_asan

ubsan:
	@if [ -z "$(DRIVER_SRC)" ] || [ -z "$(TEST_SRC)" ]; then echo "ubsan: NOT-READY — no driver/test sources"; exit 1; fi
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) -fsanitize=undefined $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_ubsan
	./bin/qn_ubsan

tsan:
	@if [ -z "$(DRIVER_SRC)" ] || [ -z "$(TEST_SRC)" ]; then echo "tsan: NOT-READY — no driver/test sources"; exit 1; fi
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) -fsanitize=thread $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_tsan
	./bin/qn_tsan

FUZZ_SRC := tests/fuzz_frame.c

fuzz:
	@if ! command -v clang >/dev/null 2>&1; then \
	  echo "fuzz: NOT-READY — clang missing (sudo apt install clang)"; exit 1; \
	fi
	@if [ ! -f $(FUZZ_SRC) ]; then echo "fuzz: NOT-READY — no harness"; exit 1; fi
	@mkdir -p bin
	clang -g -O2 -fsanitize=fuzzer,address $(DRIVER_SRC) $(FUZZ_SRC) -o bin/qn_fuzz -ffile-prefix-map=$(HOME)=.
	./bin/qn_fuzz -max_total_time=$(or $(QN_TIME),60)

fuzz-smoke:
	@if ! command -v clang >/dev/null 2>&1; then \
	  echo "fuzz-smoke: NOT-READY — clang missing (sudo apt install clang)"; exit 1; \
	fi
	@mkdir -p bin
	clang -g -O2 -fsanitize=fuzzer,address $(DRIVER_SRC) $(FUZZ_SRC) -o bin/qn_fuzz -ffile-prefix-map=$(HOME)=.
	./bin/qn_fuzz -runs=100000

fuzz-node:
	$(NODE) tests/fuzz_wire.cjs

vectors-verify:
	@mkdir -p bin
	@$(NODE) tools/gen-vectors.cjs | grep -E '^(F|E)-V[0-9]+[[:space:]]' > bin/vectors.gen.txt
	@grep -E '^(F|E)-V[0-9]+[[:space:]]' src/protocol/qn_protocol.md > bin/vectors.spec.txt
	@if diff -u bin/vectors.spec.txt bin/vectors.gen.txt > /dev/null; then 	  echo "VECTORS OK: spec §7 equals generator output"; 	else echo "VECTORS STALE: regenerate spec §7 from tools/gen-vectors.cjs"; 	  diff -u bin/vectors.spec.txt bin/vectors.gen.txt | head -20; exit 1; fi

clean:
	rm -rf $(QS_DIR)/Quake/build-w64 $(QS_DIR)/Quake/quakespasm.exe
	rm -rf bin
	$(MAKE) -C $(QS_DIR)/Quake clean
