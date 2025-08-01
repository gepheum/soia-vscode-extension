# Soia VSCode Extension - Development Guide

This guide explains how to test and develop the Soia language extension for Visual Studio Code.

## Method 1: Development/Testing Mode (Recommended for development)

1. **Navigate to the extension directory:**
   ```bash
   cd /Users/clementroux/Documents/Gepheum/soia/plugins/vscode
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Compile the TypeScript:**
   ```bash
   npm run compile
   ```

4. **Open the extension folder in VS Code:**
   ```bash
   code .
   ```

5. **Launch Extension Development Host:**
   - Press `F5` or go to `Run > Start Debugging`
   - This will open a new VS Code window titled "Extension Development Host"

6. **Test the extension:**
   - In the Extension Development Host window, open or create a `.soia` file
   - You should see syntax highlighting working
   - Try the "Go to Definition" feature by Ctrl/Cmd+clicking on symbols

## Method 2: Package and Install (For permanent installation)

1. **Create the icon file:**
   - You need to create `resources/soia-icon.png` (follow the instructions in `resources/ICON_INSTRUCTIONS.md`)

2. **Package the extension:**
   ```bash
   npm run package
   ```
   This creates a `.vsix` file in your directory.

3. **Install the packaged extension:**
   - Open VS Code
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "Extensions: Install from VSIX..."
   - Select the generated `.vsix` file

## Testing Features

Once the extension is running, you can test:

1. **Syntax Highlighting:**
   - Open any `.soia` file from the `examples/` directory
   - You should see keywords, strings, comments highlighted

2. **Go to Definition:**
   - Open `examples/usage.soia`
   - Ctrl/Cmd+click on imported symbols like `Point` or `Polyline`
   - It should navigate to their definitions

3. **Hover Information:**
   - Hover over symbols to see definition information

## Troubleshooting

If you encounter issues:

1. **Check the Developer Console:**
   - In Extension Development Host: `Help > Toggle Developer Tools`
   - Look for any error messages

2. **Verify compilation:**
   ```bash
   npm run compile
   ```

3. **Check if files exist:**
   - Ensure `dist/extension.js` exists after compilation
   - Ensure all example `.soia` files are present

4. **Restart Extension Development Host:**
   - Close the Extension Development Host window
   - Press `F5` again to relaunch

## Development Workflow

The Extension Development Host method is best for testing and development since it allows you to make changes and reload quickly:

1. Make changes to your TypeScript code
2. Run `npm run compile` (or use `npm run compile:watch` for automatic compilation)
3. Press `Ctrl+R` (Windows/Linux) or `Cmd+R` (Mac) in the Extension Development Host to reload
4. Test your changes

## Project Structure

```
vscode/
├── .vscode/               # VS Code configuration for development
├── examples/              # Example Soia files for testing
├── resources/             # Resources like icons
├── src/                   # Source code
│   ├── extension.ts       # Client-side extension code
│   └── server/            # Language server implementation
├── syntaxes/              # Syntax definitions
└── dist/                  # Compiled output (generated)
```