/* Native Metal backend for QuakeSpasm's fixed-function scene renderer.
 * GPL-2.0-or-later. Only the operations used by this pinned engine are
 * implemented; unsupported operations fail instead of silently rendering
 * incorrect output. No OpenGL context, driver calls, or framework link. */
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <simd/simd.h>
#include <math.h>
#include "qn_metal.h"
#include "metal_shaders.inc"

extern void Sys_Error(const char *, ...) __attribute__((noreturn, format(printf,1,2)));
extern void Con_Printf(const char *, ...) __attribute__((format(printf,1,2)));

typedef struct {
    vector_float4 position, color;
    vector_float2 uv, pad;
} QNMVertex;
typedef struct {
    matrix_float4x4 projection, modelview;
    vector_float4 fogColor, params;
    vector_uint4 flags;
} QNMUniforms;

@interface QNMTexture : NSObject
@property(nonatomic, strong) id<MTLTexture> image;
@property(nonatomic) GLenum minFilter, magFilter, wrapS, wrapT;
@property(nonatomic) float anisotropy;
@end
@implementation QNMTexture
- (instancetype)init {
    if ((self = [super init])) {
        _minFilter = GL_NEAREST_MIPMAP_LINEAR; _magFilter = GL_LINEAR;
        _wrapS = _wrapT = GL_REPEAT; _anisotropy = 1;
    }
    return self;
}
@end

extern void *QNM_PushPool(void);
extern void QNM_PopPool(void *);
static void *framePool;
static BOOL profile;
static double frameStart, cpuTime, drawableTime, queueTime, gpuTime;
static unsigned profileFrames, profileDraws;
static id<MTLDevice> device;
static id<MTLCommandQueue> queue;
static id<MTLLibrary> library;
static id<MTLRenderPipelineState> screenPipeline;
static id<MTLComputePipelineState> copyPipeline;
static CAMetalLayer *layer;
static SDL_MetalView metalView;
static SDL_Window *window;
static id<MTLTexture> colorTarget, depthTarget, whiteTexture;
static id<MTLCommandBuffer> command;
static id<MTLRenderCommandEncoder> encoder;
static NSMutableDictionary<NSNumber *, QNMTexture *> *textures;
static NSMutableDictionary<NSNumber *, id<MTLRenderPipelineState>> *pipelines;
static NSMutableDictionary<NSNumber *, id<MTLDepthStencilState>> *depthStates;
static NSMutableDictionary<NSNumber *, id<MTLSamplerState>> *samplers;
static NSMutableArray<id<MTLBuffer>> *bufferPools[3];
static NSUInteger bufferIndex;
static id<MTLBuffer> arena;
static NSUInteger arenaOffset;
static const NSUInteger arenaSize = 8 * 1024 * 1024;
static GLuint nextTexture = 1, boundTexture;
static int frameWidth, frameHeight, swapInterval;
static QNMVertex current = {.position = {0,0,0,1}, .color = {1,1,1,1}};
static QNMVertex *batch;
static size_t batchCount, batchCapacity;
static MTLPrimitiveType batchType;
static void flushBatch(void);
static id<MTLCommandBuffer> inFlight[3];
static NSUInteger flightIndex;
static QNMVertex *vertices;
static size_t vertexCount, vertexCapacity;
static QNMVertex *triangles;
static size_t triangleCapacity;
static GLenum primitive;
static BOOL smoothShading;
static matrix_float4x4 modelStack[32], projectionStack[32];
static unsigned modelTop, projectionTop;
static GLenum matrixMode = GL_MODELVIEW;
static BOOL texturing, blending, depthTest, depthWrite = YES;
static BOOL alphaTest, fog, culling, scissor, stencil, polygonOffset;
static GLenum blendSource = GL_SRC_ALPHA, blendDest = GL_ONE_MINUS_SRC_ALPHA;
static GLenum depthFunction = GL_LESS, cullFace = GL_BACK, frontFace = GL_CCW;
static GLenum polygonMode = GL_FILL, textureMode = GL_MODULATE;
static GLenum stencilFunction = GL_ALWAYS, stencilFail = GL_KEEP;
static GLenum stencilDepthFail = GL_KEEP, stencilPass = GL_KEEP;
static GLuint stencilMask = ~0u;
static GLint stencilRef;
static unsigned colorMask = MTLColorWriteMaskAll;
static float alphaReference, rgbScale = 1, fogDensity, offsetFactor, offsetUnits;
static vector_float4 fogColor, clearColor;
static GLint viewX, viewY, viewW, viewH, scissorX, scissorY, scissorW, scissorH;
static double depthNear, depthFar = 1;
static GLint packAlignment = 4, unpackAlignment = 4;
static GLint unpackRowLength;

