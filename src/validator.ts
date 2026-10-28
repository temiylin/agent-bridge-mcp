import path from "node:path";

/**
 * Validates that task_id contains only alphanumeric characters, hyphens, and underscores.
 * Any other characters (including slashes, backslashes, dots, spaces, etc.) are strictly rejected.
 */
export function isValidTaskId(taskId: unknown): taskId is string {
  if (typeof taskId !== "string" || taskId.length === 0) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(taskId);
}

/**
 * Generates a unique task_id adhering to the pattern: timestamp + random suffix.
 * Guaranteed to match /^[a-zA-Z0-9_-]+$/.
 */
export function generateTaskId(): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  return `task_${timestamp}_${randomSuffix}`;
}

/**
 * Resolves a filename inside baseDir and verifies that the resulting path
 * is strictly contained within baseDir and rootDir to prevent directory traversal.
 */
export function resolveSafePath(baseDir: string, rootDir: string, filename: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedRoot = path.resolve(rootDir);
  const targetPath = path.resolve(resolvedBase, filename);

  // Base directory containment check
  if (!targetPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: target "${targetPath}" is outside base directory "${resolvedBase}".`);
  }

  // Root directory containment check
  if (!targetPath.startsWith(resolvedRoot + path.sep) && targetPath !== resolvedRoot) {
    throw new Error(`Path traversal detected: target "${targetPath}" is outside root directory "${resolvedRoot}".`);
  }

  return targetPath;
}
