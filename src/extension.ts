import type {
  Module,
  MutableModule,
  RecordKey,
  RecordLocation,
  Result,
  SkirError,
  Token,
} from "skir-internal";
import {
  checkCompatibility,
  getTokenForBreakingChange,
} from "skir/dist/compatibility_checker.js";
import { parseSkirConfig, SkirConfigError } from "skir/dist/config_parser.js";
import { findDefinition } from "skir/dist/definition_finder.js";
import { getShortMessageForBreakingChange } from "skir/dist/error_renderer.js";
import { formatModule } from "skir/dist/formatter.js";
import { ModuleParser, ModuleSet } from "skir/dist/module_set.js";
import { parseModule } from "skir/dist/parser.js";
import { snapshotFileContentToModuleSet } from "skir/dist/snapshotter.js";
import { tokenizeModule } from "skir/dist/tokenizer.js";
import * as vscode from "vscode";

// Formatting provider for Skir files
class SkirFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
  ): vscode.TextEdit[] {
    const unformattedCode = document.getText();
    const tokens = tokenizeModule(unformattedCode, "");
    if (tokens.errors.length) {
      return [];
    }
    // Make sure no parsing errors exist before formatting
    if (parseModule(tokens.result, "lenient").errors.length) {
      return [];
    }

    const textEdits = formatModule(tokens.result).textEdits;
    return textEdits.map((edit) =>
      vscode.TextEdit.replace(
        new vscode.Range(
          document.positionAt(edit.oldStart),
          document.positionAt(edit.oldEnd),
        ),
        edit.newText,
      ),
    );
  }

  dispose(): void {}
}

