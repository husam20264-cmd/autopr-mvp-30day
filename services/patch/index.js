export function parseUnifiedDiff(diffText) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('--- a/')) {
      if (currentFile && currentFile.hunks.length > 0) files.push(currentFile);
      currentFile = { oldPath: line.slice(6), newPath: '', hunks: [] };
    } else if (line.startsWith('+++ b/')) {
      if (currentFile) currentFile.newPath = line.slice(6);
    } else if (line.startsWith('@@')) {
      if (currentFile) {
        currentHunk = { header: line, lines: [] };
        currentFile.hunks.push(currentHunk);
      }
    } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      currentHunk.lines.push(line);
    }
  }

  if (currentFile && currentFile.hunks.length > 0) files.push(currentFile);
  return files;
}

export function applyDiffToContent(originalContent, diffFile) {
  const lines = originalContent.split('\n');
  const result = [];
  let lineIndex = 0;

  for (const hunk of diffFile.hunks) {
    const match = hunk.header.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (!match) continue;

    const startLine = parseInt(match[1]);
    const contextBefore = lines.slice(lineIndex, startLine - 1);
    result.push(...contextBefore);

    const hunkLines = hunk.lines;
    let hunkIdx = 0;
    let srcIdx = startLine - 1;

    while (hunkIdx < hunkLines.length) {
      const hl = hunkLines[hunkIdx];
      if (hl.startsWith(' ')) {
        result.push(lines[srcIdx]);
        srcIdx++;
        hunkIdx++;
      } else if (hl.startsWith('-')) {
        srcIdx++;
        hunkIdx++;
      } else if (hl.startsWith('+')) {
        result.push(hl.slice(1));
        hunkIdx++;
      }
    }

    lineIndex = srcIdx;
  }

  result.push(...lines.slice(lineIndex));
  return result.join('\n');
}
