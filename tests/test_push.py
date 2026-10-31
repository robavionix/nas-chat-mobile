"""Offline push tests: no message is sent to a contact or a real push endpoint."""
import base64
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mobile'))
from push_service import PushService, public_origin, subscription_info


def subscription(endpoint='https://web.push.apple.com/test'):
    public = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    return {'endpoint': endpoint, 'keys': {'p256dh': encode(public), 'auth': encode(b'0123456789abcdef')}}


class PushTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.sent, self.now = [], 1000
        self.service = PushService(self.directory.name, origin='https://chat.example.com', sender=lambda **value: self.sent.append(value), clock=lambda: self.now)
        self.sub = subscription()
        self.identity = self.service.subscribe('session-a', 2000, self.sub)

    def test_origin_and_endpoint_boundaries(self):
        self.assertEqual(public_origin('https://Chat.Example.com:443/'), 'https://chat.example.com')
        for origin in ('http://chat.example.com', 'https://127.0.0.1', 'https://chat.local', 'https://u:p@chat.example.com', 'https://chat.example.com/path'):
            with self.assertRaises(ValueError):
                public_origin(origin)
        for endpoint in ('https://127.0.0.1/secret', 'https://web.push.apple.com.evil.test/', 'https://evil.push.apple.com:444/', 'https://user@fcm.googleapis.com/', 'http://fcm.googleapis.com/'):
            with self.assertRaises(ValueError):
                subscription_info(subscription(endpoint))
        invalid = copy.deepcopy(self.sub)
        invalid['keys']['auth'] = 'invalid'
        with self.assertRaises(ValueError):
            subscription_info(invalid)
        self.assertTrue(self.service.accepts({'Host': 'chat.example.com', 'Origin': 'https://chat.example.com'}))
        self.assertFalse(self.service.accepts({'Host': 'chat.example.com', 'Origin': 'https://other.example.com'}))

    def test_private_default_and_deduplication(self):
        self.service.notify('Private sender', 'Private message', ('sender', 1))
        self.service.notify('Private sender', 'Private message', ('sender', 1))
        self.assertEqual(self.service.queue.qsize(), 1)
        self.service.deliver(self.service.queue.get_nowait())
        payload = json.loads(self.sent[0]['data'])
        self.assertNotIn('Private', self.sent[0]['data'])
        self.assertEqual(payload['url'], '/mobile/?notifications=1')
        self.assertEqual(self.sent[0]['ttl'], 120)

    def test_preview_change_applies_to_queued_delivery(self):
        self.service.subscribe('session-a', 2000, self.sub, True)
        self.service.notify('<b>Alice</b>', 'hello &amp; goodbye', 1)
        job = self.service.queue.get_nowait()
        self.service.subscribe('session-a', 2000, self.sub, False)
        self.service.deliver(job)
        self.assertNotIn('Alice', self.sent[0]['data'])
        self.service.subscribe('session-a', 2000, self.sub, True)
        self.service.notify('<b>Alice</b>', 'hello &amp; goodbye', 2)
        self.service.deliver(self.service.queue.get_nowait())
        self.assertEqual(json.loads(self.sent[1]['data'])['body'], 'hello & goodbye')

    def test_revocation_expiry_and_owner_isolation(self):
        self.service.notify('A', 'B', 1)
        job = self.service.queue.get_nowait()
        self.service.unsubscribe('session-b', self.identity)
        self.assertEqual(len(self.service.status('session-a')['subscriptions']), 1)
        self.service.unsubscribe('session-a', self.identity)
        self.service.deliver(job)
        self.assertEqual(self.sent, [])
        self.service.subscribe('session-b', 1100, self.sub)
        self.service.deliver(job)
        self.assertEqual(self.sent, [])
        self.service.notify('A', 'B', 2)
        self.now = 1200
        self.service.deliver(self.service.queue.get_nowait())
        self.assertEqual(self.sent, [])

    def test_expired_subscription_is_removed(self):
        class Gone(Exception):
            response = type('Response', (), {'status_code': 410, '__bool__': lambda self: False})()
        def sender(**value):
            raise Gone()
        self.service.sender = sender
        self.service.notify('A', 'B', 1)
        self.service.deliver(self.service.queue.get_nowait())
        self.assertEqual(self.service.records, {})

    def test_persistence_key_and_test_rate_limit(self):
        restored = PushService(self.directory.name, origin='https://chat.example.com', sender=lambda **value: None, clock=lambda: self.now)
        self.assertEqual(restored.public_key, self.service.public_key)
        self.assertEqual(len(restored.status('session-a')['subscriptions']), 1)
        with self.assertRaises(ValueError):
            self.service.test('session-b', self.identity)
        self.service.test('session-a', self.identity)
        with self.assertRaises(ValueError):
            self.service.test('session-a', self.identity)
        self.service.revoke_all()
        self.service.deliver(self.service.queue.get_nowait())
        self.assertEqual(self.sent, [])

    def test_test_delivery_acknowledgement(self):
        ticket = self.service.test('session-a', self.identity)
        self.assertEqual(self.service.status('session-a')['subscriptions'][0]['test']['state'], 'queued')
        self.service.deliver(self.service.queue.get_nowait())
        report = self.service.status('session-a')['subscriptions'][0]['test']
        self.assertEqual(report['id'], ticket)
        self.assertEqual(report['state'], 'accepted')

    def test_missing_configuration_keeps_server_usable(self):
        with tempfile.TemporaryDirectory() as directory:
            service = PushService(directory)
            self.assertFalse(service.enabled)
            self.assertFalse(service.status('session-a')['available'])

    def test_audio_fallback_and_desktop_are_coalesced_without_coalescing_distinct_desktop_events(self):
        self.service.notify('聊天 · 新消息', '你有新的聊天消息，点击查看。', 'audio-1', source='audio')
        self.now += .2
        self.service.notify('Sender', 'Message', 'desktop-1')
        self.assertEqual(self.service.queue.qsize(), 1)
        self.now += 2
        self.service.notify('Sender', 'Message', 'desktop-2')
        self.service.notify('Sender', 'Another message', 'desktop-3')
        self.assertEqual(self.service.queue.qsize(), 3)
        self.service.audio = type('Audio', (), {'state': 'connected'})()
        self.service.source = 'unavailable'
        self.assertEqual(self.service.status('session-a')['source'], 'connected')
        self.assertEqual(self.service.status('session-a')['sources']['audio'], 'connected')

    def test_malformed_optional_data_never_breaks_chat_startup(self):
        folder = Path(self.directory.name) / 'push'
        (folder / 'settings.json').write_text('[]')
        self.assertFalse(PushService(self.directory.name).enabled)
        (folder / 'settings.json').write_text('{"origin": 123}')
        self.assertFalse(PushService(self.directory.name).enabled)
        (folder / 'subscriptions.json').write_text('[]')
        restored = PushService(self.directory.name, origin='https://chat.example.com', sender=lambda **value: None)
        self.assertTrue(restored.enabled)
        self.assertEqual(restored.records, {})

    def test_desktop_content_wins_even_when_audio_arrives_first(self):
        self.service.subscribe('session-a', 2000, self.sub, True)
        self.service.notify('New message', 'New message', 'tone', source='audio')
        self.now += .2
        self.service.notify('Alice', 'hello', 'desktop')
        self.assertEqual(self.service.queue.qsize(), 1)
        self.service.deliver(self.service.queue.get_nowait())
        payload = json.loads(self.sent[-1]['data'])
        self.assertEqual((payload['title'], payload['body']), ('Alice','hello'))
        self.assertNotIn('_event', payload)

    def test_ocr_enrichment_revocation_and_errors_preserve_existing_push(self):
        self.service.subscribe('session-a', 2000, self.sub, True)
        self.service.preview_wait = 0
        self.service.preview_reader = type('Reader', (), {'resolve':lambda _,stamp:('Alice','你好')})()
        self.service.notify('New message', 'New message', 'tone-1', source='audio')
        self.service.deliver(self.service.queue.get_nowait())
        self.assertEqual(json.loads(self.sent[-1]['data'])['body'], '你好')
        def disable(stamp):
            self.service.subscribe('session-a',2000,self.sub,False)
            return 'Alice','Private text'
        self.service.preview_reader.resolve = disable
        self.service.notify('New message', 'New message', 'tone-2', source='audio')
        self.service.deliver(self.service.queue.get_nowait())
        self.assertNotIn('Private text', self.sent[-1]['data'])
        self.assertNotIn('Alice', self.sent[-1]['data'])
        self.service.subscribe('session-a',2000,self.sub,True)
        self.service.preview_reader.resolve = lambda stamp: (_ for _ in ()).throw(RuntimeError())
        self.service.notify('聊天 · 新消息','你有新的聊天消息，点击查看。','tone-3',source='audio')
        self.service.deliver(self.service.queue.get_nowait())
        self.assertEqual(json.loads(self.sent[-1]['data'])['title'],'聊天 · 新消息')

    def test_cross_source_dedup_pairs_once_without_suppressing_a_stream(self):
        self.service.notify('A','one','desktop-1')
        self.now += .1
        self.service.notify('A','one','audio-1',source='audio')
        self.now += .1
        self.service.notify('B','two','desktop-2')
        self.now += .1
        self.service.notify('B','two','audio-2',source='audio')
        self.assertEqual(self.service.queue.qsize(), 2)


    def test_native_preview_keeps_text_and_internal_metadata_stays_local(self):
        self.service.subscribe('session-a',2000,self.sub,True)
        self.service.notify('朋友甲','明天8点见。','native')
        self.service.deliver(self.service.queue.get_nowait())
        payload=json.loads(self.sent[-1]['data'])
        self.assertEqual((payload['title'],payload['body']),('朋友甲','明天8点见。'))
        self.assertFalse(any(key.startswith('_') for key in payload))
        self.assertEqual(self.service.last_content_source,'desktop')

    def test_rejected_screen_preview_becomes_plain_notification(self):
        self.service.subscribe('session-a',2000,self.sub,True)
        self.service.preview_wait=0
        self.service.preview_reader=type('Reader',(),{'resolve':lambda _,stamp:None})()
        self.service.notify('聊天 · 新消息','你有新的聊天消息，点击查看。','audio',source='audio')
        self.service.deliver(self.service.queue.get_nowait())
        payload=json.loads(self.sent[-1]['data'])
        self.assertEqual((payload['title'],payload['body']),('聊天 · 新消息','你有新的聊天消息，点击查看。'))
        self.assertNotIn('摘要未能识别',self.sent[-1]['data'])
        self.assertFalse(any(key.startswith('_') for key in payload))
        self.assertEqual(self.service.last_content_source,'generic')

    def test_agreed_screen_preview_keeps_both_fields_together(self):
        self.service.subscribe('session-a',2000,self.sub,True)
        self.service.preview_wait=0
        self.service.preview_reader=type('Reader',(),{'resolve':lambda _,stamp:('朋友甲','你好。')})()
        self.service.notify('聊天 · 新消息','你有新的聊天消息，点击查看。','audio',source='audio')
        self.service.deliver(self.service.queue.get_nowait())
        payload=json.loads(self.sent[-1]['data'])
        self.assertEqual((payload['title'],payload['body']),('朋友甲','你好。'))
        self.assertEqual(self.service.last_content_source,'screen-preview')



if __name__ == '__main__':
    unittest.main()
