import { describe, expect, it } from 'vitest';
import { citationJsBibTeXParser } from '../../src/integrations/citation-js/adapter.js';

describe('Citation.js BibTeX adapter', () => {
  it('normalizes mixed records, unicode, publication dates, DOI, and URLs deterministically', () => {
    const source = String.raw`@book{livro, title={Introdução à Ciência}, author={Silva, Ana}, year={2024}, publisher={Editora}}
@article{paper, title={Concurrency}, author={Lovelace, Ada}, journal={Systems}, year={2022}, doi={10.1234/example}, url={https://example.org/paper}}
@misc{web, title={Project page}, author={Doe, Jane}, year={2021}, url={https://example.org}}
@inproceedings{conf, title={Conference work}, booktitle={Systems Conference}, year={2020}}
@video{clip, title={A video}, author={Doe, Jane}, year={2023}, url={https://example.org/video}}`;
    const first = citationJsBibTeXParser.parse(source);
    const second = citationJsBibTeXParser.parse(source);
    expect(first.issues).toEqual([]);
    expect(first.entries.map(({ citationKey }) => citationKey)).toEqual(['livro', 'paper', 'web', 'conf', 'clip']);
    expect(first.entries).toEqual(second.entries);
    expect(first.entries[0]?.csl.title).toBe('Introdução à Ciência');
    expect(first.entries[0]?.csl.issued).toEqual({ 'date-parts': [[2024]] });
    expect(first.entries[1]?.csl.DOI ?? first.entries[1]?.csl.doi).toBe('10.1234/example');
    expect(first.entries[2]?.csl.URL ?? first.entries[2]?.csl.url).toBe('https://example.org');
    expect(first.entries[3]?.csl.type).toBe('paper-conference');
    expect(first.entries[4]?.csl.type).toBe('motion_picture');
  });

  it('returns actionable diagnostics for malformed or incomplete entries', () => {
    expect(citationJsBibTeXParser.parse('not bibtex').issues.length).toBeGreaterThan(0);
    expect(citationJsBibTeXParser.parse('@misc{x, url={https://example.org}}').issues.join(' ')).toContain('title');
  });
});
