/* Pixel-level checks against the real Metal device, no game data required.
 * GPL-2.0-or-later. */
#include "qn_metal.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

static int checks;
void Sys_Error(const char *format, ...) {
    va_list args; va_start(args,format); vfprintf(stderr,format,args); va_end(args);
    fputc('\n',stderr); exit(1);
}
void Con_Printf(const char *format, ...) {
    va_list args; va_start(args,format); vprintf(format,args); va_end(args);
}
static void pixel(int x, int y, int r, int g, int b, const char *label) {
    unsigned char got[4];
    glReadPixels(x,y,1,1,GL_RGBA,GL_UNSIGNED_BYTE,got);
    if (abs((int)got[0]-r)>2 || abs((int)got[1]-g)>2 || abs((int)got[2]-b)>2)
        Sys_Error("%s: expected %d,%d,%d, got %u,%u,%u",label,r,g,b,got[0],got[1],got[2]);
    checks++;
}
static void quad(float x, float y, float size, float z) {
    glBegin(GL_QUADS);
    glTexCoord2f(0,0); glVertex3f(x,y,z);
    glTexCoord2f(1,0); glVertex3f(x+size,y,z);
    glTexCoord2f(1,1); glVertex3f(x+size,y+size,z);
    glTexCoord2f(0,1); glVertex3f(x,y+size,z);
    glEnd();
}
int QNM_engine_main(int argc, char **argv) {
    (void)argc; (void)argv;
    if (SDL_Init(SDL_INIT_VIDEO)) Sys_Error("SDL: %s",SDL_GetError());
    SDL_Window *window=SDL_CreateWindow("P2PQuake Metal checks",0,0,64,64,SDL_WINDOW_METAL|SDL_WINDOW_HIDDEN);
    if (!window) Sys_Error("window: %s",SDL_GetError());
    SDL_GLContext context=SDL_GL_CreateContext(window);
    if (!context) Sys_Error("Metal context: %s",SDL_GetError());
    QNM_BeginFrame();
    glViewport(0,0,64,64);
    glMatrixMode(GL_PROJECTION); glLoadIdentity(); glOrtho(0,64,0,64,-1,1);
    glMatrixMode(GL_MODELVIEW); glLoadIdentity();
    glClearColor(0,0,0,1); glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
    glColor3f(1,0,0); quad(0,0,32,0);
    pixel(8,8,255,0,0,"solid quad and bottom-origin readback");
    pixel(8,56,0,0,0,"clear and coordinate orientation");

    glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LEQUAL);
    glColor3f(0,1,0); quad(0,0,32,0.5f);
    glColor3f(0,0,1); quad(0,0,32,-0.5f);
    pixel(8,8,0,255,0,"depth projection and occlusion");
    glDisable(GL_DEPTH_TEST);
    glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
    glColor4f(1,0,0,0.5f); quad(0,0,32,0);
    pixel(8,8,128,127,0,"alpha blending"); glDisable(GL_BLEND);

    glEnable(GL_ALPHA_TEST); glAlphaFunc(GL_GREATER,0.5f);
    glColor4f(0,0,1,0.25f); quad(0,0,32,0);
    pixel(8,8,128,127,0,"alpha discard"); glDisable(GL_ALPHA_TEST);

    glPushMatrix(); glTranslatef(32,32,0);
    glColor3f(0,0,1); quad(0,0,16,0); glPopMatrix();
    pixel(40,40,0,0,255,"matrix stack and translation");
    glEnable(GL_SCISSOR_TEST); glScissor(48,48,8,8);
    glColor3f(1,1,0); quad(32,32,32,0); glDisable(GL_SCISSOR_TEST);
    pixel(50,50,255,255,0,"scissor origin"); pixel(60,60,0,0,0,"scissor exclusion");

    GLuint tex; glGenTextures(1,&tex); glBindTexture(GL_TEXTURE_2D,tex);
    const unsigned char pixels[]={255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255};
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,2,2,0,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glEnable(GL_TEXTURE_2D); glTexEnvi(GL_TEXTURE_ENV,GL_TEXTURE_ENV_MODE,GL_REPLACE);
    quad(0,32,32,0);
    pixel(4,36,255,0,0,"texture lower left"); pixel(28,36,0,255,0,"texture lower right");
    pixel(4,60,0,0,255,"texture upper left"); pixel(28,60,255,255,255,"texture upper right");
    const unsigned char yellow[]={255,255,0,255};
    glTexSubImage2D(GL_TEXTURE_2D,0,0,0,1,1,GL_RGBA,GL_UNSIGNED_BYTE,yellow);
    quad(0,32,32,0); pixel(4,36,255,255,0,"ordered texture subimage");

    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA,32,32,0,GL_RGBA,GL_UNSIGNED_BYTE,NULL);
    glCopyTexSubImage2D(GL_TEXTURE_2D,0,0,0,0,32,32,32);
    quad(32,0,32,0);
    pixel(36,4,255,255,0,"framebuffer texture copy lower row");
    pixel(36,28,0,0,255,"framebuffer texture copy upper row");
    glDisable(GL_TEXTURE_2D);

    glEnable(GL_FOG); glFogi(GL_FOG_MODE,GL_EXP2); glFogf(GL_FOG_DENSITY,2);
    const float blue[]={0,0,1,1}; glFogfv(GL_FOG_COLOR,blue);
    glColor3f(1,0,0); quad(0,0,16,1);
    pixel(4,4,5,0,250,"exponential squared fog"); glDisable(GL_FOG);

    glEnable(GL_STENCIL_TEST); glStencilFunc(GL_EQUAL,0,~0u); glStencilOp(GL_KEEP,GL_KEEP,GL_INCR);
    glColor3f(1,0,0); quad(16,0,16,0);
    glColor3f(0,0,1); quad(16,0,16,0);
    pixel(20,4,255,0,0,"stencil shadow overlap"); glDisable(GL_STENCIL_TEST);

    glClear(GL_COLOR_BUFFER_BIT); glShadeModel(GL_SMOOTH);
    glBegin(GL_TRIANGLE_STRIP);
    glColor3f(1,0,0); glVertex2f(0,0); glVertex2f(32,0); glVertex2f(0,32); glVertex2f(32,32);
    glEnd();
    glBegin(GL_TRIANGLE_STRIP);
    glColor3f(0,1,0); glVertex2f(32,32); glVertex2f(64,32); glVertex2f(32,64); glVertex2f(64,64);
    glEnd();
    pixel(8,8,255,0,0,"batched strip one"); pixel(56,56,0,255,0,"batched strip two");
    pixel(8,56,0,0,0,"strips have no connecting triangles");

    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_CULL_FACE); glFrontFace(GL_CCW); glCullFace(GL_BACK);
    glColor3f(1,0,0); quad(0,0,32,0);
    pixel(8,8,255,0,0,"counterclockwise front face");
    glCullFace(GL_FRONT); glColor3f(0,1,0); quad(0,0,32,0);
    pixel(8,8,255,0,0,"front face culling");
    glFrontFace(GL_CW); quad(0,0,32,0);
    pixel(8,8,0,255,0,"clockwise front face"); glDisable(GL_CULL_FACE);

    glShadeModel(GL_FLAT);
    glBegin(GL_QUADS);
    glColor3f(1,0,0); glVertex2f(32,0); glVertex2f(64,0); glVertex2f(64,32);
    glColor3f(0,0,1); glVertex2f(32,32); glEnd();
    pixel(40,8,0,0,255,"flat quad provoking vertex, first triangle");
    pixel(40,24,0,0,255,"flat quad provoking vertex, second triangle");

    glDeleteTextures(1,&tex);
    QNM_EndFrame(0,1,1);
    // Exercise reuse of all three vertex arenas across successive frames.
    for (int i=0;i<12;i++) {
        QNM_BeginFrame();
        glColor3f((float)(i&1),0,1); quad(0,0,64,0);
        if (i==11) pixel(40,40,255,0,255,"frame arena reuse");
        QNM_EndFrame(0,1,1);
    }
    SDL_GL_DeleteContext(context); SDL_DestroyWindow(window); SDL_Quit();
    printf("METAL OK: %d pixel checks\n",checks);
    return 0;
}
