using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Godot;
using MegaCrit.Sts2.addons.mega_text;
using MegaCrit.Sts2.Core.Assets;
using MegaCrit.Sts2.Core.Debug;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Multiplayer.Serialization;
using MegaCrit.Sts2.Core.Nodes.Cards;
using MegaCrit.Sts2.Core.Saves;

public partial class RenderHost : Node
{
    private HttpListener? listener;
    private SubViewport viewport = null!;
    private AtlasResourceLoader atlasLoader = null!;
    private readonly List<ImageTexture> editorIcons = new();
    private string token = "";
    private System.Threading.Timer? parentWatch;

    public override async void _Ready()
    {
        try
        {
            string assemblyDir = OS.GetEnvironment("STS2_ASSEMBLY_DIR");
            AssemblyLoadContext.GetLoadContext(Assembly.GetExecutingAssembly())!.Resolving += (context, name) =>
            {
                string path = Path.Combine(assemblyDir, name.Name + ".dll");
                return File.Exists(path) ? context.LoadFromAssemblyPath(path) : null;
            };
            // Resolve the game's dependencies before JIT-compiling initialization.
            await InitializeRenderer();
        }
        catch (Exception error) { GD.PushError(error.ToString()); GetTree().Quit(1); }
    }

    private async Task InitializeRenderer()
    {
        Engine.MaxFps = 60;
        token = OS.GetEnvironment("NATIVE_RENDER_TOKEN");
        if (token.Length < 32) throw new InvalidOperationException("Missing private worker token.");
        if (!ProjectSettings.LoadResourcePack(Path.Combine(OS.GetEnvironment("STS2_GAME_DIR"), "SlayTheSpire2.pck")))
            throw new InvalidOperationException("Could not load original game PCK.");
        typeof(GodotObject).Assembly.GetType("Godot.Bridge.ScriptManagerBridge")!
            .GetMethod("LookupScriptsInAssembly", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!
            .Invoke(null, new object[] { typeof(NCard).Assembly });
        atlasLoader = new AtlasResourceLoader();
        ResourceLoader.AddResourceFormatLoader(atlasLoader, true);
        AtlasManager.LoadEssentialAtlases();
        await ModManager.Initialize(new ModManagerFileIo(), null, SemanticVersion.FromString(OS.GetEnvironment("STS2_GAME_VERSION")));
        SaveManager.Instance.InitSettingsDataForTest();
        SaveManager.Instance.SettingsSave.Language = "zhs";
        LocManager.Initialize();
        AssemblyInfo.Init();
        ModelDb.Init();
        ModelIdSerializationCache.Init();
        ModelDb.InitIds();
        foreach (string path in Directory.GetFiles(Path.Combine(ProjectSettings.GlobalizePath("res://"), "editor_assets"), "*.png"))
        {
            using var image = Image.LoadFromFile(path);
            var texture = ImageTexture.CreateFromImage(image);
            texture.TakeOverPath("res://editor_assets/" + Path.GetFileName(path));
            editorIcons.Add(texture);
        }
        viewport = new SubViewport { Size = new Vector2I(648, 856), TransparentBg = true, Disable3D = true,
            RenderTargetUpdateMode = SubViewport.UpdateMode.Disabled };
        AddChild(viewport);
        foreach (string language in new[] { "zh", "en" })
            foreach (string kind in new[] { "card", "relic" })
            {
                using var warmup = JsonDocument.Parse(JsonSerializer.Serialize(new {
                    @object = kind, title = "预热 Warmup", name = "预热 Warmup", language,
                    description = "[gold]字体 Font[/gold] *star_energy*", flavor = "米白色 Flavor", watermark = true
                }));
                await Draw(warmup.RootElement);
            }
        listener = new HttpListener();
        int port = 0;
        // HttpListener does not accept port 0. Retry the short reservation gap.
        for (int attempt = 0; attempt < 10; attempt++)
        {
            var reservation = new TcpListener(IPAddress.Loopback, 0);
            reservation.Start();
            port = ((IPEndPoint)reservation.LocalEndpoint).Port;
            reservation.Stop();
            listener.Prefixes.Clear();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            try { listener.Start(); break; }
            catch (HttpListenerException) when (attempt < 9) { }
        }
        int parentPid = int.Parse(OS.GetEnvironment("NATIVE_RENDER_PARENT_PID"));
        parentWatch = new System.Threading.Timer(_ => {
            try { using var parent = Process.GetProcessById(parentPid); if (!parent.HasExited) return; }
            catch (ArgumentException) { }
            // A forcibly stopped Node process on Windows cannot run signal handlers.
            Callable.From(() => GetTree().Quit()).CallDeferred();
        }, null, 1000, 1000);
        _ = AcceptRequests();
        GD.Print("NATIVE_RENDER_READY " + JsonSerializer.Serialize(new {
            port, engine = Engine.GetVersionInfo()["string"].AsString(),
            gameVersion = OS.GetEnvironment("STS2_GAME_VERSION"), adapter = RenderingServer.GetVideoAdapterName()
        }));
    }

    private async Task AcceptRequests()
    {
        while (listener!.IsListening)
        {
            HttpListenerContext context;
            try { context = await listener.GetContextAsync(); }
            catch (Exception) when (!listener.IsListening) { return; }
            try
            {
                if (context.Request.Headers["Authorization"] != "Bearer " + token) { context.Response.StatusCode = 401; context.Response.Close(); continue; }
                if (context.Request.HttpMethod != "POST" || context.Request.Url!.AbsolutePath != "/render")
                { context.Response.StatusCode = 404; context.Response.Close(); continue; }
                if (context.Request.ContentLength64 < 0 || context.Request.ContentLength64 > 64 * 1024 * 1024)
                { context.Response.StatusCode = 413; context.Response.Close(); continue; }
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                using var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8);
                using var document = JsonDocument.Parse(await reader.ReadToEndAsync(timeout.Token));
                var data = document.RootElement.Clone();
                var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                Callable.From(() => Render(context, data, completion)).CallDeferred();
                await completion.Task;
            }
            catch (Exception error)
            {
                GD.PushError(error.Message);
                try { context.Response.StatusCode = 400; context.Response.Close(); } catch (Exception) { }
            }
        }
    }

