using System;
using System.Text.Json;
using Godot;
using MegaCrit.Sts2.addons.mega_text;
using MegaCrit.Sts2.Core.Helpers;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Models.CardPools;
using MegaCrit.Sts2.Core.Nodes.Cards;

internal static class CardRenderer
{
    internal const float OutputScale = 520f / 300f;
    public static NCard Create(SubViewport viewport, JsonElement data, JobResources resources)
    {
        // Use the game's scene and MegaLabel implementations, with editor content
        // supplied directly. No gameplay owner, save data or mod model is needed.
        var card = RenderInput.Load<PackedScene>("res://scenes/cards/card.tscn").Instantiate<NCard>();
        viewport.AddChild(card);
        card.Position = new Vector2(324, 428);
        card.Scale = Vector2.One * OutputScale;
        var style = data.At("style");
        string type = data.Text("type", "Attack").ToLowerInvariant();
        string poolName = data.Text("cardPool", "ironclad");
        string rarity = data.Text("rarity", "Common").ToLowerInvariant();
        if (rarity == "basic") rarity = "common";
        bool ancient = poolName == "ancient";
        bool ancientBanner = data.Text("rarity") == "Ancient";
        var pool = Pool(poolName);
        var bannerMaterial = resources.Own(RenderInput.Hsv(style.At("rarityHsv"),
            RenderInput.Load<Material>($"res://materials/cards/banners/card_banner_{rarity}_mat.tres")));
        var frame = card.GetNode<TextureRect>("%Frame");
        frame.Texture = RenderInput.Load<Texture2D>($"res://images/atlases/ui_atlas.sprites/card/card_frame_{(poolName == "quest" ? "quest" : type)}_s.tres");
        frame.Material = resources.Own(RenderInput.Hsv(style.At("borderHsv"), pool.FrameMaterial));
        frame.Visible = !ancient;
        if (poolName == "custom" && resources.Image(style.At("cardPoolCustomAsset")) is Texture2D customFrame)
        {
            frame.ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize;
            frame.Texture = customFrame;
            frame.Material = null;
            Transform(frame, style.At("cardPoolCustomAsset"), 1);
        }
        var border = card.GetNode<TextureRect>("%PortraitBorder");
        border.Texture = RenderInput.Load<Texture2D>($"res://images/atlases/ui_atlas.sprites/card/card_portrait_border_{type}_s.tres");
        border.Material = bannerMaterial;
        border.Visible = !ancientBanner;
        var banner = card.GetNode<TextureRect>("%TitleBanner");
        banner.Material = bannerMaterial;
        banner.Visible = !ancientBanner;
        card.GetNode<Control>("%AncientBanner").Visible = ancientBanner;
        var flame = card.GetNode<AnimatedSprite2D>("CardContainer/AncientBanner/Fire");
        flame.Stop();
        flame.Frame = 0;
        flame.FrameProgress = 0;

        var ancientBorder = card.GetNode<TextureRect>("%AncientBorder");
        ancientBorder.Visible = ancient;
        ancientBorder.Texture = RenderInput.Load<Texture2D>("res://images/atlases/compressed_atlas.sprites/ancient_card_border.tres");
        var ancientText = card.GetNode<TextureRect>("%AncientTextBg");
        ancientText.Visible = ancient;
        ancientText.Texture = RenderInput.Load<Texture2D>($"res://images/atlases/compressed_atlas.sprites/ancient_text_bg_{type}.tres");
        card.GetNode<CanvasGroup>("%PortraitCanvasGroup").Material = ancient
            ? RenderInput.Load<Material>("res://scenes/cards/card_canvas_group_mask_material.tres") : null;
        var portrait = card.GetNode<TextureRect>(ancient ? "%AncientPortrait" : "%Portrait");
        card.GetNode<TextureRect>(ancient ? "%Portrait" : "%AncientPortrait").Hide();
        portrait.Texture = resources.Image(style.At("thumbnail"));
        portrait.Visible = portrait.Texture != null;
        if (ancient) TransformAncientPortrait(portrait, style.At("thumbnail"), resources);
        else if (portrait.Visible) TransformPortrait(card, portrait, style.At("thumbnail"));

        bool upgraded = data.Flag("upgraded");
        var title = card.GetNode<MegaLabel>("%TitleLabel");
        title.SetTextAutoSize(data.Text("title") + (upgraded ? "+" : ""));
        title.AddThemeColorOverride("font_color", upgraded ? StsColors.green : StsColors.cream);
        title.AddThemeColorOverride("font_outline_color", upgraded ? StsColors.cardTitleOutlineSpecial : TitleOutline(rarity));
        var typeLabel = card.GetNode<MegaLabel>("%TypeLabel");
        typeLabel.SetTextAutoSize(data.Text("typeText", data.Text("language", "zh") == "en"
            ? data.Text("type", "Attack") : type switch { "attack" => "攻击", "skill" => "技能", _ => "能力" }));
        // Native type labels grow their plaque. Bound editor-defined long labels.
        typeLabel.CustomMinimumSize = Vector2.Zero;
        typeLabel.Size = new Vector2(Math.Min(220, Math.Max(44, typeLabel.GetMinimumSize().X)), 28);
        typeLabel.AutoSizeEnabled = true;
        typeLabel.SetTextAutoSize(typeLabel.Text);
        var plaque = card.GetNode<NinePatchRect>("%TypePlaque");
        plaque.Material = bannerMaterial;

        var energyStyle = style.At("energy");
        string energyType = energyStyle.Text("type", poolName);
        var energyPool = Pool(energyType);
        var icon = card.GetNode<TextureRect>("%EnergyIcon");
        var customEnergy = energyType == "custom" ? resources.Image(energyStyle.At("customAsset")) : null;
        icon.Texture = customEnergy ?? RenderInput.Load<Texture2D>(energyPool.EnergyIconPath);
        icon.Visible = energyType != "none";
        var energyLabel = card.GetNode<MegaLabel>("%EnergyLabel");
        string cost = data.Text("cost");
        bool upgradedCost = upgraded && !string.IsNullOrWhiteSpace(data.Text("upgradedCost"));
        string displayedCost = upgradedCost ? data.Text("upgradedCost") : cost;
        bool changedCost = upgradedCost && displayedCost.Trim() != cost.Trim();
        energyLabel.SetTextAutoSize(displayedCost);
        energyLabel.AddThemeColorOverride("font_color", changedCost ? StsColors.green : StsColors.cream);
        energyLabel.AddThemeColorOverride("font_outline_color", changedCost ? StsColors.energyGreenOutline : energyPool.EnergyOutlineColor);
        if (customEnergy != null)
        {
            // The uploaded icon transforms independently of its cost label.
            var image = new TextureRect { ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize,
                StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered, Texture = customEnergy, Size = icon.Size };
            icon.Texture = null;
            icon.AddChild(image);
            icon.MoveChild(image, 0);
            Transform(image, energyStyle.At("customAsset"), 1);
        }
        card.GetNode<Control>("%StarIcon").Visible = data.Flag("starEnergyEnabled");
        var starLabel = card.GetNode<MegaLabel>("%StarLabel");
        starLabel.SetTextAutoSize(data.Text("starEnergyCost"));
        starLabel.AddThemeColorOverride("font_color", StsColors.cream);
        starLabel.AddThemeColorOverride("font_outline_color", StsColors.defaultStarCostOutline);
        string description = upgraded && !string.IsNullOrWhiteSpace(data.Text("upgradedDescription"))
            ? data.Text("upgradedDescription") : data.Text("description");
        Texture2D? inlineEnergy = null;
        if (customEnergy != null)
        {
            using var small = customEnergy.GetImage();
            small.Resize(21, 21, Image.Interpolation.Lanczos);
            inlineEnergy = resources.Own(ImageTexture.CreateFromImage(small));
        }
        RenderText.Set(card.GetNode<MegaRichTextLabel>("%DescriptionLabel"), "[center]" + description + "[/center]", 21, inlineEnergy);
        card.GetNode<Control>("CardContainer/Shadow").Hide();
        card.CardHighlight.Hide();
        card.GetNode<Control>("%UnplayableEnergyIcon").Hide();
        card.GetNode<Control>("%UnplayableStarIcon").Hide();
        card.GetNode<GpuParticles2D>("CardContainer/CardSparkles").Emitting = false;
        return card;
    }

