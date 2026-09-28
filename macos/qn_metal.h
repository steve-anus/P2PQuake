/* Native Metal implementation of the fixed-function operations used by
 * QuakeSpasm. SDL's GL header supplies types/constants only; the executable
 * neither creates an OpenGL context nor links the OpenGL framework.
 * GPL-2.0-or-later. This is not a general-purpose OpenGL implementation. */
#ifndef QN_METAL_H
#define QN_METAL_H
#include "SDL.h"
#include "SDL_opengl.h"

/* Test/benchmark mode renders offscreen and never acquires a drawable. */
int QNM_Headless(void);
void QNM_BeginFrame(void);
void QNM_EndFrame(int present, float gamma, float contrast);
extern __typeof__(glAlphaFunc) QNM_glAlphaFunc;
#define glAlphaFunc QNM_glAlphaFunc
extern __typeof__(glBegin) QNM_glBegin;
#define glBegin QNM_glBegin
extern __typeof__(glBindTexture) QNM_glBindTexture;
#define glBindTexture QNM_glBindTexture
extern __typeof__(glBlendFunc) QNM_glBlendFunc;
#define glBlendFunc QNM_glBlendFunc
extern __typeof__(glClear) QNM_glClear;
#define glClear QNM_glClear
extern __typeof__(glClearColor) QNM_glClearColor;
#define glClearColor QNM_glClearColor
extern __typeof__(glColor3f) QNM_glColor3f;
#define glColor3f QNM_glColor3f
extern __typeof__(glColor3fv) QNM_glColor3fv;
#define glColor3fv QNM_glColor3fv
extern __typeof__(glColor4f) QNM_glColor4f;
#define glColor4f QNM_glColor4f
extern __typeof__(glColor4fv) QNM_glColor4fv;
#define glColor4fv QNM_glColor4fv
extern __typeof__(glColor4ubv) QNM_glColor4ubv;
#define glColor4ubv QNM_glColor4ubv
extern __typeof__(glColorMask) QNM_glColorMask;
#define glColorMask QNM_glColorMask
extern __typeof__(glCopyTexSubImage2D) QNM_glCopyTexSubImage2D;
#define glCopyTexSubImage2D QNM_glCopyTexSubImage2D
extern __typeof__(glCullFace) QNM_glCullFace;
#define glCullFace QNM_glCullFace
extern __typeof__(glDeleteTextures) QNM_glDeleteTextures;
#define glDeleteTextures QNM_glDeleteTextures
extern __typeof__(glDepthFunc) QNM_glDepthFunc;
#define glDepthFunc QNM_glDepthFunc
extern __typeof__(glDepthMask) QNM_glDepthMask;
#define glDepthMask QNM_glDepthMask
extern __typeof__(glDepthRange) QNM_glDepthRange;
#define glDepthRange QNM_glDepthRange
extern __typeof__(glDisable) QNM_glDisable;
#define glDisable QNM_glDisable
extern __typeof__(glDrawElements) QNM_glDrawElements;
#define glDrawElements QNM_glDrawElements
extern __typeof__(glEnable) QNM_glEnable;
#define glEnable QNM_glEnable
extern __typeof__(glEnd) QNM_glEnd;
#define glEnd QNM_glEnd
extern __typeof__(glFinish) QNM_glFinish;
#define glFinish QNM_glFinish
extern __typeof__(glFogf) QNM_glFogf;
#define glFogf QNM_glFogf
extern __typeof__(glFogfv) QNM_glFogfv;
#define glFogfv QNM_glFogfv
extern __typeof__(glFogi) QNM_glFogi;
#define glFogi QNM_glFogi
extern __typeof__(glFrontFace) QNM_glFrontFace;
#define glFrontFace QNM_glFrontFace
extern __typeof__(glFrustum) QNM_glFrustum;
#define glFrustum QNM_glFrustum
extern __typeof__(glGenTextures) QNM_glGenTextures;
#define glGenTextures QNM_glGenTextures
extern __typeof__(glGetFloatv) QNM_glGetFloatv;
#define glGetFloatv QNM_glGetFloatv
extern __typeof__(glGetIntegerv) QNM_glGetIntegerv;
#define glGetIntegerv QNM_glGetIntegerv
extern __typeof__(glGetString) QNM_glGetString;
#define glGetString QNM_glGetString
extern __typeof__(glGetTexImage) QNM_glGetTexImage;
#define glGetTexImage QNM_glGetTexImage
extern __typeof__(glGetTexParameterfv) QNM_glGetTexParameterfv;
#define glGetTexParameterfv QNM_glGetTexParameterfv
extern __typeof__(glHint) QNM_glHint;
#define glHint QNM_glHint
extern __typeof__(glLoadIdentity) QNM_glLoadIdentity;
#define glLoadIdentity QNM_glLoadIdentity
extern __typeof__(glMatrixMode) QNM_glMatrixMode;
#define glMatrixMode QNM_glMatrixMode
extern __typeof__(glMultMatrixf) QNM_glMultMatrixf;
#define glMultMatrixf QNM_glMultMatrixf
extern __typeof__(glOrtho) QNM_glOrtho;
#define glOrtho QNM_glOrtho
extern __typeof__(glPixelStorei) QNM_glPixelStorei;
#define glPixelStorei QNM_glPixelStorei
extern __typeof__(glPolygonMode) QNM_glPolygonMode;
#define glPolygonMode QNM_glPolygonMode
extern __typeof__(glPolygonOffset) QNM_glPolygonOffset;
#define glPolygonOffset QNM_glPolygonOffset
extern __typeof__(glPopMatrix) QNM_glPopMatrix;
#define glPopMatrix QNM_glPopMatrix
extern __typeof__(glPushMatrix) QNM_glPushMatrix;
#define glPushMatrix QNM_glPushMatrix
extern __typeof__(glReadPixels) QNM_glReadPixels;
#define glReadPixels QNM_glReadPixels
extern __typeof__(glRotatef) QNM_glRotatef;
#define glRotatef QNM_glRotatef
extern __typeof__(glScalef) QNM_glScalef;
#define glScalef QNM_glScalef
extern __typeof__(glScissor) QNM_glScissor;
#define glScissor QNM_glScissor
extern __typeof__(glShadeModel) QNM_glShadeModel;
#define glShadeModel QNM_glShadeModel
extern __typeof__(glStencilFunc) QNM_glStencilFunc;
#define glStencilFunc QNM_glStencilFunc
extern __typeof__(glStencilOp) QNM_glStencilOp;
#define glStencilOp QNM_glStencilOp
extern __typeof__(glTexCoord2f) QNM_glTexCoord2f;
#define glTexCoord2f QNM_glTexCoord2f
extern __typeof__(glTexEnvf) QNM_glTexEnvf;
#define glTexEnvf QNM_glTexEnvf
extern __typeof__(glTexEnvi) QNM_glTexEnvi;
#define glTexEnvi QNM_glTexEnvi
extern __typeof__(glTexImage2D) QNM_glTexImage2D;
#define glTexImage2D QNM_glTexImage2D
extern __typeof__(glTexParameterf) QNM_glTexParameterf;
#define glTexParameterf QNM_glTexParameterf
extern __typeof__(glTexParameteri) QNM_glTexParameteri;
#define glTexParameteri QNM_glTexParameteri
extern __typeof__(glTexSubImage2D) QNM_glTexSubImage2D;
#define glTexSubImage2D QNM_glTexSubImage2D
extern __typeof__(glTranslatef) QNM_glTranslatef;
#define glTranslatef QNM_glTranslatef
extern __typeof__(glVertex2f) QNM_glVertex2f;
#define glVertex2f QNM_glVertex2f
extern __typeof__(glVertex3f) QNM_glVertex3f;
#define glVertex3f QNM_glVertex3f
extern __typeof__(glVertex3fv) QNM_glVertex3fv;
#define glVertex3fv QNM_glVertex3fv
extern __typeof__(glViewport) QNM_glViewport;
#define glViewport QNM_glViewport
extern __typeof__(SDL_GL_CreateContext) QNM_SDL_GL_CreateContext;
#define SDL_GL_CreateContext QNM_SDL_GL_CreateContext
extern __typeof__(SDL_GL_DeleteContext) QNM_SDL_GL_DeleteContext;
#define SDL_GL_DeleteContext QNM_SDL_GL_DeleteContext
extern __typeof__(SDL_GL_GetProcAddress) QNM_SDL_GL_GetProcAddress;
#define SDL_GL_GetProcAddress QNM_SDL_GL_GetProcAddress
extern __typeof__(SDL_GL_SetAttribute) QNM_SDL_GL_SetAttribute;
#define SDL_GL_SetAttribute QNM_SDL_GL_SetAttribute
extern __typeof__(SDL_GL_GetAttribute) QNM_SDL_GL_GetAttribute;
#define SDL_GL_GetAttribute QNM_SDL_GL_GetAttribute
extern __typeof__(SDL_GL_SetSwapInterval) QNM_SDL_GL_SetSwapInterval;
#define SDL_GL_SetSwapInterval QNM_SDL_GL_SetSwapInterval
extern __typeof__(SDL_GL_GetSwapInterval) QNM_SDL_GL_GetSwapInterval;
#define SDL_GL_GetSwapInterval QNM_SDL_GL_GetSwapInterval

#endif
