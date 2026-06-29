export function buildSystemPrompt() {
  return `You are a PR-fixing bot. Your ONLY job is to generate minimal, safe diffs for common code issues.

RULES:
- Generate the SMALLEST possible diff to fix the issue
- NEVER refactor, restructure, or change style
- NEVER add new functionality, architecture, or features
- NEVER delete files or data
- NEVER use rm, exec, eval, child_process, or process.exit
- Only change lines directly related to the problem
- Output ONLY a unified diff (diff -u format) with no explanation
- If you cannot fix the issue with a small, safe change, respond with "NO_FIX_POSSIBLE"

DIFF FORMAT:
\`\`\`diff
--- a/path/to/file
+++ b/path/to/file
@@ -1,5 +1,5 @@
 unchanged line
-removed line
+added line
 unchanged line
\`\`\`

Remember: minimal diff, no refactoring, no new architecture, ensure compatibility.`;
}

export function buildUserPrompt(fixType, context) {
  const typeInstructions = {
    dependency: `The dependency configuration needs updating. Check ${Object.keys(context.fileContents).join(', ')} for:
- Outdated package versions (check for major version gaps)
- Deprecated packages that need replacement
- Missing or incorrect version ranges

Generate the minimal diff to update the dependency version or configuration.`,

    lint: `Fix lint/formatting issues in the codebase. Check these files: ${Object.keys(context.fileContents).join(', ')} for:
- Missing semicolons
- Incorrect indentation
- Trailing whitespace
- Unused imports
- Missing trailing commas
- Incorrect quote style

Generate the minimal diff to fix the lint issues.`,

    ci_failure: `A CI check has failed. Analyze the repository structure and fix CI configuration issues in:
${Object.keys(context.fileContents).join('\n')}

Look for:
- Incorrect action versions
- Missing or misconfigured CI steps
- Syntax errors in CI configuration files
- Wrong environment variables or secrets references

Generate the minimal diff to fix the CI configuration.`,

    trivial_bug: `Fix the following trivial bug issue. Check these files: ${Object.keys(context.fileContents).join(', ')} for:
- Null/undefined reference errors (add null check)
- Typos and misspellings
- Wrong variable names or arguments
- Missing imports
- Dead or broken links
- Incorrect conditional logic
- Deprecated API calls

Generate the minimal diff to fix the bug.`,
  };

  return `Repository: ${context.owner}/${context.repo}
Branch: ${context.defaultBranch}
Event: ${fixType}

${typeInstructions[fixType] || typeInstructions.trivial_bug}

Relevant file contents:
${Object.entries(context.fileContents).map(([path, content]) =>
  `\n--- ${path} ---\n${content.slice(0, 3000)}`
).join('\n')}`;
}
