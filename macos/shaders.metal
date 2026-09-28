// P2PQuake native Metal shaders. GPL-2.0-or-later.
#include <metal_stdlib>
using namespace metal;
struct Vertex { float4 position; float4 color; float2 uv; float2 pad; };
struct Uniforms {
    float4x4 projection;
    float4x4 modelview;
    float4 fogColor;
    float4 params; // fog density, alpha reference, texture mode, RGB scale
    uint4 flags;  // texture, alpha test, fog, reserved
};
struct Raster {
    float4 position [[position]];
    float4 color;
    float2 uv;
    float fogDistance;
};
vertex Raster quake_vertex(uint id [[vertex_id]],
                          const device Vertex *vertices [[buffer(0)]],
                          constant Uniforms &u [[buffer(1)]]) {
    Vertex v = vertices[id];
    float4 eye = u.modelview * v.position;
    Raster o;
    o.position = u.projection * eye;
    // Quake projection uses OpenGL's [-w,w] depth; Metal uses [0,w].
    o.position.z = (o.position.z + o.position.w) * 0.5;
    o.color = v.color;
    o.uv = v.uv;
    o.fogDistance = abs(eye.z);
    return o;
}
fragment float4 quake_fragment(Raster v [[stage_in]], constant Uniforms &u [[buffer(1)]],
                               texture2d<float> tex [[texture(0)]], sampler smp [[sampler(0)]]) {
    float4 color = v.color;
    if (u.flags.x) {
        float4 t = tex.sample(smp, v.uv);
        switch (uint(u.params.z)) {
            case 0: color = t; break; // REPLACE
            case 1: color *= t; break; // MODULATE
            case 2: color.rgb = mix(color.rgb, t.rgb, t.a); break; // DECAL
            case 3: color = float4(color.rgb + t.rgb, color.a * t.a); break; // ADD
        }
        color.rgb *= u.params.w;
    }
    if (u.flags.y && color.a <= u.params.y) discard_fragment();
    if (u.flags.z) {
        float d = u.params.x * v.fogDistance;
        color.rgb = mix(u.fogColor.rgb, color.rgb, exp(-d * d));
    }
    return color;
}
struct Screen { float4 position [[position]]; float2 uv; };
vertex Screen screen_vertex(uint id [[vertex_id]]) {
    float2 p = float2((id << 1) & 2, id & 2);
    return {float4(p * float2(2, -2) + float2(-1, 1), 0, 1), p};
}
fragment float4 screen_fragment(Screen v [[stage_in]], texture2d<float> tex [[texture(0)]],
                                constant float2 &gamma [[buffer(0)]]) {
    constexpr sampler s(coord::normalized, address::clamp_to_edge, filter::nearest);
    float3 color = tex.sample(s, v.uv).rgb;
    // Match QuakeSpasm's GLSL gamma pass, including the contrast range.
    color *= clamp(gamma.y, 1.0f, 2.0f);
    return float4(pow(max(color, float3(0)), float3(gamma.x)), 1);
}
// Copy framebuffer rectangles into Quake's bottom-origin texture space.
// Also used by the water warp and reduced-resolution view paths.
kernel void copy_frame(texture2d<float, access::read> src [[texture(0)]],
                       texture2d<float, access::write> dst [[texture(1)]],
                       constant uint4 *r [[buffer(0)]], uint2 p [[thread_position_in_grid]]) {
    if (any(p >= r[0].zw)) return;
    uint2 from = uint2(r[0].x + p.x, src.get_height() - 1 - r[0].y - p.y);
    dst.write(src.read(from), r[1].xy + p);
}
