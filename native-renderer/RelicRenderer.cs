using System;
using System.Reflection;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.addons.mega_text;
using MegaCrit.Sts2.Core.Entities.Relics;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Nodes.Screens.InspectScreens;

internal static class RelicRenderer
{
    private static readonly MethodInfo SetRarity = typeof(NInspectRelicScreen).GetMethod("SetRarityVisuals",
        BindingFlags.Instance | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Unsupported relic scene version.");

    public static NInspectRelicScreen Create(SubViewport viewport, JsonElement data, JobResources resources)
    {
        var screen = NInspectRelicScreen.Create()!;
        viewport.AddChild(screen);
        screen.SetProcessInput(false);
        foreach (string node in new[] { "Backstop", "LeftArrow", "RightArrow" }) screen.GetNode<Control>(node).Hide();
        var popup = screen.GetNode<Control>("Popup");
        popup.SetAnchorsPreset(Control.LayoutPreset.TopLeft);
        popup.Size = new Vector2(864, 864);
        var bg = popup.GetNode<TextureRect>("Bg").Texture;
        float scale = 920f / (864f * bg.GetWidth() / bg.GetHeight());
        popup.Scale = Vector2.One * scale;
        popup.Position = new Vector2(520 - 432 * scale, 28);
        string rarityName = data.Text("rarity", "Common");
        // Legacy editor uses Curse for the shop palette. Other card-only values
        // have always been accepted by the API and use the common relic palette.
        RelicRarity rarity = rarityName == "Curse" ? RelicRarity.Shop :
            Enum.TryParse<RelicRarity>(rarityName, out var parsed) ? parsed : RelicRarity.Common;
        SetRarity.Invoke(screen, new object[] { rarity });
        var frame = screen.GetNode<TextureRect>("%Frame");
        frame.Material = resources.Own(RenderInput.Hsv(data.At("style").At("rarityHsv"), frame.Material));
        screen.GetNode<MegaLabel>("%RelicName").SetTextAutoSize(data.Text("name"));
        screen.GetNode<MegaLabel>("%Rarity").SetTextAutoSize(data.Text("typeText",
            new LocString("gameplay_ui", "RELIC_RARITY." + rarity.ToString().ToUpperInvariant()).GetFormattedText()));
        RenderText.Set(screen.GetNode<MegaRichTextLabel>("%RelicDescription"), data.Text("description"), 28);
        // The original scene supplies cream text and the locale-specific font.
        // [red] and other explicit tags still override that default locally.
        RenderText.Set(screen.GetNode<MegaRichTextLabel>("%FlavorText"), data.Text("flavor"), 22);
        var asset = data.At("style").At("thumbnail");
        var icon = screen.GetNode<TextureRect>("%RelicImage");
        icon.Texture = resources.Image(asset);
        icon.StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered;
        icon.PivotOffset = icon.Size / 2;
        icon.Scale = Vector2.One * asset.Number("scale", .8f) / .8f;
        // Pan values use the editor's unscaled 340px mask coordinates.
        icon.Position += new Vector2(asset.Number("offsetX"), asset.Number("offsetY")) * (2 * .56f / scale);
        if (icon.Texture != null && asset.At("contentCenter").Present())
        {
            var center = asset.At("contentCenter");
            var textureSize = icon.Texture.GetSize();
            float fit = Math.Min(icon.Size.X / textureSize.X, icon.Size.Y / textureSize.Y);
            icon.Position += (new Vector2(.5f, .5f) - new Vector2(center.Number("x", .5f), center.Number("y", .5f)))
                * textureSize * fit * icon.Scale;
        }
        // Match the editor's fixed 340px window at .56 scale (PNG is 2x).
        // Clip a stationary parent so zoom, pan and transparent-padding centering
        // transform only the artwork, never the window or the frame.
        var clipSize = Vector2.One * (340 * .56f * 2 / scale);
        var clip = new Control {
            Position = frame.Size / 2 - clipSize / 2,
            Size = clipSize,
            ClipContents = true,
            MouseFilter = Control.MouseFilterEnum.Ignore,
        };
        icon.GetParent().AddChild(clip);
        clip.GetParent().MoveChild(clip, icon.GetIndex());
        var iconPosition = icon.Position;
        var iconSize = icon.Size;
        icon.Reparent(clip, false);
        icon.SetAnchorsPreset(Control.LayoutPreset.TopLeft);
        icon.Size = iconSize;
        icon.Position = iconPosition - clip.Position;
        RelicArtworkOutline.Apply(icon, resources);
        return screen;
    }
}
