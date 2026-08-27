# DeepTutor Windows desktop wrapper

This WPF host starts the local DeepTutor service and opens it inside WebView2,
so users launch DeepTutor like a normal Windows application instead of keeping
a browser tab open. It also loads isolated desktop plugins from the adjacent
`plugins/` directory.

## Expected installed layout

```text
DeepTutorApp/
├── .venv/
├── app/                  # published desktop executable
├── data/                 # local DeepTutor data (never commit)
├── desktop/              # this source project
├── plugin-data/          # private plugin state/corpus (never commit)
└── plugins/              # distributable plugin source
```

The executable finds the application root relative to itself, starts
`.venv/Scripts/deeptutor.exe start --home <root>`, and serves only on
`127.0.0.1:3782`.

## Build

Requires the .NET 10 SDK on Windows:

```powershell
dotnet restore desktop/DeepTutor.Desktop.csproj
dotnet publish desktop/DeepTutor.Desktop.csproj -c Release -r win-x64 -o app
```

Do not commit `app/`, `desktop/bin/`, `desktop/obj/`, `data/`, or
`plugin-data/`. They contain generated output or local user data.

## Desktop plugin boundary

`DesktopPluginHost` accepts only the plugin's own state and files below
`plugin-data/<plugin-id>/dna/`. File types are restricted to JSON, Markdown,
and text; paths are normalized and checked against traversal. The style-writer
plugin therefore remains removable without writing to DeepTutor's global
memory store.
