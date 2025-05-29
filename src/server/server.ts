import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  DefinitionParams,
  Location,
  Range,
  Position,
  MarkupKind
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'vscode-uri';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a text document manager
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Dictionary to store symbol definitions
// Key: document URI, Value: Dictionary of symbol names to their locations
const symbolDefinitions = new Map<string, Map<string, Location>>();

// Dictionary to store imports
// Key: document URI, Value: Array of import information
interface ImportInfo {
  name: string;        // Imported symbol name
  alias?: string;      // The alias if using "import * as alias"
  fromPath: string;    // The file path imported from
  location: Location;  // Location of the import statement
}
const documentImports: Map<string, ImportInfo[]> = new Map();

// Map from file URI to workspace root URI
const fileToWorkspaceRoot: Map<string, string> = new Map();

connection.onInitialize((params: InitializeParams) => {
  // Store workspace roots
  if (params.workspaceFolders) {
    params.workspaceFolders.forEach(folder => {
      const uri = folder.uri;
      const fsPath = URI.parse(uri).fsPath;
      
      // Add this workspace folder to our map
      fileToWorkspaceRoot.set(uri, uri);
    });
  }

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports go to definition
      definitionProvider: true,
      // Add hover support
      hoverProvider: true
    }
  };

  return result;
});

// Parse a Soia document to find all definitions and imports
function parseDocument(document: TextDocument): void {
  const text = document.getText();
  const definitions = new Map<string, Location>();
  const imports: ImportInfo[] = [];
  const lines = text.split('\n');
  
  // Regular expressions for different Soia definitions
  const structRegex = /\\bstruct\\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const enumRegex = /\\benum\\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const constRegex = /\\bconst\\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const methodRegex = /\\bmethod\\s+([A-Za-z_][A-Za-z0-9_]*)/;
  
  // Import patterns
  // import Point from "geometry/geometry.soia"; (single symbol imports only)
  const namedImportRegex = /\\bimport\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+from\\s+"([^"]+)"/;
  // import * as color from "color.soia";
  const wildcardImportRegex = /\\bimport\\s+\\*\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+from\\s+"([^"]+)"/;
  
  // Find all definitions and imports in the document
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for struct definitions
    let match = structRegex.exec(line);
    if (match) {
      const name = match[1];
      const startPos = Position.create(i, line.indexOf(name));
      const endPos = Position.create(i, line.indexOf(name) + name.length);
      definitions.set(name, Location.create(document.uri, Range.create(startPos, endPos)));
    }
    
    // Check for enum definitions
    match = enumRegex.exec(line);
    if (match) {
      const name = match[1];
      const startPos = Position.create(i, line.indexOf(name));
      const endPos = Position.create(i, line.indexOf(name) + name.length);
      definitions.set(name, Location.create(document.uri, Range.create(startPos, endPos)));
    }
    
    // Check for const definitions
    match = constRegex.exec(line);
    if (match) {
      const name = match[1];
      const startPos = Position.create(i, line.indexOf(name));
      const endPos = Position.create(i, line.indexOf(name) + name.length);
      definitions.set(name, Location.create(document.uri, Range.create(startPos, endPos)));
    }
    
    // Check for method definitions
    match = methodRegex.exec(line);
    if (match) {
      const name = match[1];
      const startPos = Position.create(i, line.indexOf(name));
      const endPos = Position.create(i, line.indexOf(name) + name.length);
      definitions.set(name, Location.create(document.uri, Range.create(startPos, endPos)));
    }
    
    // Check for named imports
    match = namedImportRegex.exec(line);
    if (match) {
      const importedName = match[1].trim();
      const fromPath = match[2];
      const startPos = Position.create(i, 0);
      const endPos = Position.create(i, line.length);
      const location = Location.create(document.uri, Range.create(startPos, endPos));
      
      imports.push({
        name: importedName,
        fromPath,
        location
      });
    }
    
    // Check for wildcard imports
    match = wildcardImportRegex.exec(line);
    if (match) {
      const alias = match[1];
      const fromPath = match[2];
      const startPos = Position.create(i, 0);
      const endPos = Position.create(i, line.length);
      const location = Location.create(document.uri, Range.create(startPos, endPos));
      
      imports.push({
        name: '*',
        alias,
        fromPath,
        location
      });
    }
  }
  
  // Store definitions and imports
  symbolDefinitions.set(document.uri, definitions);
  documentImports.set(document.uri, imports);
}

