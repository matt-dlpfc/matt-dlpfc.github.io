// Copies the vault's Public/ folder into content/, with privacy checks.
//
//   node scripts/publish.mjs           copy + check (then preview with: npx quartz build --serve)
//   node scripts/publish.mjs --check   check only, copy nothing
//   node scripts/publish.mjs --push    copy + check, then commit and push (the site goes live)
//
// Rules:
// - Notes with `draft: true` in their frontmatter are NOT copied (the repo source stays clean).
// - Links to notes outside Public/ (or to drafts) stop the publish: the link text would reveal
//   a private note's name. Fix the link, or write it as plain text.
// - Headings ending in "(auto)" (the vault's LLM-maintained sections, which quote daily notes)
//   stop the publish too.
// - Public/Home.md becomes the homepage (content/index.md). "index" is taken in the vault
//   by _System/index.md, and basenames must stay unique there.
// - Images and other attachments a public note uses are copied from anywhere in the vault
//   into content/attachments/.

import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"

const VAULT = process.env.VAULT || "C:/Users/Matteo/Documents/Matteo Simple Brain"
const PUBLIC = path.join(VAULT, "Public")
const SITE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..")
const CONTENT = path.join(SITE, "content")
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"])

const args = new Set(process.argv.slice(2))
const checkOnly = args.has("--check")
const push = args.has("--push")

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const isDraft = (text) => {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return !!fm && /^draft:\s*(true|yes)\s*$/im.test(fm[1])
}
const noteName = (p) => path.basename(p).replace(/\.md$/i, "").toLowerCase()

if (!fs.existsSync(PUBLIC)) {
  console.error(`No Public/ folder in the vault (${PUBLIC}).`)
  process.exit(1)
}

// Index the vault: every file by basename, for attachments.
const vaultFiles = new Map()
for (const f of walk(VAULT)) {
  const k = path.basename(f).toLowerCase()
  if (!vaultFiles.has(k)) vaultFiles.set(k, f)
}

const all = walk(PUBLIC)
const notes = all.filter((f) => f.endsWith(".md"))
const published = []
const drafts = []
for (const f of notes) (isDraft(fs.readFileSync(f, "utf8")) ? drafts : published).push(f)
const publishedNames = new Set(published.map(noteName))

const problems = []
const attachments = new Map() // basename -> source path
for (const f of all.filter((f) => !f.endsWith(".md"))) attachments.set(path.basename(f), f)

for (const f of published) {
  const rel = path.relative(PUBLIC, f)
  const text = fs.readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  for (const m of text.matchAll(/^#{1,6} .*\(auto\)\s*$/gm))
    problems.push(`${rel}: has an auto section ("${m[0].trim()}"), which quotes private notes`)

  const targets = []
  for (const m of text.matchAll(/(!?)\[\[([^\]|#^]*)[^\]]*\]\]/g)) targets.push(m[2].trim())
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const t = decodeURIComponent(m[1])
    if (!/^[a-z]+:|^#|^\//i.test(t)) targets.push(t)
  }
  for (const t of targets) {
    if (!t) continue // [[#heading]] on the same page
    const base = path.basename(t)
    const ext = path.extname(base).toLowerCase()
    if (!ext || ext === ".md") {
      if (!publishedNames.has(base.replace(/\.md$/i, "").toLowerCase()))
        problems.push(`${rel}: links to [[${t}]], which is not a published note in Public/`)
    } else if (!attachments.has(base)) {
      const src = vaultFiles.get(base.toLowerCase())
      if (src) attachments.set(base, src)
      else problems.push(`${rel}: uses attachment "${t}", not found in the vault`)
    }
  }
}

console.log(`Public/: ${published.length} note(s) to publish, ${drafts.length} draft(s) left out.`)
for (const d of drafts) console.log(`  draft: ${path.relative(PUBLIC, d)}`)
if (!fs.existsSync(path.join(PUBLIC, "Home.md")) || !publishedNames.has("home"))
  console.log("Note: no published Public/Home.md, so the site has no homepage.")

if (problems.length) {
  console.error(`\nNot published. Fix these first:`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
if (checkOnly) {
  console.log("Check passed.")
  process.exit(0)
}

// Replace content/ with exactly what is public.
fs.rmSync(CONTENT, { recursive: true, force: true })
fs.mkdirSync(CONTENT, { recursive: true })
for (const f of published) {
  const r = path.relative(PUBLIC, f)
  const dest = path.join(CONTENT, r === "Home.md" ? "index.md" : r)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(f, dest)
}
for (const [base, src] of attachments) {
  const dest = src.startsWith(PUBLIC)
    ? path.join(CONTENT, path.relative(PUBLIC, src))
    : path.join(CONTENT, "attachments", base)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}
console.log(`Copied ${published.length} note(s) and ${attachments.size} attachment(s) into content/.`)

if (push) {
  const run = (c) => execSync(c, { cwd: SITE, stdio: "inherit" })
  run("git add -A")
  try {
    run(`git commit -q -m "publish: ${new Date().toISOString().slice(0, 10)}"`)
  } catch {
    console.log("Nothing new to commit.")
  }
  run("git push -q origin main")
  console.log("Pushed. The site updates in about a minute: https://matt-dlpfc.github.io")
}
