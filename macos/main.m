/* SDL2 owns the Cocoa application; the engine retains its command-line entry.
 * Compile without ARC to keep a public NSAutoreleasePool across C frame calls.
 * GPL-2.0-or-later. */
#import <Foundation/Foundation.h>
extern int QNM_engine_main(int argc, char **argv);
void *QNM_PushPool(void) { return [[NSAutoreleasePool alloc] init]; }
void QNM_PopPool(void *pool) { [(NSAutoreleasePool *)pool drain]; }
int main(int argc, char **argv) {
    @autoreleasepool { return QNM_engine_main(argc, argv); }
}
