"""Tests for zotero_cli.py — all pyzotero calls are mocked."""

import json
import os
import sys
import unittest
from io import StringIO
from unittest.mock import MagicMock, patch

# Ensure the tool is importable
sys.path.insert(0, os.path.dirname(__file__))


def make_item(key='ABC123', title='Test Paper', creators=None, date='2024',
              item_type='journalArticle', doi='10.1234/test', url='', extra='',
              collections=None):
    """Helper to create a mock Zotero item."""
    if creators is None:
        creators = [{'creatorType': 'author', 'firstName': 'Jane', 'lastName': 'Doe'}]
    return {
        'key': key,
        'data': {
            'title': title,
            'creators': creators,
            'date': date,
            'itemType': item_type,
            'DOI': doi,
            'url': url,
            'extra': extra,
            'collections': collections or [],
        },
        'meta': {},
    }


def make_collection(key='COL1', name='Reading List', num_items=5):
    """Helper to create a mock Zotero collection."""
    return {
        'key': key,
        'data': {'name': name},
        'meta': {'numItems': num_items},
    }


@patch.dict(os.environ, {'ZOTERO_API_KEY': 'fake-key', 'ZOTERO_LIBRARY_ID': '12345'})
@patch('zotero_cli.zotero.Zotero')
class TestZoteroCli(unittest.TestCase):
    """Test all CLI commands with mocked Zotero client."""

    def _run_cli(self, argv):
        """Run the CLI with given args, capturing stdout and stderr."""
        import zotero_cli
        old_argv = sys.argv
        captured_out = StringIO()
        captured_err = StringIO()
        old_stdout, old_stderr = sys.stdout, sys.stderr
        try:
            sys.argv = ['zotero-cli'] + argv
            sys.stdout = captured_out
            sys.stderr = captured_err
            zotero_cli.main()
        except SystemExit:
            pass
        finally:
            sys.argv = old_argv
            sys.stdout = old_stdout
            sys.stderr = old_stderr
        return captured_out.getvalue(), captured_err.getvalue()

    def test_search_returns_json_array(self, MockZotero):
        """search command returns JSON array of items."""
        mock_zot = MockZotero.return_value
        mock_zot.items.return_value = [
            make_item(key='K1', title='Paper One'),
            make_item(key='K2', title='Paper Two'),
        ]
        out, err = self._run_cli(['search', 'test query'])
        results = json.loads(out)
        self.assertIsInstance(results, list)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['key'], 'K1')
        self.assertEqual(results[1]['title'], 'Paper Two')

    def test_add_creates_item_in_collection(self, MockZotero):
        """add command creates an item and adds it to a collection."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [make_collection(key='COL1', name='My Collection')]
        mock_zot.create_items.return_value = {
            'successful': {'0': {'data': {'key': 'NEW1'}}},
        }
        out, err = self._run_cli([
            'add', '--title', 'New Paper', '--authors', 'John Smith',
            '--collection', 'My Collection',
        ])
        result = json.loads(out)
        self.assertEqual(result['key'], 'NEW1')
        self.assertEqual(result['title'], 'New Paper')
        self.assertEqual(result['collection'], 'My Collection')
        # Verify the item was created with the collection key
        call_args = mock_zot.create_items.call_args[0][0]
        self.assertIn('COL1', call_args[0]['collections'])

    def test_add_creates_collection_if_missing(self, MockZotero):
        """add command creates collection when it doesn't exist."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = []  # No collections exist
        mock_zot.create_collection.return_value = {
            'successful': {'0': {'data': {'key': 'NEWCOL'}}},
        }
        mock_zot.create_items.return_value = {
            'successful': {'0': {'data': {'key': 'NEW2'}}},
        }
        out, err = self._run_cli([
            'add', '--title', 'Another Paper', '--collection', 'Brand New',
        ])
        result = json.loads(out)
        self.assertEqual(result['key'], 'NEW2')
        mock_zot.create_collection.assert_called_once()

    def test_list_returns_collection_items(self, MockZotero):
        """list command returns items from a collection."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [make_collection(key='COL1', name='Reading List')]
        mock_zot.collection_items.return_value = [
            make_item(key='I1', title='Item One'),
            make_item(key='I2', title='Item Two'),
        ]
        out, err = self._run_cli(['list', 'Reading List'])
        results = json.loads(out)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['key'], 'I1')

    def test_list_filters_attachments(self, MockZotero):
        """list command filters out attachment items."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [make_collection(key='COL1', name='Reading List')]
        mock_zot.collection_items.return_value = [
            make_item(key='I1', title='Item One'),
            make_item(key='A1', title='file.pdf', item_type='attachment'),
        ]
        out, err = self._run_cli(['list', 'Reading List'])
        results = json.loads(out)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['key'], 'I1')

    def test_add_to_adds_item_to_collection(self, MockZotero):
        """add-to command adds an existing item to a collection."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [make_collection(key='COL1', name='Favorites')]
        mock_zot.item.return_value = make_item(key='ITEM1', collections=[])
        out, err = self._run_cli(['add-to', 'ITEM1', 'Favorites'])
        result = json.loads(out)
        self.assertEqual(result['key'], 'ITEM1')
        self.assertEqual(result['action'], 'added')
        mock_zot.update_item.assert_called_once()

    def test_remove_removes_item_from_collection(self, MockZotero):
        """remove command removes an item from a collection."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [make_collection(key='COL1', name='Favorites')]
        mock_zot.item.return_value = make_item(key='ITEM1', collections=['COL1'])
        out, err = self._run_cli(['remove', 'ITEM1', 'Favorites'])
        result = json.loads(out)
        self.assertEqual(result['key'], 'ITEM1')
        self.assertEqual(result['action'], 'removed')
        mock_zot.update_item.assert_called_once()

    def test_collections_lists_all(self, MockZotero):
        """collections command lists all collections."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [
            make_collection(key='C1', name='Col One', num_items=3),
            make_collection(key='C2', name='Col Two', num_items=7),
        ]
        out, err = self._run_cli(['collections'])
        results = json.loads(out)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['name'], 'Col One')
        self.assertEqual(results[1]['numItems'], 7)

    def test_text_format_output(self, MockZotero):
        """--format text produces human-readable output."""
        mock_zot = MockZotero.return_value
        mock_zot.items.return_value = [
            make_item(key='K1', title='Paper One'),
        ]
        out, err = self._run_cli(['--format', 'text', 'search', 'test'])
        self.assertIn('[K1]', out)
        self.assertIn('Paper One', out)
        self.assertIn('Doe', out)
        # Should NOT be JSON
        with self.assertRaises(json.JSONDecodeError):
            json.loads(out)

    def test_text_format_collections(self, MockZotero):
        """--format text for collections shows name and count."""
        mock_zot = MockZotero.return_value
        mock_zot.collections.return_value = [
            make_collection(key='C1', name='My Col', num_items=10),
        ]
        out, err = self._run_cli(['--format', 'text', 'collections'])
        self.assertIn('[C1]', out)
        self.assertIn('My Col', out)
        self.assertIn('10 items', out)


class TestMissingEnvVars(unittest.TestCase):
    """Test behavior when environment variables are missing."""

    @patch.dict(os.environ, {}, clear=True)
    @patch('zotero_cli.zotero.Zotero')
    def test_missing_env_vars_error(self, MockZotero):
        """Missing env vars produce a clear error message."""
        # Remove any ZOTERO env vars
        os.environ.pop('ZOTERO_API_KEY', None)
        os.environ.pop('ZOTERO_LIBRARY_ID', None)
        import zotero_cli
        captured_err = StringIO()
        old_stderr = sys.stderr
        try:
            sys.stderr = captured_err
            with self.assertRaises(SystemExit):
                zotero_cli.get_client()
        finally:
            sys.stderr = old_stderr
        self.assertIn('ZOTERO_API_KEY', captured_err.getvalue())
        self.assertIn('ZOTERO_LIBRARY_ID', captured_err.getvalue())


class TestInvalidCommand(unittest.TestCase):
    """Test invalid command handling."""

    @patch.dict(os.environ, {'ZOTERO_API_KEY': 'fake', 'ZOTERO_LIBRARY_ID': '123'})
    def test_invalid_command_shows_usage(self):
        """Invalid commands produce usage help."""
        import zotero_cli
        old_argv = sys.argv
        captured_err = StringIO()
        old_stderr = sys.stderr
        try:
            sys.argv = ['zotero-cli', 'nonexistent']
            sys.stderr = captured_err
            with self.assertRaises(SystemExit):
                zotero_cli.main()
        finally:
            sys.argv = old_argv
            sys.stderr = old_stderr
        err_output = captured_err.getvalue()
        self.assertTrue('usage' in err_output.lower() or 'invalid' in err_output.lower()
                        or 'argument' in err_output.lower())


if __name__ == '__main__':
    unittest.main()
