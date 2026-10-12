use std::{
    collections::{BTreeMap, HashMap},
    fmt, fs,
    path::{Component, Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
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
const MAX_TITLE_CHARS: usize = 500;
const MAX_IDENTIFIER_CHARS: usize = 200;
const MAX_CITATION_STYLE_CHARS: usize = 120;
const ARTICLE_CSS: &str = include_str!("../../../assets/bard/article.css");
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

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
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Warning,
    Error,
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
    #[error("{field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("{field} exceeds the {max}-character limit")]
    FieldTooLong { field: &'static str, max: usize },
    #[error("citation_style must contain only lowercase ASCII letters, digits, and hyphens")]
    InvalidCitationStyle,
    #[error("reference '{key}' csl_json must be a JSON object")]
    ReferenceNotObject { key: String },
    #[error("unsupported citation style: {0}")]
    CitationStyle(String),
    #[error("invalid CSL JSON for reference '{key}': {message}")]
    Reference { key: String, message: String },
    #[error("generated output exceeds the {MAX_OUTPUT_BYTES}-byte limit")]
    OutputTooLarge,
    #[error("raw HTML is not allowed (line {line})")]
    RawHtml { line: usize },
    #[error("Markdown formatter failed: {0}")]
    Format(#[source] fmt::Error),
    #[error("formatting citations failed: {0}")]
    CitationFormat(#[source] fmt::Error),
    #[error("citation preparation invariant failed: {0}")]
    CitationState(&'static str),
    #[error("the embedded Syntect theme '{0}' is unavailable")]
    SyntaxThemeMissing(&'static str),
    #[error("generating Syntect CSS failed: {0}")]
    SyntaxCss(#[source] syntect::Error),
    #[error("Mermaid renderer state mutex was poisoned")]
    MermaidRendererPoisoned,
    #[error("Mermaid generated conflicting contents for asset '{path}'")]
    MermaidAssetConflict { path: String },
    #[error("output persistence failed during {operation} at '{path}': {source}{rollback_note}", rollback_note = rollback.as_ref().map(|message| format!("; rollback also failed: {message}")).unwrap_or_default())]
    OutputPersistence {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
        rollback: Option<String>,
    },
    #[error("generated file path is not a safe relative path: {0}")]
    UnsafeGeneratedPath(String),
    #[error("generated output contains duplicate path '{0}'")]
    DuplicateGeneratedPath(String),
    #[error("serializing compiler fingerprint inputs failed: {0}")]
    Fingerprint(#[source] serde_json::Error),
}

struct BundleFile {
    path: String,
    media_type: String,
    contents: String,
    sha256: String,
}

struct OutputBundle {
    files: Vec<BundleFile>,
}

impl OutputBundle {
    fn new(files: Vec<(String, String, String)>) -> Result<Self, BardError> {
        let mut sorted = BTreeMap::new();
        let mut output_size = 0usize;
        for (path, media_type, contents) in files {
            validate_generated_path(&path)?;
            if sorted
                .insert(path.clone(), (media_type, contents))
                .is_some()
            {
                return Err(BardError::DuplicateGeneratedPath(path));
            }
        }

        let files = sorted
            .into_iter()
            .map(|(path, (media_type, contents))| {
                output_size = output_size.saturating_add(contents.len());
                BundleFile {
                    path,
                    media_type,
                    sha256: digest(contents.as_bytes()),
                    contents,
                }
            })
            .collect::<Vec<_>>();
        if output_size > MAX_OUTPUT_BYTES {
            return Err(BardError::OutputTooLarge);
        }
        Ok(Self { files })
    }

    fn manifest_files(&self) -> Vec<GeneratedFile> {
        self.files
            .iter()
            .map(|file| GeneratedFile {
                path: file.path.clone(),
                media_type: file.media_type.clone(),
                sha256: file.sha256.clone(),
            })
            .collect()
    }

    fn persist(&self, output_dir: &Path) -> Result<(), BardError> {
        fs::create_dir_all(output_dir)
            .map_err(|source| output_io_error("create output directory", output_dir, source))?;
        let mut staging = StagingDirectory::create(output_dir)?;
        for file in &self.files {
            let staged = staging.path.join("new").join(&file.path);
            if let Some(parent) = staged.parent() {
                fs::create_dir_all(parent).map_err(|source| {
                    output_io_error("create staging directory", parent, source)
                })?;
            }
            fs::write(&staged, file.contents.as_bytes())
                .map_err(|source| output_io_error("write staged file", &staged, source))?;
        }

        let mut published = Vec::with_capacity(self.files.len());
        let publication = (|| {
            for file in &self.files {
                ensure_output_parent(output_dir, Path::new(&file.path))?;
                let target = output_dir.join(&file.path);
                let staged = staging.path.join("new").join(&file.path);
                let backup = match fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.file_type().is_file() => {
                        let backup = staging.path.join("backup").join(&file.path);
                        if let Some(parent) = backup.parent() {
                            fs::create_dir_all(parent).map_err(|source| {
                                output_io_error("create backup directory", parent, source)
                            })?;
                        }
                        fs::rename(&target, &backup).map_err(|source| {
                            output_io_error("stage existing file", &target, source)
                        })?;
                        Some(backup)
                    }
                    Ok(_) => {
                        return Err(output_io_error(
                            "replace generated path",
                            &target,
                            std::io::Error::new(
                                std::io::ErrorKind::InvalidInput,
                                "target exists and is not a regular file",
                            ),
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(source) => {
                        return Err(output_io_error("inspect generated path", &target, source));
                    }
                };
                published.push(PublishedFile {
                    target: target.clone(),
                    backup,
                    installed: false,
                });
                fs::rename(&staged, &target)
                    .map_err(|source| output_io_error("publish generated file", &target, source))?;
                published
                    .last_mut()
                    .expect("the publication record was just added")
                    .installed = true;
            }
            Ok(())
        })();

        if let Err(mut error) = publication {
            let rollback_failures = rollback_publication(&mut published);
            if !rollback_failures.is_empty() {
                staging.preserve = true;
                error = error.with_rollback(rollback_failures.join("; "));
            }
            return Err(error);
        }
        Ok(())
    }
}

impl BardError {
    fn with_rollback(self, rollback: String) -> Self {
        match self {
            Self::OutputPersistence {
                operation,
                path,
                source,
                ..
            } => Self::OutputPersistence {
                operation,
                path,
                source,
                rollback: Some(rollback),
            },
            other => other,
        }
    }
}

struct PublishedFile {
    target: PathBuf,
    backup: Option<PathBuf>,
    installed: bool,
}

struct StagingDirectory {
    path: PathBuf,
    preserve: bool,
}

impl StagingDirectory {
    fn create(output_dir: &Path) -> Result<Self, BardError> {
        loop {
            let id = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
            let path = output_dir.join(format!(".bard-stage-{}-{id}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    return Ok(Self {
                        path,
                        preserve: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(source) => {
                    return Err(output_io_error("create staging directory", &path, source));
                }
            }
        }
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn validate_generated_path(path: &str) -> Result<(), BardError> {
    let relative = Path::new(path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(BardError::UnsafeGeneratedPath(path.to_owned()));
    }
    Ok(())
}

fn ensure_output_parent(output_dir: &Path, relative_file: &Path) -> Result<(), BardError> {
    let Some(parent) = relative_file.parent() else {
        return Ok(());
    };
    let mut current = output_dir.to_path_buf();
    for component in parent.components() {
        let Component::Normal(name) = component else {
            return Err(BardError::UnsafeGeneratedPath(
                relative_file.to_string_lossy().into_owned(),
            ));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(output_io_error(
                    "create output directory",
                    &current,
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "path component exists and is not a directory",
                    ),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|source| {
                    output_io_error("create output directory", &current, source)
                })?;
            }
            Err(source) => {
                return Err(output_io_error(
                    "inspect output directory",
                    &current,
                    source,
                ));
            }
        }
    }
    Ok(())
}

fn rollback_publication(published: &mut [PublishedFile]) -> Vec<String> {
    let mut failures = Vec::new();
    for entry in published.iter_mut().rev() {
        if entry.installed
            && let Err(error) = fs::remove_file(&entry.target)
        {
            failures.push(format!("remove '{}': {error}", entry.target.display()));
        }
        if let Some(backup) = &entry.backup
            && let Err(error) = fs::rename(backup, &entry.target)
        {
            failures.push(format!(
                "restore '{}' from '{}': {error}",
                entry.target.display(),
                backup.display()
            ));
        }
    }
    failures
}

fn output_io_error(operation: &'static str, path: &Path, source: std::io::Error) -> BardError {
    BardError::OutputPersistence {
        operation,
        path: path.to_path_buf(),
        source,
        rollback: None,
    }
}

/// Compile into an output directory exclusively owned by this compilation.
/// Callers must keep concurrent readers and other compiles away until it returns.
pub fn compile(request: CompileRequest, output_dir: &Path) -> Result<Manifest, BardError> {
    validate_request(&request)?;

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

    let diagrams = MermaidRenderer::new();
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
                    severity: DiagnosticSeverity::Warning,
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
                    severity: DiagnosticSeverity::Error,
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
    let render_result =
        comrak::html::format_document_with_plugins(root, &options, &mut rendered_html, &plugins);
    let diagram_output = diagrams.finish()?;
    render_result.map_err(BardError::Format)?;
    let citation_style_id = citations.style_id().to_owned();
    let rendered_html = citations.apply(rendered_html)?;
    let safe_html = sanitize_html(&rendered_html);
    let safe_html = format!(
        "<article class=\"bard-article\" lang=\"{}\">{safe_html}</article>",
        request.locale
    );
    let article_css = article_css()?;
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
    files.extend(diagram_output.files);
    let bundle = OutputBundle::new(files)?;
    let manifest_files = bundle.manifest_files();

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
    .map_err(BardError::Fingerprint)?;

    bundle.persist(output_dir)?;

    Ok(Manifest {
        schema_version: SCHEMA_VERSION,
        files: manifest_files,
        toc,
        diagnostics: diagnostics
            .into_iter()
            .chain(diagram_output.diagnostics)
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
    check_max_chars("document.title", &request.document.title, MAX_TITLE_CHARS)?;
    for (field, value) in [
        ("document.slug", request.document.slug.as_deref()),
        (
            "document.revision_id",
            request.document.revision_id.as_deref(),
        ),
    ] {
        if let Some(value) = value {
            check_max_chars(field, value, MAX_IDENTIFIER_CHARS)?;
        }
    }
    if let Some(style) = &request.citation_style {
        if style.is_empty() {
            return Err(BardError::EmptyField {
                field: "citation_style",
            });
        }
        check_max_chars("citation_style", style, MAX_CITATION_STYLE_CHARS)?;
        if !style
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(BardError::InvalidCitationStyle);
        }
    }
    for reference in &request.references {
        for (field, value) in [
            ("reference.key", reference.key.as_str()),
            ("reference.revision_id", reference.revision_id.as_str()),
        ] {
            if value.is_empty() {
                return Err(BardError::EmptyField { field });
            }
            check_max_chars(field, value, MAX_IDENTIFIER_CHARS)?;
        }
        if !reference.csl_json.is_object() {
            return Err(BardError::ReferenceNotObject {
                key: reference.key.clone(),
            });
        }
    }
    Ok(())
}

fn check_max_chars(field: &'static str, value: &str, max: usize) -> Result<(), BardError> {
    if value.chars().count() > max {
        return Err(BardError::FieldTooLong { field, max });
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

fn article_css() -> Result<String, BardError> {
    let mut css = ARTICLE_CSS.to_owned();
    let themes = syntect::highlighting::ThemeSet::load_defaults();
    let theme = themes
        .themes
        .get("InspiredGitHub")
        .ok_or(BardError::SyntaxThemeMissing("InspiredGitHub"))?;
    let syntax_css =
        syntect::html::css_for_theme_with_class_style(theme, syntect::html::ClassStyle::Spaced)
            .map_err(BardError::SyntaxCss)?;
    css.push_str("\n/* Pinned syntect InspiredGitHub syntax theme. */\n");
    css.push_str(&syntax_css);
    Ok(css)
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
    state: Mutex<MermaidState>,
}

#[derive(Default)]
struct MermaidState {
    generated: BTreeMap<String, (String, String)>,
    diagnostics: Vec<Diagnostic>,
    failure: Option<MermaidFailure>,
}

#[derive(Debug)]
enum MermaidFailure {
    AssetConflict { path: String },
}

impl MermaidState {
    fn insert_asset(
        &mut self,
        path: String,
        media_type: String,
        contents: String,
    ) -> Result<(), MermaidFailure> {
        if let Some((existing_media_type, existing_contents)) = self.generated.get(&path) {
            if existing_media_type != &media_type || existing_contents != &contents {
                return Err(MermaidFailure::AssetConflict { path });
            }
            return Ok(());
        }
        self.generated.insert(path, (media_type, contents));
        Ok(())
    }
}

struct DiagramOutput {
    files: Vec<(String, String, String)>,
    diagnostics: Vec<Diagnostic>,
}

impl MermaidRenderer {
    fn new() -> Self {
        Self {
            state: Mutex::new(MermaidState::default()),
        }
    }

    fn finish(self) -> Result<DiagramOutput, BardError> {
        let state = match self.state.into_inner() {
            Ok(state) => state,
            Err(_) => return Err(BardError::MermaidRendererPoisoned),
        };
        if let Some(failure) = state.failure {
            return Err(match failure {
                MermaidFailure::AssetConflict { path } => BardError::MermaidAssetConflict { path },
            });
        }
        Ok(DiagramOutput {
            files: state
                .generated
                .into_iter()
                .map(|(path, (media_type, contents))| (path, media_type, contents))
                .collect(),
            diagnostics: state.diagnostics,
        })
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
                    self.state
                        .lock()
                        .map_err(|_| fmt::Error)?
                        .diagnostics
                        .push(Diagnostic {
                            severity: DiagnosticSeverity::Error,
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
                let mut state = self.state.lock().map_err(|_| fmt::Error)?;
                if let Err(error) =
                    state.insert_asset(relative_path.clone(), "image/svg+xml".to_owned(), safe_svg)
                {
                    let MermaidFailure::AssetConflict { path } = error;
                    state.failure = Some(MermaidFailure::AssetConflict { path });
                    return Err(fmt::Error);
                }
                drop(state);
                write!(
                    output,
                    "<figure class=\"bard-diagram\"><img src=\"{relative_path}\" alt=\"Diagram\"></figure>"
                )
            }
            Err(error) => {
                self.state
                    .lock()
                    .map_err(|_| fmt::Error)?
                    .diagnostics
                    .push(Diagnostic {
                        severity: DiagnosticSeverity::Error,
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
    use std::panic::{AssertUnwindSafe, catch_unwind};

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
        assert_eq!(svg.path, format!("assets/diagram-{}.svg", svg.sha256));
        assert!(html.contains(&format!("src=\"{}\"", svg.path)));
        assert!(
            fs::read_to_string(output.path().join(&svg.path))
                .unwrap()
                .contains("<svg")
        );
    }

    #[test]
    fn poisoned_mermaid_adapter_state_is_reported_as_a_typed_error() {
        let renderer = MermaidRenderer::new();
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _state = renderer.state.lock().unwrap();
            panic!("poison the Mermaid renderer state for this regression test");
        }));
        assert!(panic.is_err());

        let mut output = String::new();
        let adapter_result = <MermaidRenderer as comrak::adapters::CodefenceRendererAdapter>::write(
            &renderer,
            &mut output,
            "mermaid",
            "",
            "flowchart LR\n A --> B",
            None,
        );
        assert!(adapter_result.is_err());
        assert!(matches!(
            renderer.finish(),
            Err(BardError::MermaidRendererPoisoned)
        ));
    }

    #[test]
    fn conflicting_mermaid_asset_contents_propagate_after_rendering() {
        let renderer = MermaidRenderer::new();
        let mut state = renderer.state.lock().unwrap();
        state
            .insert_asset(
                "assets/diagram-fixed.svg".to_owned(),
                "image/svg+xml".to_owned(),
                "<svg>first</svg>".to_owned(),
            )
            .unwrap();
        state.failure = state
            .insert_asset(
                "assets/diagram-fixed.svg".to_owned(),
                "image/svg+xml".to_owned(),
                "<svg>conflict</svg>".to_owned(),
            )
            .err();
        drop(state);

        assert!(matches!(
            renderer.finish(),
            Err(BardError::MermaidAssetConflict { path })
                if path == "assets/diagram-fixed.svg"
        ));
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
