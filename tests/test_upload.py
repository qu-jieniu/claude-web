import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
import urllib.request
import urllib.error

import runpy
ROOT = Path(__file__).resolve().parents[1]

upload_globals = runpy.run_path(str(ROOT / 'omp-web-upload'))
sanitize_filename = upload_globals['sanitize_filename']
join_wrapped_lines = upload_globals['join_wrapped_lines']
strip_history_escapes = upload_globals['strip_history_escapes']
extract_urls = upload_globals['extract_urls']


class FilenameSanitizationTests(unittest.TestCase):
    def test_path_traversal_stripped(self):
        self.assertEqual(sanitize_filename('../../etc/passwd'), 'passwd')
        self.assertEqual(sanitize_filename('/root/secret.png'), 'secret.png')
        self.assertEqual(sanitize_filename(r'C:\Users\test\image.jpg'), 'image.jpg')

    def test_special_characters_replaced(self):
        self.assertEqual(sanitize_filename('photo (1) [final]!.png'), 'photo__1___final__.png')
        self.assertEqual(sanitize_filename('test file with spaces.pdf'), 'test_file_with_spaces.pdf')

    def test_empty_or_dots(self):
        self.assertEqual(sanitize_filename('.'), 'upload.bin')
        self.assertEqual(sanitize_filename('...'), 'upload.bin')
        self.assertEqual(sanitize_filename('.bashrc'), 'bashrc')


class StripHistoryEscapesTests(unittest.TestCase):
    """Escape handling is a pure function, so test it directly: the tmux path
    cannot reproduce what a redrawing TUI leaves behind, because the shell echoes
    the payload alongside the output."""

    def test_osc8_text_form_keeps_one_url(self):
        url = 'https://example.test/oauth?code=1'
        self.assertEqual(strip_history_escapes(f']8;id=abc;{url}{url}]8;;'), url)
        self.assertEqual(strip_history_escapes(f']8;id=abc;{url}]8;;'), url)

    def test_osc8_escape_form_keeps_the_visible_text(self):
        url = 'https://example.test/oauth?code=1'
        self.assertEqual(strip_history_escapes(f'\x1b]8;id=abc;{url}\x1b\\{url}\x1b]8;;\x1b\\'), url)

    def test_sgr_colour_survives(self):
        self.assertEqual(strip_history_escapes('\x1b[1;32mgreen\x1b[0m'), '\x1b[1;32mgreen\x1b[0m')

    def test_other_osc_and_csi_are_dropped(self):
        self.assertEqual(strip_history_escapes('\x1b]0;title\x07after'), 'after')
        self.assertEqual(strip_history_escapes('\x1b[2Jcleared'), 'cleared')

    def test_lines_are_never_merged(self):
        self.assertEqual(strip_history_escapes('one\ntwo'), 'one\ntwo')

    def test_unrelated_text_is_untouched(self):
        self.assertEqual(strip_history_escapes('seq 1 200'), 'seq 1 200')


