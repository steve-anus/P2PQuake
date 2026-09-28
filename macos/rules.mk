MACOSX_DEPLOYMENT_TARGET ?= $(shell sw_vers -productVersion | cut -d. -f1).0
CFLAGS += -DQN_METAL -I$(MACOS_DIR) -mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
CFLAGS += $(shell $(PKG_CONFIG) --cflags libmpg123)
COMMON_LIBS := -framework Metal -framework QuartzCore -framework Cocoa -framework IOKit
CODECLIBS := $(shell $(PKG_CONFIG) --libs libmpg123)
LDFLAGS += -mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)
STRIP := strip -S
OBJDIR := build-macos
OBJS := $(addprefix $(OBJDIR)/,$(OBJS) qn_os_macos.o qn_metal.o main.o)
vpath %.m $(MACOS_DIR)

$(OBJDIR)/%.o: %.c | $(OBJDIR)
	$(CC) $(DFLAGS) $(CFLAGS) $(SDL_CFLAGS) -c -o $@ $<
$(OBJDIR)/%.o: %.m $(OBJDIR)/metal_shaders.inc | $(OBJDIR)
	$(CC) $(DFLAGS) $(CFLAGS) $(SDL_CFLAGS) -I$(OBJDIR) -fobjc-arc -c -o $@ $<
$(OBJDIR)/main.o: $(MACOS_DIR)/main.m | $(OBJDIR)
	$(CC) $(DFLAGS) $(CFLAGS) -fno-objc-arc -c -o $@ $<
$(OBJDIR):
	mkdir -p $@
$(OBJDIR)/metal_shaders.inc: $(MACOS_DIR)/shaders.metal $(MACOS_DIR)/embed-shaders.py | $(OBJDIR)
	python3 $(MACOS_DIR)/embed-shaders.py $< $@

.PHONY: clean-macos
clean-macos:
	$(RM) -r $(OBJDIR) quakespasm
sinclude $(OBJS:.o=.d)

$(OBJDIR)/renderer-test.o: $(MACOS_DIR)/renderer-test.c | $(OBJDIR)
	$(CC) $(CFLAGS) $(SDL_CFLAGS) -c -o $@ $<
$(OBJDIR)/renderer-test: $(OBJDIR)/renderer-test.o $(OBJDIR)/qn_metal.o $(OBJDIR)/main.o
	$(LINKER) $^ $(LDFLAGS) $(COMMON_LIBS) $(SDL_LIBS) -o $@
.PHONY: metal-check
metal-check: $(OBJDIR)/renderer-test
	MTL_DEBUG_LAYER=1 ./$(OBJDIR)/renderer-test