export class SkirLanguageExtension {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("skir");
  }

  setFileContent(uri: string, content: FileContent): void {
    this.deleteFile(uri);
    const fileType = getFileType(uri);
    switch (fileType) {
      case "skir.yml": {
        const workspace = this.doParseSkirConfig(content, uri);
        if (workspace instanceof Workspace) {
          this.workspaces.set(uri, workspace);
          this.reassignModulesToWorkspaces();
        } else {
          const errors = workspace;
          const zeroRange = new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(0, 0),
          );
          const diagnostics = errors.map(
            (e) =>
              new vscode.Diagnostic(
                e.range
                  ? new vscode.Range(
                      new vscode.Position(
                        e.range.start.lineNumber - 1,
                        e.range.start.colNumber - 1,
                      ),
                      new vscode.Position(
                        e.range.end.lineNumber - 1,
                        e.range.end.colNumber - 1,
                      ),
                    )
                  : zeroRange,
                e.message,
                vscode.DiagnosticSeverity.Error,
              ),
          );
          this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics);
        }
        break;
      }
      case "*.skir": {
        const moduleBundle = this.parseSkirModule(content, uri);
        const moduleWorkspace = this.findModuleWorkspace(moduleBundle);
        this.moduleBundles.set(uri, moduleBundle);
        if (moduleWorkspace) {
          Workspace.addModule(moduleBundle, moduleWorkspace);
        }
        break;
      }
      case "skir-snapshot.json": {
        const snapshot = snapshotFileContentToModuleSet(content.content);
        if (snapshot instanceof ModuleSet) {
          // Find the workspace for this snapshot
          const workspaceUri = uri.replace(
            /\/skir-snapshot\.json$/,
            "/skir.yml",
          );
          const workspace = this.workspaces.get(workspaceUri);
          if (workspace) {
            workspace.lastSnapshot = snapshot;
            workspace.scheduleResolution();
          } else {
            console.error(`No workspace found for snapshot file ${uri}`);
          }
        } else {
          console.error(`Failed to parse snapshot file ${uri}`);
        }
        break;
      }
      default: {
        const _: null = fileType;
      }
    }
  }

  getFileContent(uri: string): FileContent | undefined {
    return (
      this.moduleBundles.get(uri)?.content ||
      this.workspaces.get(uri)?.yamlContent
    );
  }

  deleteFile(uri: string): void {
    // Clear diagnostics for this file
    this.diagnosticCollection.delete(vscode.Uri.parse(uri));

    const fileType = getFileType(uri);
    switch (fileType) {
      case "skir.yml": {
        if (this.workspaces.delete(uri)) {
          this.reassignModulesToWorkspaces();
        }
        break;
      }
      case "*.skir": {
        // Cancel the `scheduledSetFileContent` if it exists
        const timeout = this.uriToTimeout.get(uri);
        if (timeout) {
          clearTimeout(timeout);
          this.uriToTimeout.delete(uri);
        }
        const moduleBundle = this.moduleBundles.get(uri);
        if (moduleBundle) {
          // Remove the module from its workspace
          Workspace.removeModule(moduleBundle);
          // Remove the module bundle from the map
          this.moduleBundles.delete(uri);
        }
        break;
      }
      case "skir-snapshot.json": {
        const workspaceUri = uri.replace(/\/skir-snapshot\.json$/, "/skir.yml");
        const workspace = this.workspaces.get(workspaceUri);
        if (workspace) {
          workspace.lastSnapshot = undefined;
          workspace.scheduleResolution();
        }
        break;
      }
      default: {
        const _: null = fileType;
      }
    }
  }

  scheduleSetFileContent(uri: string, document: vscode.TextDocument): void {
    const oldTimeout = this.uriToTimeout.get(uri);
    if (oldTimeout) {
      clearTimeout(oldTimeout);
    }
    const delayMilliseconds = 100;
    const timeout = setTimeout(() => {
      this.uriToTimeout.delete(uri);
      try {
        this.setFileContent(uri, {
          content: document.getText(),
          lastModified: Date.now(),
        });
      } catch (error) {
        console.error(`Error setting file content for ${uri}:`, error);
      }
    }, delayMilliseconds);
    this.uriToTimeout.set(uri, timeout);
  }

  findDefinitionAt(uri: string, position: number): vscode.Location | null {
    console.log(`Finding definition at ${uri}:${position}`);
    const moduleBundle = this.moduleBundles.get(uri);
    if (!moduleBundle) {
      return null;
    }
    const { moduleWorkspace } = moduleBundle;
    if (!moduleWorkspace) {
      return null;
    }
    const { workspace } = moduleWorkspace;
    workspace.revolveNow();

    const module = moduleBundle.astTree.result;
    if (!module) {
      return null;
    }
    const definitionMatch = findDefinition(module, position);
    if (!definitionMatch) {
      return null;
    }

    // Convert DefinitionMatch to vscode.Location
    const targetUri = vscode.Uri.parse(
      new URL(definitionMatch.modulePath, workspace.srcUri).href,
    );
    const target = this.moduleBundles.get(targetUri.toString());
    if (!target) {
      console.warn(
        `Module ${targetUri.toString()} not found, skipping definition lookup.`,
      );
      return null;
    }
    const { positionTracker } = target;
    const targetPosition = positionTracker.getPosition(
      definitionMatch.position,
    );
    console.log(
      `Found definition at ${targetUri}:${targetPosition.line}:${targetPosition.column}`,
    );
    return new vscode.Location(
      targetUri,
      new vscode.Position(targetPosition.line, targetPosition.column),
    );
  }

  /** Get module bundle for a given URI (used by DocumentLinkProvider) */
  getModuleBundle(uri: string): ModuleBundle | undefined {
    return this.moduleBundles.get(uri);
  }

  private reassignModulesToWorkspaces(): void {
    if (this.reassigneModulesTimeout) {
      // Already scheduled, do nothing.
      return;
    }
    this.reassigneModulesTimeout = setTimeout(() => {
      console.log("Reassigning modules to workspaces...");
      for (const moduleBundle of this.moduleBundles.values()) {
        Workspace.removeModule(moduleBundle);
        const newWorkspace = this.findModuleWorkspace(moduleBundle);
        if (newWorkspace) {
          Workspace.addModule(moduleBundle, newWorkspace);
        }
      }
      for (const workspace of this.workspaces.values()) {
        workspace.scheduleResolution();
      }
      this.reassigneModulesTimeout = undefined;
    });
  }

  private doParseSkirConfig(
    content: FileContent,
    uri: string,
  ): Workspace | readonly SkirConfigError[] {
    const skirConfigResult = parseSkirConfig(content.content);
    if (skirConfigResult.errors.length > 0) {
      return skirConfigResult.errors;
    }

    const skirConfig = skirConfigResult.skirConfig!;
    let srcUri = new URL("skir-src", uri).href;
    if (!srcUri.endsWith("/")) {
      srcUri += "/";
    }
    return new Workspace(srcUri, content, this.diagnosticCollection);
  }

  private parseSkirModule(content: FileContent, uri: string): ModuleBundle {
    let astTree: Result<Module | null>;
    {
      const tokens = tokenizeModule(content.content, uri);
      if (tokens.errors.length !== 0) {
        astTree = {
          result: null,
          errors: tokens.errors,
        };
      } else {
        astTree = parseModule(tokens.result, "lenient");
      }
    }
    const positionTracker = new PositionTracker(content.content);
    return { uri, content, positionTracker, astTree };
  }

  /** Finds the workspace which contains the given module URI. */
  private findModuleWorkspace(
    moduleBundle: ModuleBundle,
  ): ModuleWorkspace | undefined {
    let match: Workspace | undefined;
    const leftIsBetter = (
      left: Workspace,
      right: Workspace | undefined,
    ): boolean => {
      if (right === undefined || left.srcUri.length < right.srcUri.length) {
        return true;
      }
      if (left.srcUri.length === right.srcUri.length) {
        // Completely arbitrary, just to have a consistent order.
        return left.srcUri < right.srcUri;
      }
      return false;
    };
    const moduleUri = moduleBundle.uri;
    for (const workspace of this.workspaces.values()) {
      const { srcUri } = workspace;
      if (moduleUri.startsWith(srcUri) && leftIsBetter(workspace, match)) {
        match = workspace;
      }
    }
    if (!match) {
      // Raise a warning that no workspace was found.
      // Also include all the lexical and parsing errors.
      const warning = new vscode.Diagnostic(
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
        "No skir workspace found; add a skir.yml file",
        vscode.DiagnosticSeverity.Warning,
      );
      const errors = moduleBundle.astTree.errors.filter(
        (error) => !error.errorIsInOtherModule,
      );
      const diagnostics = [warning].concat(
        errorsToDiagnostics(errors, moduleBundle),
      );
      this.diagnosticCollection.set(vscode.Uri.parse(moduleUri), diagnostics);
      return undefined;
    }
    return {
      workspace: match,
      modulePath: match.moduleUriToPath(moduleUri),
    };
  }

  /** Removes all the files which seem to no longer exist on the filesystem. */
  async runGarbageCollection(): Promise<void> {
    const uris = Array.from(this.moduleBundles.keys()).concat(
      Array.from(this.workspaces.keys()),
    );
    for (const uri of uris) {
      let isFile = false;
      try {
        const stat = await vscode.workspace.fs
          .stat(vscode.Uri.parse(uri))
          .then();
        isFile = stat.type === vscode.FileType.File;
      } catch (_error) {
        // Do nothing, the file does not exist.
      }
      if (!isFile) {
        this.deleteFile(uri);
      }
    }
  }

  private reassigneModulesTimeout?: NodeJS.Timeout;
  private readonly moduleBundles = new Map<string, ModuleBundle>(); // key: file URI
  private readonly workspaces = new Map<string, Workspace>(); // key: file URI
  private readonly uriToTimeout = new Map<string, NodeJS.Timeout>();
}

