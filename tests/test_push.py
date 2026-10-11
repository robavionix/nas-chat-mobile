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


if __name__ == '__main__':
    unittest.main()
