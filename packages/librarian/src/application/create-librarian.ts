import { safeParse } from './validation.js';
import { CommitRevisionInputSchema, CreateLocaleInputSchema, CreateTagInputSchema, GetArticleHeadInputSchema, GetArticleRevisionInputSchema, GetLocaleInputSchema, GetPostInputSchema, ListArticleRevisionsInputSchema, ListPostLocalesInputSchema } from '../contracts/articles.js';
import { CommitReferenceRevisionInputSchema, CreateReferenceInputSchema, GetReferenceHeadInputSchema, GetReferenceInputSchema, GetReferenceRevisionInputSchema, ImportBibTeXInputSchema, ListReferenceRevisionsInputSchema, ParseBibTeXInputSchema } from '../contracts/bibliography.js';
import { ResolveCompilationSnapshotInputSchema } from '../contracts/compilation.js';
import { GetArtifactInputSchema, ListRevisionArtifactsInputSchema, RecordArtifactInputSchema } from '../contracts/artifacts.js';
import { GetPublicationInputSchema, GetPublishedArticleInputSchema, ListPublishedArticlesInputSchema, ListPublishedByTagInputSchema, PublicationHistoryInputSchema, PublishInputSchema, RollbackPublicationInputSchema, UnpublishInputSchema } from '../contracts/publications.js';
import { LibrarianError, notFound } from '../domain/errors.js';
import type { Page } from '../domain/pagination.js';
import type { ArticleHead, ArticleRevision, ArticleRevisionSummary, CommitRevisionInput, CreateLocaleInput, CreateTagInput, GetArticleHeadInput, GetArticleRevisionInput, GetLocaleInput, GetPostInput, ListArticleRevisionsInput, ListPostLocalesInput, Post, PostLocale, Tag } from '../contracts/articles.js';
import type { BibTeXImportResult, BibTeXParseResult, CommitReferenceRevisionInput, CreateReferenceInput, GetReferenceHeadInput, GetReferenceInput, GetReferenceRevisionInput, ImportBibTeXInput, ListReferenceRevisionsInput, ParseBibTeXInput, Reference, ReferenceHead, ReferenceRevision, ReferenceRevisionSummary } from '../contracts/bibliography.js';
import type { CompilationSnapshot, ResolveCompilationSnapshotInput } from '../contracts/compilation.js';
import type { ArticleArtifact, ArticleArtifactSummary, GetArtifactInput, ListRevisionArtifactsInput, RecordArtifactInput } from '../contracts/artifacts.js';
import type { GetPublicationInput, GetPublishedArticleInput, ListPublishedArticlesInput, ListPublishedByTagInput, PublicationEvent, PublicationHistoryInput, PublishInput, PublishedArticle, PublishedArticleSummary, RollbackPublicationInput, UnpublishInput } from '../contracts/publications.js';
import type { DiscoveryRepository } from '../ports/discovery.js';
import type { TransactionManager } from '../ports/transaction.js';
import type { PublicationState } from '../domain/publication-state.js';

export interface ArticleService {
  createPost(): Promise<Post>; createLocale(input: CreateLocaleInput): Promise<PostLocale>; getPost(input: GetPostInput): Promise<Post>;
  getLocale(input: GetLocaleInput): Promise<PostLocale>; listPostLocales(input: ListPostLocalesInput): Promise<readonly PostLocale[]>;
  createTag(input: CreateTagInput): Promise<Tag>; commitRevision(input: CommitRevisionInput): Promise<ArticleRevision>;
  getHead(input: GetArticleHeadInput): Promise<ArticleHead>; getRevision(input: GetArticleRevisionInput): Promise<ArticleRevision>;
  listRevisions(input: ListArticleRevisionsInput): Promise<Page<ArticleRevisionSummary>>;
}
export interface BibliographyService {
  createReference(input: CreateReferenceInput): Promise<Reference>; getReference(input: GetReferenceInput): Promise<Reference>;
  getHead(input: GetReferenceHeadInput): Promise<ReferenceHead>; getRevision(input: GetReferenceRevisionInput): Promise<ReferenceRevision>;
  listRevisions(input: ListReferenceRevisionsInput): Promise<Page<ReferenceRevisionSummary>>; commitRevision(input: CommitReferenceRevisionInput): Promise<ReferenceRevision>;
  parseBibTeX(input: ParseBibTeXInput): BibTeXParseResult; importBibTeX(input: ImportBibTeXInput): Promise<BibTeXImportResult>;
}
export interface CompilationService { resolveSnapshot(input: ResolveCompilationSnapshotInput): Promise<CompilationSnapshot> }
export interface ArtifactService { record(input: RecordArtifactInput): Promise<ArticleArtifact>; get(input: GetArtifactInput): Promise<ArticleArtifact>; listForRevision(input: ListRevisionArtifactsInput): Promise<Page<ArticleArtifactSummary>> }
export interface PublicationService { get(input: GetPublicationInput): Promise<PublicationState>; publish(input: PublishInput): Promise<PublicationState>; unpublish(input: UnpublishInput): Promise<PublicationState>; rollback(input: RollbackPublicationInput): Promise<PublicationState>; history(input: PublicationHistoryInput): Promise<Page<PublicationEvent>> }
export interface DiscoveryService { getPublishedArticle(input: GetPublishedArticleInput): Promise<PublishedArticle>; listPublishedArticles(input: ListPublishedArticlesInput): Promise<Page<PublishedArticleSummary>>; listPublishedByTag(input: ListPublishedByTagInput): Promise<Page<PublishedArticleSummary>> }
export interface Librarian { readonly articles: ArticleService; readonly bibliography: BibliographyService; readonly compilation: CompilationService; readonly artifacts: ArtifactService; readonly publications: PublicationService; readonly discovery: DiscoveryService }
export interface BibTeXParser { parse(source: string): BibTeXParseResult }
export interface LibrarianDependencies { readonly transactions: TransactionManager; readonly discovery: DiscoveryRepository; readonly bibtex: BibTeXParser }