// Find a workspace root for a given document URI
function findWorkspaceRoot(documentUri: string): string | undefined {
  const documentPath = URI.parse(documentUri).fsPath;
  let bestMatch: string | undefined;
  let bestMatchLength = 0;
  
  for (const [workspaceUri] of fileToWorkspaceRoot.entries()) {
    const workspacePath = URI.parse(workspaceUri).fsPath;
    if (documentPath.startsWith(workspacePath) && workspacePath.length > bestMatchLength) {
      bestMatch = workspaceUri;
      bestMatchLength = workspacePath.length;
    }
  }
  
  return bestMatch;
}

// Resolve the absolute path of an imported module
function resolveImportPath(documentUri: string, importPath: string): string | undefined {
  const workspaceRoot = findWorkspaceRoot(documentUri);
  if (!workspaceRoot) return undefined;
  
  // The path is always relative to the root of the soia source directory
  const workspaceFsPath = URI.parse(workspaceRoot).fsPath;
  const resolvedPath = path.join(workspaceFsPath, importPath);
  
  if (fs.existsSync(resolvedPath)) {
    return URI.file(resolvedPath).toString();
  }
  
  return undefined;
}

// Find definition for a symbol, checking imports if necessary
async function findDefinition(documentUri: string, symbolName: string): Promise<Location | null> {
  // Check if symbol is defined in current document
  const currentDocDefs = symbolDefinitions.get(documentUri);
  if (currentDocDefs && currentDocDefs.has(symbolName)) {
    return currentDocDefs.get(symbolName)!;
  }
  
  // Check if symbol is imported
  const imports = documentImports.get(documentUri);
  if (imports) {
    // Check direct imports first
    for (const importInfo of imports) {
      if (importInfo.name === symbolName) {
        // Resolve the imported module path
        const importedModuleUri = resolveImportPath(documentUri, importInfo.fromPath);
        if (importedModuleUri) {
          // Check if we already have parsed this module
          const importedDefs = symbolDefinitions.get(importedModuleUri);
          if (importedDefs && importedDefs.has(symbolName)) {
            return importedDefs.get(symbolName)!;
          }
          
          // Try to load and parse the module
          try {
            const fsPath = URI.parse(importedModuleUri).fsPath;
            const content = fs.readFileSync(fsPath, 'utf-8');
            const document = TextDocument.create(importedModuleUri, 'soia', 0, content);
            parseDocument(document);
            
            const newDefs = symbolDefinitions.get(importedModuleUri);
            if (newDefs && newDefs.has(symbolName)) {
              return newDefs.get(symbolName)!;
            }
          } catch (e) {
            console.error(`Error parsing imported module: ${e}`);
          }
        }
      }
    }
    
    // Check module alias imports (import * as alias)
    const parts = symbolName.split('.');
    if (parts.length > 1) {
      const alias = parts[0];
      const name = parts[1];
      
      for (const importInfo of imports) {
        if (importInfo.name === '*' && importInfo.alias === alias) {
          // Resolve the imported module path
          const importedModuleUri = resolveImportPath(documentUri, importInfo.fromPath);
          if (importedModuleUri) {
            // Check if we already have parsed this module
            const importedDefs = symbolDefinitions.get(importedModuleUri);
            if (importedDefs && importedDefs.has(name)) {
              return importedDefs.get(name)!;
            }
            
            // Try to load and parse the module
            try {
              const fsPath = URI.parse(importedModuleUri).fsPath;
              const content = fs.readFileSync(fsPath, 'utf-8');
              const document = TextDocument.create(importedModuleUri, 'soia', 0, content);
              parseDocument(document);
              
              const newDefs = symbolDefinitions.get(importedModuleUri);
              if (newDefs && newDefs.has(name)) {
                return newDefs.get(name)!;
              }
            } catch (e) {
              console.error(`Error parsing imported module: ${e}`);
            }
          }
        }
      }
    }
  }
  
  // Check all other documents as a fallback
  for (const [uri, defs] of symbolDefinitions.entries()) {
    if (uri !== documentUri && defs.has(symbolName)) {
      return defs.get(symbolName)!;
    }
  }
  
  return null;
}

