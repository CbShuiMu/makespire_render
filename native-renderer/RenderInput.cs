using System;
using System.Collections.Generic;
using System.Text.Json;
using Godot;

// The public Node API validates requests and normalizes all image formats to PNG.
internal static class RenderInput
{
    public static JsonElement At(this JsonElement value, string key) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var result) ? result : default;
    public static string Text(this JsonElement value, string key, string fallback = "") =>
        value.At(key).ValueKind == JsonValueKind.String ? value.At(key).GetString()! : fallback;
    public static float Number(this JsonElement value, string key, float fallback = 0) =>
        value.At(key).ValueKind == JsonValueKind.Number ? value.At(key).GetSingle() : fallback;
    public static bool Flag(this JsonElement value, string key) => value.At(key).ValueKind == JsonValueKind.True;
    public static bool Present(this JsonElement value) => value.ValueKind == JsonValueKind.Object;
    public static T Load<T>(string path) where T : Resource => ResourceLoader.Load<T>(path)
        ?? throw new InvalidOperationException("Missing game resource: " + path);
    public static ShaderMaterial Hsv(JsonElement hsv, Material fallback)
    {
        // Shared game materials must never be mutated across jobs.
        var material = (ShaderMaterial)fallback.Duplicate();
        if (hsv.Present())
            foreach (string channel in new[] { "h", "s", "v" })
                material.SetShaderParameter(channel, hsv.Number(channel, 1));
        return material;
    }
}

internal sealed class JobResources : IDisposable
{
    private readonly List<Resource> owned = new();
    public T Own<T>(T value) where T : Resource { owned.Add(value); return value; }
    public Texture2D? Image(JsonElement asset)
    {
        string url = asset.Text("dataUrl");
        if (url.Length == 0) return null;
        using var image = new Image();
        var bytes = Convert.FromBase64String(url[(url.IndexOf(',') + 1)..]);
        if (image.LoadPngFromBuffer(bytes) != Error.Ok) throw new ArgumentException("Invalid PNG image.");
        return Own(ImageTexture.CreateFromImage(image));
    }
    public void Dispose() { foreach (var item in owned) item.Dispose(); }
}
