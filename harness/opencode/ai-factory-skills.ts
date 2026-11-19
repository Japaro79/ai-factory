// ai-factory:managed skill-index/v1 - refreshes .factory/skills.md when OpenCode opens a project.
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { join, parse } from "node:path"

const FACTORY = "__FACTORY_COMMAND__" as unknown as string[]
const PROJECT_MARKERS = [".git", ".factory", "skills", ".opencode/skills", ".claude/skills", ".codex/skills", ".gemini/skills", ".agents/skills"]

export default Plugin.define({
  id: "ai-factory.skill-index",
  async setup(ctx) {
    // The folder OpenCode opened, never process.cwd or an enclosing project.
    const cwd = ctx.location.directory
    if (!cwd || cwd === parse(cwd).root || cwd === homedir()) return
    let project = false
    for (const marker of PROJECT_MARKERS) {
      if (await access(join(cwd, marker)).then(() => true, () => false)) { project = true; break }
    }
    if (!project) return
    try {
      let child: ReturnType<typeof execFile> | undefined
      child = execFile(FACTORY[0]!, [...FACTORY.slice(1), "skills", "index", "--quiet", "--no-gitignore", "--cwd", cwd],
        { cwd, timeout: 30_000, maxBuffer: 1024, windowsHide: true }, () => { child = undefined })
      return () => { child?.kill("SIGKILL"); child = undefined }
    } catch { /* A missing factory is never a startup failure. */ }
  },
})
