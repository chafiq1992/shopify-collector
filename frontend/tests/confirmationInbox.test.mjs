import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationInboxUrl } from '../src/lib/confirmationInbox.js';
test('opens the selected WhatsApp Last inbox and never the phone WhatsApp app', () => {
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'a'.repeat(32),inbox_url:'https://wtp.chattbase.site/#workspace=conf-irrakids&chat=212612345678'}},'irrakids'),'https://wtp.chattbase.site/#workspace=conf-irrakids&chat=212612345678&website_session='+'a'.repeat(32));
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'b'.repeat(32)}},'irranova'),'https://wtp.chattbase.site/#workspace=irranovachat&chat=web_'+'b'.repeat(32)+'&website_session='+'b'.repeat(32));
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'b'.repeat(32),inbox_url:'https://evil.example/#chat=212612345678'}},'irrakids'),'https://wtp.chattbase.site/#workspace=irrakids&chat=web_'+'b'.repeat(32)+'&website_session='+'b'.repeat(32));
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'../x'}},'irrakids'),'');
});
test('keeps the WhatsApp reply destination while binding the originating website conversation', () => {
  const url=new URL(confirmationInboxUrl({web_confirmation:{session_id:'c'.repeat(32),inbox_url:'https://wtp.chattbase.site/#workspace=conf-irrakids&chat=212612345678&website_session='+'d'.repeat(32)}},'irrakids'));
  const params=new URLSearchParams(url.hash.slice(1));
  assert.equal(params.get('chat'),'212612345678');
  assert.equal(params.get('workspace'),'conf-irrakids');
  assert.equal(params.get('website_session'),'c'.repeat(32));
  const invalid=confirmationInboxUrl({web_confirmation:{session_id:'../bad',inbox_url:'https://wtp.chattbase.site/#workspace=conf-irrakids&chat=212612345678&website_session=bad'}},'irrakids');
  assert.equal(new URLSearchParams(new URL(invalid).hash.slice(1)).has('website_session'),false);
});
