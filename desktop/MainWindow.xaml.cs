using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace DeepTutor.Desktop;

public partial class MainWindow : Window
{
    private static readonly Uri AppUri = new("http://127.0.0.1:3782/");
    private readonly CancellationTokenSource _shutdown = new();
    private readonly SemaphoreSlim _startupGate = new(1, 1);
    private readonly object _logLock = new();
    private readonly string _appRoot;
    private readonly string _logPath;
    private DesktopPluginHost? _pluginHost;
    private Process? _serviceProcess;
    private Process? _sttProcess;
    private ProcessJob? _processJob;
    private bool _ownsService;
    private bool _ownsStt;
    private int? _ownedServicePid;
    private int _recoveryInProgress;
    private int _automaticRecoveries;
    private DateTime _lastRecovery = DateTime.MinValue;

    public MainWindow()
    {
        InitializeComponent();
        _appRoot = FindAppRoot();
        Directory.CreateDirectory(Path.Combine(_appRoot, "logs"));
        _logPath = Path.Combine(_appRoot, "logs", "desktop-app.log");

        Loaded += async (_, _) => await StartAsync();
        Closing += (_, _) => ShutdownService();
    }

    private async Task StartAsync()
    {
        if (!await _startupGate.WaitAsync(0))
        {
            return;
        }

        try
        {
            ShowLoading("正在启动您的专属学习助手…", canRetry: false);
            WriteLog("Desktop app starting.");

            if (!await IsServiceReadyAsync(_shutdown.Token))
            {
                PrepareForServiceRestart();
                StartService();
                ShowLoading("正在加载 DeepTutor 服务，首次启动可能需要几十秒…", canRetry: false);

                if (!await WaitForServiceAsync(TimeSpan.FromSeconds(120), _shutdown.Token))
                {
                    throw new InvalidOperationException("DeepTutor 服务未能在 120 秒内完成启动。请查看桌面应用日志。");
                }
            }

            await EnsureLocalSpeechServiceAsync();
            await InitializeBrowserAsync();
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            WriteLog("Startup failed: " + exception);
            ShowLoading("启动失败：" + exception.Message, canRetry: true);
        }
        finally
        {
            _startupGate.Release();
        }
    }

    private void StartService()
    {
        var executable = Path.Combine(_appRoot, ".venv", "Scripts", "deeptutor.exe");
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException("找不到 DeepTutor 程序。", executable);
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = _appRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        startInfo.ArgumentList.Add("start");
        startInfo.ArgumentList.Add("--home");
        startInfo.ArgumentList.Add(_appRoot);
        startInfo.Environment["DEEPTUTOR_HOME"] = _appRoot;
        startInfo.Environment["DEEPTUTOR_BIND_HOST"] = "127.0.0.1";
        startInfo.Environment["NO_PROXY"] = "127.0.0.1,localhost";
        startInfo.Environment["PYTHONIOENCODING"] = "utf-8:replace";

        _serviceProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        _serviceProcess.OutputDataReceived += (_, eventArgs) => WriteServiceLog("OUT", eventArgs.Data);
        _serviceProcess.ErrorDataReceived += (_, eventArgs) => WriteServiceLog("ERR", eventArgs.Data);
        _serviceProcess.Exited += (_, _) => Dispatcher.Invoke(() =>
        {
            WriteLog($"DeepTutor service exited with code {_serviceProcess?.ExitCode}.");
            if (!_shutdown.IsCancellationRequested)
            {
                ShowLoading("DeepTutor 服务意外停止。", canRetry: true);
            }
        });

        if (!_serviceProcess.Start())
        {
            throw new InvalidOperationException("无法启动 DeepTutor 服务。");
        }

        _ownsService = true;
        _ownedServicePid = _serviceProcess.Id;
        File.WriteAllText(Path.Combine(_appRoot, "deeptutor.pid"), _serviceProcess.Id.ToString());
        _serviceProcess.BeginOutputReadLine();
        _serviceProcess.BeginErrorReadLine();

        try
        {
            _processJob = new ProcessJob();
            _processJob.Add(_serviceProcess);
        }
        catch (Exception exception)
        {
            _processJob?.Dispose();
            _processJob = null;
            WriteLog("Job object unavailable; process-tree fallback will be used: " + exception.Message);
        }

        WriteLog($"DeepTutor service started, PID {_serviceProcess.Id}.");
    }

