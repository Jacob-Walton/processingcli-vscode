# ProcessingCLI for VS Code

<!-- TODO: Generate grammar based on the installed Processing version -->

Run Processing sketches in Visual Studio Code with [ProcessingCLI](https://github.com/Jacob-Walton/ProcessingCLI).

This is a fork of the [Processing Foundation's VS Code extension](https://github.com/processing/processing-vscode-extension). It keeps the run and stop buttons, syntax highlighting, code suggestions and the sketchbook sidebar, but runs sketches with ProcessingCLI instead of the Processing app. Sketches start in about 0.7 seconds instead of about 2.

It is not made or endorsed by the Processing Foundation.

![Processing VS Code Extension Screenshot](.github/media/screenshot.png)

## Getting Started

### Prerequisites

- Uninstall the Processing Foundation extension and any other Processing extensions. They conflict with this one.
- You don't need Java or Processing installed. Everything runs through ProcessingCLI, which the extension downloads.

### Installation

Search for "ProcessingCLI" in the Extensions view (`Ctrl + Shift + X`, or `Cmd + Shift + X` on macOS) and install the extension published by "konpeki".

The first time you run a sketch, the extension downloads ProcessingCLI (about 125 MB) to `%LOCALAPPDATA%\ProcessingCLI` on Windows, which isn't part of a roaming profile. Downloads are available for Windows (x64), macOS (Apple Silicon) and Linux (x64). The extension checks for a newer ProcessingCLI once a day and installs it in the background, or run **Download ProcessingCLI** from the Command Palette to check now. On other platforms, or to use your own build, set `processing.cliPath`.

### Running Your First Sketch

1. Click the Processing icon in the Activity Bar on the side of the VS Code window.
2. Open a sketch from your sketchbook or from the examples.
3. Click the Run button, or press `Ctrl + R` (`Cmd + R` on macOS).

The sketch's output appears in the Processing Console panel at the bottom of VS Code, and the sketch window opens.

## Settings

Open Settings (`Ctrl + ,`, or `Cmd + ,` on macOS) and search for "Processing".

- `processing.cliPath`: Full path to your own ProcessingCLI executable. Leave it empty to use the downloaded one.
- `processing.autosave`: Saves your sketch before running it. Default: `true`.
- `processing.newWindow`: Opens sketches in a new VS Code window. If disabled, sketches open in the current window. Default: `true`.
- `processing.sketchbook`: Folder for your sketches and libraries. Leave it empty to use Processing's sketchbook, or `Documents/Processing`.
- `processing.terminalPath`: Puts ProcessingCLI on the `PATH` in VS Code's terminals, so you can run `ProcessingCLI .` in a sketch folder. Default: `true`.

## Known Issues

* Some Processing constants (like `PI`, `RGB`, `DEGREES`) are not highlighted.

## Troubleshooting

If a sketch won't run, run **Download ProcessingCLI** again.

If code suggestions don't work, remove any other Processing extensions and restart VS Code. If you still have problems, open an issue on [GitHub](https://github.com/Jacob-Walton/processingcli-vscode/issues).

## License

See [LICENSE](LICENSE.md). This project is a fork of the [Processing VS Code extension](https://github.com/processing/processing-vscode-extension) by the Processing Foundation.

For Processing's own licensing, see the Processing [README](https://github.com/processing/processing4?tab=readme-ov-file).
