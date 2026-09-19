# p2pquake top-level checks. Extra-info flags always on; warnings get fixed at
# the cause, never silenced. Targets marked NOT-READY are honest gates: they
# fail loudly until their real checks exist.

QS_DIR   := src/vendor/quakespasm
PEER_DIR := src/peer
DRIVER_SRC := $(wildcard src/driver/*.c)
TEST_SRC   := $(wildcard src/tests/*.c)
CC ?= gcc
NODE ?= node
NODE_TEST_SRC := $(wildcard $(PEER_DIR)/*.test.cjs)

QN_CFLAGS := -std=c11 -g -Og -Wall -Wextra -Wpedantic -Wshadow -Wconversion
QN_CFLAGS += -ffile-prefix-map=$(HOME)=.

.PHONY: all engine peer check asan ubsan tsan fuzz fuzz-smoke fuzz-node clean

all: engine peer

# USE_SDL2=1 is mandatory: the upstream Makefile defaults to SDL-1.2
# (Quakespasm.txt "make USE_SDL2=1 to compile against SDL2").
# MP3LIB=mpg123: the vendored engine defaults to libmad (Quake/Makefile:26)
# which is not installed here; the mpg123 backend uses the system library.
# Both build cleanly; flip this back if libmad ever becomes the preference.
engine:
	$(MAKE) -C $(QS_DIR)/Quake DEBUG=$(DEBUG) USE_SDL2=1 MP3LIB=mpg123 \
	  "CC=$(CC) -ffile-prefix-map=$(HOME)=."

peer:
	cd $(PEER_DIR) && npm ci --ignore-scripts

check:
	@if [ -z "$(DRIVER_SRC)" ] || [ -z "$(TEST_SRC)" ]; then \
	  echo "check: NOT-READY — no driver/test sources yet (spec comes first)"; exit 1; \
	fi
	@mkdir -p bin
	$(CC) $(QN_CFLAGS) $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_tests -fsanitize=address,undefined
	./bin/qn_tests
	$(if $(NODE_TEST_SRC),cd $(PEER_DIR) && $(NODE) --test $(notdir $(NODE_TEST_SRC)),)

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

FUZZ_SRC := src/tests/fuzz_frame.c

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
	$(NODE) src/tests/fuzz_wire.cjs

clean:
	rm -rf bin
	$(MAKE) -C $(QS_DIR)/Quake clean