    private async Task EnsureLocalSpeechServiceAsync()
    {
        try
        {
            if (await IsLocalSpeechReadyAsync(_shutdown.Token))
            {
                WriteLog("Local SenseVoice STT service is already ready.");
                return;
            }

            var python = Path.Combine(_appRoot, ".venv", "Scripts", "python.exe");
            var script = Path.Combine(_appRoot, "local-services", "sensevoice-stt", "server.py");
            if (!File.Exists(python) || !File.Exists(script))
            {
                WriteLog("Local SenseVoice STT service is not installed; continuing without it.");
                return;
            }

            _sttProcess?.Dispose();
            var startInfo = new ProcessStartInfo
            {
                FileName = python,
                WorkingDirectory = Path.GetDirectoryName(script) ?? _appRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            startInfo.ArgumentList.Add(script);
            startInfo.Environment["PYTHONIOENCODING"] = "utf-8:replace";
            startInfo.Environment["NO_PROXY"] = "127.0.0.1,localhost";

            _sttProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            _sttProcess.OutputDataReceived += (_, eventArgs) => WriteServiceLog("STT OUT", eventArgs.Data);
            _sttProcess.ErrorDataReceived += (_, eventArgs) => WriteServiceLog("STT ERR", eventArgs.Data);
            _sttProcess.Exited += (_, _) => WriteLog($"Local SenseVoice STT service exited with code {_sttProcess?.ExitCode}.");
            if (!_sttProcess.Start())
            {
                WriteLog("Could not start local SenseVoice STT service.");
                return;
            }

            _ownsStt = true;
            _sttProcess.BeginOutputReadLine();
            _sttProcess.BeginErrorReadLine();
            try
            {
                _processJob?.Add(_sttProcess);
            }
            catch (Exception exception)
            {
                WriteLog("Could not add local STT service to the process job: " + exception.Message);
            }

            for (var attempt = 0; attempt < 50; attempt++)
            {
                if (await IsLocalSpeechReadyAsync(_shutdown.Token))
                {
                    WriteLog($"Local SenseVoice STT service ready, PID {_sttProcess.Id}.");
                    return;
                }
                if (_sttProcess.HasExited)
                {
                    break;
                }
                await Task.Delay(200, _shutdown.Token);
            }
            WriteLog("Local SenseVoice STT service did not become ready; DeepTutor will continue without microphone transcription.");
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            WriteLog("Local SenseVoice STT startup failed: " + exception.Message);
        }
    }

    private static async Task<bool> IsLocalSpeechReadyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var handler = new SocketsHttpHandler { UseProxy = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(1) };
            using var response = await client.GetAsync("http://127.0.0.1:18765/health", cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private async Task InitializeBrowserAsync()
    {
        if (Browser.CoreWebView2 is null)
        {
            var userData = Path.Combine(_appRoot, "data", "desktop-webview2");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await Browser.EnsureCoreWebView2Async(environment);

            var core = Browser.CoreWebView2 ?? throw new InvalidOperationException("WebView2 初始化失败。");
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.NewWindowRequested += OpenExternalLink;
            core.WebMessageReceived += ReceiveBrowserError;
            core.ProcessFailed += BrowserProcessFailed;
            Browser.NavigationCompleted += BrowserNavigationCompleted;

            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.addEventListener('error',e=>chrome.webview.postMessage(JSON.stringify({type:'error',message:e.message||'Unknown error',source:e.filename||'',line:e.lineno||0,column:e.colno||0})));" +
                "window.addEventListener('unhandledrejection',e=>chrome.webview.postMessage(JSON.stringify({type:'rejection',message:String(e.reason?.stack||e.reason||'Unknown rejection')})));"
            );

            _pluginHost = new DesktopPluginHost(_appRoot, WriteLog);
            foreach (var script in _pluginHost.LoadInjectionScripts())
            {
                await core.AddScriptToExecuteOnDocumentCreatedAsync(script);
            }
        }

        ShowLoading("正在打开学习空间…", canRetry: false);
        Browser.Source = AppUri;
    }

    private async void BrowserNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs eventArgs)
    {
        if (!eventArgs.IsSuccess)
        {
            WriteLog($"Navigation failed: {eventArgs.WebErrorStatus}.");
            ShowLoading("页面载入失败。", canRetry: true);
            return;
        }

        try
        {
            if (await IsGlobalErrorPageAsync())
            {
                await RecoverFromPageErrorAsync();
                return;
            }
        }
        catch (Exception exception)
        {
            WriteLog("Could not inspect page state: " + exception.Message);
        }

        _automaticRecoveries = 0;
        Browser.Visibility = Visibility.Visible;
        LoadingPanel.Visibility = Visibility.Collapsed;
    }

    private async Task RecoverFromPageErrorAsync()
    {
        if (Interlocked.Exchange(ref _recoveryInProgress, 1) == 1)
        {
            return;
        }

        try
        {
        var now = DateTime.UtcNow;
        if ((now - _lastRecovery) > TimeSpan.FromMinutes(1))
        {
            _automaticRecoveries = 0;
        }

        _lastRecovery = now;
        _automaticRecoveries++;
        WriteLog($"Next.js global error page detected; recovery attempt {_automaticRecoveries}.");

        if (_automaticRecoveries <= 2)
        {
            ShowLoading("页面出现临时异常，正在自动恢复…", canRetry: false);
            await Task.Delay(900, _shutdown.Token);
            Browser.Reload();
            return;
        }

        ShowLoading("页面连续载入失败，您可以点击重试。", canRetry: true);
        }
        finally
        {
            Interlocked.Exchange(ref _recoveryInProgress, 0);
        }
    }

