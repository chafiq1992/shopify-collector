export function confirmationInboxUrl(order, store) {
  const state = order?.web_confirmation;
  const sid = state?.session_id;
  const session = /^[a-f0-9]{32}$/.test(sid || '') ? sid : '';
  if (state?.inbox_url) {
    try {
      const url = new URL(state.inbox_url);
      const params = new URLSearchParams(url.hash.slice(1));
      if (url.origin === 'https://wtp.chattbase.site' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(params.get('workspace') || '') && /^(web_[a-f0-9]{32}|[0-9]{8,15})$/.test(params.get('chat') || '')) {
        if (session) params.set('website_session', session);
        else params.delete('website_session');
        url.hash = params.toString();
        return url.href;
      }
    } catch {}
  }
  const workspace = ({irrakids:'irrakids',irranova:'irranovachat'})[String(store).toLowerCase()];
  return workspace && session ? 'https://wtp.chattbase.site/#' + new URLSearchParams({workspace,chat:'web_' + session,website_session:session}) : '';
}
