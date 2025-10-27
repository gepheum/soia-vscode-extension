import { SoiaConfig } from "soiac/dist/config.js";
import { findDefinition } from "soiac/dist/definition_finder.js";
import { ModuleParser, ModuleSet } from "soiac/dist/module_set.js";
import { parseModule } from "soiac/dist/parser.js";
import { tokenizeModule } from "soiac/dist/tokenizer.js";
import type {
  Module,
  MutableModule,
  RecordKey,
  RecordLocation,
  Result,
  SoiaError,
} from "soiac/dist/types";
import * as vscode from "vscode";
import * as yaml from "yaml";
import { fromZodError, ValidationError } from "zod-validation-error";

export class SoiaLanguageExtension {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("soia");
  }

  setFileContent(uri: string, content: FileContent): void {
    this.deleteFile(uri);
    const fileType = getFileType(uri);
    switch (fileType) {
      case "soia.yml": {
        const workspace = this.parseSoiaConfig(content, uri);
        if (workspace instanceof Workspace) {
          this.workspaces.set(uri, workspace);
          this.reassignModulesToWorkspaces();
        } else {
          const validationError = workspace;
          const zeroRange = new vscode.Range(
            new vscode.Position(0, 0),
            new vscode.Position(0, 0),
          );
          const diagnostic = new vscode.Diagnostic(
            zeroRange,
            validationError.message,
            vscode.DiagnosticSeverity.Error,
          );
          this.diagnosticCollection.set(vscode.Uri.parse(uri), [diagnostic]);
        }
        break;
      }
      case "*.soia": {
        const moduleBundle = this.parseSoiaModule(content, uri);
        const moduleWorkspace = this.findModuleWorkspace(moduleBundle);
        this.moduleBundles.set(uri, moduleBundle);
        if (moduleWorkspace) {
          Workspace.addModule(moduleBundle, moduleWorkspace);
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
      case "soia.yml": {
        if (this.workspaces.delete(uri)) {
          this.reassignModulesToWorkspaces();
        }
        break;
      }
      case "*.soia": {
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
      new URL(definitionMatch.modulePath, workspace.rootUri).href,
    );
    const target = this.moduleBundles.get(targetUri.toString());
    if (!target) {
      console.warn(
        `Module ${targetUri.toString()} not found, skipping definition lookup.`,
      );
      return null;
    }
    const positionTracker = new PositionTracker(target.content.content);
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

  private parseSoiaConfig(
    content: FileContent,
    uri: string,
  ): Workspace | ValidationError {
    let soiaConfig: SoiaConfig;
    {
      // `yaml.parse` fail with a helpful error message, no need to add context.
      const parseResult = SoiaConfig.safeParse(yaml.parse(content.content));
      if (parseResult.success) {
        soiaConfig = parseResult.data;
      } else {
        return fromZodError(parseResult.error);
      }
    }

    let rootUri = new URL(soiaConfig.srcDir || ".", uri).href;
    if (!rootUri.endsWith("/")) {
      rootUri += "/";
    }
    return new Workspace(rootUri, content, this.diagnosticCollection);
  }

  private parseSoiaModule(content: FileContent, uri: string): ModuleBundle {
    let astTree: Result<Module | null>;
    {
      const tokens = tokenizeModule(content.content, uri);
      if (tokens.errors.length !== 0) {
        astTree = {
          result: null,
          errors: tokens.errors,
        };
      } else {
        astTree = parseModule(tokens.result, uri);
      }
    }
    return { uri, content, astTree };
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
      if (right === undefined || left.rootUri.length < right.rootUri.length) {
        return true;
      }
      if (left.rootUri.length === right.rootUri.length) {
        // Completely arbitrary, just to have a consistent order.
        return left.rootUri < right.rootUri;
      }
      return false;
    };
    const moduleUri = moduleBundle.uri;
    for (const workspace of this.workspaces.values()) {
      const { rootUri } = workspace;
      if (moduleUri.startsWith(rootUri) && leftIsBetter(workspace, match)) {
        match = workspace;
      }
    }
    if (!match) {
      // Raise a warning that no workspace was found.
      // Also include all the lexical and parsing errors.
      const warning = new vscode.Diagnostic(
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
        "No soia workspace found; add a soia.yml file",
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
      modulePath: moduleUri.substring(match.rootUri.length),
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
      } catch (error) {
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

function getFileType(uri: string): "soia.yml" | "*.soia" | null {
  if (uri.endsWith("/soia.yml")) {
    return "soia.yml";
  } else if (uri.endsWith(".soia")) {
    return "*.soia";
  }
  return null;
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
  uri: string;
  content: FileContent;
  readonly astTree: Result<Module | null>;
  moduleWorkspace?: ModuleWorkspace;
}

class Workspace implements ModuleParser {
  constructor(
    readonly rootUri: string,
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
    try {
      const moduleSet = new ModuleSet(this);
      for (const [modulePath, moduleBundle] of this.modules.entries()) {
        const parseResult = moduleSet.parseAndResolve(modulePath);
        const errors = parseResult.errors.filter(
          (error) => !error.errorIsInOtherModule,
        );
        this.updateDiagnostics(moduleBundle, errors);
      }
    } catch (error) {
      console.error(`Error during resolution:`, error);
    } finally {
      this.scheduledResolution?.callback();
      this.scheduledResolution = undefined;
    }
  }

  private updateDiagnostics(
    moduleBundle: ModuleBundle,
    errors: readonly SoiaError[],
  ): void {
    const { uri } = moduleBundle;
    if (errors.length <= 0) {
      this.diagnosticCollection.set(vscode.Uri.parse(uri), []);
    }
    const diagnostics = errorsToDiagnostics(errors, moduleBundle);
    this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics);
  }
}

const soiaLanguageExtension = new SoiaLanguageExtension();

class SoiaDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly soiaLanguageExtension: SoiaLanguageExtension) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | null {
    try {
      const offset = document.offsetAt(position);
      const uri = document.uri.toString();
      const content = document.getText();

      this.soiaLanguageExtension.setFileContent(uri, {
        content,
        lastModified: Date.now(),
      });
      return this.soiaLanguageExtension.findDefinitionAt(uri, offset);
    } catch (error) {
      console.error(`Error finding definition at ${position}:`, error);
      throw error;
    }
  }
}

class FileContentManager {
  private readonly documentChangeListener: vscode.Disposable;
  private disposed = false;

  constructor(private readonly soiaLanguageExtension: SoiaLanguageExtension) {
    // Listen for document changes (unsaved edits)
    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        const uri = event.document.uri;
        const uriString = uri.toString();

        // Only handle soia.yml and .soia files
        if (getFileType(uriString)) {
          this.soiaLanguageExtension.scheduleSetFileContent(
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
        new vscode.RelativePattern(folder, "**/{soia.yml,*.soia}"),
      );
      // Make sure soia.yml files are processed first
      files = files.sort((a, b) => {
        const aIsSoiaYml = a.toString().endsWith("/soia.yml");
        const bIsSoiaYml = b.toString().endsWith("/soia.yml");

        if (aIsSoiaYml && !bIsSoiaYml) {
          return -1;
        }
        if (!aIsSoiaYml && bIsSoiaYml) {
          return 1;
        }
        return 0;
      });
      for (const uri of files) {
        const uriString = uri.toString();
        const oldContent = this.soiaLanguageExtension.getFileContent(uriString);
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
        this.soiaLanguageExtension.setFileContent(uriString, {
          content,
          lastModified: mtime,
        });
      }
    }
  }

  /**
   * Starts a loop that periodically runs garbage collection on all files stored
   * in `soiaLanguageExtension` and then runs a scan on the filesystem.
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
      await this.soiaLanguageExtension.runGarbageCollection();
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
  errors: readonly SoiaError[],
  moduleBundle: ModuleBundle,
): vscode.Diagnostic[] {
  const positionTracker = new PositionTracker(moduleBundle.content.content);
  return errors.map((error) => {
    const { token } = error;
    const startPosition = positionTracker.getPosition(token.position);
    const endPosition = positionTracker.getPosition(
      token.position + token.text.length,
    );
    const range = new vscode.Range(
      new vscode.Position(startPosition.line, startPosition.column),
      new vscode.Position(endPosition.line, endPosition.column),
    );

    return new vscode.Diagnostic(
      range,
      error.message || `expected: ${error.expected}`,
      vscode.DiagnosticSeverity.Error,
    );
  });
}

const fileContentManager = new FileContentManager(soiaLanguageExtension);

// VS Code extension activation
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("Soia Language Support extension is now active");

  // Perform initial scan of workspace
  await fileContentManager.runScan();

  // Register definition provider for soia files
  const definitionProvider = new SoiaDefinitionProvider(soiaLanguageExtension);
  const definitionDisposable = vscode.languages.registerDefinitionProvider(
    { scheme: "file", language: "soia" },
    definitionProvider,
  );

  // Add to subscriptions for proper cleanup
  context.subscriptions.push(fileContentManager, definitionDisposable);
}

export function deactivate(): void {
  fileContentManager.dispose();
}