    public static void SetPlaqueSize(NCard card)
    {
        var plaque = card.GetNode<NinePatchRect>("%TypePlaque");
        float width = Math.Max(card.GetNode<MegaLabel>("%TypeLabel").Size.X + 17, 61);
        plaque.Size = new Vector2(width, plaque.Size.Y);
        plaque.Position = new Vector2(-width / 2, plaque.Position.Y);
    }

    private static void Transform(TextureRect image, JsonElement asset, float defaultScale)
    {
        var visualTopLeft = image.Position + image.PivotOffset * (Vector2.One - image.Scale);
        image.PivotOffset = image.Size / 2;
        image.Position = visualTopLeft - image.PivotOffset * (Vector2.One - image.Scale);
        image.Scale *= asset.Number("scale", defaultScale) / defaultScale;
        image.Position += new Vector2(asset.Number("offsetX"), asset.Number("offsetY")) * (2 / OutputScale);
    }

    private static void TransformPortrait(NCard card, TextureRect image, JsonElement asset)
    {
        // Keep the native clip, but fit artwork to the editor's full image box.
        // These dimensions and offsets match .cards-preview-thumbnail in cardPreview.css.
        var clip = new Control { Position = image.Position, Size = image.Size, ClipContents = true };
        image.GetParent().AddChild(clip);
        image.Reparent(clip, false);
        image.SetAnchorsPreset(Control.LayoutPreset.TopLeft);

        const float editorToCard = 2 / OutputScale;
        var editorSize = new Vector2(260, 364);
        var center = editorSize * new Vector2(-.0037f, -.17f)
            + new Vector2(asset.Number("offsetX"), asset.Number("offsetY"));
        var centerInClip = clip.GetGlobalTransform().AffineInverse()
            * (card.GetGlobalTransform() * (center * editorToCard));
        image.ExpandMode = TextureRect.ExpandModeEnum.IgnoreSize;
        image.StretchMode = TextureRect.StretchModeEnum.KeepAspectCentered;
        image.Size = editorSize * editorToCard;
        image.PivotOffset = image.Size / 2;
        image.Position = centerInClip - image.PivotOffset;
        image.Scale = Vector2.One * asset.Number("scale", .81f);
    }

