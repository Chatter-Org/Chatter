// CHANGELOG.md is the one place release notes are written. This turns it into
// data for the app's Settings → What's new (src/changelog.generated.ts), and
// hands the release workflow one version's notes.
//
//   npm run changelog                        write src/changelog.generated.ts
//   npm run changelog -- --check             fail if that file is out of date (CI)
//   node scripts/changelog.mjs --notes 0.2.0 print 0.2.0's section as Markdown
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../CHANGELOG.md");
const target = path.resolve(here, "../src/changelog.generated.ts");

const markdown = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");

/** Each "## " section: its heading and the lines under it. */
function sections() {
  const out = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) out.push({ heading: line.slice(3).trim(), lines: [] });
    else if (out.length > 0) out[out.length - 1].lines.push(line);
  }
  return out;
}

/** What a phone shows: no Markdown marks. */
const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").trim();

function parse() {
  return sections().map(({ heading, lines }) => {
    const [version, date] = heading.split(/\s+[—–-]\s+/, 2);
    const release = { version: version.trim(), date: date?.trim() ?? null, intro: [], groups: [] };
    for (const line of lines) {
      if (line.startsWith("### ")) release.groups.push({ title: plain(line.slice(4)), items: [] });
      else if (/^[-*] /.test(line)) {
        if (release.groups.length === 0) release.groups.push({ title: "", items: [] });
        release.groups[release.groups.length - 1].items.push(plain(line.slice(2)));
      } else if (/^\s+\S/.test(line) && release.groups.at(-1)?.items.length) {
        // A bullet carried on to the next line.
        const items = release.groups.at(-1).items;
        items[items.length - 1] += ` ${plain(line)}`;
      } else if (line.trim() && release.groups.length === 0) release.intro.push(plain(line));
    }
    return { ...release, intro: release.intro.join(" ") || null };
  });
}

const args = process.argv.slice(2);

if (args[0] === "--notes") {
  const wanted = args[1];
  const found = sections().find((s) => s.heading.split(/\s+[—–-]\s+/)[0].trim() === wanted);
  if (!found) {
    console.error(`CHANGELOG.md has no "## ${wanted}" section`);
    process.exit(1);
  }
  process.stdout.write(`${found.lines.join("\n").trim()}\n`);
  process.exit(0);
}

const generated = `// Generated from CHANGELOG.md by scripts/changelog.mjs (npm run changelog).
// Don't edit by hand.

export interface ChangelogRelease {
  /** "0.2.0", or "Unreleased" for what is in development. */
  version: string;
  date: string | null;
  intro: string | null;
  groups: { title: string; items: string[] }[];
}

export const CHANGELOG: ChangelogRelease[] = ${JSON.stringify(parse(), null, 2)};
`;

if (args[0] === "--check") {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== generated) {
    console.error("src/changelog.generated.ts is out of date with CHANGELOG.md: run `npm run changelog`.");
    process.exit(1);
  }
} else {
  fs.writeFileSync(target, generated);
  console.log(`Wrote ${path.relative(process.cwd(), target)}`);
}