static void unsupported(const char *operation, GLenum value) {
    Sys_Error("Metal: unsupported %s (0x%x)", operation, value);
}
static void endEncoder(void) {
    [encoder endEncoding]; encoder = nil;
}
static void ensureCommand(void) {
    if (!command) command = [queue commandBuffer];
}
static void submit(BOOL wait) {
    if (!command) return;
    endEncoder();
    [command commit];
    if (wait) {
        [command waitUntilCompleted];
        if (command.status == MTLCommandBufferStatusError)
            Sys_Error("Metal command failed: %s", command.error.localizedDescription.UTF8String);
    }
    command = nil;
}
static id<MTLTexture> newTarget(MTLPixelFormat format, int w, int h, BOOL mipmaps) {
    MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:format
                                  width:w height:h mipmapped:mipmaps];
    d.storageMode = MTLStorageModePrivate;
    d.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget;
    if (format == MTLPixelFormatRGBA8Unorm) d.usage |= MTLTextureUsageShaderWrite;
    id<MTLTexture> t = [device newTextureWithDescriptor:d];
    if (!t) Sys_Error("Metal: texture allocation failed (%dx%d)", w, h);
    return t;
}
static void ensureEncoder(GLbitfield clear) {
    if (encoder && !clear) return;
    endEncoder(); ensureCommand();
    MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
    pass.colorAttachments[0].texture = colorTarget;
    pass.colorAttachments[0].loadAction = (clear & GL_COLOR_BUFFER_BIT) ? MTLLoadActionClear : MTLLoadActionLoad;
    pass.colorAttachments[0].storeAction = MTLStoreActionStore;
    pass.colorAttachments[0].clearColor = MTLClearColorMake(clearColor.x,clearColor.y,clearColor.z,clearColor.w);
    pass.depthAttachment.texture = depthTarget;
    pass.depthAttachment.loadAction = (clear & GL_DEPTH_BUFFER_BIT) ? MTLLoadActionClear : MTLLoadActionLoad;
    pass.depthAttachment.storeAction = MTLStoreActionStore;
    pass.depthAttachment.clearDepth = 1;
    pass.stencilAttachment.texture = depthTarget;
    pass.stencilAttachment.loadAction = (clear & GL_STENCIL_BUFFER_BIT) ? MTLLoadActionClear : MTLLoadActionLoad;
    pass.stencilAttachment.storeAction = MTLStoreActionStore;
    pass.stencilAttachment.clearStencil = 0;
    encoder = [command renderCommandEncoderWithDescriptor:pass];
}
static MTLBlendFactor blendFactor(GLenum value) {
    switch (value) {
        case GL_ZERO: return MTLBlendFactorZero;
        case GL_ONE: return MTLBlendFactorOne;
        case GL_SRC_ALPHA: return MTLBlendFactorSourceAlpha;
        case GL_ONE_MINUS_SRC_ALPHA: return MTLBlendFactorOneMinusSourceAlpha;
        case GL_DST_COLOR: return MTLBlendFactorDestinationColor;
        case GL_SRC_COLOR: return MTLBlendFactorSourceColor;
        default: unsupported("blend factor",value); return 0;
    }
}
static MTLCompareFunction compareFunction(GLenum value) {
    if (value >= GL_NEVER && value <= GL_ALWAYS) return (MTLCompareFunction)(value - GL_NEVER);
    unsupported("comparison", value); return MTLCompareFunctionNever;
}
static MTLStencilOperation stencilOperation(GLenum value) {
    switch (value) {
        case GL_KEEP: return MTLStencilOperationKeep;
        case GL_ZERO: return MTLStencilOperationZero;
        case GL_REPLACE: return MTLStencilOperationReplace;
        case GL_INCR: return MTLStencilOperationIncrementClamp;
        case GL_DECR: return MTLStencilOperationDecrementClamp;
        default: unsupported("stencil operation", value); return 0;
    }
}
static id<MTLRenderPipelineState> pipeline(void) {
    uint64_t key = colorMask | ((uint64_t)blending << 4) |
        ((uint64_t)blendSource << 8) | ((uint64_t)blendDest << 24);
    id<MTLRenderPipelineState> p = pipelines[@(key)];
    if (p) return p;
    MTLRenderPipelineDescriptor *d = [MTLRenderPipelineDescriptor new];
    d.vertexFunction = [library newFunctionWithName:@"quake_vertex"];
    d.fragmentFunction = [library newFunctionWithName:@"quake_fragment"];
    d.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
    d.colorAttachments[0].writeMask = colorMask;
    d.colorAttachments[0].blendingEnabled = blending;
    d.colorAttachments[0].sourceRGBBlendFactor = blendFactor(blendSource);
    d.colorAttachments[0].sourceAlphaBlendFactor = blendFactor(blendSource);
    d.colorAttachments[0].destinationRGBBlendFactor = blendFactor(blendDest);
    d.colorAttachments[0].destinationAlphaBlendFactor = blendFactor(blendDest);
    d.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float_Stencil8;
    d.stencilAttachmentPixelFormat = MTLPixelFormatDepth32Float_Stencil8;
    NSError *error = nil;
    p = [device newRenderPipelineStateWithDescriptor:d error:&error];
    if (!p) Sys_Error("Metal pipeline: %s",error.localizedDescription.UTF8String);
    pipelines[@(key)] = p;
    return p;
}
static id<MTLDepthStencilState> depthState(void) {
    uint64_t key = depthTest | ((uint64_t)depthWrite << 1) | ((uint64_t)stencil << 2) |
        ((uint64_t)(depthFunction - GL_NEVER) << 3) |
        ((uint64_t)(stencilFunction - GL_NEVER) << 6) |
        ((uint64_t)stencilOperation(stencilFail) << 9) |
        ((uint64_t)stencilOperation(stencilDepthFail) << 12) |
        ((uint64_t)stencilOperation(stencilPass) << 15) | ((uint64_t)stencilMask << 24);
    id<MTLDepthStencilState> state = depthStates[@(key)];
    if (state) return state;
    MTLDepthStencilDescriptor *d = [MTLDepthStencilDescriptor new];
    d.depthCompareFunction = depthTest ? compareFunction(depthFunction) : MTLCompareFunctionAlways;
    d.depthWriteEnabled = depthTest && depthWrite;
    if (stencil) {
        MTLStencilDescriptor *s = [MTLStencilDescriptor new];
        s.stencilCompareFunction = compareFunction(stencilFunction);
        s.stencilFailureOperation = stencilOperation(stencilFail);
        s.depthFailureOperation = stencilOperation(stencilDepthFail);
        s.depthStencilPassOperation = stencilOperation(stencilPass);
        s.readMask = stencilMask; s.writeMask = ~0u;
        d.frontFaceStencil = d.backFaceStencil = s;
    }
    state = [device newDepthStencilStateWithDescriptor:d];
    depthStates[@(key)] = state;
    return state;
}
static id<MTLSamplerState> sampler(QNMTexture *t) {
    GLenum min = t ? t.minFilter : GL_NEAREST, mag = t ? t.magFilter : GL_NEAREST;
    GLenum s = t ? t.wrapS : GL_REPEAT, r = t ? t.wrapT : GL_REPEAT;
    unsigned aniso = t ? (unsigned)t.anisotropy : 1;
    uint64_t key = min | ((uint64_t)mag << 16) | ((uint64_t)(s == GL_REPEAT) << 32) |
        ((uint64_t)(r == GL_REPEAT) << 33) | ((uint64_t)aniso << 34);
    id<MTLSamplerState> state = samplers[@(key)];
    if (state) return state;
    MTLSamplerDescriptor *d = [MTLSamplerDescriptor new];
    d.minFilter = (min == GL_LINEAR || min == GL_LINEAR_MIPMAP_NEAREST || min == GL_LINEAR_MIPMAP_LINEAR) ? MTLSamplerMinMagFilterLinear : MTLSamplerMinMagFilterNearest;
    d.magFilter = mag == GL_LINEAR ? MTLSamplerMinMagFilterLinear : MTLSamplerMinMagFilterNearest;
    d.mipFilter = min == GL_NEAREST || min == GL_LINEAR ? MTLSamplerMipFilterNotMipmapped :
        (min == GL_NEAREST_MIPMAP_LINEAR || min == GL_LINEAR_MIPMAP_LINEAR ? MTLSamplerMipFilterLinear : MTLSamplerMipFilterNearest);
    d.sAddressMode = s == GL_REPEAT ? MTLSamplerAddressModeRepeat : MTLSamplerAddressModeClampToEdge;
    d.tAddressMode = r == GL_REPEAT ? MTLSamplerAddressModeRepeat : MTLSamplerAddressModeClampToEdge;
    d.maxAnisotropy = aniso;
    state = [device newSamplerStateWithDescriptor:d];
    samplers[@(key)] = state;
    return state;
}
static void encodeVertices(MTLPrimitiveType type, const QNMVertex *data, size_t count) {
    if (!count) return;
    size_t bytes = count * sizeof *data;
    if (!arena || arenaOffset + bytes > arena.length) {
        NSMutableArray<id<MTLBuffer>> *pool = bufferPools[flightIndex];
        arena = bufferIndex < pool.count ? pool[bufferIndex] : nil;
        if (arena.length < bytes)
            arena = [device newBufferWithLength:MAX(arenaSize, bytes) options:MTLResourceStorageModeShared];
        if (!arena) Sys_Error("Metal: vertex allocation failed");
        if (bufferIndex < pool.count) pool[bufferIndex] = arena;
        else [pool addObject:arena];
        bufferIndex++; arenaOffset = 0;
    }
    memcpy((char *)arena.contents + arenaOffset, data, bytes);
    ensureEncoder(0);
    [encoder setRenderPipelineState:pipeline()];
    [encoder setDepthStencilState:depthState()];
    [encoder setStencilReferenceValue:(uint32_t)stencilRef];
    // Metal's viewport uses a top-left origin; projection Y is already
    // transformed by Metal's viewport convention, so winding stays unchanged.
    [encoder setViewport:(MTLViewport){viewX, frameHeight-viewY-viewH, viewW,viewH,depthNear,depthFar}];
    int sx = scissor ? MAX(0,scissorX) : 0, sy = scissor ? MAX(0,frameHeight-scissorY-scissorH) : 0;
    int sw = scissor ? MAX(0,MIN(frameWidth-sx,scissorW)) : frameWidth;
    int sh = scissor ? MAX(0,MIN(frameHeight-sy,scissorH)) : frameHeight;
    if (!sw || !sh) return;
    [encoder setScissorRect:(MTLScissorRect){(NSUInteger)sx,(NSUInteger)sy,(NSUInteger)sw,(NSUInteger)sh}];
    [encoder setFrontFacingWinding:frontFace == GL_CW ? MTLWindingClockwise : MTLWindingCounterClockwise];
    [encoder setCullMode:!culling ? MTLCullModeNone : cullFace == GL_FRONT ? MTLCullModeFront : MTLCullModeBack];
    [encoder setTriangleFillMode:polygonMode == GL_LINE ? MTLTriangleFillModeLines : MTLTriangleFillModeFill];
    [encoder setDepthBias:polygonOffset ? offsetUnits : 0 slopeScale:polygonOffset ? offsetFactor : 0 clamp:0];
    float mode = textureMode == GL_REPLACE ? 0 : textureMode == GL_DECAL ? 2 : textureMode == GL_ADD ? 3 : 1;
    QNMUniforms u = {projectionStack[projectionTop],modelStack[modelTop],fogColor,
        {fogDensity,alphaReference,mode,rgbScale},{texturing,alphaTest,fog,0}};
    [encoder setVertexBuffer:arena offset:arenaOffset atIndex:0];
    [encoder setVertexBytes:&u length:sizeof u atIndex:1];
    [encoder setFragmentBytes:&u length:sizeof u atIndex:1];
    QNMTexture *t = textures[@(boundTexture)];
    [encoder setFragmentTexture:t.image ?: whiteTexture atIndex:0];
    [encoder setFragmentSamplerState:sampler(t) atIndex:0];
    [encoder drawPrimitives:type vertexStart:0 vertexCount:count];
    if (profile) profileDraws++;
    arenaOffset = (arenaOffset + bytes + 255) & ~(NSUInteger)255;
}

