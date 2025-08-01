// TODO: diagnostics for invalid soia.yml files
// TODO: jump to definition
import { SoiaConfig } from "soiac/dist/config.js";
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
import { fromZodError } from "zod-validation-error";

export class LanguageExtension {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("soia");
  }

  setFileContent(uri: string, content: string): void {
    console.log(`Setting content for ${uri}`);
    this.deleteFile(uri);
    const fileType = getFileType(uri);
    switch (fileType) {
      case "soia.yml": {
        const workspace = this.parseSoiaConfig(content, uri);
        if (workspace) {
          this.workspaces.set(uri, workspace);
          this.reassignModulesToWorkspaces(uri);
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
    const fileType = getFileType(uri);
    switch (fileType) {
      case "soia.yml": {
        if (this.workspaces.delete(uri)) {
          this.reassignModulesToWorkspaces(uri);
        }
        break;
      }
      case "*.soia": {
        const moduleBundle = this.moduleBundles.get(uri);
        if (moduleBundle) {
          Workspace.removeModule(moduleBundle);
          this.moduleBundles.delete(uri);
        }
        // Clear diagnostics for this file
        this.diagnosticCollection.delete(vscode.Uri.parse(uri));
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
        this.setFileContent(uri, document.getText());
      } catch (error) {
        console.error(`Error setting file content for ${uri}:`, error);
      }
    }, delayMilliseconds);
    this.uriToTimeout.set(uri, timeout);
  }

  private reassignModulesToWorkspaces(deletedUri: string): void {
    if (this.reassigneModulesTimeout) {
      // Already scheduled, do nothing.
      return;
    }
    this.reassigneModulesTimeout = setTimeout(() => {
      for (const [moduleUri, moduleBundle] of this.moduleBundles.entries()) {
        Workspace.removeModule(moduleBundle);
        const newWorkspace = this.findModuleWorkspace(moduleUri);
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

  private parseSoiaConfig(content: string, uri: string): Workspace | null {
    let soiaConfig: SoiaConfig;
    {
      // `yaml.parse` fail with a helpful error message, no need to add context.
      const parseResult = SoiaConfig.safeParse(yaml.parse(content));
      if (parseResult.success) {
        soiaConfig = parseResult.data;
      } else {
        const validationError = fromZodError(parseResult.error);
        console.error(
          `Error parsing soia.yml at ${uri}:`,
          validationError.message,
        );
        return null;
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
      if (moduleUri.startsWith(rootUri) && leftIsBetter(workspace, match)) {
        match = workspace;
      }
    }
    if (!match) {
      return undefined;
    }
    return {
      workspace: match,
      modulePath: moduleUri.substring(match.rootUri.length),
    };
  }

  private reassigneModulesTimeout?: NodeJS.Timeout;
  private readonly moduleBundles = new Map<string, ModuleBundle>(); // key: file URI
  private readonly workspaces = new Map<string, Workspace>(); // key: file URI
  private readonly uriToTimeout = new Map<string, NodeJS.Timeout>();
}

function errorToDiagnostic(error: SoiaError): Diagnostic {
  const { token, message, expected } = error;
  return {
    range: {
      start: token.position,
      end: token.position + token.text.length,
    },
    message: message ? message : `expected: ${expected}`,
  };
}

function getFileType(uri: string): "soia.yml" | "*.soia" | null {
  if (uri.endsWith("/soia.yml")) {
    return "soia.yml";
  } else if (uri.endsWith(".soia")) {
    return "*.soia";
  }
  return null;
}

interface Diagnostic {
  readonly range?: {
    readonly start: number;
    readonly end: number;
  };
  readonly message: string;
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
      this.scheduledResolution = undefined;
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

  /**
   * Synchronously performs type resolution (and validation).
   * Stores the errors in every module bundle.
   */
  private resolve(): void {
    try {
      const moduleSet = new ModuleSet(this);
      for (const [modulePath, moduleBundle] of this.modules.entries()) {
        const parseResult = moduleSet.parseAndResolve(modulePath);
        this.updateDiagnostics(moduleBundle, parseResult.errors);
      }
    } catch (error) {
      console.error(`Error during resolution:`, error);
    } finally {
      this.scheduledResolution?.callback();
    }
  }

  private updateDiagnostics(
    moduleBundle: ModuleBundle,
    errors: readonly SoiaError[],
  ): void {
    if (errors.length <= 0) {
      return;
    }

    const { uri, content } = moduleBundle;
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

const languageExtension = new LanguageExtension();

class FileContentManager {
  private fileWatcher?: vscode.FileSystemWatcher;
  private documentChangeListener?: vscode.Disposable;

  constructor() {
    this.setupFileWatcher();
    this.setupDocumentChangeListener();
  }

  private setupFileWatcher(): void {
    // Watch for soia.yml and *.soia files
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(GLOB_PATTERN);

    this.fileWatcher.onDidCreate(async (uri) => {
      await this.handleFileChange(uri, "created");
    });

    this.fileWatcher.onDidChange(async (uri) => {
      await this.handleFileChange(uri, "changed");
    });

    this.fileWatcher.onDidDelete(async (uri) => {
      await this.handleFileChange(uri, "deleted");
    });
  }

  private setupDocumentChangeListener(): void {
    // Listen for document changes (unsaved edits)
    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        const uri = event.document.uri;
        const uriString = uri.toString();

        // Only handle soia.yml and .soia files
        if (getFileType(uriString)) {
          console.log(`Document change detected: ${uriString}`);
          languageExtension.scheduleSetFileContent(uriString, event.document);
        }
      },
    );
  }

  private async handleFileChange(
    uri: vscode.Uri,
    type: "created" | "changed" | "deleted",
  ) {
    const uriString = uri.toString();

    switch (type) {
      case "created":
      case "changed": {
        try {
          const text = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(text).toString("utf-8");
          console.log(`File change detected: ${uriString}`);
          languageExtension.setFileContent(uriString, content);
        } catch (error) {
          console.error(`Failed to read file ${uriString}:`, error);
        }
        break;
      }
      case "deleted": {
        languageExtension.deleteFile(uriString);
        break;
      }
    }
  }

  async performInitialScan(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    for (const folder of workspaceFolders) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, GLOB_PATTERN),
      );

      for (const file of files) {
        try {
          const text = await vscode.workspace.fs.readFile(file);
          const content = Buffer.from(text).toString("utf-8");
          console.log(`Initial scan found file: ${file.toString()}`);
          languageExtension.setFileContent(file.toString(), content);
        } catch (error) {
          console.error(`Failed to read file ${file.toString()}:`, error);
        }
      }
    }
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    this.documentChangeListener?.dispose();
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

const GLOB_PATTERN = "**/{soia.yml,*.soia}";

const fileContentManager = new FileContentManager();

// VS Code extension activation
export async function activate(context: vscode.ExtensionContext) {
  console.log("Soia Language Support extension is now active");

  // Perform initial scan of workspace
  await fileContentManager.performInitialScan();

  // Add to subscriptions for proper cleanup
  context.subscriptions.push(fileContentManager);
}

export function deactivate() {
  fileContentManager.dispose();
}
