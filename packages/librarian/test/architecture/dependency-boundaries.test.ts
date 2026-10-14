import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : extname(path) === '.ts' ? [path] : [];
  });
}
function source(path: string): string { return readFileSync(path, 'utf8'); }
function dependencyGraph(): Map<string, string[]> {
  const modules = files(root); const known = new Set(modules); const graph = new Map<string, string[]>();
  for (const file of modules) {
    const imports: string[] = []; const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;
    for (const match of source(file).matchAll(pattern)) {
      const specifier = match[1]; if (!specifier) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (known.has(target)) imports.push(target);
    }
    graph.set(file, imports);
  }
  return graph;
}

describe('Librarian dependency boundaries', () => {
  it('keeps domain and application modules independent of PostgreSQL', () => {
    for (const layer of ['domain', 'contracts', 'ports', 'application']) {
      for (const file of files(resolve(root, layer))) {
        expect(source(file), file).not.toMatch(/from ['"](?:kysely|pg)(?:['"]|\/)/);
        expect(source(file), file).not.toMatch(/infrastructure\/postgres/);
      }
    }
  });

  it('keeps adapters inside the PostgreSQL infrastructure boundary', () => {
    for (const file of files(resolve(root, 'infrastructure/postgres'))) {
      expect(source(file), file).not.toMatch(/(?:herald|bard|atelier)/i);
    }
  });

  it('does not expose database row types from the package root', () => {
    const index = source(resolve(root, 'index.ts'));
    expect(index).not.toMatch(/infrastructure|PostRow|RevisionRow|Database/);
  });

  it('has no circular source imports', () => {
    const graph = dependencyGraph(); const active = new Set<string>(); const complete = new Set<string>();
    const visit = (file: string): void => {
      if (active.has(file)) throw new Error(`Circular import detected at ${file}`);
      if (complete.has(file)) return;
      active.add(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency);
      active.delete(file); complete.add(file);
    };
    for (const file of graph.keys()) visit(file);
    expect(complete.size).toBe(graph.size);
  });
});