function getFileType(
  uri: string,
): "skir.yml" | "skir-snapshot.json" | "*.skir" | null {
  if (uri.endsWith("/skir.yml")) {
    return "skir.yml";
  } else if (uri.endsWith("/skir-snapshot.json")) {
    return "skir-snapshot.json";
  } else if (uri.endsWith(".skir")) {
    return "*.skir";
  } else {
    return null;
  }
}

interface ModuleWorkspace {
  readonly workspace: Workspace;
  readonly modulePath: string;
}

interface FileContent {
  content: string;
  /** Mtime */
  lastModified: number;
}

interface ModuleBundle {
  readonly uri: string;
  readonly content: FileContent;
  readonly positionTracker: PositionTracker;
  readonly astTree: Result<Module | null>;
  moduleWorkspace?: ModuleWorkspace;
}

class Workspace implements ModuleParser {
  constructor(
    readonly srcUri: string,
    readonly yamlContent: FileContent,
    private diagnosticCollection: vscode.DiagnosticCollection,
  ) {}

  private readonly mutableRecordMap = new Map<RecordKey, RecordLocation>();
  // key: module path
  private readonly modules = new Map<string, ModuleBundle>();
  private scheduledResolution?: {
    timeout: NodeJS.Timeout;
    promise: Promise<void>;
    callback: () => void;
  };
  lastSnapshot?: ModuleSet;

