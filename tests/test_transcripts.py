import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def session(self, name, cwd, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        records = [
            {'type': 'title', 'title': 'A saved session'},
            {'type': 'session', 'cwd': str(cwd), 'id': name},
            {'type': 'message', 'message': {'role': 'assistant', 'content': text}},
        ]
        path.write_text(''.join(json.dumps(row) + '\n' for row in records))
        return path

    def pretty(self, path, width=80):
        return subprocess.run(
            [sys.executable, str(ROOT / 'omp-jsonl-pretty'), '--width', str(width), str(path)],
            text=True, capture_output=True, check=True,
        ).stdout

    def test_untrusted_text_cannot_inject_terminal_controls(self):
        dangerous = 'before\x1b]52;c;YXR0YWNr\x07after\x9b31mred\x9b0m\u202esafe'
        path = self.session('controls.jsonl', self.root, dangerous)
        output = self.pretty(path)
        self.assertIn('beforeafterredsafe', output)
        for forbidden in ('\x1b', '\x07', '\x9b', '\u202e', 'YXR0YWNr'):
            self.assertNotIn(forbidden, output)

    def test_malformed_events_do_not_discard_later_conversation(self):
        path = self.session('malformed.jsonl', self.root, 'First answer')
        with path.open('a') as stream:
            stream.write('{broken\nnull\n[]\n')
            stream.write(json.dumps({'type': 'message', 'message': {
                'role': 'user', 'content': [{'type': 'text', 'text': 'Later question'}],
            }}) + '\n')
        output = self.pretty(path, 1)
        self.assertIn('First answer', output)
        self.assertIn('Later question', output)

    @unittest.skipUnless(shutil.which('less'), 'less is required by the transcript viewer')
    def test_viewer_selects_header_cwd_not_lossy_folder_name(self):
        project = self.root / "project ' with spaces"
        project.mkdir()
        matching = self.session('misleading-directory/older.jsonl', project, 'MATCHED conversation')
        wrong = self.session('newest.jsonl', self.root, 'WRONG conversation')
        os.utime(matching, ns=(1_000_000_000, 1_000_000_000))
        os.utime(wrong, ns=(2_000_000_000, 2_000_000_000))
        result = subprocess.run(
            [sys.executable, str(ROOT / 'omp-jsonl-view'), '--cwd', str(project)],
            env={**os.environ, 'OMP_SESSION_DIR': str(self.root), 'LESS': ''},
            text=True, capture_output=True, check=True,
        )
        self.assertIn('MATCHED conversation', result.stdout)
        self.assertNotIn('WRONG conversation', result.stdout)

    def test_missing_project_never_displays_an_unrelated_session(self):
        self.session('other.jsonl', self.root, 'PRIVATE unrelated session')
        result = subprocess.run(
            [sys.executable, str(ROOT / 'omp-jsonl-view'), '--cwd', str(self.root / 'absent')],
            env={**os.environ, 'OMP_SESSION_DIR': str(self.root)},
            text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('PRIVATE unrelated session', result.stdout)


if __name__ == '__main__':
    unittest.main()
