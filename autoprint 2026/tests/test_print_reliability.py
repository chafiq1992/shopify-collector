import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import main, print_utils
from app.print_journal import JobBusy, PrintJournal, SubmissionUncertain


class PrintReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = PrintJournal(Path(self.tmp.name) / "receipts.sqlite3")
        self.pdf = Path(self.tmp.name) / "label.pdf"
        self.pdf.write_bytes(b"%PDF-test")

    def test_only_one_concurrent_process_claims_job(self):
        barrier = threading.Barrier(8)
        def claim(_):
            barrier.wait()
            try:
                return self.journal.claim("same-job")
            except JobBusy:
                return None
        with ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(claim, range(8)))
        self.assertEqual(sum(c is not None for c in claims), 1)

    def test_restart_retains_receipt_and_rejects_id_reuse(self):
        receipt = self.journal.claim("job", payload={"orders": [1]})
        receipt.before_submit(0)
        receipt.submitted(0)
        receipt.finish()
        reopened = PrintJournal(self.journal.path)
        self.assertTrue(reopened.claim("job", payload={"orders": [1]}).completed)
        with self.assertRaises(ValueError):
            reopened.claim("job", payload={"orders": [2]})

    def test_stale_claim_can_resume_but_old_owner_cannot_submit(self):
        with patch("app.print_journal.time.time", return_value=1):
            old = self.journal.claim("job")
        with patch("app.print_journal.time.time", return_value=200):
            current = self.journal.claim("job")
            with self.assertRaises(JobBusy):
                old.before_submit(0)
            current.before_submit(0)
            current.submitted(0)
            current.finish()

    def test_only_one_poller_instance_per_installation(self):
        previous = main._poller_instance_file
        try:
            with patch.object(main, "BASE", Path(self.tmp.name)):
                self.assertTrue(main._claim_poller_instance())
                self.assertFalse(main._claim_poller_instance())
                main._poller_instance_file.close()
                self.assertTrue(main._claim_poller_instance())
        finally:
            if main._poller_instance_file and main._poller_instance_file is not previous:
                main._poller_instance_file.close()
            main._poller_instance_file = previous

    def test_uncertain_crash_is_not_automatically_reprinted(self):
        receipt = self.journal.claim("job")
        receipt.before_submit(0)
        receipt.release()
        resumed = self.journal.claim("job")
        with self.assertRaises(SubmissionUncertain):
            resumed.is_submitted(0)

    def test_sumatra_uses_one_submission_and_explicit_requested_copies(self):
        with patch.object(print_utils.shutil, "which", return_value="SumatraPDF.exe"), \
             patch.object(print_utils.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(print_utils.time, "sleep") as sleep:
            print_utils.set_post_print_delay(0)
            for copies in (1, 3):
                with patch.object(print_utils.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
                    print_utils.print_pdf_silent(str(self.pdf), printer="Label Printer", copies=copies)
                    self.assertEqual(run.call_count, 1)
                    command = run.call_args.args[0]
                    self.assertEqual(command[command.index("-print-settings") + 1], f"{copies}x")
            sleep.assert_not_called()

    def test_spool_failure_is_held_for_review(self):
        receipt = self.journal.claim("job")
        with patch.object(print_utils.shutil, "which", return_value="SumatraPDF.exe"), \
             patch.object(print_utils.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr="spool failed", stdout="")):
            with self.assertRaises(SubmissionUncertain):
                main._submit_pdf(str(self.pdf), {}, "Label Printer", receipt=receipt)
        receipt.release()
        with self.assertRaises(SubmissionUncertain):
            self.journal.claim("job").is_submitted("pdf")

    def test_process_launch_failure_can_be_safely_retried(self):
        receipt = self.journal.claim("job")
        with patch.object(print_utils.shutil, "which", return_value="SumatraPDF.exe"), \
             patch.object(print_utils.subprocess, "run", side_effect=FileNotFoundError("missing exe")):
            with self.assertRaises(FileNotFoundError):
                main._submit_pdf(str(self.pdf), {}, "Label Printer", receipt=receipt)
        self.assertFalse(receipt.is_submitted("pdf"))

    def test_ack_failure_and_redelivery_never_reprint(self):
        cfg = {"pc_id": "test"}
        job = {"job_id": "job", "orders": ["1001"], "lease_attempt": 1}
        def receipt(_cfg, jid, payload=None):
            return self.journal.claim(jid, payload=payload)
        ack, nack = unittest.mock.Mock(side_effect=RuntimeError("ACK unavailable")), unittest.mock.Mock()
        with patch.object(main, "_job_receipt", side_effect=receipt), patch.object(main, "_print_job") as printer:
            main._handle_relay_job(job, cfg, ack, nack, lambda jid: True)
            job["lease_attempt"] = 2
            main._handle_relay_job(job, cfg, ack, nack, lambda jid: True)
            self.assertEqual(printer.call_count, 1)
            self.assertEqual(ack.call_count, 2)
            nack.assert_not_called()

    def test_partial_batch_resumes_only_unprinted_parts_after_config_change(self):
        receipt = self.journal.claim("batch")
        orders, submitted = [], []
        def process(num, *args):
            orders.append(num)
            return f"<p>#{num}</p>", "@page{size:100mm 100mm;margin:0;}body{height:100mm;}", "Printer"
        def submit(path, **kwargs):
            kwargs["before_submit"]()
            submitted.append(Path(path).read_text())
        def render(html, pdf, **kwargs):
            # The mock keeps the page text available to the fake print process.
            if "#3" in Path(html).read_text() and len(submitted) == 1:
                raise RuntimeError("browser render failed")
            Path(pdf).write_text(Path(html).read_text())
        with patch.object(main, "_process_single_order", side_effect=process), \
             patch.object(main, "fetch_overrides_from_collector", return_value={}), \
             patch.object(main, "html_to_pdf", side_effect=render), \
             patch.object(main, "print_pdf_silent", side_effect=submit):
            job = {"orders": ["1", "2", "3", "4"], "copies": 1}
            with self.assertRaises(RuntimeError):
                main._print_job(job, {"max_orders_per_batch": 2}, receipt=receipt)
            receipt.release()
            resumed = self.journal.claim("batch")
            with patch.object(main, "html_to_pdf", side_effect=lambda html, pdf, **kwargs: Path(pdf).write_text(Path(html).read_text())):
                main._print_job(job, {"max_orders_per_batch": 4}, receipt=resumed)
            self.assertEqual(len(submitted), 2)
            self.assertEqual(orders.count("1"), 1)
            self.assertEqual(orders.count("2"), 1)
            self.assertIn("#3", submitted[1])
            self.assertNotIn("#1", submitted[1])

    def test_thirty_orders_are_combined_in_one_render_and_submission(self):
        with patch.object(main, "_process_single_order", side_effect=lambda num, *args: (f"<p>#{num}</p>", "body{height:100mm;}", "Printer")), \
             patch.object(main, "fetch_overrides_from_collector", return_value={}), \
             patch.object(main, "html_to_pdf") as render, patch.object(main, "print_pdf_silent") as printer:
            main._print_job({"orders": [str(i) for i in range(30)]}, {})
            self.assertEqual(render.call_count, 1)
            self.assertEqual(printer.call_count, 1)

    def test_local_request_timeout_retry_reuses_completed_receipt(self):
        cfg = {"pc_id": "test"}
        def receipt(_cfg, jid, payload=None):
            return self.journal.claim(jid, payload=payload)
        body = main.OrdersBody(orders=["1"], request_id="stable-request")
        with patch.object(main, "load_config", return_value=cfg), patch.object(main, "_job_receipt", side_effect=receipt), patch.object(main, "_print_job") as printer:
            first, duplicate = main.print_orders(body), main.print_orders(body)
            self.assertTrue(first["ok"])
            self.assertTrue(duplicate["duplicate"])
            self.assertEqual(first["results"], [{"order": "1", "printed": True, "prepared": True}])
            self.assertEqual(duplicate["results"], first["results"])
            self.assertEqual(printer.call_count, 1)

    def test_ambiguous_relay_submission_disables_automatic_retry(self):
        def receipt(_cfg, jid, payload=None):
            return self.journal.claim(jid, payload=payload)
        nack = unittest.mock.Mock()
        with patch.object(main, "_job_receipt", side_effect=receipt), patch.object(main, "_print_job", side_effect=SubmissionUncertain("check printer")):
            main._handle_relay_job({"job_id": "job", "orders": ["1"]}, {}, unittest.mock.Mock(), nack, lambda jid: True)
        nack.assert_called_once_with("job", retry=False)

    def test_forwarding_preserves_idempotency_and_does_not_print_locally(self):
        body = main.OrdersBody(orders=["1"], job_id="relay-job", request_id="action")
        with patch.object(main, "load_config", return_value={"print_mode": "forward"}), patch.object(main, "_forward_json", return_value={"ok": True}) as forward, patch.object(main, "_print_job") as printer:
            self.assertTrue(main.print_orders(body, x_print_forwarded=None)["ok"])
        sent = forward.call_args.args[2]
        self.assertEqual(sent["job_id"], "relay-job")
        self.assertEqual(sent["request_id"], "action")
        printer.assert_not_called()

    def test_lost_lease_prevents_submission(self):
        receipt = self.journal.claim("job")
        receipt.can_submit = lambda: False
        with self.assertRaises(JobBusy):
            receipt.before_submit(0)
        self.assertFalse(receipt.is_submitted(0))


if __name__ == "__main__":
    unittest.main()
