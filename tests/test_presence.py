import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mobile'))
from desktop_presence import Presence


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.now, self.calls = 0, 0
        self.presence = Presence(clock=lambda:self.now)

    def park(self):
        self.calls += 1
        return True

    def test_background_releases_only_after_last_phone(self):
        self.presence.touch('phone-a')
        self.presence.touch('phone-b')
        self.presence.leave('phone-a')
        self.now = 2
        self.assertFalse(self.presence.settle(True,self.park))
        self.presence.leave('phone-b')
        self.assertFalse(self.presence.settle(True,self.park))
        self.now = 3
        self.assertTrue(self.presence.settle(True,self.park))
        self.assertFalse(self.presence.settle(True,self.park),'manual desktop focus must not be repeatedly stolen')

    def test_frozen_browser_expires_without_a_visibility_event(self):
        self.presence.touch('phone')
        self.now = 44
        self.assertFalse(self.presence.settle(True,self.park))
        self.now = 45
        self.assertTrue(self.presence.settle(True,self.park))

    def test_stream_keeps_foreground_and_disconnect_releases_it(self):
        self.presence.touch('stream')
        self.now = 30
        self.presence.touch('stream')
        self.now = 46
        self.assertFalse(self.presence.settle(True,self.park))
        self.presence.leave('stream')
        self.now += 1
        self.assertTrue(self.presence.settle(True,self.park))

    def test_disabled_push_never_changes_focus_and_startup_recovers(self):
        self.now = 2
        self.assertFalse(self.presence.settle(False,self.park))
        self.assertTrue(self.presence.settle(True,self.park))
        self.presence.touch('reopened')
        self.presence.leave('reopened')
        self.now += 1
        self.assertTrue(self.presence.settle(True,self.park))

    def test_late_foreground_request_cannot_undo_background(self):
        self.presence.report('phone', 1, True)
        self.presence.report('phone', 3, False)
        self.presence.report('phone', 2, True)
        self.now = 2
        self.assertTrue(self.presence.settle(True,self.park))
        self.presence.report('phone', 4, True)
        self.now = 3
        self.assertFalse(self.presence.settle(True,self.park))


if __name__ == '__main__':unittest.main()
