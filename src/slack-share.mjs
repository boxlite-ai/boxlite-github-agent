// The agent invokes sharing through a job-scoped MCP tool. The controller holds the bot token
// and binds the source to the request; no Slack credential goes into a session box.
// Only the channel link is sent; neither thread contents nor access to the source are forwarded.

export async function shareChannel(slack, req, target, bot) {
  const refused = (message) => ({ shared: false, message })
  if (req.isDM) return refused('Mention me in the channel you want to share; a DM has no channel to share.')
  if (target.channel === req.channel) return refused('The destination is already this channel.')

  // Match the workspace's existing policy: nothing is sent to a Slack Connect audience. This
  // lookup must succeed before posting, including when an older installation lacks read scopes.
  const { channel } = await slack.call('conversations.info', { channel: target.channel })
  if (!channel || channel.id !== target.channel || !(channel.is_channel || channel.is_group) || channel.is_im || channel.is_mpim) {
    return refused('The destination must be a Slack channel.')
  }
  if (channel.is_ext_shared) return refused("I can't share to a Slack Connect channel shared with another organization.")
  if (channel.is_archived) return refused('The destination is archived; choose another channel.')
  if (!channel.is_member) return refused(invite(target))

  const url = `${bot.url.replace(/\/+$/, '')}/archives/${req.channel}`
  await slack.call('chat.postMessage', {
    channel: target.channel,
    text: `<@${req.user}> shared <#${req.channel}>\n<${url}|Open channel>`,
    unfurl_links: false,
    unfurl_media: false,
  })
  return { shared: true, message: `Shared the link to <#${req.channel}> in <#${target.channel}>.` }
}

const invite = (target) => `Invite me to <#${target.channel}> first, then try sharing again.`

/** Slack failures are reported in the requesting thread, never mistaken for a successful share. */
export function shareFailure(error, target) {
  switch (error.code) {
    case 'not_in_channel': return invite(target)
    case 'channel_not_found': return "I can't access the destination. Check its channel ID and invite me to it."
    case 'missing_scope': return 'The Slack app is missing a scope. Ask an admin to update and reinstall it using slack/manifest.json, then retry.'
    case 'is_archived': return 'The destination is archived; choose another channel.'
    case 'restricted_action':
    case 'no_permission': return "Slack doesn't allow me to post in the destination."
    default: return "I couldn't confirm the share. Check the destination before retrying."
  }
}