  static addModule(
    moduleBundle: ModuleBundle,
    moduleWorkspace: ModuleWorkspace,
  ): void {
    // If the module was already in a workspace, remove it from the old workspace.
    Workspace.removeModule(moduleBundle);
    const { workspace } = moduleWorkspace;
    moduleBundle.moduleWorkspace = moduleWorkspace;
    workspace.modules.set(moduleWorkspace.modulePath, moduleBundle);
    for (const record of moduleBundle.astTree.result?.records || []) {
      workspace.mutableRecordMap.set(record.record.key, record);
    }
    workspace.scheduleResolution();
  }

  static removeModule(moduleBundle: ModuleBundle): void {
    const { moduleWorkspace } = moduleBundle;
    if (!moduleWorkspace) {
      return;
    }
    const { workspace } = moduleWorkspace;
    workspace.modules.delete(moduleWorkspace.modulePath);
    for (const record of moduleBundle.astTree.result?.records || []) {
      workspace.mutableRecordMap.delete(record.record.key);
    }
    moduleBundle.moduleWorkspace = undefined;
    workspace.scheduleResolution();
  }

  parseModule(modulePath: string): Result<MutableModule | null> {
    const moduleBundle = this.modules.get(modulePath);
    if (!moduleBundle) {
      return {
        result: null,
        errors: [],
      };
    }
    return moduleBundle.astTree;
  }

  scheduleResolution(): void {
    if (this.scheduledResolution) {
      clearTimeout(this.scheduledResolution.timeout);
    }
    const delayMilliseconds = 500;
    const timeout = setTimeout(() => {
      this.resolve();
    }, delayMilliseconds);
    const scheduledResolution = {
      timeout,
      promise: Promise.resolve(),
      callback: (() => {
        throw new Error("callback not set");
      }) as () => void,
    };
    scheduledResolution.promise = new Promise<void>((resolve) => {
      scheduledResolution.callback = resolve;
    });
    this.scheduledResolution = scheduledResolution;
  }

  get resolutionDone(): Promise<void> {
    if (this.scheduledResolution) {
      return this.scheduledResolution.promise;
    }
    return Promise.resolve();
  }

  /** Force a resolution to happen *now*, cancel any scheduled resolution. */
  revolveNow(): void {
    if (this.scheduledResolution) {
      clearTimeout(this.scheduledResolution.timeout);
    }
    this.resolve();
  }

  /**
   * Synchronously performs type resolution (and validation).
   * Stores the errors in every module bundle.
   */
  private resolve(): void {
    const { lastSnapshot, modules } = this;
    try {
      const moduleSet = new ModuleSet(this);
      let anyError = false;
      for (const [modulePath, moduleBundle] of modules.entries()) {
        const parseResult = moduleSet.parseAndResolve(modulePath);
        const errors = parseResult.errors.filter(
          (error) => !error.errorIsInOtherModule,
        );
        anyError = anyError || errors.length > 0;
        this.updateDiagnostics(moduleBundle, errors);
      }
      if (anyError || !lastSnapshot) {
        return;
      }
      // Look for breaking changes since the last snapshot.
      const breakingChanges = checkCompatibility({
        before: lastSnapshot,
        after: moduleSet,
      });
      const moduleUriToDiagnostics = new Map<string, vscode.Diagnostic[]>();
      for (const breakingChange of breakingChanges) {
        const token = getTokenForBreakingChange(breakingChange);
        if (!token) {
          // Some breaking change errors can't be tied to a specific token in
          // the new snapshot. We skip them.
          continue;
        }
        const moduleUri = token.line.modulePath; // Because it's actually a URI
        const module = modules.get(this.moduleUriToPath(moduleUri));
        if (!module) {
          // Should not happen.
          console.error(`Module not found: ${moduleUri}`);
          continue;
        }
        const { positionTracker } = module!;
        const range = getRangeForToken(token, positionTracker);
        const message =
          "Breaking change: " +
          getShortMessageForBreakingChange(breakingChange, lastSnapshot);

        const diagnostics = moduleUriToDiagnostics.get(moduleUri) || [];
        if (diagnostics.length <= 0) {
          moduleUriToDiagnostics.set(moduleUri, diagnostics);
        }
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            message,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
      for (const [moduleUri, diagnostics] of moduleUriToDiagnostics.entries()) {
        const uri = vscode.Uri.parse(moduleUri);
        this.diagnosticCollection.set(uri, diagnostics);
      }
    } catch (error) {
      console.error("Error during resolution:", error);
    } finally {
      this.scheduledResolution?.callback();
      this.scheduledResolution = undefined;
    }
  }

  private updateDiagnostics(
    moduleBundle: ModuleBundle,
    errors: readonly SkirError[],
  ): void {
    const { uri } = moduleBundle;
    const diagnostics = errorsToDiagnostics(errors, moduleBundle);
    this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics);
  }

