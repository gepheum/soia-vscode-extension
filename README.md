# Skir Language Support for Visual Studio Code

This extension provides language support for the Skir language - a language for representing data types, constants and RPC interfaces (similar to Protocol Buffer).

## Features

- Syntax highlighting for Skir files (`.skir` extension)
- Format on save
- Go to definition for symbols and imports
- Hover information for symbols
- Comment toggling (line and block comments)
- Bracket matching and auto-closing pairs

## Skir Language

Skir is a language for representing data types, constants and RPC interfaces. It is designed for systems where different services are written in different languages but need to exchange structured data.

Example:

```skir
// shapes.skir

struct Point {
  x: int32;
  y: int32;
  label: string;
}

struct Shape {
  points: [Point];
  /// A short string describing this shape.
  label: string;
}

const TOP_RIGHT_CORNER: Point = {
  x = 600,
  y = 400,
  label = "top-right corner",
};

/// Returns true if no part of the shape's boundary curves inward.
method IsConvex(Shape): bool = 12345;
```

## Go to Definition

This extension supports navigating to the definition of symbols within your Skir codebase:

- Click on any symbol to navigate to its definition
- Click on import paths to navigate to the imported file

## Requirements

No special requirements for this extension.

## Release Notes

### 0.1.1

- Format on save

### 0.1.0

Initial release of Skir Language Support:
- Syntax highlighting
- Go to definition for symbols and import paths
- Hover information for symbols
- Bracket matching and auto-closing pairs
- Comment toggling (line and block comments)

---

## About Skir

Skir is designed with backward and forward compatibility in mind. You can evolve your data schemas by adding new fields or renaming fields. You will still be able to deserialize old values, and you won't break existing applications that use older versions of the schema.

For more information about Skir, visit the [official documentation](https://github.com/gepheum/skir).