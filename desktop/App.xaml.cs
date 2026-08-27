using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;

namespace DeepTutor.Desktop;

public partial class App : Application
{
    private const string MutexName = "Local\\DeepTutor.Desktop.1C73F6B8";
    private Mutex? _singleInstanceMutex;
    private bool _ownsMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        _singleInstanceMutex = new Mutex(true, MutexName, out var isFirstInstance);
        _ownsMutex = isFirstInstance;
        if (!isFirstInstance)
        {
            ActivateExistingWindow();
            Shutdown();
            return;
        }

        base.OnStartup(e);
        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_ownsMutex)
        {
            _singleInstanceMutex?.ReleaseMutex();
        }
        _singleInstanceMutex?.Dispose();
        base.OnExit(e);
    }

    private static void ActivateExistingWindow()
    {
        var current = Process.GetCurrentProcess();
        var existing = Process.GetProcessesByName(current.ProcessName)
            .FirstOrDefault(process => process.Id != current.Id && process.MainWindowHandle != IntPtr.Zero);

        if (existing is null)
        {
            MessageBox.Show("DeepTutor 已经在运行。", "DeepTutor", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        ShowWindow(existing.MainWindowHandle, 9);
        SetForegroundWindow(existing.MainWindowHandle);
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