  moduleUriToPath(uri: string): string {
    return uri.substring(this.srcUri.length);
  }
}

const skirLanguageExtension = new SkirLanguageExtension();

class SkirDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly skirLanguageExtension: SkirLanguageExtension) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | null {
    try {
      const offset = document.offsetAt(position);
      const uri = document.uri.toString();
      const content = document.getText();

      this.skirLanguageExtension.setFileContent(uri, {
        content,
        lastModified: Date.now(),
      });
      return this.skirLanguageExtension.findDefinitionAt(uri, offset);
    } catch (error) {
      console.error(`Error finding definition at ${position}:`, error);
      throw error;
    }
  }
}

class FileContentManager {
  private readonly documentChangeListener: vscode.Disposable;
  private disposed = false;

  constructor(private readonly skirLanguageExtension: SkirLanguageExtension) {
    // Listen for document changes (unsaved edits)
    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        const uri = event.document.uri;
        const uriString = uri.toString();

        // Only handle skir.yml, skir-snapshot.json and .skir files
        if (getFileType(uriString)) {
          this.skirLanguageExtension.scheduleSetFileContent(
            uriString,
            event.document,
          );
        }
      },
    );

    this.scheduleScanLoop();
  }

  async runScan(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    for (const folder of workspaceFolders) {
      let files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(
          folder,
          "**/{skir.yml,*.skir,skir-snapshot.json}",
        ),
      );
      // Make sure skir.yml files are processed first
      files = files.sort((a, b) => {
        const aIsSkirYml = a.toString().endsWith("/skir.yml");
        const bIsSkirYml = b.toString().endsWith("/skir.yml");

        if (aIsSkirYml && !bIsSkirYml) {
          return -1;
        }
        if (!aIsSkirYml && bIsSkirYml) {
          return 1;
        }
        return 0;
      });
      for (const uri of files) {
        const uriString = uri.toString();
        const oldContent = this.skirLanguageExtension.getFileContent(uriString);
        let mtime: number | undefined;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          mtime = stat.mtime;
        } catch (error) {
          console.error(`Failed to stat file ${uri}:`, error);
          continue;
        }
        if (
          oldContent &&
          oldContent.lastModified &&
          oldContent.lastModified >= mtime
        ) {
          // No need to read the file again, it hasn't changed.
          continue;
        }
        let content: string;
        try {
          const text = await vscode.workspace.fs.readFile(uri);
          content = Buffer.from(text).toString("utf-8");
        } catch (error) {
          console.error(`Failed to read file ${uri}:`, error);
          continue;
        }
        if (oldContent && oldContent.content === content) {
          // No need to update, content is the same.
          continue;
        }
        this.skirLanguageExtension.setFileContent(uriString, {
          content,
          lastModified: mtime,
        });
      }
    }
  }

  /**
   * Starts a loop that periodically runs garbage collection on all files stored
   * in `skirLanguageExtension` and then runs a scan on the filesystem.
   */
  scheduleScanLoop(): void {
    const delayMilliseconds = 30000; // 30 seconds
    setTimeout(() => this.runScanLoopIteration(), delayMilliseconds);
  }

  private async runScanLoopIteration(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.skirLanguageExtension.runGarbageCollection();
      await this.runScan();
    } catch (error) {
      console.error("Error during scheduled scan:", error);
    }
    this.scheduleScanLoop(); // Reschedule the next scan
  }

  dispose(): void {
    this.documentChangeListener.dispose();
    this.disposed = true;
  }
}

