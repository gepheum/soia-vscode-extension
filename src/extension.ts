// TODO: handle the weirdness I'm seeing with multiple workspaces, where sometimes a module just seems to stay out in the limbs
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
import { ValidationError, fromZodError } from "zod-validation-error";

export class SoiaLanguageExtension {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("soia");
    setInterval(() => {
      this.printDebug();
    }, 2000);
  }

  setFileContent(uri: string, content: string): void {
    console.log(`Setting content for ${uri}`);
    this.deleteFile(uri);
    const fileType = getFileType(uri);
    switch (fileType) {
      case "soia.yml": {
        const workspace = this.parseSoiaConfig(content, uri);
        if (workspace instanceof Workspace) {
          this.diagnosticCollection.set(vscode.Uri.parse(uri), []);
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
        const moduleWorkspace = this.findModuleWorkspace(uri);
        const moduleBundle = this.parseSoiaModule(content, uri);
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
        const moduleBundle = this.moduleBundles.get(uri);
        if (moduleBundle) {
          Workspace.removeModule(moduleBundle);
          this.moduleBundles.delete(uri);
        }
        break;
      }
      default: {
        const _: null = fileType;
      }
    }
  }

  hasFile(uri: string): boolean {
    return this.moduleBundles.has(uri) || this.workspaces.has(uri);
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
        this.setFileContent(uri, document.getText());
      } catch (error) {
        console.error(`Error setting file content for ${uri}:`, error);
      }
    }, delayMilliseconds);
    this.uriToTimeout.set(uri, timeout);
  }

  findDefinitionAt(uri: string, position: number): vscode.Location | null {
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
    const targetContent = this.moduleBundles.get(targetUri.toString())?.content;
    if (!targetContent) {
      console.warn(
        `Module ${targetUri.toString()} not found, skipping definition lookup.`,
      );
      return null;
    }
    const positionTracker = new PositionTracker(targetContent);
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
      for (const [moduleUri, moduleBundle] of this.moduleBundles.entries()) {
        Workspace.removeModule(moduleBundle);
        const newWorkspace = this.findModuleWorkspace(moduleUri);
        if (newWorkspace) {
          Workspace.addModule(moduleBundle, newWorkspace);
          this.diagnosticCollection.set(vscode.Uri.parse(moduleUri), []);
        }
      }
      for (const workspace of this.workspaces.values()) {
        workspace.scheduleResolution();
      }
      this.reassigneModulesTimeout = undefined;
    });
  }

  private parseSoiaConfig(
    content: string,
    uri: string,
  ): Workspace | ValidationError {
    let soiaConfig: SoiaConfig;
    {
      // `yaml.parse` fail with a helpful error message, no need to add context.
      const parseResult = SoiaConfig.safeParse(yaml.parse(content));
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
    return new Workspace(rootUri, this.diagnosticCollection);
  }

  private parseSoiaModule(content: string, uri: string): ModuleBundle {
    let astTree: Result<Module | null>;
    {
      const tokens = tokenizeModule(content, uri);
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
  private findModuleWorkspace(moduleUri: string): ModuleWorkspace | undefined {
    let match: Workspace | undefined;
    // !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    // TODO: rm
    let debugString = `Trying to assign ${moduleUri} to a workspace; `;
    const leftIsBetter = (left: Workspace, right: Workspace | undefined) => {
      if (right === undefined || left.rootUri.length < right.rootUri.length) {
        return true;
      }
      if (left.rootUri.length === right.rootUri.length) {
        // Completely arbitrary, just to have a consistent order.
        return left.rootUri < right.rootUri;
      }
      return false;
    };
    for (const workspace of this.workspaces.values()) {
      const { rootUri } = workspace;
      debugString += `checking workspace ${rootUri}; `;
      if (moduleUri.startsWith(rootUri) && leftIsBetter(workspace, match)) {
        match = workspace;
      }
    }
    debugString += `result: ${match?.rootUri}; `;
    console.log(debugString);
    if (!match) {
      const zeroRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0),
      );
      const diagnostic = new vscode.Diagnostic(
        zeroRange,
        "No soia workspace found; add a soia.yml file",
        vscode.DiagnosticSeverity.Warning,
      );
      this.diagnosticCollection.set(vscode.Uri.parse(moduleUri), [diagnostic]);
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

  // TODO: remove this!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  private printDebug() {
    let result = "FOoobar ";
    for (const [uri, moduleBundle] of this.moduleBundles.entries()) {
      result += `\nModuleBundle: ${uri}; modulePath:${moduleBundle.moduleWorkspace?.modulePath}; rootUri:${moduleBundle.moduleWorkspace?.workspace.rootUri};`;
    }
    for (const [uri, workspace] of this.workspaces.entries()) {
      result += `\nWorkspace: ${uri}; rootUri:${workspace.rootUri}; `;
    }
    console.log(result);
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

interface ModuleBundle {
  uri: string;
  content: string;
  readonly astTree: Result<Module | null>;
  moduleWorkspace?: ModuleWorkspace;
}

class Workspace implements ModuleParser {
  constructor(
    readonly rootUri: string,
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
    // TODO: rm!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    console.log(`Resolving workspace at ${this.rootUri}`);
    let debugString = "ZANZIBAR ";
    try {
      const moduleSet = new ModuleSet(this);
      for (const [modulePath, moduleBundle] of this.modules.entries()) {
        const parseResult = moduleSet.parseAndResolve(modulePath);
        debugString += `modulePath: ${modulePath}; uri: ${moduleBundle.uri}; errors: ${parseResult.errors.length}; `;
        this.updateDiagnostics(moduleBundle, parseResult.errors);
      }
      console.log(debugString);
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
    const { uri, content } = moduleBundle;
    if (errors.length <= 0) {
      this.diagnosticCollection.set(vscode.Uri.parse(uri), []);
    }

    const positionTracker = new PositionTracker(content);

    const diagnostics: vscode.Diagnostic[] = errors.map((error) => {
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

      this.soiaLanguageExtension.setFileContent(uri, content);
      return this.soiaLanguageExtension.findDefinitionAt(uri, offset);
    } catch (error) {
      console.error(`Error finding definition at ${position}:`, error);
      throw error;
    }
  }
}

const GLOB_PATTERN = "**/{soia.yml,*.soia}";

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
          console.log(`Document change detected: ${uriString}`);
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
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, GLOB_PATTERN),
      );

      const uriToContent = new Map<string, string>();
      for (const uri of files) {
        try {
          const text = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(text).toString("utf-8");
          console.log(`Initial scan found file: ${uri.toString()}`);
          uriToContent.set(uri.toString(), content);
        } catch (error) {
          console.error(`Failed to read file ${uri}:`, error);
        }
      }
      for (const [uri, content] of uriToContent.entries()) {
        this.soiaLanguageExtension.setFileContent(uri, content);
      }
    }
  }

  /**
   * Starts a loop that periodically runs garbage collection on all files stored
   * in `soiaLanguageExtension` and then runs a scan on the filesystem.
   */
  scheduleScanLoop(): void {
    const delayMilliseconds = 10000; // 10 seconds
    setInterval(() => this.runScanLoopIteration(), delayMilliseconds);
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

const fileContentManager = new FileContentManager(soiaLanguageExtension);

// VS Code extension activation
export async function activate(context: vscode.ExtensionContext) {
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

export function deactivate() {
  fileContentManager.dispose();
}