static void flushBatch(void) {
    if (!batchCount) return;
    size_t count = batchCount; batchCount = 0;
    encodeVertices(batchType, batch, count);
}
static void drawVertices(MTLPrimitiveType type, const QNMVertex *data, size_t count) {
    if (type == MTLPrimitiveTypeTriangleStrip) {
        flushBatch(); encodeVertices(type, data, count); return;
    }
    if (batchCount && batchType != type) flushBatch();
    batchType = type;
    if (batchCount + count > batchCapacity) {
        batchCapacity = MAX(batchCount + count, MAX((size_t)4096, batchCapacity * 2));
        QNMVertex *p = realloc(batch, batchCapacity * sizeof *batch);
        if (!p) Sys_Error("Metal: batch allocation failed");
        batch = p;
    }
    memcpy(batch + batchCount, data, count * sizeof *batch);
    batchCount += count;
}

SDL_GLContext QNM_SDL_GL_CreateContext(SDL_Window *w) {
    @autoreleasepool {
        profile = getenv("QN_METAL_PROFILE") != NULL;
        device = MTLCreateSystemDefaultDevice();
        if (!device) { SDL_SetError("No Metal device available"); return NULL; }
        window = w;
        metalView = SDL_Metal_CreateView(window);
        if (!metalView) return NULL;
        layer = (__bridge CAMetalLayer *)SDL_Metal_GetLayer(metalView);
        layer.device = device; layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
        layer.framebufferOnly = YES; layer.displaySyncEnabled = swapInterval != 0;
        queue = [device newCommandQueue];
        NSError *error = nil;
        library = [device newLibraryWithSource:@(qnm_shader_source) options:nil error:&error];
        if (!library) Sys_Error("Metal shaders: %s",error.localizedDescription.UTF8String);
        MTLRenderPipelineDescriptor *d = [MTLRenderPipelineDescriptor new];
        d.vertexFunction = [library newFunctionWithName:@"screen_vertex"];
        d.fragmentFunction = [library newFunctionWithName:@"screen_fragment"];
        d.colorAttachments[0].pixelFormat = layer.pixelFormat;
        screenPipeline = [device newRenderPipelineStateWithDescriptor:d error:&error];
        copyPipeline = [device newComputePipelineStateWithFunction:[library newFunctionWithName:@"copy_frame"] error:&error];
        if (!screenPipeline || !copyPipeline) Sys_Error("Metal shaders: %s",error.localizedDescription.UTF8String);
        textures = [NSMutableDictionary new]; pipelines = [NSMutableDictionary new];
        depthStates = [NSMutableDictionary new]; samplers = [NSMutableDictionary new];
        for (unsigned i=0;i<3;i++) bufferPools[i] = [NSMutableArray new];
        modelStack[0] = projectionStack[0] = matrix_identity_float4x4;
        MTLTextureDescriptor *td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:1 height:1 mipmapped:NO];
        // Shared textures are not available on every Intel/discrete GPU.
        td.storageMode = MTLStorageModePrivate;
        whiteTexture = [device newTextureWithDescriptor:td];
        if (!whiteTexture) Sys_Error("Metal: fallback texture allocation failed");
        id<MTLBuffer> white = [device newBufferWithLength:256 options:MTLResourceStorageModeShared];
        if (!white) Sys_Error("Metal: fallback staging allocation failed");
        memset(white.contents,255,256);
        ensureCommand();
        id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
        [blit copyFromBuffer:white sourceOffset:0 sourceBytesPerRow:256 sourceBytesPerImage:256
            sourceSize:MTLSizeMake(1,1,1) toTexture:whiteTexture destinationSlice:0 destinationLevel:0
            destinationOrigin:MTLOriginMake(0,0,0)];
        [blit endEncoding];
        Con_Printf("Metal renderer: %s\n", device.name.UTF8String);
        return metalView;
    }
}
void QNM_SDL_GL_DeleteContext(SDL_GLContext context) {
    (void)context;
    flushBatch(); submit(YES);
    for (unsigned i=0;i<3;i++) { [inFlight[i] waitUntilCompleted]; inFlight[i]=nil; }
    free(batch); batch=NULL; batchCapacity=batchCount=0;
    textures = nil; pipelines = nil; depthStates = nil; samplers = nil;
    for (unsigned i=0;i<3;i++) bufferPools[i] = nil;
    arena = nil; colorTarget = nil; depthTarget = nil;
    whiteTexture = nil; screenPipeline = nil; copyPipeline = nil; library = nil;
    queue = nil; layer = nil; device = nil;
    if (metalView) SDL_Metal_DestroyView(metalView);
    metalView = NULL; window = NULL;
    free(vertices); vertices = NULL; vertexCapacity = vertexCount = 0;
    free(triangles); triangles = NULL; triangleCapacity = 0;
}
void *QNM_SDL_GL_GetProcAddress(const char *name) { (void)name; return NULL; }
int QNM_SDL_GL_SetAttribute(SDL_GLattr attr, int value) { (void)attr; (void)value; return 0; }
int QNM_SDL_GL_GetAttribute(SDL_GLattr attr, int *value) {
    *value = attr == SDL_GL_DEPTH_SIZE ? 32 : attr == SDL_GL_STENCIL_SIZE ? 8 : 0;
    return 0;
}
int QNM_SDL_GL_SetSwapInterval(int interval) {
    swapInterval = interval != 0; layer.displaySyncEnabled = swapInterval; return 0;
}
int QNM_SDL_GL_GetSwapInterval(void) { return swapInterval; }

