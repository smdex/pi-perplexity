"""Offline adapter acceptance tests; no Hermes startup or real credentials."""
from __future__ import annotations
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hermes_pplx", Path(__file__).with_name("__init__.py"))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"HOME": str(self.root), "PPLX_CONFIG_DIR": str(self.root / "config"),
            "PPLX_CACHE_DIR": str(self.root / "cache"), "PPLX_COOKIE": "", "PATH": str(self.root)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tools = {}
        class Context:
            def register_tool(_, **kw): self.tools[kw['name']] = kw
            def register_command(_, *args, **kw): self.fail('legacy config command registered')
        self.context = Context()

    def fake(self, body):
        executable = self.root / 'pplx'
        executable.write_text(f'#!{sys.executable}\n' + body)
        executable.chmod(0o755)

    def test_registration_and_inherited_defaults(self):
        legacy = self.root / '.config/pi-perplexity/config.json'
        legacy.parent.mkdir(parents=True)
        legacy.write_text('invalid legacy config left untouched')
        self.fake("import sys\nraise RuntimeError('registration must not spawn')\n")
        plugin.register(self.context)
        self.fake("import json,sys\nassert sys.stdin.read() == ''\nassert sys.argv[1:] == ['ask','--json',' --literal ; $(touch NO)']\nprint(json.dumps({'answer':'inherited','sources':[]}))\n")
        result = self.tools['perplexity_ask']['handler']({'query':'--literal ; $(touch NO)'})
        self.assertIn('message: "inherited"', result)
        self.assertIn('model', self.tools['perplexity_ask']['schema']['parameters']['properties'])
        self.assertEqual(legacy.read_text(), 'invalid legacy config left untouched')

    def test_explicit_overrides_and_rendering(self):
        self.fake("import json,sys\nassert sys.argv[1:] == ['research','--json','--model','custom','--recency','week','--thread','abc','--space','team','--sources','web','--sources','connector','--attach','report.pdf','--no-incognito','literal']\nprint(json.dumps({'answer':'line 1\\nline 2', 'sources':[{'name':'First','url':'https://example.test','snippet':'a,b'}], 'model':'custom'}))\n")
        result = plugin.perplexity_research({'query':'literal','model':'custom','recency':'week','thread':'abc',
            'space':'team','sources':['web','connector'],'files':['report.pdf'],'persistent':True})
        self.assertIn('message: "line 1\\nline 2"', result)
        self.assertIn('"First","https://example.test","a,b",""', result)
        self.assertIn('mode: "research"', result)

    def test_process_errors_are_actionable_and_do_not_leak_diagnostics(self):
        self.assertIn('Install pplx', plugin.perplexity_ask({'query':'x'}))
        for body, expected in [
            ("print('{\"error\":\"expired cookie SECRET\"}'); raise SystemExit(2)", 'pplx login'),
            ("import sys; sys.stderr.write('SECRET'); raise SystemExit(7)", 'status 7'),
            ("print('{\"error\":\"SECRET\"}')", 'reported an error'),
            ("print('not json')", 'invalid JSON'),
            ("print('{\"answer\":12}')", 'unexpected result shape'),
        ]:
            with self.subTest(expected=expected):
                self.fake(body + '\n')
                result = plugin.perplexity_ask({'query':'x'})
                self.assertIn(expected, result)
                self.assertNotIn('SECRET', result)

    def test_cancellation_reaps_term_resistant_child(self):
        ready = self.root / 'ready'
        self.fake(f"import os,signal,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen({str(ready)!r},'w').write(str(os.getpid()))\nwhile True: time.sleep(.01)\n")
        interrupted = threading.Event()
        interrupt = types.ModuleType('tools.interrupt')
        interrupt.is_interrupted = interrupted.is_set
        def controller():
            deadline = time.monotonic() + 3
            while not ready.exists() and time.monotonic() < deadline: time.sleep(.01)
            interrupted.set()
        thread = threading.Thread(target=controller)
        thread.start()
        with patch.dict(sys.modules, {'tools': types.ModuleType('tools'), 'tools.interrupt': interrupt}), patch.dict(os.environ, {'PI_PERPLEXITY_ASK_TIMEOUT_MS':'1500'}):
            started = time.monotonic()
            result = plugin.perplexity_ask({'query':'x'})
        thread.join()
        self.assertIn('cancelled', result)
        self.assertLess(time.monotonic() - started, 3)
        with self.assertRaises(ProcessLookupError): os.kill(int(ready.read_text()), 0)

    @unittest.skipUnless(os.name == 'posix', 'POSIX owned process groups')
    def test_timeout_terminates_wrapper_descendants(self):
        marker = self.root / 'descendant-stopped'
        parent = self.root / 'parent'
        self.fake(f"import os,signal,time\nchild=os.fork()\nif child == 0:\n def stop(*_):\n  open({str(marker)!r},'w').write('stopped')\n  raise SystemExit()\n signal.signal(signal.SIGTERM,stop)\n while True: time.sleep(.01)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen({str(parent)!r},'w').write(str(os.getpid()))\nwhile True:\n try: os.waitpid(child,os.WNOHANG)\n except ChildProcessError: pass\n time.sleep(.01)\n")
        with patch.dict(os.environ, {'PI_PERPLEXITY_ASK_TIMEOUT_MS':'200'}):
            self.assertIn('timed out', plugin.perplexity_ask({'query':'x'}))
        self.assertEqual(marker.read_text(), 'stopped')
        with self.assertRaises(ProcessLookupError): os.kill(int(parent.read_text()),0)

    def test_timeout_and_precancel(self):
        self.fake('import time\ntime.sleep(10)\n')
        with patch.dict(os.environ, {'PI_PERPLEXITY_ASK_TIMEOUT_MS':'50'}):
            self.assertIn('timed out', plugin.perplexity_ask({'query':'x'}))
        interrupt = types.ModuleType('tools.interrupt')
        interrupt.is_interrupted = lambda: True
        self.fake("raise RuntimeError('must not start')\n")
        with patch.dict(sys.modules, {'tools': types.ModuleType('tools'), 'tools.interrupt': interrupt}):
            self.assertIn('cancelled', plugin.perplexity_ask({'query':'x'}))

    def test_invalid_scope_is_not_silently_inherited(self):
        self.fake("print('{\"answer\":\"unexpected\"}')\n")
        self.assertIn('sources must not be empty', plugin.perplexity_ask({'query':'x','sources':[]}))
        for args in ({'query':'x','limit':True}, {'query':'x','thread':'a','continue':True}, {'query':'x','model':''}):
            self.assertIn('error:', plugin.perplexity_ask(args))

    def test_large_pipes_and_saved_file_references(self):
        reply = self.root / 'reply.json'
        image = self.root / 'image.png'
        self.fake("import json,sys\nsys.stderr.write('x' * 200000)\nprint(json.dumps({'answer':'a' * 200000}))\n")
        self.assertIn('message: "' + 'a' * 200000 + '"', plugin.perplexity_ask({'query':'x'}))
        self.fake(f"import json\nopen({str(reply)!r},'w').write('{{}}')\nopen({str(image)!r},'w').write('image')\nprint(json.dumps({{'answer':'saved','images':[{{'url':'https://example.test/i','filename':'image.png'}}]}}))\n")
        result = plugin.perplexity_ask({'query':'x','save':str(reply),'save_images':str(self.root)})
        self.assertIn(f'"{image}",true', result)
        self.assertIn(f'"{reply}",true', result)

    @unittest.skipUnless(os.environ.get('HERMES_INTERRUPT_SOURCE'), 'optional installed-host interrupt source')
    def test_installed_host_thread_scoped_interrupt(self):
        source = Path(os.environ['HERMES_INTERRUPT_SOURCE'])
        host_spec = importlib.util.spec_from_file_location('tools.interrupt', source)
        interrupt = importlib.util.module_from_spec(host_spec)
        # Avoid host startup: only this isolated module plus its env helper seam.
        utils = types.ModuleType('utils')
        utils.env_var_enabled = lambda _: False
        with patch.dict(sys.modules, {'utils':utils}): host_spec.loader.exec_module(interrupt)
        self.fake("import json,time\ntime.sleep(.4)\nprint(json.dumps({'answer':'completed'}))\n")
        results = {}
        def call(name): results[name] = plugin.perplexity_ask({'query':name})
        with patch.dict(sys.modules, {'tools':types.ModuleType('tools'),'tools.interrupt':interrupt}):
            cancelled = threading.Thread(target=call, args=('cancelled',))
            normal = threading.Thread(target=call, args=('normal',))
            cancelled.start(); normal.start()
            time.sleep(.1)
            interrupt.set_interrupt(True, thread_id=cancelled.ident)
            cancelled.join(3); normal.join(3)
            self.assertIn('cancelled', results['cancelled'])
            self.assertIn('message: "completed"', results['normal'])
            self.assertTrue(interrupt.is_thread_interrupted(cancelled.ident))
            interrupt.set_interrupt(False, thread_id=cancelled.ident)

if __name__ == '__main__': unittest.main()
