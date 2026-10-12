# Bard

Bard compiles Markdown into static article HTML, CSS, citations, diagrams, and generated assets. The library and CLI run in Rust; the CLI needs no Node, database, browser, or network access at runtime.

## Run

Install pinned tools with `mise install`, then compile the example request:

```sh
mise exec -- cargo run -p bard -- --output-dir /tmp/bard-output \
  < contracts/bard/v1/example.request.json
mise exec -- cargo test --workspace
mise exec -- cargo bench -p bard --bench representative
```

The CLI reads one JSON request from stdin and writes one JSON manifest to stdout. Generated files go under the required `--output-dir`; paths in the manifest are relative to that directory. See `contracts/bard/v1/` for schemas and fixtures.

Treat `--output-dir` as an exclusive compilation directory: run one compile at a time and keep readers away until it finishes. Bard stages files and rolls back a failed write sequence, but publishes files individually, so it does not provide atomic visibility across the entire output bundle.

The benchmark compiles a representative article with citations, math, highlighted code, a table, and a Mermaid diagram. It reports p50/p95 latency after warmup; compare results on the same machine and toolchain.

## Current support

- CommonMark/GFM tables, task lists, strikethrough, autolinks, and footnotes.
- Dollar math compiled to MathML Core.
- Fenced code highlighting through Syntect with an embedded stylesheet.
- Pandoc-style bracketed citations and locators rendered by Hayagriva; IEEE is the default, and `citation_style` selects another bundled CSL style.
- Mermaid flowcharts and other supported diagrams compiled to sanitized SVG.
- Raw HTML rejection, generated HTML/SVG sanitization, output hashes, and a deterministic fingerprint.

The optional request field `citation_style` defaults to `ieee`. Style identifiers are resolved through Hayagriva's archive so new bundled styles can be enabled without changing the request shape. Invalid citation keys and unsupported styles produce diagnostics or request errors. Citation and bibliography HTML is sanitized with the article output.
