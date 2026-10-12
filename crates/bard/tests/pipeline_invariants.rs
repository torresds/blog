use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

use bard::{BardError, CompileRequest, compile};

const REQUEST: &str = include_str!("fixtures/citations.request.json");

fn request() -> CompileRequest {
    serde_json::from_str(REQUEST).unwrap()
}

fn compile_error(request: CompileRequest) -> BardError {
    let output = tempfile::tempdir().unwrap();
    compile(request, output.path()).unwrap_err()
}

#[test]
fn rejects_schema_length_and_identifier_violations_in_library_api() {
    let mut invalid = request();
    invalid.document.title = "t".repeat(501);
    assert!(matches!(
        compile_error(invalid),
        BardError::FieldTooLong {
            field: "document.title",
            max: 500
        }
    ));

    let mut invalid = request();
    invalid.document.slug = Some("s".repeat(201));
    assert!(matches!(
        compile_error(invalid),
        BardError::FieldTooLong {
            field: "document.slug",
            max: 200
        }
    ));

    let mut invalid = request();
    invalid.citation_style = Some("IEEE".to_owned());
    assert!(matches!(
        compile_error(invalid),
        BardError::InvalidCitationStyle
    ));

    let mut invalid = request();
    invalid.citation_style = Some("s".repeat(121));
    assert!(matches!(
        compile_error(invalid),
        BardError::FieldTooLong {
            field: "citation_style",
            max: 120
        }
    ));

    let mut invalid = request();
    invalid.source = "s".repeat(2_000_001);
    assert!(matches!(compile_error(invalid), BardError::SourceTooLarge));

    let mut invalid = request();
    invalid.references[0].revision_id.clear();
    assert!(matches!(
        compile_error(invalid),
        BardError::EmptyField {
            field: "reference.revision_id"
        }
    ));

    let mut invalid = request();
    invalid.references[0].csl_json = serde_json::json!("not an object");
    assert!(matches!(
        compile_error(invalid),
        BardError::ReferenceNotObject { .. }
    ));
}

#[test]
fn invalid_cli_request_fails_before_creating_output_directory() {
    let temp = tempfile::tempdir().unwrap();
    let output_dir = temp.path().join("output");
    let mut input = request();
    input.document.title = "t".repeat(501);
    let input = serde_json::to_vec(&input).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_bard"))
        .arg("--output-dir")
        .arg(&output_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let result = child.wait_with_output().unwrap();

    assert!(!result.status.success());
    assert!(
        String::from_utf8_lossy(&result.stderr)
            .contains("document.title exceeds the 500-character limit")
    );
    assert!(!output_dir.exists());
}

#[test]
fn late_filesystem_failure_rolls_back_published_files_and_preserves_existing_data() {
    let temp = tempfile::tempdir().unwrap();
    let output_dir = temp.path().join("output");
    fs::create_dir(&output_dir).unwrap();
    fs::write(output_dir.join("article.css"), b"previous stylesheet").unwrap();
    fs::write(output_dir.join("article.html"), b"previous article").unwrap();
    let obstruction = output_dir.join("assets");
    fs::write(&obstruction, b"existing user data").unwrap();

    let mut input = request();
    input
        .source
        .push_str("\n```mermaid\nflowchart LR\n A --> B\n```\n");
    let error = compile(input, &output_dir).unwrap_err();

    match error {
        BardError::OutputPersistence {
            operation,
            path,
            source,
            ..
        } => {
            assert_eq!(operation, "create output directory");
            assert_eq!(path, obstruction);
            assert_eq!(source.kind(), std::io::ErrorKind::InvalidInput);
        }
        other => panic!("expected typed persistence error, got {other:?}"),
    }
    assert_eq!(fs::read(&obstruction).unwrap(), b"existing user data");
    assert_eq!(
        fs::read(output_dir.join("article.css")).unwrap(),
        b"previous stylesheet"
    );
    assert_eq!(
        fs::read(output_dir.join("article.html")).unwrap(),
        b"previous article"
    );
    assert!(fs::read_dir(&output_dir).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".bard-stage-")
    }));
}

#[test]
fn invalid_mermaid_remains_a_recoverable_diagnostic_with_fallback_output() {
    let temp = tempfile::tempdir().unwrap();
    let mut input = request();
    input.source = "```mermaid\nflowchart LR\nsubgraph missing\n A --> B\n```".to_owned();
    let manifest = compile(input, temp.path()).unwrap();
    let html = fs::read_to_string(temp.path().join("article.html")).unwrap();

    assert!(manifest.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "mermaid.invalid"
            && matches!(diagnostic.severity, bard::DiagnosticSeverity::Error)
    }));
    let diagnostic_json = serde_json::to_value(&manifest.diagnostics).unwrap();
    assert_eq!(diagnostic_json[0]["severity"], "error");
    assert!(html.contains("<pre><code>"));
    assert!(
        !manifest
            .files
            .iter()
            .any(|file| file.media_type == "image/svg+xml")
    );
}

#[test]
fn repeated_and_distinct_diagrams_compile_deterministically_in_an_exclusive_directory() {
    let temp = tempfile::tempdir().unwrap();
    let first_dir = temp.path().join("first");
    let second_dir = temp.path().join("second");
    let mut input = request();
    input.source = concat!(
        "# Diagrams\n\n",
        "```mermaid\nflowchart LR\n A --> B\n```\n\n",
        "```mermaid\nflowchart LR\n A --> B\n```\n\n",
        "```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```\n",
    )
    .to_owned();

    let first = compile(input.clone(), &first_dir).unwrap();
    let second = compile(input, &second_dir).unwrap();
    let assets = first
        .files
        .iter()
        .filter(|file| file.media_type == "image/svg+xml")
        .collect::<Vec<_>>();
    let html = fs::read_to_string(first_dir.join("article.html")).unwrap();

    assert_eq!(assets.len(), 2, "identical SVG assets are stored once");
    assert_eq!(html.matches("class=\"bard-diagram\"").count(), 3);
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(
        first
            .files
            .iter()
            .map(|file| (&file.path, &file.sha256))
            .collect::<Vec<_>>(),
        second
            .files
            .iter()
            .map(|file| (&file.path, &file.sha256))
            .collect::<Vec<_>>()
    );
    for file in &first.files {
        assert!(first_dir.join(&file.path).is_file());
    }
    assert!(fs::read_dir(&first_dir).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".bard-stage-")
    }));
}
