use std::{fs, path::Path};

use bard::{BardError, CompileRequest, compile};

const REQUEST: &str = include_str!("fixtures/citations.request.json");
const GOLDEN: &str = include_str!("fixtures/citations.article.html");

fn compile_fixture(output: &Path, style: Option<&str>) -> bard::Manifest {
    let mut request: CompileRequest = serde_json::from_str(REQUEST).unwrap();
    request.citation_style = style.map(str::to_owned);
    compile(request, output).unwrap()
}

#[test]
fn citation_fixture_matches_golden_and_repeats_deterministically() {
    let output_a = tempfile::tempdir().unwrap();
    let output_b = tempfile::tempdir().unwrap();
    let manifest_a = compile_fixture(output_a.path(), None);
    let manifest_b = compile_fixture(output_b.path(), None);
    let html_a = fs::read_to_string(output_a.path().join("article.html")).unwrap();

    assert_eq!(html_a, GOLDEN);
    assert!(html_a.contains("[1, p. 10–12]"));
    assert!(html_a.contains("[1], [2]"));
    assert!(html_a.contains("[2, Seç. 2]"));
    assert!(html_a.contains("<h2 id=\"bard-references\">Referências</h2>"));
    assert_eq!(manifest_a.fingerprint, manifest_b.fingerprint);
    assert_eq!(manifest_a.files.len(), manifest_b.files.len());
    for (first, second) in manifest_a.files.iter().zip(&manifest_b.files) {
        assert_eq!(first.path, second.path);
        assert_eq!(first.sha256, second.sha256);
    }
}

#[test]
fn supports_selectable_archived_styles_and_rejects_unknown_styles() {
    let output = tempfile::tempdir().unwrap();
    compile_fixture(output.path(), Some("apa"));
    let html = fs::read_to_string(output.path().join("article.html")).unwrap();
    assert!(html.contains("(Klabnik &amp; Nichols, 2023, p. 10–12)"));
    assert!(html.contains("<span class=\"bard-citation\">2024</span>"));
    assert!(html.contains("<h2 id=\"bard-references\">Referências</h2>"));

    let mut request: CompileRequest = serde_json::from_str(REQUEST).unwrap();
    request.citation_style = Some("not-a-real-style".to_owned());
    assert!(matches!(
        compile(request, output.path()),
        Err(BardError::CitationStyle(style)) if style == "not-a-real-style"
    ));
}

#[test]
fn reports_missing_keys_and_preserves_them_as_text() {
    let output = tempfile::tempdir().unwrap();
    let mut request: CompileRequest = serde_json::from_str(REQUEST).unwrap();
    request.source = "A missing source [@not-provided].".to_owned();
    request.references.clear();
    let manifest = compile(request, output.path()).unwrap();
    let html = fs::read_to_string(output.path().join("article.html")).unwrap();

    assert!(html.contains("[@not-provided]"));
    assert!(manifest.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "citation.unknown_key"
            && diagnostic.line == Some(1)
            && diagnostic.column.is_some()
    }));
}

#[test]
fn sanitizes_markup_in_citation_metadata() {
    let output = tempfile::tempdir().unwrap();
    let mut request: CompileRequest = serde_json::from_str(REQUEST).unwrap();
    request.references[0].csl_json["title"] =
        serde_json::Value::String("<img src=x onerror=alert(1)> Unsafe title".to_owned());
    compile(request, output.path()).unwrap();
    let html = fs::read_to_string(output.path().join("article.html")).unwrap();

    assert!(!html.contains("onerror"));
    assert!(!html.contains("<img"));
    assert!(html.contains("Unsafe title"));
}
