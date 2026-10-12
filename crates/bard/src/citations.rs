use std::{collections::HashMap, str::FromStr, sync::OnceLock};

use comrak::nodes::{AstNode, NodeValue};
use hayagriva::{
    BibliographyDriver, BibliographyRequest, BufWriteFormat, CitationItem, CitationRequest,
    CitePurpose, LocatorPayload, SpecificLocator,
    archive::ArchivedStyle,
    citationberg::{CitationFormat, Locale, LocaleCode, Style, StyleCategory, json::Item},
};

use crate::{BardError, CompileRequest, Diagnostic, digest, escape_html};

const DEFAULT_STYLE: &str = "ieee";

#[derive(Clone)]
struct ParsedCitationItem {
    key: String,
    suppress_author: bool,
    locator: Option<(hayagriva::citationberg::taxonomy::Locator, String)>,
}

#[derive(Clone)]
struct ParsedCitation {
    token: String,
    items: Vec<ParsedCitationItem>,
}

pub(crate) struct PreparedCitations {
    style_id: String,
    citations: Vec<ParsedCitation>,
    entries: Vec<Item>,
    entry_indices: HashMap<String, usize>,
    style: hayagriva::citationberg::IndependentStyle,
    locale: LocaleCode,
    bibliography_title: &'static str,
}

impl PreparedCitations {
    pub(crate) fn style_id(&self) -> &str {
        &self.style_id
    }

    pub(crate) fn apply(self, mut html: String) -> String {
        if self.citations.is_empty() {
            return html;
        }

        let locales = locale_files();
        let mut driver = BibliographyDriver::<Item>::new();
        for citation in &self.citations {
            let items = citation
                .items
                .iter()
                .map(|item| {
                    let entry = &self.entries[self.entry_indices[&item.key]];
                    let locator = item
                        .locator
                        .as_ref()
                        .map(|(label, value)| SpecificLocator(*label, LocatorPayload::Str(value)));
                    CitationItem::new(
                        entry,
                        locator,
                        None,
                        false,
                        citation_purpose(&self.style, item.suppress_author),
                    )
                })
                .collect();
            driver.citation(CitationRequest::new(
                items,
                &self.style,
                Some(self.locale.clone()),
                locales,
                None,
            ));
        }

        let rendered = driver.finish(BibliographyRequest::new(
            &self.style,
            Some(self.locale.clone()),
            locales,
        ));
        for (citation, formatted) in self.citations.iter().zip(rendered.citations) {
            let mut content = String::new();
            formatted
                .citation
                .write_buf(&mut content, BufWriteFormat::Html)
                .expect("writing citation markup to a string cannot fail");
            html = html.replace(
                &citation.token,
                &format!(
                    "<span class=\"bard-citation\">{}</span>",
                    sanitize_citation_markup(&content)
                ),
            );
        }

        if let Some(bibliography) = rendered.bibliography
            && !bibliography.items.is_empty()
        {
            let mut output = format!(
                "<section class=\"bard-bibliography\" aria-labelledby=\"bard-references\"><h2 id=\"bard-references\">{}</h2><div class=\"bard-bibliography-list\" role=\"list\">",
                self.bibliography_title
            );
            for item in bibliography.items {
                output.push_str("<div class=\"bard-bibliography-entry\" role=\"listitem\">");
                let content_start = output.len();
                if let Some(first_field) = item.first_field {
                    first_field
                        .write_buf(&mut output, BufWriteFormat::Html)
                        .expect("writing bibliography markup to a string cannot fail");
                    output.push(' ');
                }
                item.content
                    .write_buf(&mut output, BufWriteFormat::Html)
                    .expect("writing bibliography markup to a string cannot fail");
                let safe_content = sanitize_citation_markup(&output[content_start..]);
                output.truncate(content_start);
                output.push_str(&safe_content);
                output.push_str("</div>");
            }
            output.push_str("</div></section>");
            html.push_str(&output);
        }

        html
    }
}