class UrlExtractionTests(unittest.TestCase):
    """A URL inside a full-screen UI is broken by the frame's border characters,
    which row stitching cannot undo; it is extracted instead."""

    WIDTH = 81

    def frame(self, text):
        inner = text + ' ' * (self.WIDTH - 4 - len(text))
        return '│ ' + inner + ' │'

    def test_url_split_across_frame_rows_is_reassembled(self):
        url = 'https://claude.ai/oauth/authorize?client_id=abc&code=true'
        rows = [self.frame(url[:60]), self.frame(url[60:]), self.frame('unrelated')]
        self.assertEqual(extract_urls(rows, self.WIDTH), [url])

    def test_url_in_plain_output(self):
        url = 'https://example.test/login?token=abc'
        self.assertEqual(extract_urls([f'Open this URL: {url}'], self.WIDTH), [url])

    def test_no_urls_means_no_links(self):
        self.assertEqual(extract_urls(['plain text', 'more text'], self.WIDTH), [])

    def test_duplicates_collapse(self):
        url = 'https://example.test/x'
        self.assertEqual(extract_urls([url, url], self.WIDTH), [url])

    def test_split_url_does_not_swallow_the_next_rows_text(self):
        """A real login prints the URL on a full row and the phrase 'Local
        shortcut' begins the next row; the extractor must not glue them."""
        width = 81
        url = 'https://claude.ai/oauth/authorize?client_id=abc&code=true'
        rows = [url, 'Local shortcut (this machine only): http://localhost:54545/launch']
        self.assertEqual(extract_urls(rows, width), [url])

    def test_loopback_shortcuts_are_not_reported_as_links(self):
        """omp's local launch URL only resolves on the host running omp; offering
        it as a copyable link from a phone is a trap."""
        self.assertEqual(extract_urls(['http://localhost:54545/launch'], 81), [])
        self.assertEqual(extract_urls(['http://127.0.0.1:4000/x'], 81), [])

    def test_frame_rows_are_never_stitched(self):
        rows = [self.frame('x' * 40), self.frame('y' * 40)]
        self.assertEqual(join_wrapped_lines(rows, self.WIDTH), rows)


class JoinWrappedLinesTests(unittest.TestCase):
    """Rows an application drew itself (a long URL in a transcript) are exactly the
    pane width wide with the text continuing below; joining them is what makes the
    line copyable as one string."""

    def test_stitches_rows_that_fill_the_width(self):
        width = 20
        full = 'x' * width
        lines = [full, 'continuation', 'short', 'y' * width, 'tail']
        self.assertEqual(join_wrapped_lines(lines, width),
                         [full + 'continuation', 'short', 'y' * width + 'tail'])

    def test_stitches_a_chain_of_rows(self):
        width = 8
        self.assertEqual(join_wrapped_lines(['a' * width, 'b' * width, 'c'], width),
                         ['a' * width + 'b' * width + 'c'])

    def test_drops_a_shell_continuation_prompt(self):
        width = 10
        self.assertEqual(join_wrapped_lines(['z' * width, '> rest'], width), ['z' * width + 'rest'])

    def test_leaves_indented_rows_alone(self):
        width = 10
        self.assertEqual(join_wrapped_lines(['q' * width, '  indented'], width),
                         ['q' * width, '  indented'])

    def test_width_ignores_colour_escapes(self):
        width = 10
        coloured = '\x1b[31m' + 'r' * width + '\x1b[0m'
        self.assertEqual(join_wrapped_lines([coloured, 'tail'], width), [coloured + 'tail'])

    def test_no_width_means_no_joining(self):
        self.assertEqual(join_wrapped_lines(['a', 'b'], 0), ['a', 'b'])


class UploadServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix='omp-upload-test-')
        self.uploads_dir = Path(self.temp_dir.name) / 'uploads'
        self.presence_path = Path(self.temp_dir.name) / 'web-visible'
        self.tmux_socket = Path(self.temp_dir.name) / 'tmux-socket'

        # Find free port
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]

        self.proc = subprocess.Popen([
            sys.executable, str(ROOT / 'omp-web-upload'),
            '--port', str(self.port),
            '--bind', '127.0.0.1',
            '--dir', str(self.uploads_dir),
            '--presence-file', str(self.presence_path),
            '--tmux-socket', str(self.tmux_socket),
        ], stderr=subprocess.PIPE)

        # Wait for server to be ready
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(('127.0.0.1', self.port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)

    def tearDown(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        if self.proc.stderr:
            self.proc.stderr.close()
        self.temp_dir.cleanup()

    def test_multipart_upload_success(self):
        boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
        body = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="file"; filename="screenshot.png"\r\n'
            f'Content-Type: image/png\r\n\r\n'
            f'FAKE_PNG_BINARY_DATA_12345\r\n'
            f'--{boundary}--\r\n'
        ).encode('utf-8')

        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/upload',
            data=body,
            headers={
                'Content-Type': f'multipart/form-data; boundary={boundary}',
                'Content-Length': str(len(body))
            },
            method='POST'
        )

        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data['ok'])
            self.assertIn('screenshot.png', data['filename'])
            self.assertTrue(Path(data['path']).is_file())
            self.assertEqual(Path(data['path']).read_bytes(), b'FAKE_PNG_BINARY_DATA_12345')

    def test_multipart_preserves_a_trailing_newline(self):
        """The framing CRLF must be removed, not every trailing CR/LF byte."""
        boundary = '----boundary7MA4YWxkTrZu0gW'
        payload = b'line one\nline two\n'          # a file that ends in a newline
        body = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="file"; filename="notes.txt"\r\n'
            f'Content-Type: text/plain\r\n\r\n'
        ).encode() + payload + f'\r\n--{boundary}--\r\n'.encode()
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/upload',
            data=body,
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
            method='POST',
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            saved = json.loads(resp.read().decode('utf-8'))
        self.assertEqual(Path(saved['path']).read_bytes(), payload,
                         'trailing newline must survive the upload')
        self.assertEqual(saved['size'], len(payload))

    def test_raw_upload_success(self):
        body = b'RAW_DOCUMENT_CONTENT_54321'
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/upload',
            data=body,
            headers={
                'Content-Type': 'application/octet-stream',
                'X-Filename': 'data.bin',
                'Content-Length': str(len(body))
            },
            method='POST'
        )

        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data['ok'])
            self.assertIn('data.bin', data['filename'])
            self.assertTrue(Path(data['path']).is_file())
            self.assertEqual(Path(data['path']).read_bytes(), body)

    def test_not_found_on_other_path(self):
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/other',
            data=b'test',
            headers={'Content-Length': '4'},
            method='POST'
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 404)

    def test_presence_heartbeat_touches_file(self):
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/presence',
            data=b'',
            headers={'Content-Length': '0'},
            method='POST',
        )
        self.assertFalse(self.presence_path.exists())
        before = time.time()
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertTrue(data['ok'])
        self.assertTrue(self.presence_path.exists())
        payload = json.loads(self.presence_path.read_text())
        # No ?window= was sent: recorded as unattributed, not a specific window.
        self.assertIsNone(payload['window'])
        self.assertGreaterEqual(payload['ts'], before - 1)
        first_ts = payload['ts']
        time.sleep(1.1)
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
        # A second heartbeat advances ts rather than being a no-op touch.
        self.assertGreater(json.loads(self.presence_path.read_text())['ts'], first_ts)

    def test_presence_heartbeat_records_window(self):
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/presence?window=tmux-2',
            data=b'',
            headers={'Content-Length': '0'},
            method='POST',
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
        payload = json.loads(self.presence_path.read_text())
        self.assertEqual(payload['window'], 'tmux-2')




