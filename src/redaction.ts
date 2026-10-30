/**
 * Log redaction and extraction utilities.
 */

/**
 * Extracts the last N lines from content, respecting maxBytes boundary.
 */
export function extractLastLines(content: string, maxLines: number = 20, maxBytes: number = 10000): string {
  if (!content) return "";
  let text = content;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const buf = Buffer.from(text, "utf8");
    text = buf.subarray(buf.length - maxBytes).toString("utf8");
    // Drop first partial line if any
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
  }

  const lines = text.split("\n");
  if (lines.length > maxLines) {
    return lines.slice(lines.length - maxLines).join("\n");
  }
  return lines.join("\n");
}

/**
 * Extracts real execution summary without fabrication.
 */
export function extractExecutionSummary(stdout: string, stderr: string): string {
  const combined = (stdout || "") + "\n" + (stderr || "");
  const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "Execution completed without text output.";
  // Return last non-empty line as concise summary, truncated to 200 chars
  const lastLine = lines[lines.length - 1];
  return lastLine.length > 200 ? lastLine.slice(0, 197) + "..." : lastLine;
}

export interface GitLinkItem {
  type: "pr" | "commit";
  title: string;
  url: string;
}

/**
 * Extracts Git pull request and commit links from logs/output.
 */
export function extractGitLinks(output: string, repo?: string): GitLinkItem[] {
  const links: GitLinkItem[] = [];
  if (!output) return links;

  const prMatches = output.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g);
  for (const match of prMatches) {
    const url = match[0];
    if (!links.some((l) => l.url === url)) {
      links.push({
        type: "pr",
        title: `PR #${match[3]}`,
        url,
      });
    }
  }

  const commitMatches = output.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([a-f0-9]{7,40})/g);
  for (const match of commitMatches) {
    const url = match[0];
    if (!links.some((l) => l.url === url)) {
      links.push({
        type: "commit",
        title: `Commit ${match[3].slice(0, 7)}`,
        url,
      });
    }
  }

  return links;
}
