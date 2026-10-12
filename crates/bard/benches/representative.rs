use std::{hint::black_box, time::Instant};

use bard::{CompileRequest, Document, Reference, compile};

const SOURCE: &str = include_str!("fixtures/representative.md");
const WARMUP_ITERATIONS: usize = 5;
const MEASURED_ITERATIONS: usize = 40;

fn main() {
    let references = vec![
        Reference {
            key: "rust-book".to_owned(),
            revision_id: "book-1".to_owned(),
            csl_json: serde_json::json!({
                "type": "book",
                "title": "The Rust Programming Language",
                "author": [
                    { "family": "Klabnik", "given": "Steve" },
                    { "family": "Nichols", "given": "Carol" }
                ],
                "issued": { "date-parts": [[2023]] },
                "publisher": "No Starch Press"
            }),
        },
        Reference {
            key: "rust-paper".to_owned(),
            revision_id: "paper-1".to_owned(),
            csl_json: serde_json::json!({
                "type": "article-journal",
                "title": "Fearless Concurrency in Practice",
                "author": [{ "family": "Garcia", "given": "Ana" }],
                "container-title": "Journal of Systems",
                "volume": "12",
                "issue": "3",
                "page": "44-58",
                "issued": { "date-parts": [[2024, 5]] }
            }),
        },
    ];
    let request = CompileRequest {
        schema_version: 1,
        source: SOURCE.to_owned(),
        locale: "en-US".to_owned(),
        citation_style: None,
        document: Document {
            title: "Building reliable software systems".to_owned(),
            slug: Some("reliable-software".to_owned()),
            revision_id: Some("benchmark-1".to_owned()),
        },
        references,
    };
    let output = tempfile::tempdir().expect("create benchmark output directory");
    let source_bytes = SOURCE.len();
    let mut samples = Vec::with_capacity(MEASURED_ITERATIONS);

    for iteration in 0..WARMUP_ITERATIONS + MEASURED_ITERATIONS {
        let started = Instant::now();
        let manifest = compile(black_box(request.clone()), output.path())
            .expect("compile representative article");
        black_box(manifest.fingerprint);
        if iteration >= WARMUP_ITERATIONS {
            samples.push(started.elapsed());
        }
    }

    samples.sort_unstable();
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() * 95).div_ceil(100) - 1];
    println!("Bard representative compile benchmark");
    println!(
        "source: {source_bytes} bytes; iterations: {MEASURED_ITERATIONS} (after {WARMUP_ITERATIONS} warmups)"
    );
    println!("p50: {:.2} ms", p50.as_secs_f64() * 1_000.0);
    println!("p95: {:.2} ms", p95.as_secs_f64() * 1_000.0);
}
