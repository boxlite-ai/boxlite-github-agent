// A direct request to share this channel is handled by the controller, which already holds the
// bot token. No model output can trigger it, and no Slack credential goes into a session box.
// Only the channel link is sent; neither thread contents nor access to the source are forwarded.

export async function shareChannel(slack, req, target, bot) {
  const zh = target.language === 'zh'
  const refused = (message) => ({ shared: false, message })
  if (req.isDM) return refused(zh ? '请在要分享的频道里 @我，私信没有可分享的频道。' : 'Mention me in the channel you want to share; a DM has no channel to share.')
  if (target.channel === req.channel) return refused(zh ? '目标就是当前频道，无需分享。' : 'The destination is already this channel.')

  // Match the workspace's existing policy: nothing is sent to a Slack Connect audience. This
  // lookup must succeed before posting, including when an older installation lacks read scopes.
  const { channel } = await slack.call('conversations.info', { channel: target.channel })
  if (!channel || channel.id !== target.channel || !(channel.is_channel || channel.is_group) || channel.is_im || channel.is_mpim) {
    return refused(zh ? '目标必须是 Slack 频道。' : 'The destination must be a Slack channel.')
  }
  if (channel.is_ext_shared) return refused(zh ? '无法分享到与其他组织共享的 Slack Connect 频道。' : "I can't share to a Slack Connect channel shared with another organization.")
  if (channel.is_archived) return refused(zh ? '目标频道已归档，请选择其他频道。' : 'The destination is archived; choose another channel.')
  if (!channel.is_member) return refused(invite(target))

  const url = `${bot.url.replace(/\/+$/, '')}/archives/${req.channel}`
  await slack.call('chat.postMessage', {
    channel: target.channel,
    text: zh ? `<@${req.user}> 分享了频道：<#${req.channel}>\n<${url}|打开频道>` : `<@${req.user}> shared <#${req.channel}>\n<${url}|Open channel>`,
    unfurl_links: false,
    unfurl_media: false,
  })
  return { shared: true, message: zh ? `已将 <#${req.channel}> 的链接分享到 <#${target.channel}>。` : `Shared the link to <#${req.channel}> in <#${target.channel}>.` }
}

const invite = (target) => target.language === 'zh'
  ? `请先把我邀请到 <#${target.channel}>，再重试分享。`
  : `Invite me to <#${target.channel}> first, then try sharing again.`

/** Slack failures are reported in the requesting thread, never mistaken for a successful share. */
export function shareFailure(error, target) {
  const zh = target.language === 'zh'
  switch (error.code) {
    case 'not_in_channel': return invite(target)
    case 'channel_not_found': return zh ? '找不到目标频道或我无权访问，请检查频道 ID 并把我邀请进去。' : "I can't access the destination. Check its channel ID and invite me to it."
    case 'missing_scope': return zh ? 'Slack 应用缺少权限，请管理员按 slack/manifest.json 更新并重新安装应用后重试。' : 'The Slack app is missing a scope. Ask an admin to update and reinstall it using slack/manifest.json, then retry.'
    case 'is_archived': return zh ? '目标频道已归档，请选择其他频道。' : 'The destination is archived; choose another channel.'
    case 'restricted_action':
    case 'no_permission': return zh ? 'Slack 不允许我向目标频道发送消息。' : "Slack doesn't allow me to post in the destination."
    default: return zh ? '未能确认分享成功，请检查目标频道后再重试。' : "I couldn't confirm the share. Check the destination before retrying."
  }
}