// Handle definition requests
connection.onDefinition(async (params: DefinitionParams): Promise<Location | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  
  // Get the current line
  const position = params.position;
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_VALUE }
  });
  
  // Check if we're in an import statement with a string literal
  const importPathRegex = /import\\s+(?:[A-Za-z0-9_]+|\\*\\s+as\\s+[A-Za-z0-9_]+)\\s+from\\s+"([^"]+)"/;
  const importMatch = importPathRegex.exec(line);
  
  if (importMatch) {
    // Get the start and end position of the import path string
    const importPath = importMatch[1];
    const pathStart = line.indexOf('"' + importPath + '"');
    
    // Check if the cursor is within the import path string
    if (position.character > pathStart && 
        position.character < pathStart + importPath.length + 2) {
      // Try to resolve the import path to go to the file
      const resolvedPath = resolveImportPath(document.uri, importPath);
      if (resolvedPath) {
        // Create a location pointing to the beginning of the resolved file
        return Location.create(resolvedPath, Range.create(
          Position.create(0, 0),
          Position.create(0, 0)
        ));
      }
    }
  }
  
  // Try to get the word at current position
  const text = document.getText();
  const wordRange = getWordRangeAtPosition(text, position);
  if (!wordRange) {
    return null;
  }
  
  const word = text.substring(wordRange.start, wordRange.end);
  // Skip empty words and keywords
  if (!word || isKeyword(word)) {
    return null;
  }
  
  // Find the definition of the word
  return await findDefinition(document.uri, word);
});

// Check if a word is a Soia keyword
function isKeyword(word: string): boolean {
  const keywords = [
    'struct', 'enum', 'const', 'method', 'import', 'from', 'as', 'removed',
    'bool', 'int32', 'int64', 'uint32', 'uint64', 'float32', 'float64',
    'string', 'bytes', 'timestamp'
  ];
  return keywords.includes(word);
}

// Get the range of a word at a given position
function getWordRangeAtPosition(text: string, position: Position): { start: number, end: number } | null {
  const lines = text.split('\n');
  if (position.line >= lines.length) {
    return null;
  }
  
  const line = lines[position.line];
  if (position.character >= line.length) {
    return null;
  }
  
  // Find word boundaries (alphanumeric or underscore)
  let start = position.character;
  while (start > 0) {
    const char = line.charAt(start - 1);
    if (!/[A-Za-z0-9_.]/.test(char)) {
      break;
    }
    start--;
  }
  
  let end = position.character;
  while (end < line.length) {
    const char = line.charAt(end);
    if (!/[A-Za-z0-9_.]/.test(char)) {
      break;
    }
    end++;
  }
  
  if (start === end) {
    return null;
  }
  
  // Convert line positions to document positions
  let documentStart = 0;
  for (let i = 0; i < position.line; i++) {
    documentStart += lines[i].length + 1; // +1 for the newline
  }
  
  return {
    start: documentStart + start,
    end: documentStart + end
  };
}

// Provide hover information for symbols
connection.onHover(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) {
    return null;
  }
  
  // Get word at position
  const text = document.getText();
  const wordRange = getWordRangeAtPosition(text, position);
  if (!wordRange) {
    return null;
  }
  
  const word = text.substring(wordRange.start, wordRange.end);
  
  // Skip empty words and keywords
  if (!word || isKeyword(word)) {
    return null;
  }
  
  // Find definition
  const definition = await findDefinition(document.uri, word);
  if (definition) {
    // Create hover with symbol information
    let hoverText = `**${word}**\n\nDefined in *${path.basename(URI.parse(definition.uri).fsPath)}*`;
    
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: hoverText
      }
    };
  }
  
  return null;
});

// When a document opens or changes, parse it
documents.onDidChangeContent(change => {
  parseDocument(change.document);
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
