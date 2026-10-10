import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationInboxUrl } from '../src/lib/confirmationInbox.js';
test('opens the selected WhatsApp Last inbox and never the phone WhatsApp app', () => {
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'a'.repeat(32),inbox_url:'https://wtp.chattbase.site/#workspace=conf-irrakids&chat=212612345678'}},'irrakids'),'https://wtp.chattbase.site/#workspace=conf-irrakids&chat=212612345678');
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'b'.repeat(32)}},'irranova'),'https://wtp.chattbase.site/#workspace=irranovachat&chat=web_'+'b'.repeat(32));
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'b'.repeat(32),inbox_url:'https://evil.example/#chat=212612345678'}},'irrakids'),'https://wtp.chattbase.site/#workspace=irrakids&chat=web_'+'b'.repeat(32));
  assert.equal(confirmationInboxUrl({web_confirmation:{session_id:'../x'}},'irrakids'),'');
});