    private void OpenExternalLink(object? sender, CoreWebView2NewWindowRequestedEventArgs eventArgs)
    {
        if (Uri.TryCreate(eventArgs.Uri, UriKind.Absolute, out var uri) &&
            !string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            eventArgs.Handled = true;
            Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
        }
    }

    private async void ReceiveBrowserError(object? sender, CoreWebView2WebMessageReceivedEventArgs eventArgs)
    {
        try
        {
            using var document = JsonDocument.Parse(eventArgs.TryGetWebMessageAsString());
            var root = document.RootElement;
            if (_pluginHost is not null && _pluginHost.IsPluginMessage(root))
            {
                var response = await _pluginHost.HandleMessageAsync(root);
                Browser.CoreWebView2?.PostWebMessageAsJson(response);
                return;
            }
            var type = root.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : "browser";
            var message = root.TryGetProperty("message", out var messageElement) ? messageElement.GetString() : "Unknown error";
            WriteLog($"Browser {type}: {message}");

            await Task.Delay(250, _shutdown.Token);
            if (await IsGlobalErrorPageAsync())
            {
                await RecoverFromPageErrorAsync();
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            WriteLog("Browser message parse failed: " + exception.Message);
        }
    }

    private void BrowserProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs eventArgs)
    {
        WriteLog($"WebView2 process failed: {eventArgs.ProcessFailedKind}.");
        if (!_shutdown.IsCancellationRequested)
        {
            Dispatcher.Invoke(() => ShowLoading("显示组件发生异常，正在恢复…", canRetry: true));
        }
    }

    private async Task<bool> WaitForServiceAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_serviceProcess is { HasExited: true })
            {
                return false;
            }

            if (await IsServiceReadyAsync(cancellationToken))
            {
                return true;
            }

            await Task.Delay(1000, cancellationToken);
        }

        return false;
    }

    private async Task<bool> IsGlobalErrorPageAsync()
    {
        if (Browser.CoreWebView2 is null)
        {
            return false;
        }

        var result = await Browser.CoreWebView2.ExecuteScriptAsync(
            "document.documentElement.id === '__next_error__' || document.body?.innerText?.includes('This page couldn’t load') || document.body?.innerText?.includes('此页面无法加载')"
        );
        return string.Equals(result, "true", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<bool> IsServiceReadyAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var handler = new SocketsHttpHandler { UseProxy = false };
            using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync(AppUri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            return (int)response.StatusCode is >= 200 and < 500;
        }
        catch
        {
            return false;
        }
    }

    private void ShowLoading(string message, bool canRetry)
    {
        Browser.Visibility = Visibility.Collapsed;
        LoadingPanel.Visibility = Visibility.Visible;
        StatusText.Text = message;
        RetryButton.Visibility = canRetry ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void RetryButton_Click(object sender, RoutedEventArgs e)
    {
        _automaticRecoveries = 0;
        if (await IsServiceReadyAsync(_shutdown.Token) && Browser.CoreWebView2 is not null)
        {
            ShowLoading("正在重新载入…", canRetry: false);
            Browser.Reload();
            return;
        }

        await StartAsync();
    }

    private void ShutdownService()
    {
        _shutdown.Cancel();
        Browser.Dispose();

        try
        {
            _processJob?.Dispose();
            _processJob = null;

            if (_ownsService && _serviceProcess is { HasExited: false })
            {
                _serviceProcess.Kill(entireProcessTree: true);
                _serviceProcess.WaitForExit(5000);
            }
            if (_ownsStt && _sttProcess is { HasExited: false })
            {
                _sttProcess.Kill(entireProcessTree: true);
                _sttProcess.WaitForExit(5000);
            }
        }
        catch (Exception exception)
        {
            WriteLog("Service shutdown failed: " + exception.Message);
        }
        finally
        {
            _serviceProcess?.Dispose();
            _sttProcess?.Dispose();
            if (_ownsService)
            {
                TryDeleteOwnedPidFile();
            }
        }
    }

    private void PrepareForServiceRestart()
    {
        if (_serviceProcess is null)
        {
            return;
        }

        _processJob?.Dispose();
        _processJob = null;
        _serviceProcess.Dispose();
        _serviceProcess = null;
        _ownsService = false;
        _ownedServicePid = null;
    }

    private void TryDeleteOwnedPidFile()
    {
        try
        {
            var pidFile = Path.Combine(_appRoot, "deeptutor.pid");
            if (File.Exists(pidFile) &&
                int.TryParse(File.ReadAllText(pidFile), out var pid) &&
                pid == _ownedServicePid)
            {
                File.Delete(pidFile);
            }
        }
        catch (Exception exception)
        {
            WriteLog("PID cleanup failed: " + exception.Message);
        }
    }

    private void WriteServiceLog(string channel, string? message)
    {
        if (!string.IsNullOrWhiteSpace(message))
        {
            WriteLog($"SERVICE {channel}: {message}");
        }
    }

    private void WriteLog(string message)
    {
        lock (_logLock)
        {
            File.AppendAllText(_logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
    }

    private static string FindAppRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, ".venv", "Scripts", "deeptutor.exe")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("无法定位 DeepTutor 安装目录。");
    }
}
