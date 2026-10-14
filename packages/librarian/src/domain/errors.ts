export type LibrarianErrorCode =
  | 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'DUPLICATE_LOCALE' | 'DUPLICATE_TAG'
  | 'DUPLICATE_CITATION_KEY' | 'REVISION_CONFLICT' | 'REFERENCE_CONFLICT'
  | 'PUBLICATION_CONFLICT' | 'PUBLISHED_SLUG_CONFLICT' | 'UNKNOWN_TAGS'
  | 'UNKNOWN_CITATIONS' | 'INVALID_REVISION' | 'INVALID_ARTIFACT'
  | 'INVALID_PUBLICATION_TRANSITION';

export interface ValidationIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class LibrarianError extends Error {
  constructor(
    readonly code: LibrarianErrorCode,
    message: string,
    options?: ErrorOptions & { readonly issues?: readonly ValidationIssue[] },
  ) {
    super(message, options);
    this.name = 'LibrarianError';
    this.issues = options?.issues;
  }

  readonly issues: readonly ValidationIssue[] | undefined;
}

export function validationError(error: { readonly issues: readonly { readonly code: string; readonly path: PropertyKey[]; readonly message: string }[] }): LibrarianError {
  return new LibrarianError('VALIDATION', 'Input validation failed', {
    issues: error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String), message: issue.message })),
  });
}

export function notFound(entity: string): LibrarianError {
  return new LibrarianError('NOT_FOUND', `${entity} was not found`);
}