export function createLibrarian({ transactions, discovery, bibtex }: LibrarianDependencies): Librarian {
  const articles: ArticleService = {
    createPost: () => transactions.run((tx) => tx.articles.createPost()),
    createLocale: async (raw) => { const i = safeParse(CreateLocaleInputSchema, raw); return transactions.run((tx) => tx.articles.createLocale(i.postId, i.locale)); },
    getPost: async (raw) => { const i = safeParse(GetPostInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.articles.getPost(i.postId); if (!x) throw notFound('Post'); return x; }); },
    getLocale: async (raw) => { const i = safeParse(GetLocaleInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.articles.getLocale(i.localeId); if (!x) throw notFound('Locale'); return x; }); },
    listPostLocales: async (raw) => { const i = safeParse(ListPostLocalesInputSchema, raw); return transactions.run(async (tx) => { if (!await tx.articles.getPost(i.postId)) throw notFound('Post'); return tx.articles.listPostLocales(i.postId); }); },
    createTag: async (raw) => { const i = safeParse(CreateTagInputSchema, raw); return transactions.run((tx) => tx.articles.createTag(i)); },
    commitRevision: async (raw) => { const i = safeParse(CommitRevisionInputSchema, raw); return transactions.run(async (tx) => {
      const slugs = [...new Set(i.tags)]; const tags = await tx.articles.resolveTags(slugs); const present = new Set(tags.map((tag) => tag.slug));
      const missing = slugs.filter((slug) => !present.has(slug));
      if (missing.length) throw new LibrarianError('UNKNOWN_TAGS', `Unknown tags: ${missing.join(', ')}`);
      return tx.articles.commitRevision(i, tags);
    }); },
    getHead: async (raw) => { const i = safeParse(GetArticleHeadInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.articles.getHead(i.localeId); if (!x) throw notFound('Article locale'); return x; }); },
    getRevision: async (raw) => { const i = safeParse(GetArticleRevisionInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.articles.getRevision(i.revisionId); if (!x) throw notFound('Article revision'); return x; }); },
    listRevisions: async (raw) => { const i = safeParse(ListArticleRevisionsInputSchema, raw); return transactions.run(async (tx) => { if (!await tx.articles.getLocale(i.localeId)) throw notFound('Article locale'); return tx.articles.listRevisions(i.localeId, i.limit, i.cursor); }); },
  };
  const bibliography: BibliographyService = {
    createReference: async (raw) => { const i = safeParse(CreateReferenceInputSchema, raw); return transactions.run(async (tx) => (await tx.bibliography.createReference(i.citationKey, i.csl)).reference); },
    getReference: async (raw) => { const i = safeParse(GetReferenceInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.bibliography.getReference(i.referenceId); if (!x) throw notFound('Reference'); return x; }); },
    getHead: async (raw) => { const i = safeParse(GetReferenceHeadInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.bibliography.getHead(i.referenceId); if (!x) throw notFound('Reference'); return x; }); },
    getRevision: async (raw) => { const i = safeParse(GetReferenceRevisionInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.bibliography.getRevision(i.revisionId); if (!x) throw notFound('Reference revision'); return x; }); },
    listRevisions: async (raw) => { const i = safeParse(ListReferenceRevisionsInputSchema, raw); return transactions.run(async (tx) => { if (!await tx.bibliography.getReference(i.referenceId)) throw notFound('Reference'); return tx.bibliography.listRevisions(i.referenceId, i.limit, i.cursor); }); },
    commitRevision: async (raw) => { const i = safeParse(CommitReferenceRevisionInputSchema, raw); return transactions.run((tx) => tx.bibliography.commitRevision(i)); },
    parseBibTeX: (raw) => bibtex.parse(safeParse(ParseBibTeXInputSchema, raw).source),
    importBibTeX: async (raw) => {
      const parsed = bibtex.parse(safeParse(ImportBibTeXInputSchema, raw).source);
      if (parsed.issues.length) throw new LibrarianError('VALIDATION', 'BibTeX contains invalid entries', { issues: parsed.issues.map((message) => ({ code: 'bibtex.invalid_entry', path: [], message })) });
      const keys = parsed.entries.map((entry) => entry.citationKey); if (new Set(keys).size !== keys.length) throw new LibrarianError('DUPLICATE_CITATION_KEY', 'BibTeX input contains duplicate citation keys');
      return transactions.run(async (tx) => { const rows = await tx.bibliography.importEntries(parsed.entries); return { references: rows.map((x) => x.reference), revisions: rows.map((x) => x.revision) }; });
    },
  };
  const compilation: CompilationService = {
    resolveSnapshot: async (raw) => { const i = safeParse(ResolveCompilationSnapshotInputSchema, raw); return transactions.run(async (tx) => {
      const revision = await tx.articles.getRevision(i.revisionId); if (!revision) throw notFound('Article revision');
      const locale = await tx.articles.getLocale(revision.localeId); if (!locale) throw notFound('Article locale');
      const keys = [...new Set(i.citationKeys)]; const refs = await tx.bibliography.findByCitationKeys(keys);
      const missing = keys.filter((key) => !refs.some((ref) => ref.citationKey === key));
      if (missing.length) throw new LibrarianError('UNKNOWN_CITATIONS', `Unknown citations: ${missing.join(', ')}`);
      return { articleId: locale.postId, localeId: locale.id, locale: locale.locale, revisionId: revision.id, revisionNumber: revision.revisionNumber, title: revision.title, slug: revision.slug, markdown: revision.markdown, subtitle: revision.subtitle ?? null, excerpt: revision.excerpt ?? null, seo: revision.seo, presentation: revision.presentation, references: refs.map((ref) => ({ referenceId: ref.referenceId, citationKey: ref.citationKey, revisionId: ref.id, revisionNumber: ref.revisionNumber, csl: ref.csl })) };
    }, { isolationLevel: 'repeatable read' }); },
  };
  const artifacts: ArtifactService = {
    record: async (raw) => { const i = safeParse(RecordArtifactInputSchema, raw); return transactions.run((tx) => tx.artifacts.record(i)); },
    get: async (raw) => { const i = safeParse(GetArtifactInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.artifacts.get(i.artifactId); if (!x) throw notFound('Artifact'); return x; }); },
    listForRevision: async (raw) => { const i = safeParse(ListRevisionArtifactsInputSchema, raw); return transactions.run(async (tx) => { if (!await tx.articles.getRevision(i.revisionId)) throw notFound('Article revision'); return tx.artifacts.listForRevision(i.revisionId, i.limit, i.cursor); }); },
  };
  const publications: PublicationService = {
    get: async (raw) => { const i = safeParse(GetPublicationInputSchema, raw); return transactions.run(async (tx) => { const x = await tx.publications.get(i.localeId); if (!x) throw notFound('Publication locale'); return x; }); },
    publish: async (raw) => { const i = safeParse(PublishInputSchema, raw); return transactions.run((tx) => tx.publications.publish(i)); },
    unpublish: async (raw) => { const i = safeParse(UnpublishInputSchema, raw); return transactions.run((tx) => tx.publications.unpublish(i)); },
    rollback: async (raw) => { const i = safeParse(RollbackPublicationInputSchema, raw); return transactions.run((tx) => tx.publications.rollback(i)); },
    history: async (raw) => { const i = safeParse(PublicationHistoryInputSchema, raw); return transactions.run(async (tx) => { if (!await tx.articles.getLocale(i.localeId)) throw notFound('Article locale'); return tx.publications.history(i.localeId, i.limit, i.cursor); }); },
  };
  const discoveryService: DiscoveryService = {
    getPublishedArticle: async (raw) => { const i = safeParse(GetPublishedArticleInputSchema, raw); const x = await discovery.getPublishedArticle(i.locale, i.slug); if (!x) throw notFound('Published article'); return x; },
    listPublishedArticles: async (raw) => { const i = safeParse(ListPublishedArticlesInputSchema, raw); return discovery.listPublishedArticles(i.locale, i.limit, i.cursor); },
    listPublishedByTag: async (raw) => { const i = safeParse(ListPublishedByTagInputSchema, raw); return discovery.listPublishedByTag(i.locale, i.tag, i.limit, i.cursor); },
  };
  return { articles, bibliography, compilation, artifacts, publications, discovery: discoveryService };
}
