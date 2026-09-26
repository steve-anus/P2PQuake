# p2pquake top-level checks. Extra-info flags always on; warnings get fixed at
# the cause, never silenced. Targets marked NOT-READY are honest gates: they
# fail loudly until their real checks exist.

QS_DIR   := src/vendor/quakespasm
DRIVER_SRC := $(wildcard src/driver/*.c)
TEST_SRC   := $(filter-out tests/fake-engine.c,$(wildcard tests/*.c))
CC ?= gcc
NODE ?= node
NODE_TEST_SRC := $(wildcard tests/*.test.cjs)

QN_CFLAGS := -std=c11 -g -Og -Wall -Wextra -Wpedantic -Wshadow -Wconversion
QN_CFLAGS += -ffile-prefix-map=$(HOME)=.

# Source-level build identity (spec §3.4a): commit + digest over the ordered
# qn-patch series. The engine embeds it as the magic-framed marker the daemon
# proves from the parent image before joining; changing a patch changes it.
QN_COMMIT := $(shell git rev-parse --short=9 HEAD 2>/dev/null || echo src-nogit)
QN_DIRTY := $(if $(shell git status --porcelain --untracked-files=no 2>/dev/null | head -n1),-dirty,)
QN_PSERIES := $(shell cat $(sort $(wildcard qn-patches/*.patch)) 2>/dev/null | sha256sum | cut -c1-16)
QN_BUILD_ID ?= $(QN_COMMIT)p$(QN_PSERIES)$(QN_DIRTY)

src/driver/qn_buildid.h: FORCE
	@printf '#define QN_BUILD_ID "%s"\n' '$(QN_BUILD_ID)' > $@.new
	@if cmp -s $@.new $@ 2>/dev/null; then rm -f $@.new; else mv $@.new $@; fi
FORCE:

.PHONY: all engine engine-verify peer check asan ubsan tsan fuzz fuzz-smoke fuzz-node fuzz-loopback vectors-verify e2e loopback loopback-fatal twoplayer relay smoke-dht clean fake-engine

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
	diff -r -q -x '*.o' -x '*.d' -x quakespasm "$$Q" src/vendor/quakespasm \
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

twoplayer: engine
	$(NODE) tests/qn_twoplayer.cjs

relay: engine
	QN_RELAY=1 $(NODE) tests/qn_twoplayer.cjs
	@echo "twoplayer-coop-advance:"
	QN_COOP=1 $(NODE) tests/qn_twoplayer.cjs

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
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_tests -fsanitize=address,undefined
	./bin/qn_tests
	$(MAKE) --no-print-directory fake-engine
	$(if $(NODE_TEST_SRC),$(NODE) --test $(NODE_TEST_SRC),)
	$(MAKE) --no-print-directory e2e
	$(MAKE) --no-print-directory loopback
	$(MAKE) --no-print-directory loopback-fatal
	$(MAKE) --no-print-directory twoplayer
	$(MAKE) --no-print-directory relay

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
	rm -rf bin
	$(MAKE) -C $(QS_DIR)/Quake clean