    private async void Render(HttpListenerContext context, JsonElement data, TaskCompletionSource completion)
    {
        try
        {
            var result = await Draw(data);
            context.Response.ContentType = "application/octet-stream";
            context.Response.ContentLength64 = result.Pixels.Length;
            context.Response.Headers["X-Image-Width"] = viewport.Size.X.ToString();
            context.Response.Headers["X-Image-Height"] = viewport.Size.Y.ToString();
            context.Response.Headers["Server-Timing"] = "godot;dur=" + result.Milliseconds.ToString("F2", CultureInfo.InvariantCulture);
            if (OS.GetEnvironment("NATIVE_RENDER_DIAGNOSTICS") == "1")
                context.Response.Headers["X-Native-Metadata"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(result.Metadata));
            await context.Response.OutputStream.WriteAsync(result.Pixels);
            context.Response.Close();
        }
        catch (Exception error)
        {
            GD.PushError(error.ToString());
            try { context.Response.StatusCode = error is TextOverflowException ? 422 : 500; context.Response.Close(); } catch (Exception) { }
        }
        finally { completion.TrySetResult(); }
    }

    private async Task<(byte[] Pixels, double Milliseconds, string Metadata)> Draw(JsonElement data)
    {
        var timer = Stopwatch.StartNew();
        using var resources = new JobResources();
        try
        {
            string language = data.Text("language", "zh") == "en" ? "eng" : "zhs";
            if (LocManager.Instance.Language != language) LocManager.Instance.SetLanguage(language);
            bool isCard = data.Text("object") == "card";
            viewport.Size = isCard ? new Vector2I(648, 856) : new Vector2I(1040, 1296);
            Control scene = isCard ? CardRenderer.Create(viewport, data, resources) : RelicRenderer.Create(viewport, data, resources);
            if (data.Flag("watermark")) viewport.AddChild(RenderText.Watermark(data, viewport.Size));
            await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
            if (scene is NCard card) CardRenderer.SetPlaqueSize(card);
            await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
            foreach (var entry in isCard
                ? new[] { ("TitleLabel", 210f), ("TypeLabel", 220f), ("EnergyLabel", 46f), ("StarLabel", 46f) }
                : new[] { ("RelicName", 770f), ("Rarity", 442f) })
            {
                var label = scene.GetNode<MegaLabel>("%" + entry.Item1);
                if (!label.IsVisibleInTree()) continue;
                var font = label.GetThemeFont("font");
                int size = label.GetThemeFontSize("font_size");
                string[] lines = label.Text.Split('\n');
                foreach (string line in lines)
                    if (font.GetStringSize(line, fontSize: size).X > entry.Item2 + 1) throw new TextOverflowException();
                if (lines.Length * font.GetHeight(size) > label.Size.Y + 1) throw new TextOverflowException();
            }
            if (!isCard)
            {
                // Preserve the original sizes for ordinary relic text. Fit longer
                // editor content down to the scene's original minimum of 18px.
                var box = scene.GetNode<VBoxContainer>("Popup/VBoxContainer");
                for (int attempt = 0; box.GetCombinedMinimumSize().Y > 288 && attempt < 12; attempt++)
                {
                    foreach (string name in new[] { "RelicDescription", "FlavorText" })
                    {
                        var label = scene.GetNode<MegaRichTextLabel>("%" + name);
                        int size = Math.Max(18, label.GetThemeFontSize("normal_font_size") - 1);
                        foreach (string key in new[] { "normal_font_size", "bold_font_size", "italics_font_size", "bold_italics_font_size", "mono_font_size" })
                            label.AddThemeFontSizeOverride(key, size);
                    }
                    await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);
                }
                if (box.GetCombinedMinimumSize().Y > 289) throw new TextOverflowException();
            }
            else
            {
                var description = scene.GetNode<MegaRichTextLabel>("%DescriptionLabel");
                if (description.GetContentHeight() > description.Size.Y + 1) throw new TextOverflowException();
            }
            viewport.RenderTargetUpdateMode = SubViewport.UpdateMode.Once;
            await ToSignal(RenderingServer.Singleton, RenderingServer.SignalName.FramePostDraw);
            using var image = viewport.GetTexture().GetImage();
            image.Convert(Image.Format.Rgba8);
            var metadata = new Dictionary<string, object>();
            if (OS.GetEnvironment("NATIVE_RENDER_DIAGNOSTICS") == "1")
            {
                foreach (string name in isCard ? new[] { "TitleLabel", "DescriptionLabel", "EnergyLabel" } : new[] { "RelicName", "RelicDescription", "FlavorText" })
                {
                    var label = scene.GetNode<Control>("%" + name);
                    bool rich = label is RichTextLabel;
                    metadata[name] = new {
                        font = label.GetThemeFont(rich ? "normal_font" : "font").ResourcePath,
                        family = label.GetThemeFont(rich ? "normal_font" : "font").GetFontName(),
                        size = label.GetThemeFontSize(rich ? "normal_font_size" : "font_size"),
                        color = label.GetThemeColor(rich ? "default_color" : "font_color").ToHtml(),
                        x = label.GlobalPosition.X, y = label.GlobalPosition.Y,
                        width = label.Size.X, height = label.Size.Y
                    };
                }
                foreach (string name in isCard ? new[] { "Portrait", "AncientPortrait", "Frame", "EnergyIcon" } : new[] { "RelicImage", "Frame" })
                {
                    var node = scene.GetNode<Control>("%" + name);
                    var rect = node.GetGlobalRect();
                    metadata[name] = new { x = rect.Position.X, y = rect.Position.Y,
                        width = rect.Size.X, height = rect.Size.Y };
                }
            }
            return (image.GetData(), timer.Elapsed.TotalMilliseconds, JsonSerializer.Serialize(metadata));
        }
        finally
        {
            // Fresh scene instances restore the original English font after CJK
            // substitution and reset all user image/material overrides.
            foreach (Node child in viewport.GetChildren()) { viewport.RemoveChild(child); child.Free(); }
            PreloadManager.Cache.UnloadAssets(new[] { "res://__request_energy.png" });
        }
    }

    public override void _ExitTree()
    {
        parentWatch?.Dispose();
        listener?.Close();
        MegaRichTextLabel.DisposeCachedParagraph();
        foreach (var icon in editorIcons) icon.Dispose();
    }
}

internal sealed class TextOverflowException : Exception
{
    public TextOverflowException() : base("Text does not fit the native layout. Shorten the text.") { }
}
