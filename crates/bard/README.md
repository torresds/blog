# Bard

Bard compiles Markdown into static article HTML, CSS, and generated assets. The library and CLI run in Rust; the CLI needs no Node, database, browser, or network access at runtime.

## Run

Install pinned tools with `mise install`, then compile the example request:

```sh
mise exec -- cargo run -p bard -- --output-dir /tmp/bard-output \
  < contracts/bard/v1/example.request.json
```

The CLI reads one JSON request from stdin and writes one JSON manifest to stdout. Generated files go under the required `--output-dir`; paths in the manifest are relative to that directory. See `contracts/bard/v1/` for schemas and fixtures.

## Current support

- CommonMark/GFM tables, task lists, strikethrough, autolinks, and footnotes.
- Dollar math compiled to MathML Core.
- Fenced code highlighting through Syntect with an embedded stylesheet.
- Mermaid flowcharts and other supported diagrams compiled to sanitized SVG.
- Raw HTML rejection, generated HTML/SVG sanitization, output hashes, and a deterministic fingerprint.

CSL citation parsing, supported citation styles, and some Mermaid syntax families remain open in `artifacts/specs/SPEC-003-BARD.md`. Invalid render inputs are reported in manifest diagnostics with source positions when available.
