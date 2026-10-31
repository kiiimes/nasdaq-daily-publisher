import unittest
from unittest.mock import Mock
from urllib.error import URLError
from check_kis import BrokerHTTPError, retry_read

class RetryTests(unittest.TestCase):
    def test_transient_read_recovers_without_changing_request(self):
        operation=Mock(side_effect=[BrokerHTTPError(500,'temporary'),URLError('offline'),{'ok':True}])
        wait=Mock()
        self.assertEqual(retry_read(operation,wait),{'ok':True})
        self.assertEqual(operation.call_count,3)
        self.assertEqual([c.args[0] for c in wait.call_args_list],[2,4])
    def test_auth_or_data_rejection_is_not_retried(self):
        for error in (BrokerHTTPError(403,'denied'),ValueError('wrong date')):
            operation=Mock(side_effect=error)
            with self.assertRaises(type(error)):retry_read(operation,Mock())
            self.assertEqual(operation.call_count,1)
    def test_transient_failure_is_bounded(self):
        operation=Mock(side_effect=BrokerHTTPError(500,'temporary'))
        with self.assertRaises(BrokerHTTPError):retry_read(operation,Mock())
        self.assertEqual(operation.call_count,3)
