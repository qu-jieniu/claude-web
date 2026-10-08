import contextlib
import io
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
Multiplexer = runpy.run_path(str(ROOT / 'omp-launcher'))['Multiplexer']


@unittest.skipUnless(shutil.which('tmux'), 'tmux required')
class RequiredServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='omp-required-tmux-')
        self.addCleanup(temporary.cleanup)
        self.socket = str(Path(temporary.name) / 'server.sock')
        self.tmux = ['tmux', '-S', self.socket]
        self.environment = {**os.environ, 'OMP_TMUX_SOCKET': self.socket,
                            'OMP_TMUX_REQUIRE_SERVER': '1', 'OMP_TMUX_SESSION': 'test'}
        self.environment.pop('TMUX', None)
        self.environment.pop('TMUX_PANE', None)
        with patch.dict(os.environ, self.environment, clear=True):
            self.mux = Multiplexer()

    def test_missing_required_server_does_not_start_fallback(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = self.mux.create('/tmp', 'must-not-start', ['/bin/sleep', '30'])
        self.assertIsNone(result)
        self.assertIn('server', output.getvalue())
        self.assertFalse(Path(self.socket).exists())

    def test_existing_server_owns_new_windows(self):
        subprocess.run(self.tmux + ['-f', '/dev/null', 'new-session', '-d', '-s', 'seed',
                                   '/bin/sleep', '30'], env=self.environment,
                       check=True, capture_output=True)
        self.addCleanup(lambda: subprocess.run(self.tmux + ['kill-server'], capture_output=True))
        before = subprocess.check_output(self.tmux + ['display-message', '-p', '#{pid}'], text=True).strip()
        window = self.mux.create('/tmp', 'attached', ['/bin/sleep', '30'])
        self.assertIsNotNone(window)
        after = subprocess.check_output(self.tmux + ['display-message', '-p', '-t', window.strip(),
                                                     '#{pid} #{pane_dead}'], text=True).strip()
        self.assertEqual(after, before + ' 0')
        sessions = subprocess.check_output(self.tmux + ['list-sessions', '-F', '#{session_name}'], text=True)
        self.assertEqual(set(sessions.splitlines()), {'seed', 'test'})

    def test_shell_exit_after_failed_command_closes_pane(self):
        subprocess.run(self.tmux + ['-f', str(ROOT / 'tmux.conf'), 'new-session', '-d',
                                   '-s', 'seed', '/bin/sleep', '30'],
                       env=self.environment, check=True, capture_output=True)
        self.addCleanup(lambda: subprocess.run(self.tmux + ['kill-server'], capture_output=True))
        window = self.mux.create('/tmp', 'shell', ['/bin/bash', '--noprofile', '--norc', '-i']).strip()
        # A bare exit inherits the failed command's status; it must still close.
        subprocess.run(self.tmux + ['send-keys', '-t', window, 'false', 'Enter', 'exit', 'Enter'],
                       check=True, capture_output=True)
        deadline = time.monotonic() + 5
        while window in {item.id for item in self.mux.windows()} and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertNotIn(window, {item.id for item in self.mux.windows()})

    def test_attach_takes_over_and_detaches_previous_client(self):
        import pty, fcntl, termios, struct
        env = dict(self.environment, TERM='xterm-256color')
        subprocess.run(self.tmux + ['-f', str(ROOT / 'tmux.conf'), 'new-session', '-d',
                                   '-s', 'test', '/bin/sleep', '30'],
                       env=env, check=True, capture_output=True)
        self.addCleanup(lambda: subprocess.run(self.tmux + ['kill-server'], capture_output=True))

        m1, s1 = pty.openpty()
        fcntl.ioctl(s1, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 80, 0, 0))
        p1 = subprocess.Popen(self.tmux + ['attach-session', '-t', 'test'],
                              stdin=s1, stdout=s1, stderr=s1, env=env)
        os.close(s1)

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            clients = subprocess.check_output(self.tmux + ['list-clients'], env=env, text=True).strip()
            if clients:
                break
            time.sleep(0.05)
        self.assertTrue(clients)

        m2, s2 = pty.openpty()
        fcntl.ioctl(s2, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
        p2 = subprocess.Popen(self.tmux + ['attach-session', '-d', '-t', 'test'],
                              stdin=s2, stdout=s2, stderr=s2, env=env)
        os.close(s2)

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and p1.poll() is None:
            time.sleep(0.05)
        self.assertEqual(p1.poll(), 0)

        p2.terminate()
        p2.wait()
        os.close(m1)
        os.close(m2)


if __name__ == '__main__':
    unittest.main()
