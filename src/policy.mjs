// Your policy, in one place: who may summon the bot in Slack, and what it may do in the team's
// Linear, Notion and Google Workspace. (Who may do what on GitHub is access.mjs: anyone may ask
// there, and only admins, maintainers and people an admin added may ask for PRs.)
//
// Every Slack request costs a microVM run and a turn on the bot's ChatGPT plan, and a workspace
// holds more than one kind of person: full members, guests (multi- and single-channel), people from
// other organizations in Slack Connect channels and — on Enterprise Grid — members of sibling
// workspaces in the same org. It's decided here, by the controller, before any quota is spent or
// box started; never by Codex, which a message could talk into anything.

/**
 * May this person use the bot in Slack?
 *
 * @param {object} user  their Slack user object (users.info): `id`, `team_id` (their workspace),
 *   `deleted` (deactivated), `is_bot`, `is_restricted` (a guest), `is_ultra_restricted` (a
 *   single-channel guest), `is_stranger` (from another organization), `enterprise_user?.enterprise_id`
 *   (their Enterprise Grid org, if any)
 * @param {{ teamId: string, enterpriseId: string|null }} home  the workspace the bot is installed in
 *   (auth.test), and its Grid org if it's part of one
 * @param {{ extShared: boolean }} where  whether the message came from a channel shared with
 *   another organization (Slack Connect) — everyone there, outsiders included, sees the answer
 * @returns {{ ok: boolean, why: string }}  `why` is shown to the person when they're refused
 */
export function mayUseSlack(user, home, where) {
  // Members only: people of this workspace (or of its Enterprise Grid org) — not guests, not other
  // organizations, and not in a channel another organization shares, where they'd read the answer.
  if (user.deleted || user.is_bot) return { ok: false, why: "this account can't use me" }
  if (user.is_restricted || user.is_ultra_restricted) return { ok: false, why: "guest accounts can't use me here" }
  const member = user.team_id === home.teamId || (Boolean(home.enterpriseId) && user.enterprise_user?.enterprise_id === home.enterpriseId)
  if (!member || user.is_stranger) return { ok: false, why: "you're not a member of this workspace" }
  if (where.extShared) return { ok: false, why: 'this channel is shared with another organization; ask me in one of ours, or in a DM' }
  return { ok: true, why: "you're a member of this workspace" }
}

/**
 * Who runs the bot from Slack — `@bot /model`, `/deploy`, `/pause`, `/resume`: the workspace's
 * owners and admins, as Slack reports them. (On GitHub, it's BOT_ADMINS.)
 */
export const isSlackAdmin = (user) => Boolean(user && !user.deleted && (user.is_primary_owner || user.is_owner || user.is_admin))

/**
 * Where a Slack request may open a draft PR, from the bot's fork: `owner/name`, or `owner/*` for
 * every public repo of that owner. Anyone mayUseSlack() lets in may ask; an admin's `/pause` stops
 * it, on GitHub and in Slack alike. A PR is public, and says only that it was asked for in Slack.
 */
export const SLACK_PR_REPOS = ['boxlite-ai/*']
export function slackPrAllowed(repo, allowed = SLACK_PR_REPOS) {
  const [owner, name] = String(repo).toLowerCase().split('/')
  return allowed.some((rule) => {
    const [o, n] = rule.toLowerCase().split('/')
    return o === owner && (n === '*' || n === name)
  })
}

// What the bot may do in Linear, Notion and Google Workspace, tool by tool, as each service's MCP
// server names its tools. The controller refuses every other call (tools.mjs), however Codex asks —
// and a tool a service adds later stays off until it's listed here.
const READS = {
  linear: ['list_issues', 'get_issue', 'list_comments', 'list_projects', 'get_project', 'list_documents', 'get_document', 'list_teams', 'get_team', 'list_users', 'get_user', 'list_issue_statuses', 'list_issue_labels', 'list_cycles', 'list_milestones', 'get_milestone', 'search_documentation', 'get_attachment', 'extract_images'],
  notion: ['notion-search', 'notion-fetch', 'notion-get-comments', 'notion-get-users', 'notion-get-teams', 'notion-query-data-sources'],
  drive: ['search_files', 'read_file_content', 'download_file_content', 'get_file_metadata', 'get_file_permissions', 'list_recent_files'],
  docs: ['read_doc'],
  sheets: ['get_values', 'get_spreadsheet'],
  slides: ['read_presentation', 'read_slide_page', 'read_slide_page_thumbnail'],
  calendar: ['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'],
}

// The changes the bot may make: as its own account, seen by your whole team, for anyone
// mayUseSlack() lets in and for the bot's admins on GitHub — and triggered by what's in a thread,
// which anyone in that channel (or, on GitHub, anyone at all) can write.
const WRITES = {
  // TODO: the writes you allow, e.g. linear: ['save_comment'] — the candidates, and what each does,
  // are under "Linear, Notion and Google Workspace" in the README. Until then the tools only read.
}

for (const service of Object.keys(WRITES)) if (!READS[service]) throw new Error(`WRITES names no service "${service}" (one of: ${Object.keys(READS).join(', ')})`)
export const TOOLS = Object.fromEntries(Object.entries(READS).map(([service, read]) => [service, { read, write: WRITES[service] ?? [] }]))
