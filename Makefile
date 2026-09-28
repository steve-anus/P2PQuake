# p2pquake windows build. The unix regression battery and release tooling
# live on the linux branch. Extra-info flags always on; warnings are fixed
# at the cause, never silenced.

QS_DIR   := src/vendor/quakespasm

NODE ?= $(firstword $(wildcard $(CURDIR)/bin/node/bin/node) $(shell command -v node 2>/dev/null))

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

.PHONY: all win64 peer clean

all: win64

# Toolchain: llvm-mingw + SDL2 mingw devel + mpg123 static, laid out under
# WINBUILD as tools/winbuild.sh arranges it. Point WINBUILD at a shared
# install to reuse it across checkouts.
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

peer:
	npm ci --ignore-scripts

clean:
	rm -rf $(QS_DIR)/Quake/build-w64 $(QS_DIR)/Quake/quakespasm.exe