    private static void TransformAncientPortrait(TextureRect image, JsonElement asset, JobResources resources)
    {
        float zoom = asset.Number("scale", .81f) / .81f;
        var offset = new Vector2(asset.Number("offsetX"), asset.Number("offsetY"));
        if (zoom == 1 && offset == Vector2.Zero) return;
        // The original ancient mask/glass shader derives its UVs from the group's
        // bounds. Transform texture sampling, not the node bounds, so zoom/pan
        // cannot move or enlarge the card-shaped mask and glass border.
        var shader = resources.Own(new Shader { Code = @"
shader_type canvas_item;
uniform float zoom = 1.0;
uniform vec2 pan = vec2(0.0);
varying vec4 modulation;
void vertex() { modulation = COLOR; }
void fragment() {
    vec2 uv = (UV - vec2(0.5) - pan) / (abs(zoom) < 0.00001 ? 1.0 : zoom) + vec2(0.5);
    if (abs(zoom) < 0.00001 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        COLOR = vec4(0.0);
    } else { COLOR = modulation * texture(TEXTURE, uv); }
}" });
        var material = resources.Own(new ShaderMaterial { Shader = shader });
        material.SetShaderParameter("zoom", zoom);
        material.SetShaderParameter("pan", offset * (2 / OutputScale) / (image.Size * image.Scale));
        image.Material = material;
    }

    private static Color TitleOutline(string rarity) => rarity switch {
        "uncommon" => StsColors.cardTitleOutlineUncommon, "rare" => StsColors.cardTitleOutlineRare,
        "curse" => StsColors.cardTitleOutlineCurse, "quest" => StsColors.cardTitleOutlineQuest,
        "status" => StsColors.cardTitleOutlineStatus, "event" => StsColors.cardTitleOutlineSpecial,
        _ => StsColors.cardTitleOutlineCommon
    };

    private static CardPoolModel Pool(string pool) => pool switch {
        "silent" => ModelDb.CardPool<SilentCardPool>(), "regent" => ModelDb.CardPool<RegentCardPool>(),
        "necrobinder" => ModelDb.CardPool<NecrobinderCardPool>(), "defect" => ModelDb.CardPool<DefectCardPool>(),
        "fool" => ModelDb.CardPool<FoolCardPool>(), "quest" => ModelDb.CardPool<QuestCardPool>(),
        "curse" => ModelDb.CardPool<CurseCardPool>(), "status" => ModelDb.CardPool<StatusCardPool>(),
        "colorless" or "ancient" or "custom" => ModelDb.CardPool<ColorlessCardPool>(),
        _ => ModelDb.CardPool<IroncladCardPool>()
    };
}
