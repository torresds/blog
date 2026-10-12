use std::{
    env,
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

use bard::{CompileRequest, compile};

const MAX_REQUEST_BYTES: usize = 2_100_000;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("bard: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let mut output_dir: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        if arg == "--output-dir" {
            if output_dir.is_some() {
                return Err("--output-dir may be provided only once".into());
            }
            output_dir = args.next().map(PathBuf::from);
            if output_dir.is_none() {
                return Err("--output-dir requires a path".into());
            }
        } else {
            return Err(format!("unknown argument: {}", arg.to_string_lossy()));
        }
    }
    let output_dir = output_dir.ok_or_else(|| "--output-dir is required".to_owned())?;

    let mut input = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|error| format!("could not read request: {error}"))?;
    if input.len() > MAX_REQUEST_BYTES {
        return Err(format!(
            "request exceeds the {MAX_REQUEST_BYTES}-byte limit"
        ));
    }

    let request: CompileRequest =
        serde_json::from_slice(&input).map_err(|error| format!("invalid request JSON: {error}"))?;
    let manifest = compile(request, &output_dir).map_err(|error| error.to_string())?;
    serde_json::to_writer(io::stdout().lock(), &manifest)
        .map_err(|error| format!("could not write manifest: {error}"))?;
    println!();
    Ok(())
}
