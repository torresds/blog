use std::{
    collections::{BTreeMap, HashMap},
    fmt, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use comrak::{Arena, Options, nodes::NodeValue};
use pulldown_latex::{Parser as LatexParser, Storage, mathml::push_mathml};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod citations;

pub const SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_BYTES: usize = 2_000_000;
const MAX_OUTPUT_BYTES: usize = 20_000_000;
const MAX_SVG_BYTES: usize = 8_000_000;
const ARTICLE_CSS: &str = include_str!("../../../assets/bard/article.css");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompileRequest {
    pub schema_version: u32,
    pub source: String,
    pub locale: String,
    #[serde(default)]
    pub citation_style: Option<String>,
    pub document: Document,
    #[serde(default)]
    pub references: Vec<Reference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub title: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub revision_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub key: String,
    pub revision_id: String,
    pub csl_json: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub files: Vec<GeneratedFile>,
    pub toc: Vec<TocEntry>,
    pub diagnostics: Vec<Diagnostic>,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
pub struct GeneratedFile {
    pub path: String,
    pub media_type: String,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct TocEntry {
    pub level: u8,
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
}

#[derive(Debug, Error)]
pub enum BardError {
    #[error("unsupported request schema version {0}")]
    SchemaVersion(u32),
    #[error("unsupported locale: {0}")]
    Locale(String),
    #[error("source exceeds the {MAX_SOURCE_BYTES}-byte limit")]
    SourceTooLarge,
    #[error("document title must not be empty")]
    EmptyTitle,
    #[error("unsupported citation style: {0}")]
    CitationStyle(String),
    #[error("invalid CSL JSON for reference '{key}': {message}")]
    Reference { key: String, message: String },
    #[error("generated output exceeds the {MAX_OUTPUT_BYTES}-byte limit")]
    OutputTooLarge,
    #[error("raw HTML is not allowed (line {line})")]
    RawHtml { line: usize },
    #[error("Markdown formatter failed")]
    Format,
    #[error("failed to write generated file: {0}")]
    Io(#[from] std::io::Error),
}

pub fn compile(request: CompileRequest, output_dir: &Path) -> Result<Manifest, BardError> {
    validate_request(&request)?;
    fs::create_dir_all(output_dir)?;

    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.autolink = true;
    options.extension.math_dollars = true;
    options.parse.sourcepos_chars = true;
    options.render.sourcepos = true;
    options.render.r#unsafe = true;
    options.render.escape = false;
    options.extension.header_id_prefix = Some(String::new());

    let root = comrak::parse_document(&arena, &request.source, &options);
    if let Some(line) = raw_html_line(root) {
        return Err(BardError::RawHtml { line });
    }

    let mut diagnostics = Vec::new();
    let citations = citations::prepare(root, &request, &mut diagnostics)?;

    let diagrams = MermaidRenderer::new(output_dir);
    let mut toc = Vec::new();
    let mut anchorizer = comrak::Anchorizer::new();
    let syntax_set = syntect::parsing::SyntaxSet::load_defaults_newlines();
    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        if let NodeValue::CodeBlock(block) = &data.value {
            if let Some(language) = block.info.split_whitespace().next()
                && !matches!(language.to_ascii_lowercase().as_str(), "mermaid" | "math")
                && syntax_set.find_syntax_by_token(language).is_none()
            {
                diagnostics.push(Diagnostic {
                    severity: "warning".to_owned(),
                    code: "code.unknown_language".to_owned(),
                    message: format!(
                        "unknown code language '{language}'; using the highlighter fallback"
                    ),
                    line: Some(data.sourcepos.start.line),
                    column: Some(data.sourcepos.start.column),
                });
            }
        } else if let NodeValue::Math(math) = &data.value {
            let storage = Storage::new();
            let parser = LatexParser::new(&math.literal, &storage);
            let mut rendered = String::new();
            if let Err(error) = push_mathml(&mut rendered, parser, Default::default()) {
                diagnostics.push(Diagnostic {
                    severity: "error".to_owned(),
                    code: "math.invalid".to_owned(),
                    message: error.to_string(),
                    line: Some(data.sourcepos.start.line),
                    column: Some(data.sourcepos.start.column),
                });
                rendered = format!(
                    "<code class=\"math-error\">{}</code>",
                    escape_html(&math.literal)
                );
            }
            data.value = NodeValue::HtmlInline(rendered);
        } else if let NodeValue::Heading(heading) = &data.value {
            let title = plain_text(node);
            let id = anchorizer.anchorize(&title);
            toc.push(TocEntry {
                level: heading.level,
                id,
                title,
            });
        }
    }

    let mut renderers = HashMap::new();
    renderers.insert(
        "mermaid".to_owned(),
        &diagrams as &dyn comrak::adapters::CodefenceRendererAdapter,
    );
    let plugins = comrak::options::Plugins {
        render: comrak::options::RenderPlugins {
            codefence_renderers: renderers,
            codefence_syntax_highlighter: Some(&comrak::plugins::syntect::SyntectAdapter::new(
                None,
            )),
            ..Default::default()
        },
    };
    let mut rendered_html = String::new();
    comrak::html::format_document_with_plugins(root, &options, &mut rendered_html, &plugins)
        .map_err(|_| BardError::Format)?;
    let citation_style_id = citations.style_id().to_owned();
    let rendered_html = citations.apply(rendered_html);
    let safe_html = sanitize_html(&rendered_html);
    let safe_html = format!(
        "<article class=\"bard-article\" lang=\"{}\">{safe_html}</article>",
        request.locale
    );
    let article_css = article_css();
    let mut files = vec![
        (
            "article.html".to_owned(),
            "text/html; charset=utf-8".to_owned(),
            safe_html,
        ),
        (
            "article.css".to_owned(),
            "text/css; charset=utf-8".to_owned(),
            article_css,
        ),
    ];
    files.extend(diagrams.files());
    files = files
        .into_iter()
        .map(|(path, media_type, contents)| (path, (media_type, contents)))
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .map(|(path, (media_type, contents))| (path, media_type, contents))
        .collect();

    let output_size: usize = files.iter().map(|(_, _, content)| content.len()).sum();
    if output_size > MAX_OUTPUT_BYTES {
        return Err(BardError::OutputTooLarge);
    }

    let mut manifest_files = Vec::with_capacity(files.len());
    for (relative_path, media_type, contents) in files {
        let path = output_dir.join(&relative_path);
        fs::write(&path, contents.as_bytes())?;
        manifest_files.push(GeneratedFile {
            path: relative_path,
            media_type,
            sha256: digest(contents.as_bytes()),
        });
    }

    let fingerprint_input = serde_json::to_vec(&(
        SCHEMA_VERSION,
        env!("CARGO_PKG_VERSION"),
        digest(include_str!("../../../Cargo.lock").as_bytes()),
        &request.source,
        &request.locale,
        &citation_style_id,
        &request.document,
        &request.references,
        &manifest_files,
    ))
    .expect("serializing compiler fingerprint inputs cannot fail");

    Ok(Manifest {
        schema_version: SCHEMA_VERSION,
        files: manifest_files,
        toc,
        diagnostics: diagnostics
            .into_iter()
            .chain(diagrams.diagnostics())
            .collect(),
        fingerprint: digest(&fingerprint_input),
    })
}

fn validate_request(request: &CompileRequest) -> Result<(), BardError> {
    if request.schema_version != SCHEMA_VERSION {
        return Err(BardError::SchemaVersion(request.schema_version));
    }
    if request.locale != "pt-BR" && request.locale != "en-US" {
        return Err(BardError::Locale(request.locale.clone()));
    }
    if request.source.len() > MAX_SOURCE_BYTES {
        return Err(BardError::SourceTooLarge);
    }
    if request.document.title.trim().is_empty() {
        return Err(BardError::EmptyTitle);
    }
    Ok(())
}

fn raw_html_line<'a>(root: &'a comrak::nodes::AstNode<'a>) -> Option<usize> {
    use comrak::nodes::NodeValue;
    root.descendants().find_map(|node| {
        let data = node.data.borrow();
        matches!(
            data.value,
            NodeValue::HtmlBlock(_) | NodeValue::HtmlInline(_)
        )
        .then_some(data.sourcepos.start.line)
    })
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn article_css() -> String {
    let mut css = ARTICLE_CSS.to_owned();
    let themes = syntect::highlighting::ThemeSet::load_defaults();
    let theme = themes
        .themes
        .get("InspiredGitHub")
        .expect("syntect's embedded InspiredGitHub theme is present");
    let syntax_css =
        syntect::html::css_for_theme_with_class_style(theme, syntect::html::ClassStyle::Spaced)
            .expect("the embedded syntect theme generates valid CSS");
    css.push_str("\n/* Pinned syntect InspiredGitHub syntax theme. */\n");
    css.push_str(&syntax_css);
    css
}

fn plain_text<'a>(node: &'a comrak::nodes::AstNode<'a>) -> String {
    use comrak::nodes::NodeValue;
    node.descendants()
        .skip(1)
        .filter_map(|child| {
            let data = child.data.borrow();
            match &data.value {
                NodeValue::Text(text) => Some(text.to_string()),
                NodeValue::Code(code) => Some(code.literal.clone()),
                NodeValue::Math(math) => Some(math.literal.clone()),
                _ => None,
            }
        })
        .collect()
}

struct MermaidRenderer {
    output_dir: PathBuf,
    generated: Mutex<Vec<(String, String, String)>>,
    diagnostics: Mutex<Vec<Diagnostic>>,
}

impl MermaidRenderer {
    fn new(output_dir: &Path) -> Self {
        Self {
            output_dir: output_dir.to_path_buf(),
            generated: Mutex::new(Vec::new()),
            diagnostics: Mutex::new(Vec::new()),
        }
    }

    fn files(&self) -> Vec<(String, String, String)> {
        self.generated
            .lock()
            .expect("diagram lock poisoned")
            .clone()
    }

    fn diagnostics(&self) -> Vec<Diagnostic> {
        self.diagnostics
            .lock()
            .expect("diagnostics lock poisoned")
            .clone()
    }
}

impl comrak::adapters::CodefenceRendererAdapter for MermaidRenderer {
    fn write(
        &self,
        output: &mut dyn fmt::Write,
        _lang: &str,
        _meta: &str,
        code: &str,
        sourcepos: Option<comrak::nodes::Sourcepos>,
    ) -> fmt::Result {
        match mermaid_rs_renderer::render_strict(
            code,
            mermaid_rs_renderer::RenderOptions::default(),
        ) {
            Ok(svg) => {
                if svg.len() > MAX_SVG_BYTES {
                    self.diagnostics
                        .lock()
                        .map_err(|_| fmt::Error)?
                        .push(Diagnostic {
                            severity: "error".to_owned(),
                            code: "mermaid.output_too_large".to_owned(),
                            message: format!(
                                "generated diagram exceeds the {MAX_SVG_BYTES}-byte limit"
                            ),
                            line: sourcepos.map(|span| span.start.line),
                            column: sourcepos.map(|span| span.start.column),
                        });
                    return write!(output, "<pre><code>{}</code></pre>", escape_html(code));
                }
                let safe_svg = sanitize_svg(&svg);
                let hash = digest(safe_svg.as_bytes());
                let relative_path = format!("assets/diagram-{hash}.svg");
                let full_path = self.output_dir.join(&relative_path);
                if let Some(parent) = full_path.parent() {
                    fs::create_dir_all(parent).map_err(|_| fmt::Error)?;
                }
                fs::write(&full_path, safe_svg.as_bytes()).map_err(|_| fmt::Error)?;
                self.generated.lock().map_err(|_| fmt::Error)?.push((
                    relative_path.clone(),
                    "image/svg+xml".to_owned(),
                    safe_svg,
                ));
                write!(
                    output,
                    "<figure class=\"bard-diagram\"><img src=\"{relative_path}\" alt=\"Diagram\"></figure>"
                )
            }
            Err(error) => {
                self.diagnostics
                    .lock()
                    .map_err(|_| fmt::Error)?
                    .push(Diagnostic {
                        severity: "error".to_owned(),
                        code: "mermaid.invalid".to_owned(),
                        message: error.to_string(),
                        line: sourcepos.map(|span| span.start.line),
                        column: sourcepos.map(|span| span.start.column),
                    });
                write!(output, "<pre><code>{}</code></pre>", escape_html(code))
            }
        }
    }
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn sanitize_svg(svg: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .tags(
            [
                "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
                "text", "tspan", "defs", "marker", "title", "desc",
            ]
            .into(),
        )
        .tag_attributes(
            [
                (
                    "svg",
                    ["xmlns", "viewBox", "width", "height"]
                        .into_iter()
                        .collect(),
                ),
                ("g", ["id", "class", "transform"].into_iter().collect()),
                (
                    "path",
                    [
                        "id",
                        "class",
                        "d",
                        "fill",
                        "stroke",
                        "stroke-width",
                        "stroke-dasharray",
                        "transform",
                        "marker-end",
                    ]
                    .into_iter()
                    .collect(),
                ),
                (
                    "rect",
                    [
                        "id",
                        "class",
                        "x",
                        "y",
                        "width",
                        "height",
                        "rx",
                        "ry",
                        "fill",
                        "stroke",
                        "stroke-width",
                    ]
                    .into_iter()
                    .collect(),
                ),
                (
                    "circle",
                    [
                        "id",
                        "class",
                        "cx",
                        "cy",
                        "r",
                        "fill",
                        "stroke",
                        "stroke-width",
                    ]
                    .into_iter()
                    .collect(),
                ),
                (
                    "ellipse",
                    [
                        "id",
                        "class",
                        "cx",
                        "cy",
                        "rx",
                        "ry",
                        "fill",
                        "stroke",
                        "stroke-width",
                    ]
                    .into_iter()
                    .collect(),
                ),
                (
                    "line",
                    [
                        "id",
                        "class",
                        "x1",
                        "y1",
                        "x2",
                        "y2",
                        "stroke",
                        "stroke-width",
                        "marker-end",
                    ]
                    .into_iter()
                    .collect(),
                ),
                (
                    "polyline",
                    ["id", "class", "points", "fill", "stroke", "stroke-width"]
                        .into_iter()
                        .collect(),
                ),
                (
                    "polygon",
                    ["id", "class", "points", "fill", "stroke", "stroke-width"]
                        .into_iter()
                        .collect(),
                ),
                (
                    "text",
                    [
                        "id",
                        "class",
                        "x",
                        "y",
                        "fill",
                        "text-anchor",
                        "font-size",
                        "font-family",
                    ]
                    .into_iter()
                    .collect(),
                ),
                ("tspan", ["x", "y", "dx", "dy"].into_iter().collect()),
                (
                    "marker",
                    [
                        "id",
                        "viewBox",
                        "refX",
                        "refY",
                        "markerWidth",
                        "markerHeight",
                        "orient",
                    ]
                    .into_iter()
                    .collect(),
                ),
                ("title", ["id"].into_iter().collect()),
                ("desc", ["id"].into_iter().collect()),
            ]
            .into(),
        )
        .url_schemes(std::iter::empty::<&str>().collect());
    builder.clean(svg).to_string()
}

fn sanitize_html(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .add_generic_attributes(["class", "id", "role", "aria-labelledby"])
        .add_tags([
            "section",
            "input",
            "math",
            "mi",
            "mn",
            "mo",
            "mrow",
            "mfrac",
            "msup",
            "msub",
            "msubsup",
            "msqrt",
            "mroot",
            "mtext",
            "mspace",
            "mover",
            "munder",
            "munderover",
            "mtable",
            "mtr",
            "mtd",
            "semantics",
            "annotation",
        ])
        .add_tag_attributes("math", ["xmlns", "display"])
        .add_tag_attributes("annotation", ["encoding"])
        .add_tag_attributes("input", ["type", "checked", "disabled"]);
    builder.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(source: &str) -> CompileRequest {
        CompileRequest {
            schema_version: 1,
            source: source.to_owned(),
            locale: "pt-BR".to_owned(),
            citation_style: None,
            document: Document {
                title: "Artigo de teste".to_owned(),
                slug: Some("artigo-de-teste".to_owned()),
                revision_id: Some("revision-1".to_owned()),
            },
            references: Vec::new(),
        }
    }

    #[test]
    fn renders_gfm_unicode_toc_and_static_code() {
        let output = tempfile::tempdir().unwrap();
        let manifest = compile(
            request(
                "# Olá\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\nfootnote[^1]\n\n[^1]: note\n\n```rust\nfn main() {}\n```",
            ),
            output.path(),
        )
        .unwrap();
        let html = fs::read_to_string(output.path().join("article.html")).unwrap();
        let css = fs::read_to_string(output.path().join("article.css")).unwrap();

        assert!(html.contains("<article class=\"bard-article\" lang=\"pt-BR\">"));
        assert!(html.contains("<table>"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("id=\"fn-1\""));
        assert!(html.contains("id=\"olá\""));
        assert!(html.contains("class=\"source rust\""));
        assert!(css.contains("Pinned syntect InspiredGitHub"));
        assert_eq!(manifest.toc[0].title, "Olá");
        assert_eq!(manifest.toc[0].id, "olá");
    }

    #[test]
    fn renders_math_as_sanitized_mathml() {
        let output = tempfile::tempdir().unwrap();
        compile(
            request("Inline $x^2$ and block:\n\n$$\n\\frac{1}{2}\n$$"),
            output.path(),
        )
        .unwrap();
        let html = fs::read_to_string(output.path().join("article.html")).unwrap();

        assert!(html.contains("<math display=\"inline\">"));
        assert!(html.contains("<msup>"));
        assert!(html.contains("<mfrac>"));
    }

    #[test]
    fn rejects_raw_html_with_source_line() {
        let output = tempfile::tempdir().unwrap();
        let error =
            compile(request("Text\n\n<script>alert(1)</script>"), output.path()).unwrap_err();

        assert!(matches!(error, BardError::RawHtml { line: 3 }));
    }

    #[test]
    fn renders_mermaid_to_a_hashed_svg_asset() {
        let output = tempfile::tempdir().unwrap();
        let manifest = compile(
            request("```mermaid\nflowchart LR\n A[Start] --> B[End]\n```"),
            output.path(),
        )
        .unwrap();
        let svg = manifest
            .files
            .iter()
            .find(|file| file.media_type == "image/svg+xml")
            .unwrap();
        let html = fs::read_to_string(output.path().join("article.html")).unwrap();

        assert!(svg.path.starts_with("assets/diagram-"));
        assert!(html.contains(&format!("src=\"{}\"", svg.path)));
        assert!(
            fs::read_to_string(output.path().join(&svg.path))
                .unwrap()
                .contains("<svg")
        );
    }

    #[test]
    fn renders_supported_mermaid_families_and_reports_invalid_diagrams() {
        let output = tempfile::tempdir().unwrap();
        let manifest = compile(
            request(
                "```mermaid\nsequenceDiagram\n Alice->>Bob: Olá\n```\n\n```mermaid\nerDiagram\n CUSTOMER ||--o{ ORDER : places\n```\n\n```mermaid\nclassDiagram\n class User {\n  +String name\n }\n```\n\n```mermaid\nflowchart LR\nsubgraph missing\n A --> B\n```",
            ),
            output.path(),
        )
        .unwrap();

        let diagrams = manifest
            .files
            .iter()
            .filter(|file| file.media_type == "image/svg+xml")
            .count();
        assert_eq!(diagrams, 3);
        assert!(
            manifest
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.line.is_some()),
            "expected an invalid diagram diagnostic, got {:?}",
            manifest.diagnostics
        );
    }

    #[test]
    fn reports_unknown_code_languages_and_sanitizes_svg() {
        let output = tempfile::tempdir().unwrap();
        let manifest = compile(request("```made-up-lang\nplain code\n```"), output.path()).unwrap();
        assert!(manifest.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "code.unknown_language"
                && diagnostic.line == Some(1)
                && diagnostic.column == Some(1)
        }));

        let svg = sanitize_svg(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script><foreignObject><img src=x></foreignObject><text>safe</text></svg>",
        );
        assert!(!svg.contains("script"));
        assert!(!svg.contains("foreignObject"));
        assert!(svg.contains("safe"));
    }

    #[test]
    fn fingerprints_repeat_for_identical_inputs() {
        let output_a = tempfile::tempdir().unwrap();
        let output_b = tempfile::tempdir().unwrap();
        let manifest_a =
            compile(request("# Reproducible\n\nFixed input."), output_a.path()).unwrap();
        let manifest_b =
            compile(request("# Reproducible\n\nFixed input."), output_b.path()).unwrap();

        assert_eq!(manifest_a.fingerprint, manifest_b.fingerprint);
        assert_eq!(manifest_a.files.len(), manifest_b.files.len());
        for (a, b) in manifest_a.files.iter().zip(&manifest_b.files) {
            assert_eq!(a.path, b.path);
            assert_eq!(a.sha256, b.sha256);
        }
    }
}
