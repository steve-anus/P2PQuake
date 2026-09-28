# SDL2 command-line macOS build, reusing the pinned engine's object list.
# Invoke from Quake/: make -f ../../../../macos/engine.mk
MACOS_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
.DEFAULT_GOAL := all
override USE_SDL2 := 1
override MP3LIB := mpg123
override USE_CODEC_VORBIS := 0
QN_PLATFORM_MAKEFILE := $(MACOS_DIR)/rules.mk
include Makefile