int QNM_Headless(void) {
    const char *value = getenv("QN_METAL_HEADLESS");
    return value && !strcmp(value,"1");
}
void QNM_BeginFrame(void) {
    if (!framePool) framePool = QNM_PushPool();
    double start = profile ? CACurrentMediaTime() : 0;
    [inFlight[flightIndex] waitUntilCompleted];
    if (profile) {
        queueTime += CACurrentMediaTime() - start;
        gpuTime += inFlight[flightIndex].GPUEndTime - inFlight[flightIndex].GPUStartTime;
        frameStart = CACurrentMediaTime();
    }
    if (inFlight[flightIndex].status == MTLCommandBufferStatusError)
        Sys_Error("Metal command failed: %s",inFlight[flightIndex].error.localizedDescription.UTF8String);
    inFlight[flightIndex] = nil;
    @autoreleasepool {
        int w, h;
        SDL_GetWindowSize(window,&w,&h);
        if (w < 1 || h < 1) return;
        if (!colorTarget || w != frameWidth || h != frameHeight) {
            submit(YES);
            frameWidth = w; frameHeight = h;
            layer.drawableSize = CGSizeMake(w,h);
            colorTarget = newTarget(MTLPixelFormatBGRA8Unorm,w,h,NO);
            depthTarget = newTarget(MTLPixelFormatDepth32Float_Stencil8,w,h,NO);
        }
        ensureEncoder(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
    }
}
void QNM_EndFrame(int present, float gamma, float contrast) {
    flushBatch();
    if (profile) cpuTime += CACurrentMediaTime() - frameStart;
    @autoreleasepool {
        endEncoder();
        if (present && !QNM_Headless() && colorTarget) {
            double start = profile ? CACurrentMediaTime() : 0;
            id<CAMetalDrawable> drawable = [layer nextDrawable];
            if (profile) drawableTime += CACurrentMediaTime() - start;
            if (drawable) {
                ensureCommand();
                MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
                pass.colorAttachments[0].texture = drawable.texture;
                pass.colorAttachments[0].loadAction = MTLLoadActionDontCare;
                pass.colorAttachments[0].storeAction = MTLStoreActionStore;
                id<MTLRenderCommandEncoder> e = [command renderCommandEncoderWithDescriptor:pass];
                [e setRenderPipelineState:screenPipeline];
                [e setFragmentTexture:colorTarget atIndex:0];
                vector_float2 correction = {gamma, contrast};
                [e setFragmentBytes:&correction length:sizeof correction atIndex:0];
                [e drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
                [e endEncoding];
                [command presentDrawable:drawable];
            }
        }
        // Reuse this slot's buffers only after BeginFrame waits for its GPU
        // work. This avoids allocating megabytes of vertex buffers each frame.
        inFlight[flightIndex] = command;
        submit(NO);
        flightIndex = (flightIndex + 1) % 3;
        arena = nil; arenaOffset = bufferIndex = 0;
    }
    QNM_PopPool(framePool); framePool = NULL;
    if (profile && ++profileFrames == 120) {
        Con_Printf("Metal profile: CPU %.2f ms, drawable %.2f ms, queue %.2f ms, GPU %.2f ms, %u draws/frame\n",
            cpuTime*1000/120, drawableTime*1000/120, queueTime*1000/120, gpuTime*1000/120, profileDraws/120);
        profileFrames=profileDraws=0; cpuTime=drawableTime=queueTime=gpuTime=0;
    }
}

void QNM_glBegin(GLenum mode) { primitive = mode; vertexCount = 0; }
void QNM_glVertex3f(GLfloat x, GLfloat y, GLfloat z) {
    if (vertexCount == vertexCapacity) {
        vertexCapacity = MAX((size_t)1024,vertexCapacity * 2);
        QNMVertex *p = realloc(vertices,vertexCapacity * sizeof *vertices);
        if (!p) Sys_Error("Metal: CPU vertex allocation failed");
        vertices = p;
    }
    current.position = (vector_float4){x,y,z,1}; vertices[vertexCount++] = current;
}
void QNM_glVertex2f(GLfloat x, GLfloat y) { QNM_glVertex3f(x,y,0); }
void QNM_glVertex3fv(const GLfloat *v) { QNM_glVertex3f(v[0],v[1],v[2]); }
void QNM_glColor4f(GLfloat r, GLfloat g, GLfloat b, GLfloat a) { current.color = simd_clamp((vector_float4){r,g,b,a},0,1); }
void QNM_glColor3f(GLfloat r, GLfloat g, GLfloat b) { QNM_glColor4f(r,g,b,1); }
void QNM_glColor3fv(const GLfloat *v) { QNM_glColor3f(v[0],v[1],v[2]); }
void QNM_glColor4fv(const GLfloat *v) { QNM_glColor4f(v[0],v[1],v[2],v[3]); }
void QNM_glColor4ubv(const GLubyte *v) { QNM_glColor4f(v[0]/255.f,v[1]/255.f,v[2]/255.f,v[3]/255.f); }
void QNM_glTexCoord2f(GLfloat s, GLfloat t) { current.uv = (vector_float2){s,t}; }
static void triangle(QNMVertex *out, size_t a, size_t b, size_t c, size_t provoking) {
    out[0]=vertices[a]; out[1]=vertices[b]; out[2]=vertices[c];
    if (!smoothShading) out[0].color=out[1].color=out[2].color=vertices[provoking].color;
}
void QNM_glEnd(void) {
    if (!vertexCount) return;
    if (primitive == GL_LINES || primitive == GL_POINTS) {
        drawVertices(primitive == GL_LINES ? MTLPrimitiveTypeLine : MTLPrimitiveTypePoint,vertices,vertexCount);
        return;
    }
    size_t count;
    switch (primitive) {
        case GL_TRIANGLES: count=vertexCount/3*3; break;
        case GL_QUADS: count=vertexCount/4*6; break;
        case GL_QUAD_STRIP: count=vertexCount>=4 ? (vertexCount/2-1)*6 : 0; break;
        case GL_TRIANGLE_STRIP: case GL_POLYGON: case GL_TRIANGLE_FAN:
            count=vertexCount>=3 ? (vertexCount-2)*3 : 0; break;
        default: unsupported("primitive",primitive); return;
    }
    if (!count) return;
    if (count > triangleCapacity) {
        triangleCapacity = MAX(count, MAX((size_t)1024, triangleCapacity * 2));
        QNMVertex *p = realloc(triangles, triangleCapacity * sizeof *triangles);
        if (!p) Sys_Error("Metal: triangle allocation failed");
        triangles = p;
    }
    QNMVertex *tri = triangles;
    size_t k=0;
    if (primitive==GL_TRIANGLES) {
        for (size_t i=0;i+2<vertexCount;i+=3) { triangle(tri+k,i,i+1,i+2,i+2); k+=3; }
    } else if (primitive==GL_QUADS) {
        for (size_t i=0;i+3<vertexCount;i+=4) {
            triangle(tri+k,i,i+1,i+2,i+3); triangle(tri+k+3,i,i+2,i+3,i+3); k+=6;
        }
    } else if (primitive==GL_QUAD_STRIP) {
        for (size_t i=0;i+3<vertexCount;i+=2) {
            triangle(tri+k,i,i+1,i+3,i+3); triangle(tri+k+3,i,i+3,i+2,i+3); k+=6;
        }
    } else if (primitive==GL_TRIANGLE_STRIP) {
        for (size_t i=0;i+2<vertexCount;i++) {
            triangle(tri+k,i+(i&1),i+1-(i&1),i+2,i+2); k+=3;
        }
    } else for (size_t i=1;i+1<vertexCount;i++) {
        triangle(tri+k,0,i,i+1,primitive==GL_POLYGON?vertexCount-1:i+1); k+=3;
    }
    drawVertices(MTLPrimitiveTypeTriangle,tri,count);
}

static matrix_float4x4 *matrix(void) { return matrixMode == GL_MODELVIEW ? &modelStack[modelTop] : &projectionStack[projectionTop]; }
void QNM_glMatrixMode(GLenum mode) { flushBatch();
    if (mode != GL_MODELVIEW && mode != GL_PROJECTION) unsupported("matrix mode", mode);
    matrixMode = mode;
}
void QNM_glLoadIdentity(void) { flushBatch(); *matrix() = matrix_identity_float4x4; }
void QNM_glMultMatrixf(const GLfloat *m) { flushBatch(); matrix_float4x4 n; memcpy(&n,m,sizeof n); *matrix() = simd_mul(*matrix(),n); }
void QNM_glPushMatrix(void) {
    unsigned *top = matrixMode == GL_MODELVIEW ? &modelTop : &projectionTop;
    matrix_float4x4 *stack = matrixMode == GL_MODELVIEW ? modelStack : projectionStack;
    if (*top >= 31) Sys_Error("Metal: matrix stack overflow");
    stack[*top+1] = stack[*top]; ++*top;
}
void QNM_glPopMatrix(void) { flushBatch();
    unsigned *top = matrixMode == GL_MODELVIEW ? &modelTop : &projectionTop;
    if (!*top) Sys_Error("Metal: matrix stack underflow");
    --*top;
}
void QNM_glTranslatef(GLfloat x, GLfloat y, GLfloat z) { flushBatch();
    matrix_float4x4 m = matrix_identity_float4x4; m.columns[3] = (vector_float4){x,y,z,1};
    *matrix() = simd_mul(*matrix(),m);
}
void QNM_glScalef(GLfloat x, GLfloat y, GLfloat z) { flushBatch();
    matrix_float4x4 m = matrix_identity_float4x4;
    m.columns[0].x=x; m.columns[1].y=y; m.columns[2].z=z; *matrix()=simd_mul(*matrix(),m);
}
void QNM_glRotatef(GLfloat angle, GLfloat x, GLfloat y, GLfloat z) { flushBatch();
    vector_float3 axis = {x,y,z};
    if (simd_length_squared(axis) == 0) return;
    simd_quatf q = simd_quaternion(angle * (float)M_PI/180,simd_normalize(axis));
    *matrix() = simd_mul(*matrix(),simd_matrix4x4(q));
}
void QNM_glOrtho(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f) { flushBatch();
    matrix_float4x4 m = { .columns = {{2/(r-l),0,0,0},{0,2/(t-b),0,0},{0,0,-2/(f-n),0},{-(r+l)/(r-l),-(t+b)/(t-b),-(f+n)/(f-n),1}} };
    *matrix() = simd_mul(*matrix(),m);
}
void QNM_glFrustum(GLdouble l, GLdouble r, GLdouble b, GLdouble t, GLdouble n, GLdouble f) { flushBatch();
    matrix_float4x4 m = { .columns = {{2*n/(r-l),0,0,0},{0,2*n/(t-b),0,0},{(r+l)/(r-l),(t+b)/(t-b),-(f+n)/(f-n),-1},{0,0,-2*f*n/(f-n),0}} };
    *matrix() = simd_mul(*matrix(),m);
}
static void capability(GLenum cap, BOOL enabled) {
    flushBatch();
    switch (cap) {
        case GL_TEXTURE_2D: texturing=enabled; break;
        case GL_BLEND: blending=enabled; break;
        case GL_DEPTH_TEST: depthTest=enabled; break;
        case GL_ALPHA_TEST: alphaTest=enabled; break;
        case GL_FOG: fog=enabled; break;
        case GL_CULL_FACE: culling=enabled; break;
        case GL_SCISSOR_TEST: scissor=enabled; break;
        case GL_STENCIL_TEST: stencil=enabled; break;
        case GL_POLYGON_OFFSET_FILL: case GL_POLYGON_OFFSET_LINE: polygonOffset=enabled; break;
        default: unsupported("capability",cap);
    }
}
void QNM_glEnable(GLenum cap) { capability(cap,YES); }
void QNM_glDisable(GLenum cap) { capability(cap,NO); }
void QNM_glBlendFunc(GLenum s, GLenum d) { flushBatch(); blendSource=s; blendDest=d; }
void QNM_glAlphaFunc(GLenum func, GLclampf ref) { flushBatch(); if (func!=GL_GREATER) unsupported("alpha test",func); alphaReference=ref; }
void QNM_glDepthFunc(GLenum f) { flushBatch(); depthFunction=f; }
void QNM_glDepthMask(GLboolean value) { flushBatch(); depthWrite=value; }
void QNM_glDepthRange(GLclampd n, GLclampd f) { flushBatch(); depthNear=n; depthFar=f; }
void QNM_glCullFace(GLenum mode) { flushBatch(); cullFace=mode; }
void QNM_glFrontFace(GLenum mode) { flushBatch(); frontFace=mode; }
void QNM_glColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a) { flushBatch();
    colorMask=(r?MTLColorWriteMaskRed:0)|(g?MTLColorWriteMaskGreen:0)|(b?MTLColorWriteMaskBlue:0)|(a?MTLColorWriteMaskAlpha:0);
}
void QNM_glPolygonMode(GLenum face, GLenum mode) { flushBatch(); (void)face; polygonMode=mode; }
void QNM_glPolygonOffset(GLfloat factor, GLfloat units) { flushBatch(); offsetFactor=factor; offsetUnits=units; }
void QNM_glStencilFunc(GLenum f, GLint ref, GLuint mask) { flushBatch(); stencilFunction=f; stencilRef=ref; stencilMask=mask; }
void QNM_glStencilOp(GLenum fail, GLenum zfail, GLenum pass) { flushBatch(); stencilFail=fail; stencilDepthFail=zfail; stencilPass=pass; }
void QNM_glViewport(GLint x, GLint y, GLsizei w, GLsizei h) { flushBatch(); viewX=x; viewY=y; viewW=w; viewH=h; }
void QNM_glScissor(GLint x, GLint y, GLsizei w, GLsizei h) { flushBatch(); scissorX=x; scissorY=y; scissorW=w; scissorH=h; }
void QNM_glClearColor(GLclampf r, GLclampf g, GLclampf b, GLclampf a) { clearColor=(vector_float4){r,g,b,a}; }
void QNM_glClear(GLbitfield mask) { flushBatch(); ensureEncoder(mask); }
void QNM_glFinish(void) { flushBatch(); submit(YES); }
void QNM_glFogf(GLenum p, GLfloat value) { flushBatch();
    if (p==GL_FOG_DENSITY) fogDensity=value;
    else if (p==GL_FOG_MODE && value!=GL_EXP2) unsupported("fog mode",(GLenum)value);
    else if (p!=GL_FOG_MODE && p!=GL_FOG_START && p!=GL_FOG_END) unsupported("fog parameter",p);
}
void QNM_glFogi(GLenum p, GLint value) { QNM_glFogf(p,(GLfloat)value); }
void QNM_glFogfv(GLenum p, const GLfloat *value) { flushBatch();
    if (p==GL_FOG_COLOR) memcpy(&fogColor,value,sizeof fogColor); else QNM_glFogf(p,*value);
}
void QNM_glHint(GLenum target, GLenum mode) { (void)target; (void)mode; }
void QNM_glShadeModel(GLenum mode) { flushBatch(); if (mode!=GL_SMOOTH && mode!=GL_FLAT) unsupported("shade mode",mode); smoothShading=mode==GL_SMOOTH; }
void QNM_glDrawElements(GLenum mode, GLsizei count, GLenum type, const GLvoid *indices) {
    (void)mode; (void)count; (void)type; (void)indices;
    Sys_Error("Metal: VBO draw used despite disabled VBO capability");
}

static QNMTexture *bound(void) {
    QNMTexture *t = textures[@(boundTexture)];
    if (!t) { t = [QNMTexture new]; textures[@(boundTexture)] = t; }
    return t;
}
void QNM_glGenTextures(GLsizei count, GLuint *names) {
    for (int i=0;i<count;i++) { names[i]=nextTexture++; textures[@(names[i])]=[QNMTexture new]; }
}
void QNM_glDeleteTextures(GLsizei count, const GLuint *names) { flushBatch();
    for (int i=0;i<count;i++) [textures removeObjectForKey:@(names[i])];
}
void QNM_glBindTexture(GLenum target, GLuint name) { flushBatch();
    if (target!=GL_TEXTURE_2D) unsupported("texture target",target);
    boundTexture=name;
}
static void upload(QNMTexture *t, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                   GLenum format, GLenum type, const void *data) {
    if (!data || w==0 || h==0) return;
    if (format!=GL_RGBA && format!=GL_RGB && format!=GL_BGRA) unsupported("texture format",format);
    if (type!=GL_UNSIGNED_BYTE) unsupported("texture element type",type);
    if (level<0 || (NSUInteger)level>=t.image.mipmapLevelCount)
        Sys_Error("Metal: invalid upload mip");
    NSUInteger tw=MAX((NSUInteger)1,t.image.width >> level), th=MAX((NSUInteger)1,t.image.height >> level);
    if (x<0 || y<0 ||
        w<0 || h<0 || x+w>tw || y+h>th) Sys_Error("Metal: texture upload out of bounds");
    size_t channels=format==GL_RGB?3:4;
    size_t srcrow=((size_t)(unpackRowLength?unpackRowLength:w)*channels+unpackAlignment-1)&~(size_t)(unpackAlignment-1);
    size_t row=((size_t)w*4+255)&~(size_t)255;
    id<MTLBuffer> staging=[device newBufferWithLength:row*(size_t)h options:MTLResourceStorageModeShared];
    if (!staging) Sys_Error("Metal: texture staging allocation failed");
    for (int j=0;j<h;j++) {
        const unsigned char *src=(const unsigned char *)data+(size_t)j*srcrow;
        unsigned char *dst=(unsigned char *)staging.contents+(size_t)j*row;
        for (int i=0;i<w;i++) {
            dst[i*4]=src[i*channels+(format==GL_BGRA?2:0)];
            dst[i*4+1]=src[i*channels+1];
            dst[i*4+2]=src[i*channels+(format==GL_BGRA?0:2)];
            dst[i*4+3]=channels==4?src[i*channels+3]:255;
        }
    }
    endEncoder(); ensureCommand();
    id<MTLBlitCommandEncoder> b=[command blitCommandEncoder];
    [b copyFromBuffer:staging sourceOffset:0 sourceBytesPerRow:row sourceBytesPerImage:row*(size_t)h
        sourceSize:MTLSizeMake(w,h,1) toTexture:t.image destinationSlice:0 destinationLevel:level
        destinationOrigin:MTLOriginMake(x,y,0)];
    [b endEncoding];
}
void QNM_glTexImage2D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h,
                      GLint border, GLenum format, GLenum type, const GLvoid *data) { flushBatch();
    (void)internal;
    if (target!=GL_TEXTURE_2D || border || w<1 || h<1 || w>16384 || h>16384 || level<0)
        Sys_Error("Metal: invalid texture allocation");
    QNMTexture *t=bound();
    if (level==0) t.image=newTarget(MTLPixelFormatRGBA8Unorm,w,h,YES);
    if (!t.image) Sys_Error("Metal: texture mip without base level");
    upload(t,level,0,0,w,h,format,type,data);
}
void QNM_glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                         GLenum format, GLenum type, const GLvoid *data) { flushBatch();
    if (target!=GL_TEXTURE_2D) unsupported("texture target",target);
    upload(bound(),level,x,y,w,h,format,type,data);
}
void QNM_glTexParameterf(GLenum target, GLenum pname, GLfloat value) { flushBatch();
    if (target!=GL_TEXTURE_2D) unsupported("texture target",target);
    QNMTexture *t=bound();
    switch (pname) {
        case GL_TEXTURE_MIN_FILTER: t.minFilter=(GLenum)value; break;
        case GL_TEXTURE_MAG_FILTER: t.magFilter=(GLenum)value; break;
        case GL_TEXTURE_WRAP_S: t.wrapS=(GLenum)value; break;
        case GL_TEXTURE_WRAP_T: t.wrapT=(GLenum)value; break;
        case GL_TEXTURE_MAX_ANISOTROPY_EXT: t.anisotropy=MAX(1,MIN(16,value)); break;
        default: unsupported("texture parameter",pname);
    }
}
void QNM_glTexParameteri(GLenum target, GLenum pname, GLint value) { QNM_glTexParameterf(target,pname,(GLfloat)value); }
void QNM_glGetTexParameterfv(GLenum target, GLenum pname, GLfloat *value) {
    (void)target;
    if (pname!=GL_TEXTURE_MAX_ANISOTROPY_EXT) unsupported("texture parameter query",pname);
    *value=bound().anisotropy;
}
void QNM_glTexEnvf(GLenum target, GLenum pname, GLfloat value) { flushBatch();
    if (target!=GL_TEXTURE_ENV || pname!=GL_TEXTURE_ENV_MODE) unsupported("texture environment",pname);
    GLenum mode=(GLenum)value;
    if (mode!=GL_REPLACE && mode!=GL_MODULATE && mode!=GL_DECAL && mode!=GL_ADD) unsupported("texture mode",mode);
    textureMode=mode;
}
void QNM_glTexEnvi(GLenum target, GLenum pname, GLint value) { QNM_glTexEnvf(target,pname,(GLfloat)value); }
void QNM_glPixelStorei(GLenum pname, GLint value) {
    if (pname==GL_PACK_ALIGNMENT || pname==GL_UNPACK_ALIGNMENT) {
        if (value!=1 && value!=2 && value!=4 && value!=8) unsupported("pixel alignment",value);
        if (pname==GL_PACK_ALIGNMENT) packAlignment=value; else unpackAlignment=value;
    } else if (pname==GL_UNPACK_ROW_LENGTH && value>=0) unpackRowLength=value;
    else unsupported("pixel store",pname);
}
void QNM_glCopyTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff, GLint x, GLint y, GLsizei w, GLsizei h) { flushBatch();
    QNMTexture *t=bound();
    if (target!=GL_TEXTURE_2D || level || x<0 || y<0 || xoff<0 || yoff<0 || w<0 || h<0 ||
        x+w>frameWidth || y+h>frameHeight || xoff+w>t.image.width || yoff+h>t.image.height)
        Sys_Error("Metal: framebuffer copy out of bounds");
    endEncoder(); ensureCommand();
    id<MTLComputeCommandEncoder> e=[command computeCommandEncoder];
    [e setComputePipelineState:copyPipeline];
    [e setTexture:colorTarget atIndex:0]; [e setTexture:t.image atIndex:1];
    vector_uint4 rects[2]={{x,y,w,h},{xoff,yoff,0,0}};
    [e setBytes:rects length:sizeof rects atIndex:0];
    [e dispatchThreads:MTLSizeMake(w,h,1) threadsPerThreadgroup:MTLSizeMake(8,8,1)];
    [e endEncoding];
}
static void readTexture(id<MTLTexture> t, int level, int x, int y, int w, int h,
                        GLenum format, GLenum type, void *pixels, BOOL flip) {
    if (!t || type!=GL_UNSIGNED_BYTE || (format!=GL_RGB && format!=GL_RGBA))
        Sys_Error("Metal: unsupported readback format");
    size_t row=((size_t)w*4+255)&~(size_t)255;
    id<MTLBuffer> buffer=[device newBufferWithLength:row*(size_t)h options:MTLResourceStorageModeShared];
    if (!buffer) Sys_Error("Metal: readback allocation failed");
    endEncoder(); ensureCommand();
    id<MTLBlitCommandEncoder> b=[command blitCommandEncoder];
    [b copyFromTexture:t sourceSlice:0 sourceLevel:level sourceOrigin:MTLOriginMake(x,y,0)
        sourceSize:MTLSizeMake(w,h,1) toBuffer:buffer destinationOffset:0 destinationBytesPerRow:row destinationBytesPerImage:row*(size_t)h];
    [b endEncoding]; submit(YES);
    int channels=format==GL_RGB?3:4;
    size_t dstrow=((size_t)w*channels+packAlignment-1)&~(size_t)(packAlignment-1);
    BOOL bgra=t.pixelFormat==MTLPixelFormatBGRA8Unorm;
    for (int j=0;j<h;j++) {
        const unsigned char *src=(const unsigned char *)buffer.contents+(size_t)(flip?h-1-j:j)*row;
        unsigned char *dst=(unsigned char *)pixels+(size_t)j*dstrow;
        for (int i=0;i<w;i++) {
            dst[i*channels]=src[i*4+(bgra?2:0)]; dst[i*channels+1]=src[i*4+1];
            dst[i*channels+2]=src[i*4+(bgra?0:2)];
            if (channels==4) dst[i*4+3]=src[i*4+3];
        }
    }
}
void QNM_glReadPixels(GLint x, GLint y, GLsizei w, GLsizei h, GLenum format, GLenum type, GLvoid *data) { flushBatch();
    if (x<0 || y<0 || w<0 || h<0 || x+w>frameWidth || y+h>frameHeight) Sys_Error("Metal: readback out of bounds");
    readTexture(colorTarget,0,x,frameHeight-y-h,w,h,format,type,data,YES);
}
void QNM_glGetTexImage(GLenum target, GLint level, GLenum format, GLenum type, GLvoid *data) { flushBatch();
    if (target!=GL_TEXTURE_2D) unsupported("texture target",target);
    id<MTLTexture> t=bound().image;
    if (level<0 || (NSUInteger)level>=t.mipmapLevelCount) Sys_Error("Metal: invalid readback mip");
    readTexture(t,level,0,0,MAX(1,t.width>>level),MAX(1,t.height>>level),format,type,data,NO);
}
const GLubyte *QNM_glGetString(GLenum name) {
    switch (name) {
        case GL_VENDOR: return (const GLubyte *)"Apple Metal";
        case GL_RENDERER: return (const GLubyte *)device.name.UTF8String;
        case GL_VERSION: return (const GLubyte *)"1.1 (native Metal fixed-function backend)";
        case GL_EXTENSIONS: return (const GLubyte *)"GL_ARB_texture_non_power_of_two GL_EXT_texture_filter_anisotropic";
        default: unsupported("string query",name); return NULL;
    }
}
void QNM_glGetIntegerv(GLenum name, GLint *value) {
    if (name==GL_MAX_TEXTURE_SIZE) *value=16384;
    else if (name==GL_MAX_TEXTURE_UNITS) *value=1;
    else if (name==GL_VIEWPORT) { value[0]=viewX; value[1]=viewY; value[2]=viewW; value[3]=viewH; }
    else unsupported("integer query",name);
}
void QNM_glGetFloatv(GLenum name, GLfloat *value) {
    if (name==GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT) *value=16;
    else if (name==GL_MODELVIEW_MATRIX) memcpy(value,&modelStack[modelTop],sizeof(matrix_float4x4));
    else if (name==GL_PROJECTION_MATRIX) memcpy(value,&projectionStack[projectionTop],sizeof(matrix_float4x4));
    else unsupported("float query",name);
}