/** Gets the (line number, column number) for a given offset. */
class PositionTracker {
  private readonly lineBreaks: number[];

  constructor(private readonly text: string) {
    this.text = text;
    this.lineBreaks = PositionTracker.findLineBreaks(text);
  }

  private static findLineBreaks(text: string): number[] {
    const breaks: number[] = [0]; // Start of first line
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "\n") {
        breaks.push(i + 1);
      } else if (char === "\r") {
        // Handle \r\n (don't double-count)
        if (i + 1 < text.length && text[i + 1] === "\n") {
          breaks.push(i + 2);
          i++; // Skip the \n
        } else {
          // Standalone \r
          breaks.push(i + 1);
        }
      }
    }
    return breaks;
  }

  getPosition(offset: number): { line: number; column: number } {
    if (offset < 0 || offset > this.text.length) {
      throw new Error(
        `Offset ${offset} is out of bounds (text length: ${this.text.length})`,
      );
    }

    // Binary search to find the line containing this offset
    let left = 0;
    let right = this.lineBreaks.length - 1;
    let lineIndex = 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);

      if (this.lineBreaks[mid] <= offset) {
        lineIndex = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    // If we're beyond the last line break, check if there's a next one
    if (
      lineIndex < this.lineBreaks.length - 1 &&
      offset >= this.lineBreaks[lineIndex + 1]
    ) {
      lineIndex++;
    }

    const lineStart = this.lineBreaks[lineIndex];
    const column = offset - lineStart;

    return { line: lineIndex, column };
  }
}

function errorsToDiagnostics(
  errors: readonly SkirError[],
  moduleBundle: ModuleBundle,
): vscode.Diagnostic[] {
  const { positionTracker } = moduleBundle;
  return errors.map(
    (error) =>
      new vscode.Diagnostic(
        getRangeForToken(error.token, positionTracker),
        error.message || `expected: ${error.expected}`,
        vscode.DiagnosticSeverity.Error,
      ),
  );
}

function getRangeForToken(
  token: Token,
  positionTracker: PositionTracker,
): vscode.Range {
  const startPos = positionTracker.getPosition(token.position);
  const endPos = positionTracker.getPosition(
    token.position + token.text.length,
  );
  return new vscode.Range(
    new vscode.Position(startPos.line, startPos.column),
    new vscode.Position(endPos.line, endPos.column),
  );
}

const fileContentManager = new FileContentManager(skirLanguageExtension);

// VS Code extension activation
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("Skir Language Support extension is now active");

  // Perform initial scan of workspace
  await fileContentManager.runScan();

  // Register definition provider for skir files
  const definitionProvider = new SkirDefinitionProvider(skirLanguageExtension);
  const definitionDisposable = vscode.languages.registerDefinitionProvider(
    { scheme: "file", language: "skir" },
    definitionProvider,
  );

  // Register document formatting provider for skir files
  const formattingProvider = new SkirFormattingProvider();
  const formattingDisposable =
    vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: "file", language: "skir" },
      formattingProvider,
    );

  // Register format on save handler
  const formatOnSaveDisposable = vscode.workspace.onWillSaveTextDocument(
    async (event) => {
      if (event.document.languageId === "skir") {
        // Format the document before saving
        const edits = formattingProvider.provideDocumentFormattingEdits(
          event.document,
        );

        if (edits && edits.length > 0) {
          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.set(event.document.uri, edits);
          event.waitUntil(vscode.workspace.applyEdit(workspaceEdit));
        }
      }
    },
  );

  // Add to subscriptions for proper cleanup
  context.subscriptions.push(
    fileContentManager,
    definitionDisposable,
    formattingProvider,
    formattingDisposable,
    formatOnSaveDisposable,
  );
}

export function deactivate(): void {
  fileContentManager.dispose();
}
