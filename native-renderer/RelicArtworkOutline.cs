using Godot;

internal static class RelicArtworkOutline
{
    // Original big relic icons have a firm black contour baked into their art.
    // Add a similar contour to uploaded alpha silhouettes in icon-local pixels.
    internal const float Width = 4;
    private static Shader? shader;

    public static void Apply(TextureRect icon, JobResources resources)
    {
        if (icon.Texture == null) return;
        shader ??= new Shader { Code = """
            shader_type canvas_item;
            render_mode unshaded;
            uniform vec2 content_size;
            uniform vec2 content_center;
            uniform float outline_width;
            varying vec4 source_modulate;

            vec4 sample_image(sampler2D image, vec2 uv) {
                if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
                    return vec4(0.0);
                }
                return texture(image, uv);
            }

            void vertex() {
                source_modulate = COLOR;
                // Expand only the draw quad, not the Control or its contain box.
                // This also outlines images whose alpha reaches a texture edge.
                VERTEX += sign(VERTEX - content_center) * outline_width;
            }

            void fragment() {
                vec2 uv = (UV - vec2(0.5)) *
                    (content_size + vec2(2.0 * outline_width)) / content_size + vec2(0.5);
                vec4 image = sample_image(TEXTURE, uv);
                float coverage = image.a;
                // Circular dilation produces a solid contour without a drop shadow.
                for (int i = 0; i < 24; i++) {
                    float angle = float(i) * TAU / 24.0;
                    vec2 offset = vec2(cos(angle), sin(angle)) * outline_width / content_size;
                    coverage = max(coverage, sample_image(TEXTURE, uv + offset).a);
                }
                COLOR = vec4(image.rgb * image.a / max(coverage, 0.00001), coverage) * source_modulate;
            }
            """ };
        var textureSize = icon.Texture.GetSize();
        float fit = Mathf.Min(icon.Size.X / textureSize.X, icon.Size.Y / textureSize.Y);
        var material = resources.Own(new ShaderMaterial { Shader = shader });
        material.SetShaderParameter("content_size", textureSize * fit);
        material.SetShaderParameter("content_center", icon.Size / 2);
        material.SetShaderParameter("outline_width", Width);
        icon.Material = material;
    }
}