fn sanitize_citation_markup(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .tags(["a", "b", "em", "i", "span", "strong", "sub", "sup"].into())
        .tag_attributes(
            [
                ("a", ["href", "title"].into_iter().collect()),
                ("span", ["class"].into_iter().collect()),
            ]
            .into(),
        );
    builder.clean(html).to_string()
}

fn citation_purpose(
    style: &hayagriva::citationberg::IndependentStyle,
    suppress_author: bool,
) -> Option<CitePurpose> {
    if !suppress_author {
        return None;
    }
    let numeric = style.info.category.iter().any(|category| {
        matches!(
            category,
            StyleCategory::CitationFormat {
                format: CitationFormat::Numeric | CitationFormat::Label
            }
        )
    });
    (!numeric).then_some(CitePurpose::Year)
}

pub(crate) fn prepare<'a>(
    root: &'a AstNode<'a>,
    request: &CompileRequest,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<PreparedCitations, BardError> {
    let requested_style = request.citation_style.as_deref().unwrap_or(DEFAULT_STYLE);
    let archived = ArchivedStyle::by_name(requested_style)
        .ok_or_else(|| BardError::CitationStyle(requested_style.to_owned()))?;
    let style_id = archived.names()[0].to_owned();
    let style = match archived.get() {
        Style::Independent(style) => style,
        Style::Dependent(_) => return Err(BardError::CitationStyle(requested_style.to_owned())),
    };

    let mut references = HashMap::new();
    for reference in &request.references {
        if references
            .insert(reference.key.as_str(), reference)
            .is_some()
        {
            return Err(BardError::Reference {
                key: reference.key.clone(),
                message: "duplicate citation key".to_owned(),
            });
        }
    }

    let token_base = unique_token_base(&request.source);
    let mut citations = Vec::new();
    for node in root.descendants() {
        let source_text = {
            let data = node.data.borrow();
            match &data.value {
                NodeValue::Text(text) => Some((text.clone(), data.sourcepos.start)),
                _ => None,
            }
        };
        let Some((text, source_start)) = source_text else {
            continue;
        };

        let mut output = String::new();
        let mut cursor = 0;
        let mut changed = false;
        while let Some(relative_open) = text[cursor..].find('[') {
            let open = cursor + relative_open;
            if open > 0 && text.as_bytes()[open - 1] == b'\\' {
                output.push_str(&escape_html(&text[cursor..=open]));
                cursor = open + 1;
                continue;
            }
            let Some(relative_close) = text[open + 1..].find(']') else {
                break;
            };
            let close = open + 1 + relative_close;
            let Some(items) = parse_cluster(&text[open + 1..close]) else {
                output.push_str(&escape_html(&text[cursor..=close]));
                cursor = close + 1;
                continue;
            };

            let missing = items
                .iter()
                .filter(|item| !references.contains_key(item.key.as_str()))
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                for item in missing {
                    let (line, column) =
                        source_location(&text, open, source_start.line, source_start.column);
                    diagnostics.push(Diagnostic {
                        severity: "error".to_owned(),
                        code: "citation.unknown_key".to_owned(),
                        message: format!("citation key '{}' was not provided", item.key),
                        line: Some(line),
                        column: Some(column),
                    });
                }
                output.push_str(&escape_html(&text[cursor..=close]));
            } else {
                output.push_str(&escape_html(&text[cursor..open]));
                let token = format!("{token_base}{}__", citations.len());
                output.push_str(&token);
                citations.push(ParsedCitation { token, items });
                changed = true;
            }
            cursor = close + 1;
        }

        if changed {
            output.push_str(&escape_html(&text[cursor..]));
            node.data.borrow_mut().value = NodeValue::HtmlInline(output);
        }
    }

    let mut entries = Vec::new();
    let mut entry_indices = HashMap::new();
    for citation in &citations {
        for item in &citation.items {
            if entry_indices.contains_key(&item.key) {
                continue;
            }
            let reference = references[item.key.as_str()];
            let mut csl_json = reference.csl_json.clone();
            let Some(object) = csl_json.as_object_mut() else {
                return Err(BardError::Reference {
                    key: reference.key.clone(),
                    message: "expected a CSL JSON object".to_owned(),
                });
            };
            object.insert(
                "id".to_owned(),
                serde_json::Value::String(reference.key.clone()),
            );
            let entry =
                serde_json::from_value::<Item>(csl_json).map_err(|error| BardError::Reference {
                    key: reference.key.clone(),
                    message: error.to_string(),
                })?;
            entry_indices.insert(item.key.clone(), entries.len());
            entries.push(entry);
        }
    }

    let locale = LocaleCode(request.locale.clone());
    Ok(PreparedCitations {
        style_id,
        citations,
        entries,
        entry_indices,
        style,
        locale,
        bibliography_title: if request.locale == "pt-BR" {
            "Referências"
        } else {
            "References"
        },
    })
}

