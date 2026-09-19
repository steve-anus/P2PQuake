# p2pquake top-level checks. Extra-info flags always on; warnings get fixed at
# the cause, never silenced. Targets marked NOT-READY are honest gates: they
# fail loudly until their real checks exist.

QS_DIR   := src/vendor/quakespasm
PEER_DIR := src/peer
DRIVER_SRC := $(wildcard src/driver/*.c)
TEST_SRC   := $(wildcard src/tests/*.c)
CC ?= gcc

QN_CFLAGS := -std=c11 -g -Og -Wall -Wextra -Wpedantic -Wshadow -Wconversion

.PHONY: all engine peer check asan ubsan tsan fuzz fuzz-smoke clean

all: engine peer

# USE_SDL2=1 is mandatory: the upstream Makefile defaults to SDL-1.2
# (Quakespasm.txt "make USE_SDL2=1 to compile against SDL2").
# MP3LIB=mpg123: upstream defaults to libmad (Makefile:26) which is not
# installed here; the mpg123 backend uses the system library we do have.
# Both build cleanly; flip this back if libmad ever becomes the preference.
engine:
	$(MAKE) -C $(QS_DIR)/Quake DEBUG=$(DEBUG) USE_SDL2=1 MP3LIB=mpg123

peer:
	cd $(PEER_DIR) && npm ci --ignore-scripts

check:
	@if [ -z "$(DRIVER_SRC)" ] || [ -z "$(TEST_SRC)" ]; then \
	  echo "check: NOT-READY — no driver/test sources yet (spec comes first)"; exit 1; \
	fi
	$(CC) $(QN_CFLAGS) $(DRIVER_SRC) $(TEST_SRC) -o bin/qn_tests -fsanitize=address,undefined
	./bin/qn_tests

asan:
	@if [ -z "$(DRIVER_SRC)" ]; then echo "asan: NOT-READY — no driver sources"; exit 1; fi
	$(CC) $(QN_CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer $(DRIVER_SRC) -o bin/qn_asan

ubsan:
	@if [ -z "$(DRIVER_SRC)" ]; then echo "ubsan: NOT-READY — no driver sources"; exit 1; fi
	$(CC) $(QN_CFLAGS) -fsanitize=undefined $(DRIVER_SRC) -o bin/qn_ubsan

tsan:
	@if [ -z "$(DRIVER_SRC)" ]; then echo "tsan: NOT-READY — no driver sources"; exit 1; fi
	$(CC) $(QN_CFLAGS) -fsanitize=thread $(DRIVER_SRC) -o bin/qn_tsan

fuzz fuzz-smoke:
	@echo "$@: NOT-READY — fuzz harnesses land with the wire spec; needs clang"
	@exit 1

clean:
	rm -rf bin
	$(MAKE) -C $(QS_DIR)/Quake clean