class HistoryEndpointTests(unittest.TestCase):
    """The /history endpoint pages tmux scrollback (it cannot come from the
    browser: under tmux the client's xterm buffer never exceeds one screen)."""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory(prefix='omp-history-test-')
        cls.socket = str(Path(cls.temp_dir.name) / 'tmux')
        cls.tmux = ['tmux', '-S', cls.socket]
        subprocess.run(cls.tmux + ['new-session', '-d', '-s', 'hist', '-x', '80', '-y', '24',
                                   'bash --norc -i'], capture_output=True)
        time.sleep(0.4)
        subprocess.run(cls.tmux + ['send-keys', '-t', 'hist', 'seq 1 200', 'Enter'], capture_output=True)
        time.sleep(0.4)
        # a mixed-case marker so the search tests do not depend on the shell's
        # prompt text (which varies by bash version)
        subprocess.run(cls.tmux + ['send-keys', '-t', 'hist', "printf 'MaRkEr-CaSe\n'", 'Enter'],
                       capture_output=True)
        time.sleep(0.4)

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            cls.port = s.getsockname()[1]
        cls.proc = subprocess.Popen([
            sys.executable, str(ROOT / 'omp-web-upload'),
            '--port', str(cls.port), '--bind', '127.0.0.1',
            '--dir', str(Path(cls.temp_dir.name) / 'uploads'),
            '--presence-file', str(Path(cls.temp_dir.name) / 'presence'),
            '--tmux-socket', cls.socket,
        ], stderr=subprocess.PIPE)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(('127.0.0.1', cls.port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.wait()
        if cls.proc.stderr:
            cls.proc.stderr.close()
        subprocess.run(cls.tmux + ['kill-server'], capture_output=True)
        cls.temp_dir.cleanup()

    def get(self, query):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/history?{query}') as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))

    def test_pages_backwards_without_gaps_or_overlap(self):
        status, newest = self.get('window=hist&count=40')
        self.assertEqual(status, 200)
        self.assertEqual(len(newest['lines']), 40)
        self.assertTrue(newest['more'])
        self.assertEqual(newest['offset'], 0)

        status, older = self.get('window=hist&count=40&offset=40')
        self.assertEqual(status, 200)
        self.assertEqual(len(older['lines']), 40)
        # adjacent pages must be contiguous: the older page's last line is the
        # line immediately before the newest page's first line
        self.assertNotEqual(newest['lines'][0], older['lines'][-1])
        full = subprocess.run(self.tmux + ['capture-pane', '-p', '-t', 'hist', '-S', '-'],
                              capture_output=True, text=True).stdout.split('\n')
        newest_first = newest['lines'][0]
        older_last = older['lines'][-1]
        i_newest = full.index(newest_first)
        i_older = full.index(older_last)
        self.assertEqual(i_newest - i_older, 1, 'pages must be adjacent')

    def test_oldest_page_reports_no_more(self):
        status, page = self.get('window=hist&count=5000')
        self.assertEqual(status, 200)
        self.assertFalse(page['more'], 'a full capture should exhaust history')
        self.assertEqual(page['start'], 0)
        self.assertEqual(len(page['lines']), page['total'])

    def test_pages_backwards_without_gaps_or_overlap(self):
        status, newest = self.get('window=hist&count=40')
        self.assertEqual(status, 200)
        self.assertEqual(len(newest['lines']), 40)
        self.assertTrue(newest['more'])
        self.assertEqual(newest['offset'], 0)

        status, older = self.get('window=hist&count=40&offset=40')
        self.assertEqual(status, 200)
        self.assertEqual(len(older['lines']), 40)
        # adjacent pages must be contiguous: the older page's last line is the
        # line immediately before the newest page's first line
        self.assertNotEqual(newest['lines'][0], older['lines'][-1])
        full = subprocess.run(self.tmux + ['capture-pane', '-p', '-t', 'hist', '-S', '-'],
                              capture_output=True, text=True).stdout.split('\n')
        newest_first = newest['lines'][0]
        older_last = older['lines'][-1]
        i_newest = full.index(newest_first)
        i_older = full.index(older_last)
        self.assertEqual(i_newest - i_older, 1, 'pages must be adjacent')

    def test_oldest_page_reports_no_more(self):
        status, page = self.get('window=hist&count=5000')
        self.assertEqual(status, 200)
        self.assertFalse(page['more'], 'a full capture should exhaust history')
        self.assertEqual(page['start'], 0)
        self.assertEqual(len(page['lines']), page['total'])

    def test_wrapped_rows_come_back_as_one_line(self):
        """A long line wraps on screen; -J must join it again, or copying a URL
        out of the dialog yields embedded newlines (reported for an OAuth URL)."""
        subprocess.run(self.tmux + [
            'send-keys', '-t', 'hist',
            r"printf 'URLSTART'; printf 'a%.0s' $(seq 1 200); printf 'ENDURL\n'", 'Enter'],
            capture_output=True)
        time.sleep(0.6)
        status, page = self.get('window=hist&count=40')
        self.assertEqual(status, 200)
        joined = [line for line in page['lines'] if 'URLSTART' in line]
        self.assertTrue(joined, 'the long line must appear in the page')
        self.assertTrue(any(line.endswith('ENDURL') for line in joined),
                        'the whole line must arrive as a single entry')
        self.assertFalse(any('URLSTART' in line and 'ENDURL' not in line for line in joined),
                         'no partial fragments from the wrap')

    def long_line_session(self, name):
        """A session of its own: long lines wrap, and -J joins them, which would
        otherwise shift the line counts the other tests depend on."""
        subprocess.run(self.tmux + ['new-session', '-d', '-s', name, '-x', '60', '-y', '12',
                                    'bash --norc -i'], capture_output=True)
        time.sleep(0.4)
        return name

    def test_wrapped_rows_come_back_as_one_line(self):
        """A long line wraps on screen; -J must join it again, or copying a URL
        out of the dialog yields embedded newlines."""
        name = self.long_line_session('wraptest')
        subprocess.run(self.tmux + [
            'send-keys', '-t', name,
            r"printf 'URLSTART'; printf 'a%.0s' $(seq 1 200); printf 'ENDURL\n'", 'Enter'],
            capture_output=True)
        time.sleep(0.8)
        status, page = self.get(f'window={name}&count=20')
        self.assertEqual(status, 200)
        hits = [line for line in page['lines'] if 'URLSTART' in line]
        self.assertTrue(hits, 'the long line must appear')
        self.assertTrue(any(line.endswith('ENDURL') for line in hits),
                        'it must arrive as one entry, not fragments')
        subprocess.run(self.tmux + ['kill-session', '-t', name], capture_output=True)

    def test_osc8_hyperlink_becomes_its_url(self):
        """An agent CLI wraps a URL in an OSC 8 hyperlink; capture-pane hands the
        sequence back, and it used to show as `]8;id=...;https://...` noise in
        front of the URL, so copying the login link produced garbage."""
        name = self.long_line_session('osctest')
        url = 'https://example.test/oauth?code=1'
        subprocess.run(self.tmux + [
            'send-keys', '-t', name,
            r"printf '\033]8;id=abc;" + url + r"\033\\" + url + r"\033]8;;\033\\\n'", 'Enter'],
            capture_output=True)
        time.sleep(0.8)
        status, page = self.get(f'window={name}&count=20')
        self.assertEqual(status, 200)
        # The shell's echo of the command legitimately contains the text ]8;id=...,
        # so the checks are: no escape bytes anywhere, and the link target present
        # as a clean line of its own (once - the visible text repeats it).
        self.assertFalse(any('\x1b' in line for line in page['lines']), 'no escape bytes')
        self.assertEqual(page['lines'].count(url), 1,
                         'the link target must survive as a clean line, exactly once')
        subprocess.run(self.tmux + ['kill-session', '-t', name], capture_output=True)

    def test_offset_past_history_returns_an_empty_page(self):
        """Past the oldest line tmux clamps -S/-E and would return a stray line."""
        status, page = self.get('window=hist&count=10&offset=999999')
        self.assertEqual(status, 200)
        self.assertEqual(page['lines'], [])
        self.assertFalse(page['more'])

    def test_presence_rejects_an_invalid_window_label(self):
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/presence?window=bad;id',
            data=b'', headers={'Content-Length': '0'}, method='POST')
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 400)

    def test_count_is_capped(self):
        status, page = self.get('window=hist&count=999999')
        self.assertEqual(status, 200)
        self.assertLessEqual(page['count'], 5000)

    def test_rejects_bad_target_and_params(self):
        for query in ('window=;id', 'window=$(id)', 'window=hist&count=abc', 'window=hist&offset=-5'):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self.get(query)
            self.assertEqual(ctx.exception.code, 400, query)

    def test_unknown_window_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.get('window=does-not-exist')
        self.assertEqual(ctx.exception.code, 404)

    def search(self, query):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/history/search?{query}') as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))

    def test_search_finds_matches_newest_first_with_usable_indices(self):
        status, res = self.search('window=hist&q=199')
        self.assertEqual(status, 200)
        self.assertTrue(res['matches'], 'expected matches for a common substring')
        indices = [m['index'] for m in res['matches']]
        self.assertEqual(indices, sorted(indices, reverse=True), 'newest match first')
        # every reported index must point at a line that really contains it
        status, page = self.get(f"window=hist&count=5000")
        for m in res['matches'][:5]:
            self.assertIn('199', page['lines'][m['index']])
        # and the index must round-trip into a page offset
        m = res['matches'][0]
        offset = res['total'] - 1 - m['index']
        status, p2 = self.get(f'window=hist&count=1&offset={offset}')
        self.assertEqual(p2['lines'], [m['text']])

    def test_search_is_case_insensitive_by_default_and_can_be_strict(self):
        _, loose = self.search('window=hist&q=marker-case')
        self.assertTrue(loose['matches'], 'case-insensitive search should find MaRkEr-CaSe')
        _, strict = self.search('window=hist&q=marker-case&case=1')
        self.assertEqual(strict['matches'], [], 'strict search must not match a different case')

    def test_search_rejects_missing_query_and_bad_window(self):
        for query in ('window=hist', 'window=hist&q=', 'window=;id&q=x'):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self.search(query)
            self.assertEqual(ctx.exception.code, 400, query)

    def test_search_limit_is_capped_and_reports_truncation(self):
        status, res = self.search('window=hist&q=1&limit=3')
        self.assertEqual(status, 200)
        self.assertLessEqual(len(res['matches']), 3)
        self.assertTrue(res['truncated'])

    def test_dead_tmux_socket_reports_404_not_a_crash(self):
        """A socket with no server behind it must fail cleanly, not 500."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        proc = subprocess.Popen([
            sys.executable, str(ROOT / 'omp-web-upload'),
            '--port', str(port), '--bind', '127.0.0.1',
            '--dir', str(Path(self.temp_dir.name) / 'uploads2'),
            '--presence-file', str(Path(self.temp_dir.name) / 'presence2'),
            '--tmux-socket', str(Path(self.temp_dir.name) / 'no-such-socket'),
        ], stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.05)
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/history?window=hist')
            self.assertEqual(ctx.exception.code, 404)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            if proc.stderr:
                proc.stderr.close()


if __name__ == '__main__':
    unittest.main()


class WindowEndpointTests(unittest.TestCase):
    """The window bar's endpoints. The frontend owns that bar because tmux's own
    status line (now `status off`) was a single terminal row, too thin to tap."""

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory(prefix='omp-windows-test-')
        cls.socket = str(Path(cls.temp_dir.name) / 'tmux')
        cls.tmux = ['tmux', '-S', cls.socket]
        subprocess.run(cls.tmux + ['new-session', '-d', '-s', 'bar', '-n', 'one', '-x', '80', '-y', '24',
                                   'bash --norc -i'], capture_output=True)
        for name in ('two', 'three'):
            subprocess.run(cls.tmux + ['new-window', '-d', '-t', '=bar:', '-n', name, 'bash --norc -i'],
                           capture_output=True)
        time.sleep(0.4)

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            cls.port = s.getsockname()[1]
        cls.proc = subprocess.Popen([
            sys.executable, str(ROOT / 'omp-web-upload'),
            '--port', str(cls.port), '--bind', '127.0.0.1',
            '--dir', str(Path(cls.temp_dir.name) / 'uploads'),
            '--presence-file', str(Path(cls.temp_dir.name) / 'presence'),
            '--tmux-socket', cls.socket,
        ], stderr=subprocess.PIPE)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(('127.0.0.1', cls.port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.wait()
        if cls.proc.stderr:
            cls.proc.stderr.close()
        subprocess.run(cls.tmux + ['kill-server'], capture_output=True)
        cls.temp_dir.cleanup()

    def windows(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/windows') as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))

    def select(self, window):
        request = urllib.request.Request(
            f'http://127.0.0.1:{self.port}/windows/select?window={urllib.parse.quote(window)}',
            data=b'', headers={'Content-Length': '0'}, method='POST')
        with urllib.request.urlopen(request) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))

    def active_names(self):
        out = subprocess.run(self.tmux + ['list-windows', '-t', 'bar', '-F',
                                          '#{window_active} #{window_name}'],
                             capture_output=True, text=True).stdout.splitlines()
        return [line.split()[1] for line in out if line.startswith('1 ')]

    def test_lists_windows_with_ids_names_and_the_active_flag(self):
        status, payload = self.windows()
        self.assertEqual(status, 200)
        self.assertTrue(payload['ok'])
        mine = [w for w in payload['windows'] if w['session'] == 'bar']
        self.assertEqual([w['name'] for w in mine], ['one', 'two', 'three'])
        # index numbering follows base-index, which this harness inherits from
        # whatever tmux config exists - assert order and uniqueness instead
        indexes = [int(w['index']) for w in mine]
        self.assertEqual(indexes, sorted(indexes))
        self.assertEqual(len(set(indexes)), 3)
        self.assertTrue(all(w['id'].startswith('@') for w in mine))
        self.assertEqual(len([w for w in mine if w['active']]), 1)
        self.assertTrue(all(w['dead'] is False for w in mine))
        self.assertTrue(all(isinstance(w['activity'], bool) and isinstance(w['bell'], bool) for w in mine))
        self.assertTrue(all(w['path'] for w in mine))

    def test_select_makes_the_window_current(self):
        _, payload = self.windows()
        target = next(w for w in payload['windows'] if w['session'] == 'bar' and w['name'] == 'three')
        self.assertNotIn('three', self.active_names())
        status, result = self.select(target['id'])
        self.assertEqual(status, 200)
        self.assertTrue(result['ok'])
        self.assertEqual(self.active_names(), ['three'])
        _, payload = self.windows()
        self.assertTrue(next(w for w in payload['windows'] if w['id'] == target['id'])['active'])

    def test_reports_the_bell_flag_and_clears_it_when_selected(self):
        """tmux raises the bell flag for a window that is not current - how a
        finished omp turn announces itself - and clears it when it is selected.
        The bar's highlight relies on exactly that."""
        _, payload = self.windows()
        mine = [w for w in payload['windows'] if w['session'] == 'bar']
        first, two = mine[0], next(w for w in mine if w['name'] == 'two')
        self.select(first['id'])                      # make sure 'two' is not current
        _, payload = self.windows()
        self.assertFalse(next(w for w in payload['windows'] if w['id'] == two['id'])['bell'])

        subprocess.run(self.tmux + ['send-keys', '-t', 'bar:two', r'printf "\a"', 'Enter'],
                       capture_output=True)
        time.sleep(0.6)
        _, payload = self.windows()
        flagged = next(w for w in payload['windows'] if w['id'] == two['id'])
        self.assertTrue(flagged['bell'], 'a bell in a non-current window must set the flag')
        self.assertFalse(flagged['active'])

        self.select(two['id'])
        _, payload = self.windows()
        self.assertFalse(next(w for w in payload['windows'] if w['id'] == two['id'])['bell'])

    def test_select_rejects_an_invalid_window(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.select('bad;id')
        self.assertEqual(ctx.exception.code, 400)

    def test_select_reports_an_unknown_window(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.select('@9999')
        self.assertEqual(ctx.exception.code, 502)