fn parse_cluster(body: &str) -> Option<Vec<ParsedCitationItem>> {
    let mut items = Vec::new();
    for raw_item in body.split(';') {
        let part = raw_item.trim();
        let (suppress_author, remainder) = if let Some(rest) = part.strip_prefix("-@") {
            (true, rest)
        } else {
            (false, part.strip_prefix('@')?)
        };
        let key_end = remainder
            .find([',', ' ', '\t', '\n', '\r'])
            .unwrap_or(remainder.len());
        if key_end == 0 {
            return None;
        }
        let key = remainder[..key_end].to_owned();
        let suffix = remainder[key_end..].trim();
        let locator = if suffix.is_empty() {
            None
        } else {
            let raw_locator = suffix.strip_prefix(',')?.trim();
            let (label, value) = split_locator(raw_locator);
            if value.is_empty() {
                return None;
            }
            let label = hayagriva::citationberg::taxonomy::Locator::from_str(label).ok()?;
            Some((label, value.to_owned()))
        };
        items.push(ParsedCitationItem {
            key,
            suppress_author,
            locator,
        });
    }
    (!items.is_empty()).then_some(items)
}

fn split_locator(locator: &str) -> (&str, &str) {
    let Some((candidate, value)) = locator.split_once(char::is_whitespace) else {
        return ("page", locator);
    };
    let label = candidate.trim_end_matches('.').to_ascii_lowercase();
    let label = match label.as_str() {
        "p" | "pp" | "page" | "pages" => "page",
        "ch" | "chs" | "chap" | "chapter" | "chapters" => "chapter",
        "sec" | "secs" | "section" | "sections" => "section",
        "para" | "paras" | "paragraph" | "paragraphs" => "paragraph",
        "vol" | "vols" | "volume" | "volumes" => "volume",
        "fig" | "figs" | "figure" | "figures" => "figure",
        "tbl" | "tbls" | "table" | "tables" => "table",
        "eq" | "eqs" | "equation" | "equations" => "equation",
        _ => return ("page", locator),
    };
    (label, value.trim())
}

fn source_location(
    text: &str,
    offset: usize,
    start_line: usize,
    start_column: usize,
) -> (usize, usize) {
    let prefix = &text[..offset];
    let line_breaks = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let line = start_line + line_breaks;
    let column = prefix
        .rsplit('\n')
        .next()
        .map(|tail| {
            if line_breaks == 0 {
                start_column + tail.chars().count()
            } else {
                1 + tail.chars().count()
            }
        })
        .unwrap_or(start_column);
    (line, column)
}

fn unique_token_base(source: &str) -> String {
    let base = format!("BARD_CITATION_{}__", digest(source.as_bytes()));
    let mut token = base.clone();
    while source.contains(&token) {
        token.push('_');
    }
    token
}

fn locale_files() -> &'static [Locale] {
    static LOCALES: OnceLock<Vec<Locale>> = OnceLock::new();
    LOCALES.get_or_init(hayagriva::archive::locales).as_slice()
}
