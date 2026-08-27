using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace DeepTutor.Desktop;

internal sealed class DesktopPluginHost
{
    private const int MaxStateChars = 5_000_000;
    private const int MaxPluginFileChars = 2_000_000;
    private const int MaxListedFiles = 500;
    private const string MessageSource = "deeptutor-desktop-plugin";
    private static readonly Regex PluginIdPattern = new("^[a-z0-9][a-z0-9-]{0,63}$", RegexOptions.Compiled);
    private static readonly HashSet<string> AllowedPluginFileExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".json", ".md", ".txt"
    };
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly string _pluginsRoot;
    private readonly string _dataRoot;
    private readonly Action<string> _log;
    private readonly Dictionary<string, InstalledPlugin> _plugins = new(StringComparer.OrdinalIgnoreCase);

    public DesktopPluginHost(string appRoot, Action<string> log)
    {
        _pluginsRoot = Path.Combine(appRoot, "plugins");
        _dataRoot = Path.Combine(appRoot, "plugin-data");
        _log = log;
        Discover();
    }

    public IReadOnlyList<string> LoadInjectionScripts()
    {
        var scripts = new List<string>();
        foreach (var plugin in _plugins.Values.Where(plugin => plugin.Manifest.Enabled))
        {
            try
            {
                var script = File.ReadAllText(plugin.InjectionPath);
                scripts.Add($"/* DeepTutor desktop plugin: {plugin.Manifest.Id} */\n{script}\n//# sourceURL=deeptutor-plugin-{plugin.Manifest.Id}.js");
                _log($"Plugin {plugin.Manifest.Id} injection loaded ({plugin.Manifest.Version}).");
            }
            catch (Exception exception)
            {
                _log($"Plugin {plugin.Manifest.Id} injection failed: {exception.Message}");
            }
        }
        return scripts;
    }

    public bool IsPluginMessage(JsonElement root)
    {
        return root.TryGetProperty("source", out var source) &&
               string.Equals(source.GetString(), MessageSource, StringComparison.Ordinal);
    }

    public async Task<string> HandleMessageAsync(JsonElement root)
    {
        var pluginId = GetString(root, "pluginId");
        var requestId = GetString(root, "requestId");
        var action = GetString(root, "action");

        if (!_plugins.TryGetValue(pluginId, out var plugin) || !plugin.Manifest.Enabled)
        {
            return Error(pluginId, requestId, "插件未安装或已禁用。");
        }

        try
        {
            return action switch
            {
                "state.load" => await LoadStateAsync(plugin, requestId),
                "state.save" => await SaveStateAsync(plugin, requestId, root),
                "file.list" => await ListFilesAsync(plugin, requestId, root),
                "file.read" => await ReadFileAsync(plugin, requestId, root),
                "file.write" => await WriteFileAsync(plugin, requestId, root),
                "file.delete" => await DeleteFileAsync(plugin, requestId, root),
                "directory.delete" => await DeleteDirectoryAsync(plugin, requestId, root),
                _ => Error(pluginId, requestId, $"不支持的插件操作：{action}")
            };
        }
        catch (Exception exception)
        {
            _log($"Plugin {pluginId} message {action} failed: {exception}");
            return Error(pluginId, requestId, exception.Message);
        }
    }

    private void Discover()
    {
        if (!Directory.Exists(_pluginsRoot))
        {
            return;
        }

        foreach (var directory in Directory.EnumerateDirectories(_pluginsRoot))
        {
            var manifestPath = Path.Combine(directory, "plugin.json");
            if (!File.Exists(manifestPath))
            {
                continue;
            }

            try
            {
                var manifest = JsonSerializer.Deserialize<PluginManifest>(File.ReadAllText(manifestPath), JsonOptions);
                if (manifest is null || !PluginIdPattern.IsMatch(manifest.Id))
                {
                    _log($"Ignored invalid desktop plugin manifest: {manifestPath}");
                    continue;
                }

                var pluginRoot = Path.GetFullPath(directory);
                var injectionPath = Path.GetFullPath(Path.Combine(pluginRoot, manifest.InjectScript));
                if (!IsChildPath(pluginRoot, injectionPath) || !File.Exists(injectionPath))
                {
                    _log($"Ignored plugin {manifest.Id}: injection script is missing or outside the plugin directory.");
                    continue;
                }

                _plugins[manifest.Id] = new InstalledPlugin(manifest, pluginRoot, injectionPath);
            }
            catch (Exception exception)
            {
                _log($"Could not load desktop plugin manifest {manifestPath}: {exception.Message}");
            }
        }
    }

    private async Task<string> LoadStateAsync(InstalledPlugin plugin, string requestId)
    {
        var statePath = StatePath(plugin.Manifest.Id);
        JsonElement? state = null;
        if (File.Exists(statePath))
        {
            var text = await File.ReadAllTextAsync(statePath);
            if (text.Length > MaxStateChars)
            {
                throw new InvalidDataException("插件状态文件过大。");
            }
            using var document = JsonDocument.Parse(text);
            state = document.RootElement.Clone();
        }

        return JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true,
            state
        });
    }

    private async Task<string> SaveStateAsync(InstalledPlugin plugin, string requestId, JsonElement root)
    {
        if (!root.TryGetProperty("state", out var state))
        {
            return Error(plugin.Manifest.Id, requestId, "缺少 state。");
        }

        var stateText = state.GetRawText();
        if (stateText.Length > MaxStateChars)
        {
            return Error(plugin.Manifest.Id, requestId, "插件状态超过 5 MB 限制。");
        }

        var stateDirectory = PluginDataDirectory(plugin.Manifest.Id);
        Directory.CreateDirectory(stateDirectory);
        var statePath = StatePath(plugin.Manifest.Id);
        var temporaryPath = statePath + ".tmp";
        await File.WriteAllTextAsync(temporaryPath, FormatJson(stateText));
        File.Move(temporaryPath, statePath, true);

        return JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true
        });
    }

    private Task<string> ListFilesAsync(InstalledPlugin plugin, string requestId, JsonElement root)
    {
        var relativeDirectory = GetString(root, "path");
        var directory = ResolvePluginDataPath(plugin.Manifest.Id, relativeDirectory, requireFile: false);
        var files = new List<object>();
        if (Directory.Exists(directory))
        {
            foreach (var path in Directory.EnumerateFiles(directory).Take(MaxListedFiles))
            {
                if (!AllowedPluginFileExtensions.Contains(Path.GetExtension(path)))
                {
                    continue;
                }

                var info = new FileInfo(path);
                files.Add(new
                {
                    name = info.Name,
                    path = Path.GetRelativePath(PluginDataDirectory(plugin.Manifest.Id), path).Replace('\\', '/'),
                    size = info.Length,
                    modifiedAt = info.LastWriteTimeUtc.ToString("O")
                });
            }
        }

        return Task.FromResult(JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true,
            files
        }));
    }

    private async Task<string> ReadFileAsync(InstalledPlugin plugin, string requestId, JsonElement root)
    {
        var relativePath = GetString(root, "path");
        var path = ResolvePluginDataPath(plugin.Manifest.Id, relativePath, requireFile: true);
        if (!File.Exists(path))
        {
            return Error(plugin.Manifest.Id, requestId, "插件数据文件不存在。");
        }

        var info = new FileInfo(path);
        if (info.Length > MaxPluginFileChars * 4L)
        {
            return Error(plugin.Manifest.Id, requestId, "插件数据文件过大。");
        }

        var content = await File.ReadAllTextAsync(path);
        if (content.Length > MaxPluginFileChars)
        {
            return Error(plugin.Manifest.Id, requestId, "插件数据文件超过 2 MB 限制。");
        }

        return JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true,
            path = relativePath,
            content
        });
    }

    private async Task<string> WriteFileAsync(InstalledPlugin plugin, string requestId, JsonElement root)
    {
        var relativePath = GetString(root, "path");
        var content = GetString(root, "content");
        if (content.Length > MaxPluginFileChars)
        {
            return Error(plugin.Manifest.Id, requestId, "单个插件文件超过 2 MB 限制。");
        }

        var path = ResolvePluginDataPath(plugin.Manifest.Id, relativePath, requireFile: true);
        var directory = Path.GetDirectoryName(path) ?? throw new InvalidDataException("无效的插件数据路径。");
        Directory.CreateDirectory(directory);
        var temporaryPath = path + ".tmp";
        await File.WriteAllTextAsync(temporaryPath, content);
        File.Move(temporaryPath, path, true);

        return JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true
        });
    }

    private Task<string> DeleteFileAsync(InstalledPlugin plugin, string requestId, JsonElement root)
    {
        var relativePath = GetString(root, "path");
        var path = ResolvePluginDataPath(plugin.Manifest.Id, relativePath, requireFile: true);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        return Task.FromResult(JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true
        }));
    }

    private Task<string> DeleteDirectoryAsync(InstalledPlugin plugin, string requestId, JsonElement root)
    {
        var relativePath = GetString(root, "path");
        var normalized = relativePath.Replace('\\', '/').Trim('/');
        if (normalized.Split('/', StringSplitOptions.RemoveEmptyEntries).Length < 2)
        {
            throw new InvalidDataException("不能删除插件 DNA 根目录。");
        }

        var path = ResolvePluginDataPath(plugin.Manifest.Id, relativePath, requireFile: false);
        if (Directory.Exists(path))
        {
            Directory.Delete(path, true);
        }

        return Task.FromResult(JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId = plugin.Manifest.Id,
            requestId,
            ok = true
        }));
    }

    private string ResolvePluginDataPath(string pluginId, string relativePath, bool requireFile)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath))
        {
            throw new InvalidDataException("无效的插件数据路径。");
        }

        var normalized = relativePath.Replace('/', Path.DirectorySeparatorChar).TrimStart(Path.DirectorySeparatorChar);
        var firstSegment = normalized.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (!string.Equals(firstSegment, "dna", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("插件文件操作仅限 dna 目录。");
        }

        var root = Path.GetFullPath(PluginDataDirectory(pluginId));
        var path = Path.GetFullPath(Path.Combine(root, normalized));
        if (!IsChildPath(root, path))
        {
            throw new InvalidDataException("插件数据路径越界。");
        }

        if (requireFile && !AllowedPluginFileExtensions.Contains(Path.GetExtension(path)))
        {
            throw new InvalidDataException("仅支持 JSON、Markdown 和 TXT 插件数据文件。");
        }

        return path;
    }

    private string PluginDataDirectory(string pluginId)
    {
        if (!PluginIdPattern.IsMatch(pluginId))
        {
            throw new InvalidDataException("无效的插件 ID。");
        }
        return Path.Combine(_dataRoot, pluginId);
    }

    private string StatePath(string pluginId) => Path.Combine(PluginDataDirectory(pluginId), "state.json");

    private static bool IsChildPath(string parent, string child)
    {
        var normalizedParent = parent.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return child.StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase);
    }

    private static string GetString(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out var value) ? value.GetString() ?? "" : "";
    }

    private static string FormatJson(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        return JsonSerializer.Serialize(document.RootElement, JsonOptions);
    }

    private static string Error(string pluginId, string requestId, string message)
    {
        return JsonSerializer.Serialize(new
        {
            source = MessageSource,
            pluginId,
            requestId,
            ok = false,
            error = message
        });
    }

    private sealed record InstalledPlugin(PluginManifest Manifest, string Root, string InjectionPath);

    private sealed class PluginManifest
    {
        [JsonPropertyName("id")]
        public string Id { get; init; } = "";

        [JsonPropertyName("name")]
        public string Name { get; init; } = "";

        [JsonPropertyName("version")]
        public string Version { get; init; } = "0.0.0";

        [JsonPropertyName("enabled")]
        public bool Enabled { get; init; }

        [JsonPropertyName("injectScript")]
        public string InjectScript { get; init; } = "frontend/inject.js";
    }
}
